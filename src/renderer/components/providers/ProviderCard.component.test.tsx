// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Provider, UsageWindow } from '@shared/types'
import ProviderCard from './ProviderCard'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { percent?: string }) =>
      options?.percent === undefined ? key : `${key} ${options.percent}`,
  }),
}))
vi.mock('../../hooks/useAppMessage', () => ({
  useAppMessage: () => ({ success: vi.fn(), error: vi.fn() }),
}))
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: () => ({ globalSettings: { defaultTerminalType: 'terminal' } }),
}))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
Object.defineProperty(window, 'matchMedia', {
  value: () => ({
    matches: false,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
  }),
})
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: { writeText: vi.fn().mockResolvedValue(undefined) },
})

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

/** The shared window-row shape the Go and Command Code templates emit. */
const windowRow = (id: string, usedPercent: number | null): UsageWindow => ({
  id,
  label: id,
  usedPercent,
  resetsAt: null,
  status: null,
})

interface FixtureOptions {
  script?: string | null
  windows?: UsageWindow[]
  groups?: { id: string; label: string; windows: UsageWindow[] }[]
  balance?: number | null
  currency?: string | null
  lastUsageCheckedAt?: string | null
  lastBalanceCheckedAt?: string | null
  refreshing?: boolean
}

async function renderCard(options: FixtureOptions = {}) {
  const provider = {
    id: 'provider-1',
    name: 'Provider',
    baseUrl: 'https://api.example.com',
    icon: null,
    isActive: true,
    walletBalanceScript: options.script ?? null,
    cachedUsage:
      options.windows || options.groups
        ? { windows: options.windows ?? [], groups: options.groups ?? [] }
        : null,
    cachedWalletBalance: options.balance ?? null,
    cachedWalletBalanceCurrency: options.currency ?? null,
    lastUsageCheckedAt: options.lastUsageCheckedAt ?? null,
    lastBalanceCheckedAt: options.lastBalanceCheckedAt ?? null,
  } as unknown as Provider
  await act(async () =>
    root.render(
      <ProviderCard
        provider={provider}
        onEdit={() => {}}
        onDelete={() => {}}
        onRefreshBalance={() => {}}
        refreshing={options.refreshing}
      />,
    ),
  )
}

const balanceBoxes = () => container.querySelectorAll<HTMLElement>('[class*="balanceBox"]')

it('renders neither block for a provider without a query script', async () => {
  await renderCard({ windows: [], refreshing: true })
  expect(balanceBoxes().length).toBe(0)
  expect(container.textContent ?? '').not.toContain('providers.usagePending')
})

it('shows per-block pending placeholders when the query was never checked', async () => {
  await renderCard({ script: 'fetch credits', balance: null })
  const text = container.textContent ?? ''
  expect(balanceBoxes().length).toBe(2)
  expect(balanceBoxes()[0].textContent).toContain('providers.usage')
  expect(balanceBoxes()[1].textContent).toContain('providers.balance')
  expect(text).toContain('providers.usagePending')
  expect(container.querySelectorAll('.anticon-loading').length).toBeGreaterThan(0)
  expect(text).not.toContain('providers.usageWindowUsed')
})

it('keeps the placeholders while a first refresh is in flight', async () => {
  await renderCard({ script: 'fetch credits', refreshing: true })
  const text = container.textContent ?? ''
  expect(balanceBoxes().length).toBe(2)
  expect(text).toContain('providers.usagePending')
})

it('renders cached values without placeholders while refreshing', async () => {
  await renderCard({
    script: 'fetch credits',
    windows: [windowRow('monthly', 0.1), windowRow('rolling', 0.6), windowRow('weekly', 0.3)],
    balance: 12.34,
    currency: 'credits',
    lastUsageCheckedAt: '2026-11-06T00:00:00Z',
    lastBalanceCheckedAt: '2026-11-06T00:00:00Z',
    refreshing: true,
  })
  const text = container.textContent ?? ''
  expect(text).not.toContain('providers.usagePending')
  // It kept its data: balance in the reported unit, windows in reading order.
  expect(text).toContain('12.34 credits')
  const usageText = balanceBoxes()[0].textContent ?? ''
  expect(usageText.indexOf('providers.usageWindowUsed 0.6')).toBeLessThan(
    usageText.indexOf('providers.usageWindowUsed 0.3'),
  )
  expect(usageText.indexOf('providers.usageWindowUsed 0.3')).toBeLessThan(
    usageText.indexOf('providers.usageWindowUsed 0.1'),
  )
})

it('keeps the honest 未返回 row after a completed check without a percentage', async () => {
  await renderCard({
    script: 'fetch credits',
    windows: [windowRow('rolling', null)],
    balance: 5,
    currency: 'credits',
    lastUsageCheckedAt: '2026-11-06T00:00:00Z',
    lastBalanceCheckedAt: '2026-11-06T00:00:00Z',
  })
  const text = container.textContent ?? ''
  expect(text).toContain('providers.usageWindowUnknown')
  expect(text).not.toContain('providers.usagePending')
})

it('hides blocks with no cached value once a check has completed', async () => {
  // After a completed check the cache write is atomic: a missing balance can
  // only mean the script reports no balance (e.g. usage-only), so the block
  // stays hidden instead of spinning forever.
  await renderCard({
    script: 'fetch credits',
    windows: [],
    balance: null,
    lastUsageCheckedAt: '2026-11-06T00:00:00Z',
    lastBalanceCheckedAt: '2026-11-06T00:00:00Z',
  })
  const text = container.textContent ?? ''
  expect(balanceBoxes().length).toBe(0)
  expect(text).not.toContain('providers.usagePending')
})
