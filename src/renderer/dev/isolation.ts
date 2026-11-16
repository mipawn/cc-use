import type { FixtureDiagnostics } from './fixtureSupport'

// This allowlist is shared with the isolated Vite configuration and unit tests.
// It never allows API paths, arbitrary same-origin GETs, redirects or daemon ports.
export function isAllowedStaticUrl(value: string, origin: string): boolean {
  try {
    const url = new URL(value, origin)
    const base = new URL(origin)
    if (
      url.origin !== base.origin ||
      !['http:', 'https:'].includes(url.protocol) ||
      ['12345', '22345'].includes(url.port) ||
      url.username ||
      url.password
    )
      return false
    if (
      url.pathname === '/' ||
      url.pathname === '/index.html' ||
      url.pathname === '/@vite/client' ||
      url.pathname === '/@react-refresh'
    )
      return true
    return (
      /^(?:\/src\/|\/assets\/|\/node_modules\/\.vite\/deps\/)/.test(url.pathname) &&
      /\.(?:[cm]?[jt]sx?|css|svg|png|jpe?g|webp|gif|woff2?|ttf|ico|json)$/.test(url.pathname)
    )
  } catch {
    return false
  }
}

export const fixtureHmrPath = '/__fixture_hmr'

export function isAllowedHmrUrl(
  value: string | URL,
  protocols: string | string[] | undefined,
  origin: string,
): boolean {
  try {
    const url = new URL(value)
    const base = new URL(origin)
    const protocol = Array.isArray(protocols)
      ? protocols.length === 1
        ? protocols[0]
        : undefined
      : protocols
    const allowedProtocol =
      (protocol === 'vite-hmr' && [...url.searchParams.keys()].every((key) => key === 'token')) ||
      // Vite 6 strips the query and opens vite-ping on this exact endpoint when
      // its dev server restarts. No application socket or other URL is allowed.
      (protocol === 'vite-ping' && url.search === '')
    return (
      url.protocol === (base.protocol === 'https:' ? 'wss:' : 'ws:') &&
      url.host === base.host &&
      !['12345', '22345'].includes(url.port) &&
      !url.username &&
      !url.password &&
      !url.hash &&
      url.pathname === fixtureHmrPath &&
      allowedProtocol
    )
  } catch {
    return false
  }
}

/** Install before importing App/stores. Native/global escapes fail visibly. */
export function installIsolation(
  window: Window & typeof globalThis,
  diagnostics: FixtureDiagnostics,
): () => void {
  const origin = window.location.origin
  if (['12345', '22345'].includes(window.location.port))
    diagnostics.reject('Preview cannot use a daemon port')
  const nativeGlobals = ['__TAURI_INTERNALS__', '__TAURI__', '__TAURI_IPC__']
  for (const name of nativeGlobals) {
    if (Object.getOwnPropertyDescriptor(window, name))
      diagnostics.reject('Fixture preview refuses an existing native Tauri bridge')
  }
  const undo: (() => void)[] = []
  const replace = (target: object, name: string, value: unknown) => {
    const previous = Object.getOwnPropertyDescriptor(target, name)
    Object.defineProperty(target, name, { configurable: true, writable: true, value })
    undo.push(() => {
      if (previous) Object.defineProperty(target, name, previous)
      else Reflect.deleteProperty(target, name)
    })
  }
  const reject = (name: string) =>
    function blocked(): never {
      return diagnostics.reject(`${name} is disabled in fixture preview`)
    }
  const nativeFetch = window.fetch?.bind(window)
  replace(window, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method =
      init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')
    if (
      !isAllowedStaticUrl(url, origin) ||
      !['GET', 'HEAD'].includes(method.toUpperCase()) ||
      init?.body
    )
      diagnostics.reject('fetch outside static allowlist')
    if (!nativeFetch) return diagnostics.reject('fetch transport unavailable')
    return nativeFetch(input, { ...init, redirect: 'error', credentials: 'omit' })
  })
  // Vite's client connects even when server.hmr=false. Permit only the dedicated
  // preview-origin HMR socket; all application/daemon sockets remain forbidden.
  const NativeWebSocket = window.WebSocket
  replace(
    window,
    'WebSocket',
    class FixtureWebSocket extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        if (!isAllowedHmrUrl(url, protocols, origin))
          diagnostics.reject('WebSocket outside preview HMR allowlist')
        super(url, protocols)
      }
    },
  )
  // XHR is unused by the fixture UI. Block rather than retaining another transport.
  for (const name of [
    'XMLHttpRequest',
    'EventSource',
    'WebTransport',
    'Worker',
    'SharedWorker',
    'RTCPeerConnection',
    'webkitRTCPeerConnection',
  ])
    replace(window, name, reject(name))
  replace(window.navigator, 'sendBeacon', reject('sendBeacon'))
  if (window.navigator.serviceWorker)
    replace(window.navigator.serviceWorker, 'register', reject('ServiceWorker'))
  replace(window, 'open', reject('window.open'))
  replace(window.HTMLFormElement.prototype, 'submit', reject('form.submit'))
  replace(window.HTMLFormElement.prototype, 'requestSubmit', reject('form.requestSubmit'))
  for (const name of nativeGlobals) {
    Object.defineProperty(window, name, {
      configurable: true,
      get: reject(`Native ${name}`),
      set: reject(`Native ${name}`),
    })
    undo.push(() => {
      Reflect.deleteProperty(window, name)
    })
  }
  const preventNavigation = (event: Event) => {
    if (event.type === 'submit') {
      // React/Ant forms submit locally. Prevent the browser's navigation without
      // blocking their event handlers or treating ordinary input clicks as IPC.
      event.preventDefault()
      const form = event.target
      if (
        form instanceof window.HTMLFormElement &&
        !form.getAttribute('action') &&
        !form.getAttribute('target')
      )
        return
      diagnostics.reject('External form submission')
    }
    const target = event.target instanceof window.Element ? event.target.closest('a[href]') : null
    if (!(target instanceof window.HTMLAnchorElement)) return
    const url = new URL(target.href, origin)
    if (
      url.origin === origin &&
      url.pathname === window.location.pathname &&
      url.search === window.location.search &&
      (url.hash || target.getAttribute('href') === '#')
    )
      return
    event.preventDefault()
    diagnostics.reject('External navigation')
  }
  window.document.addEventListener('click', preventNavigation, true)
  window.document.addEventListener('submit', preventNavigation, true)
  undo.push(() => {
    window.document.removeEventListener('click', preventNavigation, true)
    window.document.removeEventListener('submit', preventNavigation, true)
  })
  return () => {
    for (const restore of undo.reverse()) restore()
  }
}
