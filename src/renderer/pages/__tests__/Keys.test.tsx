// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App as AntdApp, ConfigProvider } from 'antd'
import { StyleProvider } from '@ant-design/cssinjs'
import { createRoot } from 'react-dom/client'

Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
    length: 0,
    key: () => null,
  },
  configurable: true,
})

Object.defineProperty(window, 'localStorage', {
  value: globalThis.localStorage,
  configurable: true,
})

const mockProviders = [
  { id: 'p1', name: 'Provider Alpha', baseUrl: 'https://alpha.test.com', isActive: true, sortOrder: 0 },
  { id: 'p2', name: 'Provider Beta', baseUrl: 'https://beta.test.com', isActive: true, sortOrder: 1 },
]

const apiMock = {
  provider: {
    list: vi.fn().mockResolvedValue(mockProviders),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    reorder: vi.fn(),
    modelList: vi.fn(),
  },
  apiKey: {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  requestLog: {
    getKeyCosts: vi.fn().mockResolvedValue([]),
  },
  balance: {
    refresh: vi.fn(),
  },
  session: {
    create: vi.fn(),
  },
  proxy: {
    status: vi.fn().mockResolvedValue({ isRunning: false, port: 12345 }),
    onStatusChanged: vi.fn().mockReturnValue(() => {}),
  },
  settings: {
    get: vi.fn(),
  },
  keyUsage: {
    refresh: vi.fn(),
  },
  system: {
    openExternal: vi.fn(),
  },
}

vi.mock('../../api', () => ({
  getApi: () => apiMock,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (options?.count !== undefined) return `${key} (count:${options.count})`
      return key
    },
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}))

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(() => ({
    matches: false,
    media: '',
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
})

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(vi.fn()),
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
}))

function reorder(ids: string[], fromId: string, toId: string): string[] | null {
  const fromIdx = ids.indexOf(fromId)
  const toIdx = ids.indexOf(toId)
  if (fromIdx === -1 || toIdx === -1) return null
  const result = [...ids]
  result.splice(fromIdx, 1)
  result.splice(toIdx, 0, fromId)
  return result
}

describe('computeProviderReorder', () => {
  it('moves an item forward in the list', () => {
    expect(reorder(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'c', 'a'])
  })

  it('moves an item backward in the list', () => {
    expect(reorder(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b'])
  })

  it('returns null for unknown ids', () => {
    expect(reorder(['a', 'b'], 'a', 'x')).toBeNull()
    expect(reorder(['a', 'b'], 'x', 'a')).toBeNull()
  })

  it('does not mutate the original array', () => {
    const orig = ['a', 'b', 'c']
    const copy = [...orig]
    reorder(orig, 'a', 'c')
    expect(orig).toEqual(copy)
  })
})

describe('Keys page - filter tabs', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.clearAllMocks()
  })

  afterEach(() => {
    act(() => root.unmount())
    document.body.removeChild(container)
  })

  it('renders provider filter tabs', async () => {
    const { default: Keys } = await import('../Keys')

    await act(async () => {
      root.render(
        <StyleProvider layer>
          <ConfigProvider>
            <AntdApp>
              <Keys />
            </AntdApp>
          </ConfigProvider>
        </StyleProvider>,
      )
    })

    await act(async () => {
      await new Promise((r) => setTimeout(r, 200))
    })

    expect(apiMock.provider.list).toHaveBeenCalled()
    expect(container.textContent).toContain('keys.allKeys')
    expect(container.textContent).toContain('Provider Alpha')
    expect(container.textContent).toContain('Provider Beta')

    const draggableTabs = container.querySelectorAll('[class*="filterTabDraggable"]')
    expect(draggableTabs.length).toBe(2)

    const allTabs = container.querySelectorAll('[class*="filterTab"]')
    expect(allTabs.length).toBeGreaterThanOrEqual(3)
  })
})
