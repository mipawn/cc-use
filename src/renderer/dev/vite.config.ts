import { defineConfig, mergeConfig } from 'vite'
import baseConfig from '../../../vite.config'
import { fixtureHmrPath } from './isolation'

/** Isolated dev server only. Production preview/build intentionally cannot enable fixtures. */
export default defineConfig(({ command }) => {
  if (command !== 'serve' || process.env.VITE_CC_USE_FIXTURE !== '1')
    throw new Error('Use VITE_CC_USE_FIXTURE=1 with the isolated fixture dev server')
  return mergeConfig(baseConfig, {
    server: {
      host: '127.0.0.1',
      port: 15173,
      strictPort: true,
      hmr: { host: '127.0.0.1', clientPort: 15173, path: fixtureHmrPath },
      proxy: {},
      headers: {
        'Content-Security-Policy':
          "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'",
        'Referrer-Policy': 'no-referrer',
      },
    },
  })
})
