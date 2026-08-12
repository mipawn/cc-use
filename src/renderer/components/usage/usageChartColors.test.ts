import { describe, expect, it } from 'vitest'
import usageChartColors from './usageChartColors'

describe('usageChartColors', () => {
  it('keeps input and cache token series visually distinct', () => {
    expect(usageChartColors.cacheRead).not.toBe(usageChartColors.input)
    expect(usageChartColors.cacheCreation).not.toBe(usageChartColors.input)
  })
})
