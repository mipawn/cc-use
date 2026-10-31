// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, expect, it, vi } from 'vitest'
import type { ApiKey, Provider } from '@shared/types'
import type { ClientCatalog } from '../utils/modelMapping'
import { clearModelCatalogQueryCache } from '../hooks/useModelCatalogQuery'
import Keys from './Keys'
import { useProviderStore } from '../stores/providerStore'
import { useApiKeyStore } from '../stores/apiKeyStore'
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
    keyUsage: { refresh: async () => ({ error: null, isValid: true }) },
    balance: {
      refresh: async () => ({ balance: null, isValid: true, error: null }),
      checkScript: async () => ({ url: '', method: 'GET', headers: {} }),
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
vi.mock('../components/providers/ProviderModal', () => ({ default: () => null }))
// The modal internals (refresh/error states, T22 second half) are covered by
// ResourceUsageModal's own tests; this container test only proves the Keys page
// hands it the clicked provider's real providerId.
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
    clientConfigs: {
      claude_code: { baseUrl: 'https://key.example/anthropic', authScheme: 'bearer' },
    },
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
  document.body.innerHTML = ''
})

const flush = async (times = 3) => {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

/** Poll for a condition so parallel test files do not turn slow renders into flakes. */
async function waitFor(check: () => boolean, timeout = 8000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (check()) return
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
  }
  expect(check()).toBe(true)
}

async function withPage(check: (container: HTMLDivElement) => Promise<void>) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(<Keys />)
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

const itemByText = (text: string) =>
  Array.from(
    document.body.querySelectorAll('.ant-dropdown-menu-item, .ant-dropdown-menu-submenu-title'),
  ).find((node) => node.textContent?.includes(text)) as HTMLElement | undefined

async function clickMenu(text: string) {
  await waitFor(() => Boolean(itemByText(text)))
  await act(async () => {
    itemByText(text)!.click()
  })
  await flush()
}

async function openProviderMenu() {
  await waitFor(() => Boolean(document.body.querySelector('[aria-label="common.more"]')))
  await act(async () => {
    document.body.querySelector<HTMLButtonElement>('[aria-label="common.more"]')!.click()
  })
  await waitFor(() => Boolean(itemByText('usageDetail.openProvider')))
}

async function clickButton(text: string) {
  const button = buttonByText(text)
  expect(button).toBeDefined()
  await act(async () => button!.click())
  await flush()
}
async function fill(selector: string, value: string) {
  const input = document.body.querySelector<HTMLInputElement>(selector)!
  expect(input).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
}
async function openModels() {
  await openProviderMenu()
  await clickMenu('keys.viewModels')
  await flush()
}

it('opens independent provider model management and queries only on explicit action', async () => {
  await withPage(async () => {
    await openModels()
    expect(document.body.textContent).toContain('keys.viewModels')
    expect(document.body.querySelector('input[type="password"]')).toBeNull()
    expect(mocks.catalogPreview).not.toHaveBeenCalled()
    await clickButton('keys.catalogLoad')
    expect(mocks.catalogPreview).toHaveBeenCalledTimes(1)
    expect(mocks.catalogPreview.mock.calls[0][0]).toEqual({
      providerId: 'provider-1',
      apiKeyId: 'key-1',
      connectionConfig: { baseUrl: null, authScheme: 'bearer', userAgent: null },
    })
    expect(document.body.textContent).toContain('cloud-model-a')
    expect(
      document.body.querySelector<HTMLInputElement>('input[aria-label="cloud-model-a"]')!.checked,
    ).toBe(false)
    expect(mocks.saveCatalog).not.toHaveBeenCalled()
    expect(mocks.updateKey).not.toHaveBeenCalled()
  })
})

it('does not inherit any client connection or guess a clientKind for multi-client keys', async () => {
  mocks.keys = [key({ types: ['claude_code', 'codex'] })]
  await withPage(async () => {
    await openModels()
    expect(document.body.textContent).toContain('https://provider.example/v1')
    await clickButton('keys.catalogLoad')
    const input = mocks.catalogPreview.mock.calls[0][0]
    expect(input).not.toHaveProperty('clientKind')
    expect(input).not.toHaveProperty('clientConfigs')
    expect(input).not.toHaveProperty('keyValue')
    expect(input.connectionConfig).toEqual({ baseUrl: null, authScheme: 'bearer', userAgent: null })
  })
})

it('chooses among saved keys inside the model window', async () => {
  mocks.keys = [key(), key({ id: 'key-2', alias: 'backup key' })]
  await withPage(async () => {
    await openModels()
    expect(itemByText('backup key')).toBeUndefined()
    expect(buttonByText('keys.catalogLoad')!.disabled).toBe(true)
    const combo = document.body.querySelector('[aria-label="keys.queryKey"]')!
    await act(async () =>
      combo.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', keyCode: 40, bubbles: true }),
      ),
    )
    await flush()
    const option = [...document.body.querySelectorAll<HTMLElement>('.ant-select-item-option')].find(
      (item) => item.textContent?.includes('backup key'),
    )!
    await act(async () => option.click())
    await clickButton('keys.catalogLoad')
    expect(mocks.catalogPreview.mock.calls[0][0].apiKeyId).toBe('key-2')
  })
})

