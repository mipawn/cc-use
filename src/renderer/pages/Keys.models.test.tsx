// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiKey, Provider } from '@shared/types'
import type { ClientCatalog } from '../utils/modelMapping'
import { clearModelCatalogQueryCache } from '../hooks/useModelCatalogQuery'
import Keys, { computeProviderReorder } from './Keys'
import ProviderModelModal from '../components/providers/ProviderModelModal'
import { useProviderStore } from '../stores/providerStore'
import { useApiKeyStore } from '../stores/apiKeyStore'
import { useClientProfileStore } from '../stores/clientProfileStore'
import { useProviderModelCatalogStore } from '../stores/providerModelCatalogStore'

const mocks = vi.hoisted(() => ({
  providers: [] as Provider[],
  keys: [] as ApiKey[],
  catalogPreview: vi.fn(),
  getCatalog: vi.fn(),
  saveCatalog: vi.fn(),
  updateKey: vi.fn(),
  getResourceStatistics: vi.fn(),
  getQueryPreference: vi.fn(async () => null as string | null),
  saveQueryPreference: vi.fn(async () => {}),
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}))

const catalog: ClientCatalog = {
  models: [
    { id: 'cloud-model-a', displayName: '' },
    { id: 'cloud-model-b', displayName: '' },
  ],
  fromCache: false,
  fetchedAt: '2026-10-28T00:00:00Z',
}

vi.mock('../api', () => ({
  getApi: () => ({
    provider: {
      list: async () => mocks.providers,
      get: async () => mocks.providers[0],
      create: async (input: unknown) => input,
      modelCatalogPreview: mocks.catalogPreview,
      queryModels: mocks.catalogPreview,
      getModelCatalog: mocks.getCatalog,
      saveModelCatalog: mocks.saveCatalog,
    },
    apiKey: {
      list: async () => mocks.keys,
      update: mocks.updateKey,
      create: async (input: ApiKey) => input,
      retiredMappingReport: async () => [],
    },
    clientProfile: {
      list: async () => [],
    },
    gateway: {
      list: async () => [],
    },
    keyUsage: { refresh: async () => ({ error: null, isValid: true }) },
    balance: {
      refresh: async () => ({ balance: null, isValid: true, error: null }),
      checkScript: async () => ({ url: '', method: 'GET', headers: {} }),
      schemes: async () => [],
      testDraft: async () => ({
        scope: 'key',
        usage: null,
        isValid: false,
        invalidMessage: null,
        error: null,
      }),
    },
    requestLog: {
      getProviderGatewayMetrics: async () => [],
      getKeyTokenStats: async () => [],
      getResourceStatistics: mocks.getResourceStatistics,
    },
    userAgent: {
      list: async () => [],
      save: async (value: string) => [value],
      delete: async () => [],
      getQueryPreference: mocks.getQueryPreference,
      saveQueryPreference: mocks.saveQueryPreference,
    },
    terminal: {
      getLaunchPreview: async () => ({ cliType: 'claude_code', command: 'claude', env: {} }),
    },
  }),
}))

