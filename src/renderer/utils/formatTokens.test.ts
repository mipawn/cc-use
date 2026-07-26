import { describe, expect, it } from 'vitest'
import { formatExactTokenCount, formatTokenCount, formatTokenCountWithUnit } from './formatTokens'

describe('formatTokenCount', () => {
  it('uses Chinese ten-thousand and hundred-million units', () => {
    expect(formatTokenCount(12_000, 'zh-CN')).toBe('1.2万')
    expect(formatTokenCount(1_230_000, 'zh-CN')).toBe('123万')
    expect(formatTokenCount(150_000_000, 'zh-CN')).toBe('1.5亿')
  })

  it('keeps international K/M/B units for English', () => {
    expect(formatTokenCount(1_230_000, 'en-US')).toBe('1.2M')
    expect(formatTokenCount(1_500_000_000, 'en-US')).toBe('1.5B')
  })

  it('can expose the exact value for tooltips', () => {
    expect(formatExactTokenCount(123_456_789, 'zh-CN')).toBe('123,456,789')
  })

  it('formats trend values with an explicit unit', () => {
    expect(formatTokenCountWithUnit(123_456, 'zh-CN', 'Token')).toBe('12.3万 Token')
    expect(formatTokenCountWithUnit(1_230_000, 'en-US', 'Tokens')).toBe('1.2M Tokens')
  })
})
