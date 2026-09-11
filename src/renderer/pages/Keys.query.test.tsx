// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, expect, it, vi } from 'vitest'
import type { ApiKey, Provider } from '@shared/types'
import Keys from './Keys'
import { useProviderStore } from '../stores/providerStore'
import { useApiKeyStore } from '../stores/apiKeyStore'

const mocks = vi.hoisted(() => ({
  keyRefresh: vi.fn(),
  providerRefresh: vi.fn(),
  keyUpdate: vi.fn(),
  providerCreate: vi.fn(),
  warning: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  providers: [] as Provider[],
  keys: [] as ApiKey[],
}))
vi.mock('../api', () => ({
  getApi: () => ({
    provider: {
      list: async () => mocks.providers,
      get: async () => mocks.providers[0],
      create: mocks.providerCreate,
    },
    apiKey: { list: async () => mocks.keys, update: mocks.keyUpdate },
    keyUsage: { refresh: mocks.keyRefresh },
    balance: { refresh: mocks.providerRefresh },
    requestLog: { getProviderGatewayMetrics: async () => [], getKeyTokenStats: async () => [] },
  }),
}))
vi.mock('../hooks/useServiceStatus', () => ({
  useServiceStatus: () => ({ status: { isRunning: false } }),
}))
vi.mock('../stores/settingsStore', () => ({
  useSettingsStore: () => ({ globalSettings: { defaultTerminalType: 'iterm2' } }),
}))
vi.mock('../hooks/useAppMessage', () => ({ useAppMessage: () => mocks }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh' } }),
}))
vi.mock('../components/providers/ProviderModal', () => ({
  default: ({ open, onSave }: any) =>
    open ? (
      <button
        onClick={() =>
          onSave({
            name: 'new provider',
            baseUrl: 'https://example.com',
            walletBalanceScript: '{{apiKey}}',
          })
        }
      >
        save-provider
      </button>
    ) : null,
}))
vi.mock('../components/usage/ResourceUsageModal', () => ({ default: () => null }))
vi.mock('../components/keys/KeyEditModal', () => ({
  default: ({ open, apiKey, onSave }: any) =>
    open ? (
      <button
        onClick={() =>
          onSave({
            mode: 'edit',
            id: apiKey.id,
            providerId: apiKey.providerId,
            types: ['claude_code'],
            usageScript: 'enabled',
          })
        }
      >
        save-query
      </button>
    ) : null,
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

beforeEach(() => {
  vi.clearAllMocks()
  mocks.providers = [
    {
      id: 'go',
      name: 'Go',
      baseUrl: 'https://example.com',
      isActive: true,
      walletBalanceScript: null,
    },
  ] as Provider[]
  mocks.keys = [
    {
      id: 'key',
      providerId: 'go',
      alias: 'test-key',
      value: 'fixture',
      types: ['claude_code'],
      usageScript: null,
    },
  ] as ApiKey[]
  useProviderStore.setState({ providers: [], loading: false })
  useApiKeyStore.setState({ apiKeys: {}, loading: {} })
})

async function withPage(check: (container: HTMLDivElement) => Promise<void>) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(<Keys />)
    })
    await check(container)
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
}

it('shows a configuration entry for an unconfigured provider and no refresh for a disabled key', async () => {
  await withPage(async (container) => {
    expect(container.textContent).toContain('providers.configureQuery')
    expect(container.querySelector('[aria-label="keys.refreshQuota"]')).toBeNull()
    expect(mocks.keyRefresh).not.toHaveBeenCalled()
  })
})

it('queries after enabling and saving a key, then renders the persisted balance', async () => {
  mocks.keyUpdate.mockImplementation(
    async () => (mocks.keys[0] = { ...mocks.keys[0], usageScript: 'enabled' }),
  )
  mocks.keyRefresh.mockImplementation(async () => {
    mocks.keys[0] = {
      ...mocks.keys[0],
      cachedUsage: { remaining: 0, unit: 'CNY' } as ApiKey['cachedUsage'],
    }
    return { error: null, isValid: true }
  })
  await withPage(async (container) => {
    const edit = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('common.edit'),
    )!
    await act(async () => edit.click())
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === 'save-query')!
        .click(),
    )
    expect(mocks.keyRefresh).toHaveBeenCalledWith('key')
    expect(container.textContent).toContain('¥0.00')
  })
})

it('renders all Go periods after a manual query with no monetary balance', async () => {
  mocks.providers[0].walletBalanceScript = 'enabled'
  mocks.providerRefresh.mockImplementation(async () => {
    mocks.providers[0] = {
      ...mocks.providers[0],
      cachedUsage: {
        windows: ['rolling', 'weekly', 'monthly'].map((id) => ({
          id,
          label: id,
          usedPercent: 42,
          resetsAt: null,
          status: 'ok',
        })),
      } as Provider['cachedUsage'],
    }
    return { balance: null, isValid: true, error: null }
  })
  await withPage(async (container) => {
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="providers.refreshBalance"]')!
        .click(),
    )
    for (const period of ['Rolling', 'Weekly', 'Monthly'])
      expect(container.textContent).toContain(`providers.period${period}`)
    expect(container.querySelectorAll('[role="progressbar"]')).toHaveLength(3)
  })
})

it('saves a new provider without querying and explains the missing key', async () => {
  mocks.keys = []
  mocks.providerCreate.mockImplementation(async () => {
    const provider = { ...mocks.providers[0], walletBalanceScript: '{{apiKey}}' }
    mocks.providers = [provider]
    return provider
  })
  await withPage(async (container) => {
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent?.includes('providers.addProvider'))!
        .click(),
    )
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === 'save-provider')!
        .click(),
    )
    expect(mocks.providerCreate).toHaveBeenCalledOnce()
    expect(mocks.providerRefresh).not.toHaveBeenCalled()
    expect(container.textContent).toContain('providers.queryNeedsKey')
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="providers.refreshBalance"]')!
        .disabled,
    ).toBe(true)
  })
})