it('allows manual model management without any saved Key', async () => {
  mocks.keys = []
  await withPage(async () => {
    await openModels()
    expect(buttonByText('keys.catalogLoad')!.disabled).toBe(true)
    await clickButton('keys.manualAddModel')
    await fill('input[aria-label="keys.clientModelId"]', 'manual-id')
    await fill('input[aria-label="keys.clientModelName"]', 'Manual name')
    await clickButton('keys.clientModelAdd')
    await clickButton('keys.catalogSave')
    expect(mocks.saveCatalog).toHaveBeenCalledWith(
      'provider-1',
      [{ id: 'manual-id', displayName: 'Manual name' }],
      0,
    )
    expect(mocks.catalogPreview).not.toHaveBeenCalled()
    expect(mocks.updateKey).not.toHaveBeenCalled()
  })
})

it('keeps query parameters local and cancellation leaves the saved catalog unchanged', async () => {
  await withPage(async () => {
    await openModels()
    await act(async () => {
      const details = document.body.querySelector<HTMLDetailsElement>('details')!
      details.querySelector('summary')!.click()
      details.querySelector<HTMLDetailsElement>('details')!.querySelector('summary')!.click()
    })
    await fill('input[aria-label="gateway.baseUrl"]', 'https://query.example/v1')
    await fill('input[aria-label="User-Agent"]', 'query-agent')
    await clickButton('keys.catalogLoad')
    expect(mocks.catalogPreview.mock.calls[0][0].connectionConfig).toEqual({
      baseUrl: 'https://query.example/v1',
      authScheme: 'bearer',
      userAgent: 'query-agent',
    })
    await act(async () =>
      document.body.querySelector<HTMLInputElement>('input[aria-label="cloud-model-a"]')!.click(),
    )
    await clickButton('common.cancel')
    expect(mocks.saveCatalog).not.toHaveBeenCalled()
    expect(mocks.updateKey).not.toHaveBeenCalled()
    expect(mocks.saveQueryPreference).not.toHaveBeenCalled()
  })
})

it('saves only checked models at the read revision and publishes the saved snapshot', async () => {
  mocks.getCatalog.mockResolvedValue({
    models: [{ id: 'old-id', displayName: 'Old' }],
    revision: 4,
    updatedAt: null,
  })
  await withPage(async () => {
    await openModels()
    await clickButton('keys.catalogLoad')
    await act(async () =>
      document.body.querySelector<HTMLInputElement>('input[aria-label="cloud-model-b"]')!.click(),
    )
    await clickButton('keys.catalogSave')
    expect(mocks.saveCatalog).toHaveBeenCalledWith(
      'provider-1',
      [
        { id: 'old-id', displayName: 'Old' },
        { id: 'cloud-model-b', displayName: 'cloud-model-b' },
      ],
      4,
    )
    expect(useProviderModelCatalogStore.getState().catalogs['provider-1'].models).toHaveLength(2)
    expect(mocks.updateKey).not.toHaveBeenCalled()
  })
})

it('preserves selection and gives an explicit reload action when revision save conflicts', async () => {
  mocks.saveCatalog.mockRejectedValue('revision conflict')
  await withPage(async () => {
    await openModels()
    await clickButton('keys.manualAddModel')
    await fill('input[aria-label="keys.clientModelId"]', 'draft-id')
    await clickButton('keys.clientModelAdd')
    await clickButton('keys.catalogSave')
    expect(document.body.textContent).toContain('keys.catalogSaveConflict')
    expect(
      document.body.querySelector<HTMLInputElement>('input[aria-label="draft-id"]')!.checked,
    ).toBe(true)
    expect(buttonByText('keys.catalogReload')).toBeDefined()
  })
})

it('hands the clicked provider id to the resource usage query on first open', async () => {
  await withPage(async () => {
    await openProviderMenu()
    await clickMenu('usageDetail.openProvider')

    expect(mocks.getResourceStatistics).toHaveBeenCalled()
    expect(mocks.getResourceStatistics.mock.calls[0][1]).toBe('provider-1')
  })
})

