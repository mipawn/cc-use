// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://127.0.0.1:15173"}
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDiagnostics } from './fixtureSupport'
import { installIsolation, isAllowedStaticUrl, isAllowedHmrUrl } from './isolation'

const origin = 'http://127.0.0.1:15173'
let restore: (() => void) | undefined
const nativeFetch = vi.fn(async () => new Response('static asset'))

beforeEach(() => {
  vi.stubGlobal('fetch', nativeFetch)
  nativeFetch.mockClear()
})
afterEach(() => {
  restore?.()
  restore = undefined
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.resetModules()
  Reflect.deleteProperty(window, '__CC_USE_FIXTURE__')
  document.getElementById('cc-use-fixture-status')?.remove()
})

describe('fixture transport isolation', () => {
  it.each([
    '/',
    '/index.html',
    '/@vite/client',
    '/@react-refresh',
    '/src/renderer/main.tsx?t=1',
    '/assets/icon.svg',
    '/node_modules/.vite/deps/react.js?v=1',
  ])('allows only preview-origin static asset %s', (path) => {
    expect(isAllowedStaticUrl(path, origin)).toBe(true)
  })
  it.each([
    'https://provider.example/v1/models',
    'http://127.0.0.1:12345/',
    'http://localhost:22345/',
    '//elsewhere.example/a.js',
    '/api/list',
    '/__open-in-editor',
    '/@fs/Users/private/config.json',
    '/src/../../api/secret.json',
    'data:text/plain,hello',
    'file:///Users/private',
    'http://user:pass@127.0.0.1:15173/src/a.ts',
  ])('rejects non-static or external URL %s', (path) => {
    expect(isAllowedStaticUrl(path, origin)).toBe(false)
  })

  it('allows static fetches without credentials or redirects; rejects external requests before transport', async () => {
    const diagnostics = createDiagnostics()
    restore = installIsolation(window, diagnostics)
    await window.fetch('/src/renderer/main.tsx')
    expect(nativeFetch).toHaveBeenCalledWith('/src/renderer/main.tsx', {
      redirect: 'error',
      credentials: 'omit',
    })
    await expect(window.fetch('https://provider.example/v1/models')).rejects.toThrow(
      'static allowlist',
    )
    await expect(window.fetch('http://127.0.0.1:12345/status')).rejects.toThrow('static allowlist')
    await expect(window.fetch('/src/renderer/main.tsx', { method: 'POST' })).rejects.toThrow(
      'static allowlist',
    )
    await expect(window.fetch(new Request(`${origin}/api/list`))).rejects.toThrow(
      'static allowlist',
    )
    expect(nativeFetch).toHaveBeenCalledTimes(1)
    expect(diagnostics.violations).toHaveLength(4)
  })

  it('rejects secondary browser transports before opening a connection', () => {
    const diagnostics = createDiagnostics()
    restore = installIsolation(window, diagnostics)
    expect(() => new window.WebSocket('ws://127.0.0.1:12345')).toThrow(
      'WebSocket outside preview HMR allowlist',
    )
    expect(() => new window.WebSocket('ws://127.0.0.1:15173')).toThrow(
      'WebSocket outside preview HMR allowlist',
    )
    expect(() => new window.XMLHttpRequest()).toThrow('XMLHttpRequest is disabled')
    expect(() => new window.EventSource('https://provider.example')).toThrow(
      'EventSource is disabled',
    )
    expect(() => new window.Worker('/src/worker.js')).toThrow('Worker is disabled')
    expect(() => window.navigator.sendBeacon('https://provider.example', 'data')).toThrow(
      'sendBeacon is disabled',
    )
    expect(() => window.open('https://provider.example')).toThrow('window.open is disabled')
    expect(() => document.createElement('form').submit()).toThrow('form.submit is disabled')
    expect(diagnostics.violations).toHaveLength(8)
    expect(nativeFetch).not.toHaveBeenCalled()
  })

  it('blocks actual Tauri core invoke at the native bridge and records the attempt', async () => {
    const diagnostics = createDiagnostics()
    restore = installIsolation(window, diagnostics)
    const { invoke } = await import('@tauri-apps/api/core')
    await expect(invoke('provider_list')).rejects.toThrow('Native __TAURI_INTERNALS__')
    expect(diagnostics.violations).toHaveLength(1)
    expect(() => Reflect.set(window, '__TAURI_INTERNALS__', {})).toThrow(
      'Native __TAURI_INTERNALS__',
    )
    expect(nativeFetch).not.toHaveBeenCalled()
  })

  it('allows only the dedicated same-origin HMR socket, before calling its native constructor', () => {
    const calls = vi.fn()
    vi.stubGlobal(
      'WebSocket',
      class {
        static OPEN = 1
        constructor(url: string | URL, protocols?: string | string[]) {
          calls(url, protocols)
        }
      },
    )
    const diagnostics = createDiagnostics()
    restore = installIsolation(window, diagnostics)
    const url = 'ws://127.0.0.1:15173/__fixture_hmr?token=synthetic'
    expect(isAllowedHmrUrl(url, 'vite-hmr', origin)).toBe(true)
    const socket = new window.WebSocket(url, 'vite-hmr')
    expect(socket).toBeInstanceOf(window.WebSocket)
    expect(window.WebSocket.OPEN).toBe(1)
    expect(calls).toHaveBeenCalledWith(url, 'vite-hmr')
    const pingUrl = 'ws://127.0.0.1:15173/__fixture_hmr'
    new window.WebSocket(pingUrl, 'vite-ping')
    expect(calls).toHaveBeenCalledWith(pingUrl, 'vite-ping')
    expect(() => new window.WebSocket(url, 'vite-ping')).toThrow('HMR allowlist')
    for (const bad of [
      'ws://provider.example/__fixture_hmr',
      'ws://127.0.0.1:12345/__fixture_hmr',
      'ws://127.0.0.1:15173/api',
      `${url}&other=1`,
    ]) {
      expect(() => new window.WebSocket(bad, 'vite-hmr')).toThrow('HMR allowlist')
    }
    expect(() => new window.WebSocket(url, 'app')).toThrow('HMR allowlist')
    expect(calls).toHaveBeenCalledTimes(2)
  })

  it('restricts Vite restart probes to the same endpoint, empty query and a single exact protocol', () => {
    const url = 'ws://127.0.0.1:15173/__fixture_hmr'
    expect(isAllowedHmrUrl(url, 'vite-ping', origin)).toBe(true)
    expect(isAllowedHmrUrl(new URL(url), ['vite-ping'], origin)).toBe(true)
    const blocked: [string, string | string[] | undefined][] = [
      [`${url}?token=synthetic`, 'vite-ping'],
      [`${url}?probe=1`, 'vite-ping'],
      [`${url}#fragment`, 'vite-ping'],
      ['ws://provider.example/__fixture_hmr', 'vite-ping'],
      ['ws://127.0.0.1:12345/__fixture_hmr', 'vite-ping'],
      ['ws://127.0.0.1:22345/__fixture_hmr', 'vite-ping'],
      ['ws://127.0.0.1:15173/api', 'vite-ping'],
      ['ws://user:secret@127.0.0.1:15173/__fixture_hmr', 'vite-ping'],
      ['wss://127.0.0.1:15173/__fixture_hmr', 'vite-ping'],
      [url, 'application'],
      [url, undefined],
      [url, []],
      [url, ['vite-ping', 'vite-hmr']],
    ]
    for (const [target, protocol] of blocked)
      expect(isAllowedHmrUrl(target, protocol, origin)).toBe(false)
  })

  it('refuses an existing native bridge without overwriting it or partially installing guards', () => {
    const nativeInvoke = vi.fn()
    const existing = { invoke: nativeInvoke }
    vi.stubGlobal('__TAURI_INTERNALS__', existing)
    const websocket = window.WebSocket
    const diagnostics = createDiagnostics()
    expect(() => installIsolation(window, diagnostics)).toThrow(
      'refuses an existing native Tauri bridge',
    )
    expect(window.__TAURI_INTERNALS__).toBe(existing)
    expect(window.WebSocket).toBe(websocket)
    expect(window.fetch).toBe(nativeFetch)
    expect(nativeInvoke).not.toHaveBeenCalled()
  })

  it('allows local form controls and href-less pagination while preventing native form navigation', () => {
    const diagnostics = createDiagnostics()
    restore = installIsolation(window, diagnostics)
    const form = document.createElement('form')
    const input = document.createElement('input')
    const pagination = document.createElement('a')
    form.append(input, pagination)
    document.body.append(form)
    try {
      for (const target of [input, pagination]) {
        const click = new MouseEvent('click', { bubbles: true, cancelable: true })
        target.dispatchEvent(click)
        expect(click.defaultPrevented).toBe(false)
      }
      const submitHandler = vi.fn()
      form.addEventListener('submit', submitHandler)
      const submit = new Event('submit', { bubbles: true, cancelable: true })
      form.dispatchEvent(submit)
      expect(submit.defaultPrevented).toBe(true)
      expect(submitHandler).toHaveBeenCalledOnce()
      expect(diagnostics.violations).toEqual([])
      expect(nativeFetch).not.toHaveBeenCalled()
    } finally {
      form.remove()
    }
  })

  it('still blocks external links and explicit form destinations before browser navigation', () => {
    const diagnostics = createDiagnostics()
    restore = installIsolation(window, diagnostics)
    const errors: unknown[] = []
    const capture = (event: ErrorEvent) => {
      errors.push(event.error)
      event.preventDefault()
    }
    window.addEventListener('error', capture)
    const anchor = document.createElement('a')
    anchor.href = 'https://provider.example/private'
    const form = document.createElement('form')
    form.action = 'https://provider.example/private'
    document.body.append(anchor, form)
    try {
      const click = new MouseEvent('click', { bubbles: true, cancelable: true })
      anchor.dispatchEvent(click)
      const submit = new Event('submit', { bubbles: true, cancelable: true })
      form.dispatchEvent(submit)
      expect(click.defaultPrevented).toBe(true)
      expect(submit.defaultPrevented).toBe(true)
      expect(diagnostics.violations).toHaveLength(2)
      expect(errors).toHaveLength(2)
      expect(nativeFetch).not.toHaveBeenCalled()
    } finally {
      anchor.remove()
      form.remove()
      window.removeEventListener('error', capture)
    }
  })

  it('restores original globals when a test fixture is removed', () => {
    const websocket = window.WebSocket
    const diagnostics = createDiagnostics()
    restore = installIsolation(window, diagnostics)
    restore()
    restore = undefined
    expect(window.WebSocket).toBe(websocket)
    expect(window.fetch).toBe(nativeFetch)
    expect(Object.getOwnPropertyDescriptor(window, '__TAURI_INTERNALS__')).toBeUndefined()
  })
})

