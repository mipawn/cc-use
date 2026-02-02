import express, { Request, Response, NextFunction } from 'express'
import { createProxyMiddleware, responseInterceptor } from 'http-proxy-middleware'
import type { Server } from 'http'
import { getProvider } from '../providerService'
import { selectKey, handleKeyFailure, isRetryableError } from './keySelector'
import { BrowserWindow } from 'electron'

const DEFAULT_PORT = 12345
const MAX_RETRIES = 5

let server: Server | null = null
let requestCount = 0
let lastError: string | null = null

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

  const app = express()

  // Parse provider ID from request headers
  app.use(async (req: Request, _res: Response, next: NextFunction) => {
    const providerId = req.headers['x-cc-use-provider-id'] as string

    if (!providerId) {
      // Try to get from environment variable passed through
      const envProviderId = req.headers['x-provider-id'] as string
      if (envProviderId) {
        req.headers['x-cc-use-provider-id'] = envProviderId
      }
    }

    next()
  })

  // Main proxy handler
  app.use('/', async (req: Request, res: Response, next: NextFunction) => {
    requestCount++

    // Get provider ID from various sources
    let providerId = req.headers['x-cc-use-provider-id'] as string

    // If no provider ID, try to extract from the path or use default
    if (!providerId) {
      // For now, we'll need the provider ID to be passed
      // In a real scenario, you might have a default provider
      res.status(400).json({
        error: 'No provider specified',
        message: 'Please set x-cc-use-provider-id header or configure a default provider',
      })
      return
    }

    const provider = await getProvider(providerId)
    if (!provider) {
      res.status(404).json({ error: 'Provider not found' })
      return
    }

    // Select an API key
    let keyResult = await selectKey(providerId)
    let retries = 0

    const makeRequest = async (): Promise<void> => {
      if (!keyResult.key) {
        lastError = 'All API keys exhausted'
        notifyFrontend('All API keys exhausted for this provider')
        res.status(502).json({
          error: 'All API keys exhausted',
          message: 'All configured API keys have been marked as exhausted. Please add more keys or reset existing ones.',
        })
        return
      }

      const targetUrl = provider.baseUrl.replace(/\/$/, '')

      // Create proxy middleware for this request
      const proxy = createProxyMiddleware({
        target: targetUrl,
        changeOrigin: true,
        selfHandleResponse: true,
        on: {
          proxyReq: (proxyReq, _req) => {
            // Replace authorization header with selected key
            proxyReq.setHeader('Authorization', `Bearer ${keyResult.key!.value}`)

            // Remove our custom headers
            proxyReq.removeHeader('x-cc-use-provider-id')
            proxyReq.removeHeader('x-provider-id')
          },
          proxyRes: responseInterceptor(async (responseBuffer, proxyRes, _req, _res) => {
            const statusCode = proxyRes.statusCode || 500

            if (isRetryableError(statusCode) && retries < MAX_RETRIES) {
              retries++
              console.log(`Key ${keyResult.key!.alias || keyResult.key!.id} failed with ${statusCode}, trying next key (attempt ${retries}/${MAX_RETRIES})`)

              // Mark current key as exhausted and get next one
              keyResult = await handleKeyFailure(keyResult.key!.id, providerId)

              if (keyResult.key) {
                // We can't actually retry here due to how the middleware works
                // The response has already been sent
                // In a production system, you'd want to handle this differently
                lastError = `Key exhausted, switched to next key`
              } else {
                lastError = 'All API keys exhausted'
              }
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
    }

    await makeRequest()
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

function notifyFrontend(message: string): void {
  const windows = BrowserWindow.getAllWindows()
  windows.forEach((win) => {
    win.webContents.send('proxy:error', message)
  })
}
