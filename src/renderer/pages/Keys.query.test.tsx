// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiKey, Provider } from '@shared/types'
import Keys from './Keys'
import { useProviderStore } from '../stores/providerStore'
import { useApiKeyStore } from '../stores/apiKeyStore'
import { useClientProfileStore } from '../stores/clientProfileStore'
import { useProviderModelCatalogStore } from '../stores/providerModelCatalogStore'

const mocks = vi.hoisted(() => ({
  keyRefresh: vi.fn(),
  providerRefresh: vi.fn(),
  keyUpdate: vi.fn(),
  keyCreate: vi.fn(),
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
      getModelCatalog: async () => ({ models: [], revision: 0, updatedAt: null }),
    },
    apiKey: {
      list: async () => mocks.keys,
      update: mocks.keyUpdate,
      create: mocks.keyCreate,
    },
    clientProfile: {
      list: async () => [],
    },
    gateway: {
      list: async () => [],
    },
    keyUsage: { refresh: mocks.keyRefresh },
    balance: { refresh: mocks.providerRefresh },
    requestLog: { getProviderGatewayMetrics: async () => [], getKeyTokenStats: async () => [] },
  }),
}))

vi.mock('../hooks/useAppMessage', () => ({ useAppMessage: () => mocks }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh' } }),
}))
vi.mock('../components/providers/ProviderModal', () => ({ default: () => null }))
vi.mock('../components/usage/ResourceUsageModal', () => ({ default: () => null }))
vi.mock('../components/keys/KeySimpleModal', () => ({
  default: ({ open, apiKey, onUpdate, onAfterSave, onClose }: any) =>
    open && apiKey ? (
      <button
        onClick={async () => {
          const saved = await onUpdate({
            id: apiKey.id,
            alias: apiKey.alias,
            value: apiKey.value,
            usageScript: 'enabled',
            queryConfig: { enabled: true, schemeId: 'custom' },
          })
          onAfterSave?.(saved, apiKey)
          onClose()
        }}
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
      queryScope: 'key',
    },
  ] as Provider[]
  mocks.keys = [
    {
      id: 'key',
      providerId: 'go',
      alias: 'test-key',
      value: 'fixture',
      types: ['claude_code'],
      isActive: true,
      isExhausted: false,
      usageScript: null,
    },
  ] as ApiKey[]
  useProviderStore.setState({ providers: [], loading: false })
  useApiKeyStore.setState({ apiKeys: {}, loading: {} })
  useClientProfileStore.setState({ profiles: [], loading: false })
  useProviderModelCatalogStore.setState({ catalogs: {}, loading: {}, errors: {} })
})

async function withPage(check: (container: HTMLDivElement) => Promise<void>) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <Keys />
        </MemoryRouter>,
      )
    })
    await check(container)
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
}

describe('Keys workspace quota queries', () => {
  it('queries after enabling and saving a key quota script, then renders persisted balance', async () => {
    mocks.keyUpdate.mockImplementation(
      async () =>
        (mocks.keys[0] = {
          ...mocks.keys[0],
          usageScript: 'enabled',
          queryConfig: { enabled: true, schemeId: 'custom' },
        }),
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

  it('renders account-scope multi-window periods after refreshing provider balance', async () => {
    mocks.providers[0] = {
      ...mocks.providers[0],
      queryScope: 'account',
      walletBalanceScript: 'enabled',
      queryConfig: { enabled: true, schemeId: 'custom' },
    }
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
      const refreshBtn = [...container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('common.refresh'),
      )!
      await act(async () => refreshBtn.click())
      for (const period of ['Rolling', 'Weekly', 'Monthly']) {
        expect(container.textContent).toContain(`providers.period${period}`)
      }
      expect(container.querySelectorAll('[role="progressbar"]')).toHaveLength(3)
    })
  })
})
