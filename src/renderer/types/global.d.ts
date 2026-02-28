import type { Api } from '../api/types'

declare global {
  interface Window {
    api: Api
    __TAURI__?: Record<string, unknown>
    __TAURI_INTERNALS__?: Record<string, unknown>
  }
}

export {}
