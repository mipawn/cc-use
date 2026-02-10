import express, { Request, Response, NextFunction } from 'express'
import { createProxyMiddleware, responseInterceptor } from 'http-proxy-middleware'
import type { Server } from 'http'
import { getProvider, listProviders } from '../providerService'
import { getApiKey } from '../apiKeyService'
import { getSession, restoreSessions } from './sessionManager'
import { createRequestLog } from '../requestLogService'
import { syncProviderPricing } from '../pricingSyncService'
import {
  parseUsageFromResponse,
  parseModelFromResponse,
  StreamUsageAccumulator,
} from './usageParser'
import { execSync } from 'child_process'

const DEFAULT_PORT = 12345

let server: Server | null = null
let requestCount = 0
let lastError: string | null = null

// Cached fallback pricing from other providers (refreshed every 5 minutes)
let fallbackPricingCache: Record<string, { input: number; output: number; cacheRead?: number; cacheCreation?: number }> | null = null
let fallbackPricingCacheTime = 0
const FALLBACK_CACHE_TTL = 5 * 60 * 1000 // 5 minutes

async function getFallbackPricing(excludeProviderId: string): Promise<Record<string, { input: number; output: number; cacheRead?: number; cacheCreation?: number }> | undefined> {
  const now = Date.now()
  if (fallbackPricingCache && now - fallbackPricingCacheTime < FALLBACK_CACHE_TTL) {
    return Object.keys(fallbackPricingCache).length > 0 ? fallbackPricingCache : undefined
  }

  try {
    const allProviders = await listProviders()
    // Filter providers that have synced pricing, sort by sync time (oldest first)
    // so the most recently synced provider's prices win on merge
    const withPricing = allProviders
      .filter((p) => p.id !== excludeProviderId && p.cachedModelPricing && p.lastPricingSyncedAt)
      .sort((a, b) => (a.lastPricingSyncedAt! < b.lastPricingSyncedAt! ? -1 : 1))

    const merged: Record<string, { input: number; output: number; cacheRead?: number; cacheCreation?: number }> = {}
    for (const p of withPricing) {
      Object.assign(merged, p.cachedModelPricing)
    }
    fallbackPricingCache = merged
    fallbackPricingCacheTime = now
    return Object.keys(merged).length > 0 ? merged : undefined
  } catch {
    return undefined
  }
}

