export type UsageMetric = 'tokens' | 'cost'

const STORAGE_KEY = 'usageMetric'

export function getInitialUsageMetric(): UsageMetric {
  return localStorage.getItem(STORAGE_KEY) === 'cost' ? 'cost' : 'tokens'
}

export function saveUsageMetric(metric: UsageMetric): void {
  localStorage.setItem(STORAGE_KEY, metric)
}
