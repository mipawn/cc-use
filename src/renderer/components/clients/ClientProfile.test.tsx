// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiKey, ClientProfile, Provider } from '@shared/types'
import { useClientProfileStore } from '../../stores/clientProfileStore'
import ClientProfileCard from './ClientProfileCard'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  reorder: vi.fn(),
}))

vi.mock('../../api', () => ({
  getApi: () => ({
    clientProfile: mocks,
  }),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh' } }),
}))

Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
})

const provider: Provider = {
  id: 'p1',
  name: 'OpenCode Go',
  baseUrl: 'https://go.example/v1',
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
  responsesRectifier: false,
  walletBalanceScript: null,
  requestHeaders: null,
  queryConfig: null,
  queryScope: 'key',
}

const keys: ApiKey[] = [
  {
    id: 'k1',
    providerId: 'p1',
    alias: 'Account A',
    value: 'sk-a',
    types: ['claude_code'],
    priority: 0,
    isExhausted: false,
    isActive: true,
    usageType: 'none',
    usageUrl: null,
    usagePath: null,
    usageHeaders: null,
    usageScript: null,
    queryConfig: null,
    cachedUsage: { unit: 'USD', remaining: 12.5 },
    lastUsageCheckedAt: null,
    modelMapping: null,
    cooldownUntil: null,
    lastErrorAt: null,
    lastErrorKind: null,
    consecutiveErrors: 0,
  },
  {
    id: 'k2',
    providerId: 'p1',
    alias: 'Account B',
    value: 'sk-b',
    types: ['claude_code'],
    priority: 1,
    isExhausted: false,
    isActive: true,
    usageType: 'none',
    usageUrl: null,
    usagePath: null,
    usageHeaders: null,
    usageScript: null,
    queryConfig: null,
    cachedUsage: { unit: 'USD', remaining: 50 },
    lastUsageCheckedAt: null,
    modelMapping: null,
    cooldownUntil: null,
    lastErrorAt: null,
    lastErrorKind: null,
    consecutiveErrors: 0,
  },
]

const sampleProfile: ClientProfile = {
  id: 'prof-1',
  name: 'Main Coding',
  clientKind: 'claude_code',
  providerId: 'p1',
  apiKeyId: 'k1',
  isDefault: true,
  sortOrder: 0,
  modelConfig: JSON.stringify({
    version: 2,
    clients: {
      claude_code: {
        catalog: { mode: 'provider' },
        upstream: { mode: 'fixed', model: 'glm-5' },
      },
    },
  }),
  connectionConfig: null,
  launchEnv: { ANTHROPIC_MODEL: 'claude-sonnet-5' },
  createdAt: '2026-11-22 00:00:00',
  updatedAt: '2026-11-22 00:00:00',
}

beforeEach(() => {
  vi.clearAllMocks()
  useClientProfileStore.setState({ profiles: [], loading: false })
  document.body.innerHTML = ''
})

describe('clientProfileStore', () => {
  it('fetches, updates default flags, and removes profiles consistently', async () => {
    const second: ClientProfile = {
      ...sampleProfile,
      id: 'prof-2',
      name: 'Fast Draft',
      isDefault: false,
    }
    mocks.list.mockResolvedValue([sampleProfile, second])
    await useClientProfileStore.getState().fetchProfiles('claude_code')
    expect(useClientProfileStore.getState().profiles).toHaveLength(2)

    mocks.update.mockResolvedValue({ ...second, isDefault: true })
    await useClientProfileStore.getState().updateProfile({ id: 'prof-2', isDefault: true })
    const afterUpdate = useClientProfileStore.getState().profiles
    expect(afterUpdate.find((p) => p.id === 'prof-1')?.isDefault).toBe(false)
    expect(afterUpdate.find((p) => p.id === 'prof-2')?.isDefault).toBe(true)

    mocks.delete.mockResolvedValue(true)
    await useClientProfileStore.getState().deleteProfile('prof-1')
    expect(useClientProfileStore.getState().profiles.map((p) => p.id)).toEqual(['prof-2'])
  })
})

describe('ClientProfileCard', () => {
  it('renders profile badges, model rewrite summary, env count and edit action', async () => {
    const onEdit = vi.fn()
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    try {
      await act(async () => {
        root.render(
          <ClientProfileCard
            profile={sampleProfile}
            provider={provider}
            apiKey={keys[0]}
            providerKeys={keys}
            catalogCount={3}
            onEdit={onEdit}
            onDuplicate={vi.fn()}
            onDelete={vi.fn()}
            onSwapKey={vi.fn(async () => {})}
          />,
        )
      })
      expect(container.textContent).toContain('Main Coding')
      expect(container.textContent).toContain('OpenCode Go')
      expect(container.textContent).toContain('profiles.cliDefaultBadge')
      expect(container.textContent).toContain('profiles.summaryRewriteFixed')
      expect(container.textContent).toContain('profiles.summaryEnvCount')

      const editBtn = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('common.edit'),
      )!
      await act(async () => editBtn.click())
      expect(onEdit).toHaveBeenCalledWith(sampleProfile)
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })
})
