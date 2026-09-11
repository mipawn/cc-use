import { describe, expect, it } from 'vitest'
import type { ApiKey, Provider, UsageWindow } from '@shared/types'
import {
  formatAccountAmount,
  formatUsedPercent,
  hasKeyQuery,
  hasProviderQuery,
  orderUsageWindows,
  usageWindowLabel,
  providerQueryMissingCredential,
} from './accountQuery'

const window = (id: string): UsageWindow => ({
  id,
  label: id,
  usedPercent: 0,
  resetsAt: null,
  status: null,
})

describe('account query presentation', () => {
  it('waits for a usable key but supports independent account credentials', () => {
    const provider = { id: 'p', walletBalanceScript: '{{apiKey}}', token: null } as Provider
    const key = { providerId: 'p', value: 'fixture', isActive: true, isExhausted: false } as ApiKey
    expect(providerQueryMissingCredential(provider, [])).toBe('providers.queryNeedsKey')
    expect(providerQueryMissingCredential(provider, [{ ...key, isExhausted: true }])).toBe(
      'providers.queryNeedsKey',
    )
    expect(providerQueryMissingCredential(provider, [{ ...key, isActive: false }])).toBe(
      'providers.queryNeedsKey',
    )
    expect(providerQueryMissingCredential(provider, [key])).toBeNull()
    expect(
      providerQueryMissingCredential(
        { ...provider, walletBalanceScript: '{{accessToken}}', token: 'fixture' },
        [],
      ),
    ).toBeNull()
  })
  it('keeps a disabled key query hidden even if its legacy type is custom', () => {
    const key = { usageScript: '', usageType: 'custom' }
    expect(hasKeyQuery(key)).toBe(false)
    expect(hasKeyQuery({ usageScript: null })).toBe(false)
    expect(hasKeyQuery({ usageScript: 'query' })).toBe(true)
  })
  it('enables a provider query based on its script even when its legacy type is none', () => {
    const provider = { walletBalanceScript: 'query', walletBalanceType: 'none' }
    expect(hasProviderQuery(provider)).toBe(true)
    expect(hasProviderQuery({ walletBalanceScript: '  ' })).toBe(false)
  })
  it('preserves zero and the reported currency', () => {
    expect(formatAccountAmount(0, 'CNY')).toBe('¥0.00')
    expect(formatAccountAmount(2, 'USD')).toBe('$2.00')
    expect(formatAccountAmount(2, null)).toBe('2.00')
    expect(formatAccountAmount(null)).toBe('—')
  })
  it('localizes cached Go labels without requiring another query', () => {
    const t = (key: string) => ({ 'providers.periodWeekly': '每周' })[key] ?? key
    expect(
      usageWindowLabel(
        { id: 'weekly', label: 'Weekly', usedPercent: 10, resetsAt: null, status: null },
        t,
      ),
    ).toBe('每周')
    expect(
      usageWindowLabel(
        { id: 'other', label: '自定义周期', usedPercent: null, resetsAt: null, status: null },
        t,
      ),
    ).toBe('自定义周期')
  })

  it('lists the periods shortest first, whoever ordered them', () => {
    const shuffled = [window('monthly'), window('rolling'), window('weekly')]

    expect(orderUsageWindows(shuffled).map((entry) => entry.id)).toEqual([
      'rolling',
      'weekly',
      'monthly',
    ])
    // The list handed in is the cached one; ordering it must not reorder that.
    expect(shuffled.map((entry) => entry.id)).toEqual(['monthly', 'rolling', 'weekly'])
  })

  it('keeps a period this build does not name after the ones it does', () => {
    const ordered = orderUsageWindows([
      window('rolling'),
      window('daily'),
      window('weekly'),
      window('hourly'),
    ])

    expect(ordered.map((entry) => entry.id)).toEqual(['rolling', 'weekly', 'daily', 'hourly'])
  })

  it('prints the percentage the provider sent instead of rounding it to whole numbers', () => {
    expect(formatUsedPercent(0.3)).toBe('0.3')
    expect(formatUsedPercent(0.6)).toBe('0.6')
    expect(formatUsedPercent(0)).toBe('0')
    expect(formatUsedPercent(32)).toBe('32')
    expect(formatUsedPercent(33.3333)).toBe('33.33')
  })
})
