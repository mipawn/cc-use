import { describe, expect, it } from 'vitest'
import en from './en'
import zh from './zh'

describe('usage chart locales', () => {
  it('defines every chart control in both supported languages', () => {
    for (const locale of [zh, en]) {
      expect(locale.statistics.legendToggleHint).toBeTruthy()
      expect(locale.statistics.lastYear).toBeTruthy()
      expect(locale.statistics.year).toBeTruthy()
      expect(locale.statistics.dailyModelUsage).toBeTruthy()
      expect(locale.statistics.granularity.week).toBeTruthy()
      expect(locale.usageDetail.granularityHint).toBeTruthy()
      expect(locale.usageDetail.firstTokenLatency).toBeTruthy()
      expect(locale.usageDetail.usageTrend).toBeTruthy()
      expect(locale.usageDetail.qualityTrend).toBeTruthy()
    }
  })

  it('keeps the Chinese chart controls translated instead of exposing i18n keys', () => {
    expect(zh.usageDetail.firstTokenLatency).toBe('首 Token 延迟')
    expect(zh.usageDetail.usageTrend).toBe('Token 构成')
    expect(zh.usageDetail.qualityTrend).toBe('线路质量')
    expect(zh.statistics.lastYear).toBe('近一年')
    expect(zh.statistics.year).toBe('本年')
    expect(zh.statistics.week).toBe('近一周')
    expect(zh.statistics.last30Days).toBe('近一月')
  })
})
