import { afterEach, describe, expect, it, vi } from 'vitest'
import fixtureConfig from './vite.config'
import { fixtureHmrPath } from './isolation'

const config = (command: 'serve' | 'build') => {
  if (typeof fixtureConfig !== 'function')
    throw new Error('Fixture config must enforce its command gate')
  return fixtureConfig({ command, mode: 'development' })
}

afterEach(() => vi.unstubAllEnvs())

describe('isolated fixture Vite configuration', () => {
  it('requires an explicit environment flag and refuses fixture production builds', () => {
    vi.stubEnv('VITE_CC_USE_FIXTURE', undefined)
    expect(() => config('serve')).toThrow('isolated fixture dev server')
    vi.stubEnv('VITE_CC_USE_FIXTURE', '1')
    expect(() => config('build')).toThrow('isolated fixture dev server')
  })

  it('uses only the fixed loopback preview origin, matching HMR allowlist and restrictive CSP', async () => {
    vi.stubEnv('VITE_CC_USE_FIXTURE', '1')
    const result = await config('serve')
    expect(result.server).toMatchObject({
      host: '127.0.0.1',
      port: 15173,
      strictPort: true,
      proxy: {},
      hmr: { host: '127.0.0.1', clientPort: 15173, path: fixtureHmrPath },
    })
    const csp = result.server?.headers?.['Content-Security-Policy']
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("connect-src 'self'")
    expect(csp).toContain("worker-src 'none'")
    expect(csp).toContain("form-action 'none'")
  })
})