it('blocks cancellation until an explicit catalog save finishes', async () => {
  let resolveSave!: (value: { models: never[]; revision: number; updatedAt: null }) => void
  mocks.saveCatalog.mockReturnValue(
    new Promise((resolve) => {
      resolveSave = resolve
    }),
  )
  mocks.getCatalog.mockResolvedValue({
    models: [{ id: 'busy-model', displayName: 'Busy model', supports1m: true }],
    revision: 0,
    updatedAt: null,
  })
  await withPage(async () => {
    await openModels()
    await clickButton('keys.catalogSave')
    expect(buttonByText('common.cancel')!.disabled).toBe(true)
    expect(document.body.querySelector('.ant-modal-close')).toBeNull()
    expect(buttonByText('keys.manualAddModel')!.disabled).toBe(true)
    expect(buttonByText('keys.selectAllModels')!.disabled).toBe(true)
    expect(buttonByText('keys.clearModels')!.disabled).toBe(true)
    expect(
      document.body.querySelector<HTMLInputElement>('input[aria-label="busy-model"]')!.disabled,
    ).toBe(true)
    expect(
      document.body.querySelector<HTMLInputElement>(
        'input[aria-label="busy-model keys.supports1m"]',
      )!.disabled,
    ).toBe(true)
    expect(
      document.body.querySelector<HTMLButtonElement>(
        'button[aria-label="busy-model keys.renameModel"]',
      )!.disabled,
    ).toBe(true)
    expect(
      document.body.querySelector<HTMLButtonElement>(
        'button[aria-label="busy-model common.delete"]',
      )!.disabled,
    ).toBe(true)
    await act(async () => resolveSave({ models: [], revision: 1, updatedAt: null }))
    await flush()
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })
})

it('persists outer rename, remove, manual add and 1M changes, then saves and reopens an empty list', async () => {
  mocks.getCatalog.mockResolvedValue({
    models: [
      { id: 'rename-me', displayName: 'Old label' },
      { id: 'remove-me', displayName: 'Remove' },
    ],
    revision: 7,
    updatedAt: null,
  })
  await withPage(async () => {
    await openModels()
    await act(async () =>
      document.body
        .querySelector<HTMLButtonElement>('button[aria-label="rename-me keys.renameModel"]')!
        .click(),
    )
    await fill('input[aria-label="rename-me keys.clientModelName"]', 'New label')
    await act(async () =>
      document.body
        .querySelector<HTMLInputElement>('input[aria-label="rename-me keys.supports1m"]')!
        .click(),
    )
    await act(async () =>
      document.body
        .querySelector<HTMLButtonElement>('button[aria-label="remove-me common.delete"]')!
        .click(),
    )
    await clickButton('keys.manualAddModel')
    await fill('input[aria-label="keys.clientModelId"]', 'manual-model')
    await fill('input[aria-label="keys.clientModelName"]', 'Manual label')
    await clickButton('keys.clientModelAdd')
    await clickButton('keys.catalogSave')
    const models = [
      { id: 'rename-me', displayName: 'New label', supports1m: true },
      { id: 'manual-model', displayName: 'Manual label' },
    ]
    expect(mocks.saveCatalog).toHaveBeenLastCalledWith('provider-1', models, 7)
    expect(mocks.updateKey).not.toHaveBeenCalled()
    mocks.getCatalog.mockResolvedValue({ models, revision: 8, updatedAt: null })
    await openModels()
    expect(document.body.textContent).toContain('New label')
    expect(
      document.body.querySelector<HTMLInputElement>(
        'input[aria-label="rename-me keys.supports1m"]',
      )!.checked,
    ).toBe(true)
    expect(document.body.querySelector('input[aria-label="remove-me"]')).toBeNull()
    await clickButton('keys.clearModels')
    await clickButton('keys.catalogSave')
    expect(mocks.saveCatalog).toHaveBeenLastCalledWith('provider-1', [], 8)
    mocks.getCatalog.mockResolvedValue({ models: [], revision: 9, updatedAt: null })
    await openModels()
    expect(document.body.textContent).toContain('keys.noMatchingModels')
    expect(useProviderModelCatalogStore.getState().catalogs['provider-1'].models).toEqual([])
    expect(mocks.updateKey).not.toHaveBeenCalled()
  })
})