describe('fixture early bootstrap', () => {
  it('injects before stores and keeps native transport completely unused', async () => {
    vi.stubEnv('DEV', true)
    vi.stubEnv('VITE_CC_USE_FIXTURE', '1')
    vi.resetModules()
    const isolation = await import('./isolation')
    const install = isolation.installIsolation
    vi.spyOn(isolation, 'installIsolation').mockImplementation((target, diagnostics) => {
      restore = install(target, diagnostics)
      return restore
    })
    const { installFixturePreview } = await import('./bootstrap')
    const fixture = installFixturePreview()
    const { useProviderStore } = await import('../stores/providerStore')
    await useProviderStore.getState().fetchProviders()
    const { useApiKeyStore } = await import('../stores/apiKeyStore')
    await useApiKeyStore
      .getState()
      .fetchAllApiKeys(useProviderStore.getState().providers.map((provider) => provider.id))
    expect(useProviderStore.getState().providers).toHaveLength(4)
    expect(fixture.diagnostics.calls).toContain('provider.list')
    expect(fixture.diagnostics.violations).toEqual([])
    expect(nativeFetch).not.toHaveBeenCalled()
    expect(document.getElementById('cc-use-fixture-status')?.textContent).toContain('FIXTURE')
    expect(() => fixture.api.proxy.restart()).toThrow('Unimplemented API')
    expect(document.getElementById('cc-use-fixture-status')?.getAttribute('role')).toBe('alert')
  })

  it('retains an import boundary ahead of console, stores, and App, and skips the persistence bridge', () => {
    const entry = readFileSync('src/renderer/main.tsx', 'utf8')
    const injection = entry.indexOf('installFixturePreview()')
    expect(injection).toBeGreaterThan(0)
    for (const module of [
      './api/consoleBus',
      './api/consoleStore',
      './stores/settingsStore',
      './App',
    ]) {
      expect(entry.indexOf(`import('${module}')`)).toBeGreaterThan(injection)
      expect(entry).not.toContain(`from '${module}'`)
    }
    expect(entry).toMatch(
      /if \(!isFixtureMode\)\s*\{\s*const \{ installRendererLogBridge \} = await import\('\.\/api\/consoleLogBridge'\)/,
    )
  })
})
