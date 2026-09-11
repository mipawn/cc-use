import { describe, expect, it } from 'vitest'
import {
  formatAccountAmount,
  hasKeyQuery,
  hasProviderQuery,
  usageWindowLabel,
} from './accountQuery'

describe('account query presentation', () => {
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
})
