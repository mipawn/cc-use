// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ApiKey, Gateway, Provider } from '@shared/types'
import GatewayPage from './GatewayPage'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}))

const provider = { id: 'provider-1', name: 'DeepSeek' } as unknown as Provider
const apiKey = {
  id: 'key-1',
  providerId: 'provider-1',
  alias: 'main',
  value: 'sk-real',
} as unknown as ApiKey
const gateway: Gateway = {
  sessionToken: 'session-abcdefghijklmnopqrstuvwxyz',
  displayName: 'Work',
  providerId: 'provider-1',
  providerName: 'DeepSeek',
  apiKeyId: 'key-1',
  keyAlias: 'main',
  isActive: true,
  createdAt: '2026-10-26T00:00:00Z',
  lastSeenAt: '2026-10-26T00:00:00Z',
}

vi.mock('../api', () => ({
  getApi: () => ({
    gateway: {
      list: mocks.list,
      create: mocks.create,
      update: mocks.update,
      delete: mocks.delete,
    },
    provider: { list: async () => [provider] },
    apiKey: { list: async () => [apiKey] },
  }),
}))
vi.mock('../hooks/useServiceStatus', () => ({
  useServiceStatus: () => ({ status: { isRunning: true }, restart: vi.fn(), loading: false }),
}))
vi.mock('../stores/settingsStore', () => ({
  useSettingsStore: (selector: (state: { globalSettings: { proxyPort: number } }) => unknown) =>
    selector({ globalSettings: { proxyPort: 22345 } }),
}))
vi.mock('../hooks/usePageRefresh', () => ({ usePageRefresh: () => {} }))
vi.mock('../hooks/useAppMessage', () => ({
  useAppMessage: () => ({ success: mocks.success, error: mocks.error }),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh' } }),
}))
vi.mock('simplebar-react', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
})
Object.defineProperty(window, 'matchMedia', {
  value: () => ({
    matches: false,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
  }),
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.clearAllMocks()
  mocks.list.mockResolvedValue([gateway])
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

async function renderPage() {
  await act(async () => root.render(<GatewayPage />))
  await act(async () => {
    await Promise.resolve()
  })
}

it('shows the outlet address, bound provider/key and the local key', async () => {
  await renderPage()

  const text = container.textContent ?? ''
  expect(text).toContain('Work')
  expect(text).toContain('DeepSeek / main')
  expect(text).toContain('http://127.0.0.1:22345')
  expect(text).toContain('session-abcd')
})

it('toggles a gateway through gateway.update', async () => {
  await renderPage()
  mocks.update.mockResolvedValue({ ...gateway, isActive: false })

  const toggle = container.querySelector('button[role="switch"]') as HTMLButtonElement | null
  expect(toggle).not.toBeNull()
  await act(async () => toggle?.click())
  await act(async () => {
    await Promise.resolve()
  })

  expect(mocks.update).toHaveBeenCalledWith(gateway.sessionToken, { isActive: false })
})

it('shows an empty state when there are no gateways', async () => {
  mocks.list.mockResolvedValue([])
  await renderPage()

  expect(container.textContent).toContain('gateway.empty')
})
