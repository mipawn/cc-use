import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import { resolve } from 'path'

const alias = {
  '@main': resolve(__dirname, 'src/main'),
  '@renderer': resolve(__dirname, 'src/renderer'),
  '@shared': resolve(__dirname, 'src/shared'),
  '@preload': resolve(__dirname, 'src/preload'),
}

export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        entry: 'src/main/index.ts',
        onstart(args) {
          args.startup()
        },
        vite: {
          resolve: { alias },
          build: {
            outDir: 'dist-electron/main',
            rollupOptions: {
              external: ['better-sqlite3', 'node-pty'],
            },
          },
        },
      },
      {
        entry: 'src/preload/index.ts',
        onstart(args) {
          args.reload()
        },
        vite: {
          resolve: { alias },
          build: {
            outDir: 'dist-electron/preload',
          },
        },
      },
    ]),
    renderer(),
  ],
  resolve: {
    alias,
  },
  build: {
    outDir: 'dist',
  },
})