async function killProcessOnPort(port: number): Promise<void> {
  try {
    if (process.platform === 'darwin' || process.platform === 'linux') {
      execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null || true`, {
        stdio: 'ignore',
      })
    } else if (process.platform === 'win32') {
      execSync(
        `FOR /F "tokens=5" %P IN ('netstat -ano ^| findstr :${port}') DO taskkill /PID %P /F 2>nul`,
        { stdio: 'ignore', shell: 'cmd.exe' },
      )
    }
    // Give OS time to release the port
    await new Promise((resolve) => setTimeout(resolve, 500))
  } catch {
    // Ignore errors - port might not be in use
  }
}

interface ProxyState {
  isRunning: boolean
  port: number
  requestCount: number
  lastError: string | null
}

export function getProxyStatus(): ProxyState {
  return {
    isRunning: server !== null,
    port: DEFAULT_PORT,
    requestCount,
    lastError,
  }
}

export async function startProxy(): Promise<void> {
  if (server) {
    console.log('Proxy already running')
    return
  }

  // Restore sessions from database so terminals launched before a restart keep working
  restoreSessions()

  // Try to kill any process holding the port from a previous session
  await killProcessOnPort(DEFAULT_PORT)

  const app = express()

  // Main proxy handler
  app.use('/', async (req: Request, res: Response, next: NextFunction) => {
    requestCount++
    const startTime = Date.now()
    console.log(
      `[Proxy] Incoming: ${req.method} ${req.url}, auth=${req.headers['authorization']}, x-api-key=${req.headers['x-api-key']}`,
    )

    // Get authorization header - try both Authorization and x-api-key
    const authHeader = req.headers['authorization'] as string
    const xApiKey = req.headers['x-api-key'] as string
    const apiKeyValue = authHeader?.replace(/^Bearer\s+/i, '') || xApiKey

    if (!apiKeyValue) {
      res.status(401).json({
        error: 'No authorization header',
        message: 'Please provide an API key or session token',
      })
      return
    }

    // Try to parse as session token
    const sessionToken = apiKeyValue.startsWith('session-') ? apiKeyValue : null

    if (!sessionToken) {
      res.status(401).json({
        error: 'Invalid session',
        message: 'Please launch the project from CC-Use to create a valid session',
      })
      return
    }

    // Get session
    const session = getSession(sessionToken)
    console.log(
      `[Proxy] Session lookup: token=${sessionToken}, found=${!!session}, providerId=${session?.providerId}, apiKeyId=${session?.apiKeyId}`,
    )
    if (!session) {
      res.status(401).json({
        error: 'Session not found',
        message: 'Session expired or invalid. Please relaunch the project from CC-Use',
      })
      return
    }

    // Get provider and API key from session
    const provider = await getProvider(session.providerId)
    console.log(`[Proxy] Provider: found=${!!provider}, baseUrl=${provider?.baseUrl}`)
    if (!provider) {
      res.status(404).json({ error: 'Provider not found' })
      return
    }

    const apiKey = await getApiKey(session.apiKeyId)
    console.log(`[Proxy] ApiKey: found=${!!apiKey}, alias=${apiKey?.alias}`)
    if (!apiKey) {
      res.status(404).json({ error: 'API key not found' })
      return
    }

    // Parse provider's cached model pricing for cost calculation
    let providerPricing: Record<string, { input: number; output: number; cacheRead?: number; cacheCreation?: number }> | undefined
    if (provider.cachedModelPricing) {
      providerPricing = provider.cachedModelPricing
    } else {
      // Current provider has no synced pricing - fallback to other providers' pricing
      providerPricing = await getFallbackPricing(provider.id)

      // Also trigger background auto-sync if never attempted
      if (!provider.lastPricingSyncedAt) {
        syncProviderPricing(provider.id)
          .then((result) => {
            if (result.count > 0) {
              console.log(`[Proxy] Auto-synced ${result.count} model prices for provider ${provider.name}`)
            }
          })
          .catch((err) => {
            console.log('[Proxy] Auto-sync pricing failed (non-fatal):', err)
          })
      }
    }

    // Parse baseUrl to separate origin and path prefix
    // e.g. "https://api.openai.com/v1" → target "https://api.openai.com", pathPrefix "/v1"
    const parsedUrl = new URL(provider.baseUrl.replace(/\/$/, ''))
    const targetOrigin = parsedUrl.origin
    const pathPrefix = parsedUrl.pathname === '/' ? '' : parsedUrl.pathname.replace(/\/$/, '')
    console.log(
      `[Proxy] URL parsed: targetOrigin=${targetOrigin}, pathPrefix=${pathPrefix}, reqPath=${req.url}`,
    )

    // Check if this is a streaming request
    const isStreaming =
      req.headers['accept']?.includes('text/event-stream') || req.body?.stream === true

    if (isStreaming) {
      // For streaming requests, do NOT use selfHandleResponse/responseInterceptor
      // as it buffers the entire response and breaks SSE streaming
      const streamAccumulator = new StreamUsageAccumulator()

      const proxy = createProxyMiddleware({
        target: targetOrigin,
        changeOrigin: true,
        on: {
          proxyReq: (proxyReq) => {
            if (pathPrefix) {
              proxyReq.path = pathPrefix + proxyReq.path
            }
            proxyReq.setHeader('Authorization', `Bearer ${apiKey.value}`)
            proxyReq.setHeader('x-api-key', apiKey.value)
            console.log(
              `[Proxy] Forwarding (stream): ${proxyReq.method} ${targetOrigin}${proxyReq.path}`,
            )
          },
          proxyRes: (proxyRes) => {
            const statusCode = proxyRes.statusCode || 500

            if (statusCode === 401 || statusCode === 429) {
              console.log(`Request failed with ${statusCode} for key ${apiKey.alias || apiKey.id}`)
              lastError = `Key error: ${statusCode}`
            }

            // Listen to chunks for usage tracking
            proxyRes.on('data', (chunk: Buffer) => {
              try {
                streamAccumulator.processChunk(chunk.toString('utf-8'))
              } catch {
                // Ignore parse errors in individual chunks
              }
            })

            proxyRes.on('end', async () => {
              const latencyMs = Date.now() - startTime
              try {
                const usage = streamAccumulator.getUsage()
                const model = streamAccumulator.getModel()
                if (usage && (usage.inputTokens > 0 || usage.outputTokens > 0)) {
                  await createRequestLog({
                    providerId: session.providerId,
                    apiKeyId: session.apiKeyId,
                    projectId: session.projectId,
                    sessionId: sessionToken,
                    model: model,
                    usage,
                    costMultiplier: apiKey.costMultiplier ?? 1,
                    latencyMs,
                    statusCode,
                    isStreaming: true,
                    providerPricing,
                  })
                }
              } catch (err) {
                console.error('Failed to log streaming request usage:', err)
              }
            })
          },
          error: (err, _req, res) => {
            console.error('Proxy error:', err)
            lastError = err.message
            if (res && 'status' in res) {
              ;(res as Response).status(502).json({ error: 'Proxy error', message: err.message })
            }
          },
        },
      })

      proxy(req, res, next)
    } else {
      // For non-streaming requests, use responseInterceptor to capture full response
      const proxy = createProxyMiddleware({
        target: targetOrigin,
        changeOrigin: true,
        selfHandleResponse: true,
        on: {
          proxyReq: (proxyReq) => {
            if (pathPrefix) {
              proxyReq.path = pathPrefix + proxyReq.path
            }
            proxyReq.setHeader('Authorization', `Bearer ${apiKey.value}`)
            proxyReq.setHeader('x-api-key', apiKey.value)
            console.log(`[Proxy] Forwarding: ${proxyReq.method} ${targetOrigin}${proxyReq.path}`)
          },
          proxyRes: responseInterceptor(async (responseBuffer, proxyRes) => {
            const statusCode = proxyRes.statusCode || 500
            const latencyMs = Date.now() - startTime

            if (statusCode === 401 || statusCode === 429) {
              console.log(`Request failed with ${statusCode} for key ${apiKey.alias || apiKey.id}`)
              lastError = `Key error: ${statusCode}`
            }

            try {
              const responseText = responseBuffer.toString('utf-8')
              const responseJson = JSON.parse(responseText)
              const usage = parseUsageFromResponse(responseJson)
              const model = parseModelFromResponse(responseJson)

              if (usage && (usage.inputTokens > 0 || usage.outputTokens > 0)) {
                await createRequestLog({
                  providerId: session.providerId,
                  apiKeyId: session.apiKeyId,
                  projectId: session.projectId,
                  sessionId: sessionToken,
                  model: model,
                  usage,
                  costMultiplier: apiKey.costMultiplier ?? 1,
                  latencyMs,
                  statusCode,
                  isStreaming: false,
                  providerPricing,
                })
              }
            } catch {
              // Not JSON or no usage info - skip logging
            }

            return responseBuffer
          }),
          error: (err, _req, res) => {
            console.error('Proxy error:', err)
            lastError = err.message
            if (res && 'status' in res) {
              ;(res as Response).status(502).json({ error: 'Proxy error', message: err.message })
            }
          },
        },
      })

      proxy(req, res, next)
    }
  })

  return new Promise((resolve, reject) => {
    try {
      server = app.listen(DEFAULT_PORT, () => {
        console.log(`Proxy server started on port ${DEFAULT_PORT}`)
        resolve()
      })

      server.on('error', (err) => {
        console.error('Server error:', err)
        lastError = err.message
        reject(err)
      })
    } catch (err) {
      reject(err)
    }
  })
}

export async function stopProxy(): Promise<void> {
  return new Promise((resolve) => {
    if (server) {
      server.close(() => {
        server = null
        console.log('Proxy server stopped')
        resolve()
      })
    } else {
      resolve()
    }
  })
}
