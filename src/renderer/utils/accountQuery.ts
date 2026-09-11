import type { ApiKey, Provider, UsageWindow } from '@shared/types'

export const hasProviderQuery = (provider: Pick<Provider, 'walletBalanceScript'>) =>
  Boolean(provider.walletBalanceScript?.trim())

export const hasKeyQuery = (key: Pick<ApiKey, 'usageScript'>) => Boolean(key.usageScript?.trim())

export function providerQueryMissingCredential(provider: Provider, keys: ApiKey[]): string | null {
  const script = provider.walletBalanceScript ?? ''
  if (
    script.includes('{{apiKey}}') &&
    !provider.token?.trim() &&
    !keys.some(
      (key) =>
        key.providerId === provider.id && key.isActive && !key.isExhausted && key.value.trim(),
    )
  ) {
    return 'providers.queryNeedsKey'
  }
  if (script.includes('{{accessToken}}') && !provider.token?.trim())
    return 'providers.queryNeedsToken'
  if (script.includes('{{userId}}') && !provider.walletBalanceUserId?.trim())
    return 'providers.queryNeedsUserId'
  return null
}

export function formatAccountAmount(value: number | null | undefined, currency?: string | null) {
  if (value == null) return '—'
  const amount = value.toFixed(2)
  if (currency === 'USD') return `$${amount}`
  if (currency === 'CNY') return `¥${amount}`
  return currency ? `${amount} ${currency}` : amount
}

/** The periods this build names, in the order a person reads them: shortest first. */
const KNOWN_PERIODS = [
  { id: 'rolling', label: 'providers.periodRolling' },
  { id: 'weekly', label: 'providers.periodWeekly' },
  { id: 'monthly', label: 'providers.periodMonthly' },
]

export function usageWindowLabel(window: UsageWindow, t: (key: string) => string) {
  const known = KNOWN_PERIODS.find((period) => period.id === window.id)
  return known ? t(known.label) : window.label
}

/**
 * The periods in that same reading order.
 *
 * Shortest first is the provider's own order (5h → 每周 → 每月), not whatever
 * order a script emitted: the response's key order does not survive the JSON
 * round trip into the script, so a Go card came out 每月 / 5 小时 / 每周 —
 * alphabetical, unlike both the dashboard and the labels. A period this build
 * does not name keeps the script's order, after the ones it does.
 */
export function orderUsageWindows(windows: UsageWindow[]): UsageWindow[] {
  const rank = (id: string) => {
    const index = KNOWN_PERIODS.findIndex((period) => period.id === id)
    return index === -1 ? KNOWN_PERIODS.length : index
  }
  return windows
    .map((window, index) => ({ window, index }))
    .sort((a, b) => rank(a.window.id) - rank(b.window.id) || a.index - b.index)
    .map((entry) => entry.window)
}

/**
 * A percentage as the provider stated it.
 *
 * Whole numbers are not the provider's number: `toFixed(0)` turned a reported
 * 0.6% into 1%, and 0.3% into 0% — a figure nobody ever sent.
 */
export function formatUsedPercent(percent: number): string {
  return String(Number(percent.toFixed(2)))
}
