import express, { Request, Response, NextFunction } from 'express'
import { createProxyMiddleware, responseInterceptor } from 'http-proxy-middleware'
import type { Server } from 'http'
import { getProvider } from '../providerService'
import { getApiKey } from '../apiKeyService'
import { getSession } from './sessionManager'
import { execSync } from 'child_process'

const DEFAULT_PORT = 12345

let server: Server | null = null
let requestCount = 0
let lastError: string | null = null

async function killProcessOnPort(port: number): Promise<void> {
  try {
    if (process.platform === 'darwin' || process.platform === 'linux') {
      execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null || true`, { stdio: 'ignore' })
    } else if (process.platform === 'win32') {
      execSync(`FOR /F "tokens=5" %P IN ('netstat -ano ^| findstr :${port}') DO taskkill /PID %P /F 2>nul`, { stdio: 'ignore', shell: 'cmd.exe' })
    }
    // Give OS time to release the port
    await new Promise(resolve => setTimeout(resolve, 500))
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

  // Try to kill any process holding the port from a previous session
  await killProcessOnPort(DEFAULT_PORT)

  const app = express()

  // Main proxy handler
  app.use('/', async (req: Request, res: Response, next: NextFunction) => {
    requestCount++

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
    if (!session) {
      res.status(401).json({
        error: 'Session not found',
        message: 'Session expired or invalid. Please relaunch the project from CC-Use',
      })
      return
    }

    // Get provider and API key from session
    const provider = await getProvider(session.providerId)
    if (!provider) {
      res.status(404).json({ error: 'Provider not found' })
      return
    }

    const apiKey = await getApiKey(session.apiKeyId)
    if (!apiKey) {
      res.status(404).json({ error: 'API key not found' })
      return
    }

    const targetUrl = provider.baseUrl.replace(/\/$/, '')

    // Create proxy middleware for this request
    const proxy = createProxyMiddleware({
      target: targetUrl,
      changeOrigin: true,
      selfHandleResponse: true,
      on: {
        proxyReq: (proxyReq) => {
          // Replace authorization header with actual API key
          proxyReq.setHeader('Authorization', `Bearer ${apiKey.value}`)
          proxyReq.setHeader('x-api-key', apiKey.value)
        },
        proxyRes: responseInterceptor(async (responseBuffer, proxyRes) => {
          const statusCode = proxyRes.statusCode || 500

          if (statusCode === 401 || statusCode === 429) {
            console.log(`Request failed with ${statusCode} for key ${apiKey.alias || apiKey.id}`)
            lastError = `Key error: ${statusCode}`
            // Note: We can't retry here as response is already being sent
            // In production, you'd want more sophisticated retry logic
          }

          return responseBuffer
        }),
        error: (err, _req, res) => {
          console.error('Proxy error:', err)
          lastError = err.message
          if (res && 'status' in res) {
            (res as Response).status(502).json({ error: 'Proxy error', message: err.message })
          }
        },
      },
    })

    proxy(req, res, next)
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
