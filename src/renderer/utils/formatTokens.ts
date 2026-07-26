function compact(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '')
}

export function formatTokenCount(value: number, language: string): string {
  if (language.toLowerCase().startsWith('zh')) {
    if (value >= 100_000_000) return `${compact(value / 100_000_000)}亿`
    if (value >= 10_000) return `${compact(value / 10_000)}万`
    return value.toLocaleString('zh-CN')
  }

  if (value >= 1_000_000_000) return `${compact(value / 1_000_000_000)}B`
  if (value >= 1_000_000) return `${compact(value / 1_000_000)}M`
  if (value >= 1_000) return `${compact(value / 1_000)}K`
  return value.toLocaleString('en-US')
}

export function formatExactTokenCount(value: number, language: string): string {
  return value.toLocaleString(language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US')
}

export function formatTokenCountWithUnit(value: number, language: string, unit: string): string {
  return `${formatTokenCount(value, language)} ${unit}`
}