it('keeps a separately saved provider catalog after a selected Key draft is cancelled', async () => {
  await withPage(async () => {
    await openModels()
    await clickButton('keys.manualAddModel')
    await fill('input[aria-label="keys.clientModelId"]', 'provider-persisted')
    await clickButton('keys.clientModelAdd')
    await clickButton('keys.catalogSave')
    await clickButton('common.edit')
    const tab = Array.from(document.body.querySelectorAll<HTMLElement>('.ant-tabs-tab')).find(
      (node) => node.textContent?.includes('keys.modelConfiguration'),
    )!
    await act(async () => tab.click())
    const header = Array.from(
      document.body.querySelectorAll<HTMLElement>('.ant-collapse-header'),
    ).find((node) => node.textContent?.includes('Claude Code'))!
    if (header.getAttribute('aria-expanded') !== 'true') await act(async () => header.click())
    const select = document.body
      .querySelector('[aria-label="Claude Code keys.clientModelSelection"]')!
      .closest('.ant-select')!
    await act(async () =>
      select
        .querySelector('input[role="combobox"]')!
        .dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowDown', keyCode: 40, bubbles: true }),
        ),
    )
    const option = Array.from(
      document.body.querySelectorAll<HTMLElement>('.ant-select-item-option'),
    ).find((node) => node.textContent?.includes('provider-persisted'))!
    expect(option).toBeDefined()
    await act(async () => option.click())
    // Responsive tags collapse in jsdom's zero-width layout; verify the real option state.
    expect(option.classList.contains('ant-select-item-option-selected')).toBe(true)
    await clickButton('common.cancel')
    expect(mocks.updateKey).not.toHaveBeenCalled()
    expect(mocks.saveCatalog).toHaveBeenCalledOnce()
    expect(useProviderModelCatalogStore.getState().catalogs['provider-1'].models).toEqual([
      { id: 'provider-persisted', displayName: 'provider-persisted' },
    ])
  })
})

it('locks pending manual and rename inputs while saving and restores the same draft after failure', async () => {
  let rejectSave!: (reason: Error) => void
  mocks.saveCatalog.mockReturnValue(
    new Promise((_resolve, reject) => {
      rejectSave = reject
    }),
  )
  mocks.getCatalog.mockResolvedValue({
    models: [{ id: 'busy-model', displayName: 'Before' }],
    revision: 2,
    updatedAt: null,
  })
  await withPage(async () => {
    await openModels()
    await clickButton('keys.manualAddModel')
    await fill('input[aria-label="keys.clientModelId"]', 'pending-manual')
    await fill('input[aria-label="keys.clientModelName"]', 'Pending label')
    await act(async () =>
      document.body
        .querySelector<HTMLButtonElement>('button[aria-label="busy-model keys.renameModel"]')!
        .click(),
    )
    await fill('input[aria-label="busy-model keys.clientModelName"]', 'Changed draft')
    await clickButton('keys.catalogSave')
    for (const label of [
      'busy-model keys.clientModelName',
      'keys.clientModelId',
      'keys.clientModelName',
    ]) {
      expect(
        document.body.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!.disabled,
      ).toBe(true)
    }
    expect(buttonByText('keys.clientModelAdd')!.disabled).toBe(true)
    expect(
      document.body.querySelector<HTMLInputElement>('input[aria-label="keys.searchModels"]')!
        .disabled,
    ).toBe(false)
    await act(async () => rejectSave(new Error('save unavailable')))
    await flush()
    for (const label of [
      'busy-model keys.clientModelName',
      'keys.clientModelId',
      'keys.clientModelName',
    ]) {
      expect(
        document.body.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!.disabled,
      ).toBe(false)
    }
    expect(
      document.body.querySelector<HTMLInputElement>(
        'input[aria-label="busy-model keys.clientModelName"]',
      )!.value,
    ).toBe('Changed draft')
    expect(
      document.body.querySelector<HTMLInputElement>('input[aria-label="keys.clientModelId"]')!
        .value,
    ).toBe('pending-manual')
    expect(buttonByText('keys.clientModelAdd')!.disabled).toBe(false)
    expect(
      document.body.querySelector<HTMLButtonElement>(
        'button[aria-label="busy-model common.delete"]',
      )!.disabled,
    ).toBe(false)
    expect(mocks.saveCatalog).toHaveBeenCalledOnce()
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
  })
})

it('retains checked and manual drafts through empty results and failed query refreshes', async () => {
  await withPage(async () => {
    await openModels()
    await clickButton('keys.catalogLoad')
    await act(async () =>
      document.body.querySelector<HTMLInputElement>('input[aria-label="cloud-model-a"]')!.click(),
    )
    mocks.catalogPreview.mockResolvedValueOnce({ ...catalog, models: [] })
    await clickButton('keys.catalogRefresh')
    expect(
      document.body.querySelector<HTMLInputElement>('input[aria-label="cloud-model-a"]')!.checked,
    ).toBe(true)
    await clickButton('keys.manualAddModel')
    await fill('input[aria-label="keys.clientModelId"]', 'manual-kept')
    await clickButton('keys.clientModelAdd')
    mocks.catalogPreview.mockRejectedValueOnce('query unavailable')
    await clickButton('keys.catalogRefresh')
    expect(document.body.textContent).toContain('query unavailable')
    expect(
      document.body.querySelector<HTMLInputElement>('input[aria-label="cloud-model-a"]')!.checked,
    ).toBe(true)
    expect(
      document.body.querySelector<HTMLInputElement>('input[aria-label="manual-kept"]')!.checked,
    ).toBe(true)
    expect(mocks.saveCatalog).not.toHaveBeenCalled()
  })
})
