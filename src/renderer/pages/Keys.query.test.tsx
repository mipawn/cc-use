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
      queryScope: 'account',
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

it('keeps the refresh icon as the only provider-level query trigger', async () => {
  mocks.providers[0].walletBalanceScript = 'enabled'
  await withPage(async (container) => {
    // The duplicated "Check quota" link action is gone; the icon above the
    // key grid is the single provider-level manual trigger.
    const queryNowAction = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'providers.queryNow',
    )
    expect(queryNowAction).toBeUndefined()
    expect(container.querySelector('[aria-label="providers.refreshBalance"]')).not.toBeNull()
  })
})

it('refreshes this key from its clickable quota stat', async () => {
  mocks.keys[0].usageScript = 'enabled'
  mocks.keyRefresh.mockImplementation(async () => {
    mocks.keys[0] = {
      ...mocks.keys[0],
      cachedUsage: { remaining: 2, unit: 'USD' } as ApiKey['cachedUsage'],
    }
    return { error: null, isValid: true, invalidMessage: null }
  })
  await withPage(async (container) => {
    const stat = container.querySelector<HTMLButtonElement>('[aria-label="keys.refreshQuota"]')
    expect(stat).not.toBeNull()
    expect(stat!.tagName).toBe('BUTTON')
    // The reload icon is visible even before the first answer, so the manual
    // refresh stays discoverable after a query has rendered a value.
    expect(stat!.querySelector('.anticon-reload')).not.toBeNull()
    // The card had no cached answer yet: the stat invites the manual query.
    expect(stat!.textContent).toContain('providers.queryNow')

    await act(async () => stat!.click())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(mocks.keyRefresh).toHaveBeenCalledWith('key')
    expect(container.textContent).toContain('$2.00')
    // The answered card keeps the reload icon: refreshing a rendered value is
    // still one click away.
    expect(stat!.querySelector('.anticon-reload')).not.toBeNull()
  })
})

it('hides every provider-level account query entry of a per-key provider', async () => {
  mocks.providers[0] = {
    ...mocks.providers[0],
    queryScope: 'key',
    walletBalanceScript: 'enabled',
    cachedUsage: {
      remaining: 9,
      unit: 'USD',
      windows: [{ id: 'rolling', label: 'rolling', usedPercent: 10, resetsAt: null, status: 'ok' }],
    } as Provider['cachedUsage'],
  }
  await withPage(async (container) => {
    // The quota is asked per key, so the provider level offers no configure
    // entry, no refresh icon and no account balance/window block.
    expect(container.textContent).not.toContain('providers.configureQuery')
    expect(container.querySelector('[aria-label="providers.refreshBalance"]')).toBeNull()
    expect(container.querySelectorAll('[role="progressbar"]')).toHaveLength(0)
    expect(container.textContent).not.toContain('$9.00')
  })
})

it('renders all of the key card metering periods from its cached usage', async () => {
  mocks.keys[0] = {
    ...mocks.keys[0],
    usageScript: 'enabled',
    cachedUsage: {
      windows: ['rolling', 'weekly', 'monthly'].map((id) => ({
        id,
        label: id,
        usedPercent: 42,
        resetsAt: null,
        status: 'ok',
      })),
    } as ApiKey['cachedUsage'],
  }
  await withPage(async (container) => {
    for (const period of ['Rolling', 'Weekly', 'Monthly'])
      expect(container.textContent).toContain(`providers.period${period}`)
    expect(container.querySelectorAll('[role="progressbar"]')).toHaveLength(3)
    // A window-only key has no amount, so the stat names what it does have
    // instead of inventing a zero.
    const stat = container.querySelector('[aria-label="keys.refreshQuota"]')
    expect(stat?.textContent).toContain('querySchemes.capabilityWindows')
  })
})
