import type { ApiKey, Provider, UsageWindow } from '@shared/types'

export const hasProviderQuery = (provider: Pick<Provider, 'walletBalanceScript'>) =>
  Boolean(provider.walletBalanceScript?.trim())

export const hasKeyQuery = (key: Pick<ApiKey, 'usageScript'>) => Boolean(key.usageScript?.trim())

export function formatAccountAmount(value: number | null | undefined, currency?: string | null) {
  if (value == null) return '—'
  const amount = value.toFixed(2)
  if (currency === 'USD') return `$${amount}`
  if (currency === 'CNY') return `¥${amount}`
  return currency ? `${amount} ${currency}` : amount
}

export function usageWindowLabel(window: UsageWindow, t: (key: string) => string) {
  const known: Record<string, string> = {
    rolling: 'providers.periodRolling',
    weekly: 'providers.periodWeekly',
    monthly: 'providers.periodMonthly',
  }
  return known[window.id] ? t(known[window.id]) : window.label
}
