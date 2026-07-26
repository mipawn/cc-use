// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { getInitialUsageMetric, saveUsageMetric } from './usageMetric'

const storage = new Map<string, string>()

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    clear: () => storage.clear(),
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  },
})

describe('usage metric preference', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('defaults to tokens', () => {
    expect(getInitialUsageMetric()).toBe('tokens')
  })

  it('persists an explicit cost preference', () => {
    saveUsageMetric('cost')
    expect(getInitialUsageMetric()).toBe('cost')
  })

  it('falls back to tokens for an unknown saved value', () => {
    localStorage.setItem('usageMetric', 'requests')
    expect(getInitialUsageMetric()).toBe('tokens')
  })
})