vi.mock('../hooks/useAppMessage', () => ({ useAppMessage: () => mocks }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh' } }),
}))
vi.mock('../components/providers/ProviderModal', () => ({ default: () => null }))
vi.mock('../components/usage/ResourceUsageModal', () => ({
  default: ({
    open,
    scope,
  }: {
    open: boolean
    scope?: { providerId: string; apiKeyId?: string }
  }) => {
    if (open && scope) mocks.getResourceStatistics('week', scope.providerId, scope.apiKeyId)
    return null
  },
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

const provider = (overrides: Partial<Provider> = {}): Provider =>
  ({
    id: 'provider-1',
    name: 'Provider One',
    baseUrl: 'https://provider.example/v1',
    httpProxy: null,
    website: null,
    remark: null,
    token: null,
    icon: null,
    walletBalanceType: 'none',
    walletBalanceUrl: null,
    walletBalancePath: null,
    walletBalanceHeaders: null,
    walletBalanceUserId: null,
    cachedWalletBalance: null,
    cachedWalletBalanceCurrency: null,
    lastBalanceCheckedAt: null,
    usageType: 'none',
    usageUrl: null,
    usagePath: null,
    usageHeaders: null,
    cachedUsage: null,
    lastUsageCheckedAt: null,
    isActive: true,
    sortOrder: 0,
    presetId: 'custom',
    defaultKeyConfig: null,
    requestAdapter: 'none',
    walletBalanceScript: null,
    requestHeaders: null,
    queryScope: 'account',
    ...overrides,
  }) as Provider

const key = (overrides: Partial<ApiKey> = {}): ApiKey =>
  ({
    id: 'key-1',
    providerId: 'provider-1',
    alias: 'daily key',
    value: 'sk-key-credential',
    types: ['claude_code'],
    priority: 1,
    isExhausted: false,
    isActive: true,
    usageType: 'none',
    usageScript: null,
    usageUrl: null,
    usagePath: null,
    usageHeaders: null,
    cachedUsage: null,
    lastUsageCheckedAt: null,
    modelMapping: null,
    cooldownUntil: null,
    lastErrorAt: null,
    lastErrorKind: null,
    consecutiveErrors: 0,
    ...overrides,
  }) as ApiKey

vi.setConfig({ testTimeout: 30_000 })

beforeEach(() => {
  vi.clearAllMocks()
  clearModelCatalogQueryCache()
  mocks.getQueryPreference.mockResolvedValue(null)
  mocks.catalogPreview.mockResolvedValue(catalog)
  mocks.getCatalog.mockResolvedValue({ models: [], revision: 0, updatedAt: null })
  mocks.saveCatalog.mockImplementation(async (_id, models, revision) => ({
    models,
    revision: revision + 1,
    updatedAt: null,
  }))
  useProviderModelCatalogStore.setState({ catalogs: {}, loading: {}, errors: {}, requests: {} })
  mocks.providers = [provider()]
  mocks.keys = [key()]
  useProviderStore.setState({ providers: [], loading: false })
  useApiKeyStore.setState({ apiKeys: {}, loading: {} })
  useClientProfileStore.setState({ profiles: [], loading: false })
  document.body.innerHTML = ''
})

const flush = async (times = 3) => {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

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
    await flush()
    await check(container)
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
}

const buttonByText = (text: string, scope: ParentNode = document.body) =>
  Array.from(scope.querySelectorAll('button')).find((node) => node.textContent?.trim() === text) as
    | HTMLButtonElement
    | undefined

async function clickTab(label: string) {
  const tab = Array.from(document.body.querySelectorAll('[role="tab"]')).find((el) =>
    el.textContent?.includes(label),
  ) as HTMLElement | undefined
  expect(tab).toBeDefined()
  await act(async () => tab!.click())
  await flush()
}

async function clickButton(text: string) {
  const button = buttonByText(text)
  expect(button).toBeDefined()
  await act(async () => button!.click())
  await flush()
}

describe('Keys workspace model catalog & provider management', () => {
  it('reorders provider ids cleanly', () => {
    expect(computeProviderReorder(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b'])
    expect(computeProviderReorder(['a', 'b'], 'missing', 'a')).toBeNull()
  })

  it('opens embedded provider model catalog tab and queries only on explicit action', async () => {
    await withPage(async () => {
      await clickTab('keysWorkspace.tabCatalog')
      expect(document.body.textContent).toContain('keys.providerModelList')
      expect(mocks.catalogPreview).not.toHaveBeenCalled()
      await clickButton('keys.catalogLoad')
      expect(mocks.catalogPreview).toHaveBeenCalledTimes(1)
      expect(mocks.catalogPreview.mock.calls[0][0]).toEqual({
        providerId: 'provider-1',
        apiKeyId: 'key-1',
        connectionConfig: { baseUrl: null, authScheme: 'bearer', userAgent: null },
      })
      expect(document.body.textContent).toContain('cloud-model-a')
    })
  })

  it('saves checked models from the embedded catalog tab and updates revision', async () => {
    await withPage(async () => {
      await clickTab('keysWorkspace.tabCatalog')
      await clickButton('keys.catalogLoad')
      const checkbox = document.body.querySelector<HTMLInputElement>(
        'input[aria-label="cloud-model-a"]',
      )!
      await act(async () => checkbox.click())
      await flush()
      await clickButton('keys.catalogSave')
      expect(mocks.saveCatalog).toHaveBeenCalledWith(
        'provider-1',
        [{ id: 'cloud-model-a', displayName: 'cloud-model-a' }],
        0,
      )
      expect(mocks.success).toHaveBeenCalledWith('keys.catalogSaved')
    })
  })

  it('hands the selected provider id to the resource usage modal', async () => {
    await withPage(async (container) => {
      const statsBtn = Array.from(container.querySelectorAll('header button')).find((btn) =>
        btn.textContent?.includes('statistics.title'),
      ) as HTMLButtonElement | undefined
      expect(statsBtn).toBeDefined()
      await act(async () => statsBtn!.click())
      await flush()
      expect(mocks.getResourceStatistics).toHaveBeenCalledWith('week', 'provider-1', undefined)
    })
  })

  it('blocks modal cancellation while ProviderModelModal save is in flight', async () => {
    let finishSave!: () => void
    mocks.saveCatalog.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSave = () => resolve({ models: [], revision: 1, updatedAt: null })
        }),
    )
    const onClose = vi.fn()
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    try {
      await act(async () => {
        root.render(<ProviderModelModal provider={provider()} apiKeys={[key()]} onClose={onClose} />)
      })
      await flush()
      await clickButton('keys.catalogSave')
      const cancel = buttonByText('common.cancel')!
      expect(cancel.disabled).toBe(true)
      await act(async () => finishSave())
      await flush()
      expect(onClose).toHaveBeenCalledTimes(1)
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })
})
