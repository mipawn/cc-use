import { describe, expect, it } from 'vitest'
import en from './en'
import zh from './zh'

describe('usage chart locales', () => {
  it('defines every chart control in both supported languages', () => {
    for (const locale of [zh, en]) {
      expect(locale.statistics.chartSampledHint).toBeTruthy()
      expect(locale.statistics.legendToggleHint).toBeTruthy()
      expect(locale.usageDetail.firstTokenLatency).toBeTruthy()
      expect(locale.usageDetail.usageTrend).toBeTruthy()
      expect(locale.usageDetail.qualityTrend).toBeTruthy()
    }
  })

  it('keeps the Chinese chart controls translated instead of exposing i18n keys', () => {
    expect(zh.usageDetail.firstTokenLatency).toBe('首 Token 延迟')
    expect(zh.usageDetail.usageTrend).toBe('Token 构成')
    expect(zh.usageDetail.qualityTrend).toBe('线路质量')
  })
})
