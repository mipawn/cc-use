import type {
  DailyTrendItem,
  RequestLogFilter,
  StatsTimeRange,
  UsageStatistics,
  ResourceUsageStatistics,
} from '@shared/types'
import type { LedgerRow } from './fixtureData'
import { localDay } from './fixtureSupport'

export const totalTokens = (row: LedgerRow) =>
  row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheCreationTokens
const dayOf = (row: LedgerRow) => localDay(new Date(`${row.createdAt.replace(' ', 'T')}Z`))
const ledgerSource = (row: LedgerRow) => row.source ?? 'proxy'
const isAntigravityRow = (row: LedgerRow) => ledgerSource(row) !== 'proxy'
const dateKey = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('[fixture] Invalid date range')
  const date = new Date(`${value}T12:00:00`)
  if (!Number.isFinite(date.getTime()) || localDay(date) !== value)
    throw new Error('[fixture] Invalid date range')
  return value
}
export function rangeBounds(range: StatsTimeRange, now: Date): [string, string] {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const end = new Date(start)
  if (range.startsWith('custom:')) {
    const parts = range.split(':')
    if (parts.length !== 3) throw new Error('[fixture] Invalid custom range')
    const from = dateKey(parts[1])
    const to = dateKey(parts[2])
    if (from > to) throw new Error('[fixture] Inverted date range')
    return [from, to]
  }
  switch (range) {
    case 'today':
      break
    case 'yesterday':
      start.setDate(start.getDate() - 1)
      end.setDate(end.getDate() - 1)
      break
    case 'week':
      start.setDate(start.getDate() - 6)
      break
    case 'last30Days':
      start.setDate(start.getDate() - 29)
      break
    case 'lastYear':
      start.setFullYear(start.getFullYear() - 1)
      break
    case 'month':
      start.setDate(1)
      break
    case 'lastMonth':
      start.setDate(1)
      start.setMonth(start.getMonth() - 1)
      end.setDate(0)
      break
    case 'year':
      start.setMonth(0, 1)
      break
    case 'all':
      return ['0000-01-01', '9999-12-31']
    default:
      throw new Error('[fixture] Invalid time range')
  }
  return [localDay(start), localDay(end)]
}
export function filterLedger(
  rows: LedgerRow[],
  range: StatsTimeRange,
  now: Date,
  filter: RequestLogFilter = {},
): LedgerRow[] {
  const allowed = ['providerId', 'apiKeyId', 'instanceId', 'outcome', 'population', 'source']
  if (Object.keys(filter).some((key) => !allowed.includes(key)))
    throw new Error('[fixture] Unknown ledger filter')
  if (
    filter.outcome &&
    !['success', 'failed', 'client_error', 'upstream_error', 'transport_error'].includes(
      filter.outcome,
    )
  )
    throw new Error('[fixture] Invalid outcome')
  if (filter.population && !['all', 'with_usage'].includes(filter.population))
    throw new Error('[fixture] Invalid population')
  if (filter.source && !['proxy', 'antigravity_desktop', 'antigravity_cli'].includes(filter.source))
    throw new Error('[fixture] Invalid ledger source')
  const [from, to] = rangeBounds(range, now)
  return rows.filter((row) => {
    const day = dayOf(row)
    return (
      day >= from &&
      day <= to &&
      (!filter.providerId || row.providerId === filter.providerId) &&
      (!filter.apiKeyId || row.apiKeyId === filter.apiKeyId) &&
      (!filter.instanceId || row.instanceId === filter.instanceId) &&
      (!filter.source || ledgerSource(row) === filter.source) &&
      (!filter.outcome ||
        (filter.outcome === 'failed'
          ? row.outcome !== null && row.outcome !== 'success'
          : row.outcome === filter.outcome)) &&
      (filter.population !== 'with_usage' || totalTokens(row) > 0)
    )
  })
}
function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const id = key(item)
    groups.set(id, [...(groups.get(id) ?? []), item])
  }
  return groups
}
const sum = (
  rows: LedgerRow[],
  key: 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheCreationTokens',
) => rows.reduce((n, row) => n + row[key], 0)
const average = (
  rows: LedgerRow[],
  key: 'latencyMs' | 'firstTokenMs' | 'outputTokensPerSecond',
) => {
  const values = rows.map((row) => row[key]).filter((value): value is number => value !== null)
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
}
export function statistics(rows: LedgerRow[]): UsageStatistics {
  const totalInputTokens = sum(rows, 'inputTokens')
  const totalOutputTokens = sum(rows, 'outputTokens')
  const totalCacheReadTokens = sum(rows, 'cacheReadTokens')
  const totalCacheCreationTokens = sum(rows, 'cacheCreationTokens')
  const denominator = totalInputTokens + totalCacheReadTokens + totalCacheCreationTokens
  // Proxy latency and Antigravity generation time are different measurements;
  // a mixed billable scope reports no averages, matching the SQL rule.
  const billable = rows.filter((row) => totalTokens(row) > 0)
  const performanceMixedSources =
    billable.some((row) => !isAntigravityRow(row)) && billable.some((row) => isAntigravityRow(row))
  return {
    summary: {
      totalRequests: rows.filter((row) => totalTokens(row) > 0).length,
      // A failed generation that carried tokens is counted as both billable and
      // failed: the two counts overlap, which is exactly the SQL summary rule.
      failedRequests: rows.filter((row) => row.outcome !== null && row.outcome !== 'success')
        .length,
      totalInputTokens,
      totalOutputTokens,
      totalCacheReadTokens,
      totalCacheCreationTokens,
      totalTokens: denominator + totalOutputTokens,
      cacheHitRate: denominator ? totalCacheReadTokens / denominator : 0,
      avgLatencyMs: performanceMixedSources ? null : average(rows, 'latencyMs'),
      avgFirstTokenMs: performanceMixedSources ? null : average(rows, 'firstTokenMs'),
      avgOutputTokensPerSecond: performanceMixedSources
        ? null
        : average(rows, 'outputTokensPerSecond'),
      performanceMixedSources,
    },
    dailyModelUsage: [...groupBy(rows, (row) => `${dayOf(row)}|${row.model}`).values()]
      .map((group) => ({
        date: dayOf(group[0]),
        model: group[0].model ?? 'unknown',
        tokens: group.reduce((n, row) => n + totalTokens(row), 0),
      }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    keyUsage: [...groupBy(rows, (row) => row.apiKeyId).entries()].map(([id, group]) => ({
      id,
      name: group[0].keyAlias ?? id,
      detail: group[0].providerName ?? '',
      tokens: group.reduce((n, row) => n + totalTokens(row), 0),
      requests: group.filter((row) => totalTokens(row) > 0).length,
    })),
    projectUsage: [],
    trendGranularity: 'day',
  }
}
export function dailyTrend(rows: LedgerRow[]): DailyTrendItem[] {
  return [...groupBy(rows, dayOf).entries()]
    .map(([date, group]) => ({
      date,
      tokens: group.reduce((n, row) => n + totalTokens(row), 0),
      requests: group.filter((row) => totalTokens(row) > 0).length,
      inputTokens: sum(group, 'inputTokens'),
      outputTokens: sum(group, 'outputTokens'),
      cacheReadTokens: sum(group, 'cacheReadTokens'),
      cacheCreationTokens: sum(group, 'cacheCreationTokens'),
    }))
    .sort((a, b) => a.date.localeCompare(b.date))
}
export function resourceStatistics(rows: LedgerRow[]): ResourceUsageStatistics {
  const summary = (group: LedgerRow[]) => {
    const stats = statistics(group).summary
    const successfulRequests = group.filter((row) => row.outcome === 'success').length
    return {
      totalTokens: stats.totalTokens,
      totalRequests: group.length,
      successfulRequests,
      failedRequests: stats.failedRequests,
      successRate: group.length ? successfulRequests / group.length : 0,
      cacheHitRate: stats.cacheHitRate,
      avgLatencyMs: stats.avgLatencyMs,
      avgFirstTokenMs: stats.avgFirstTokenMs,
      avgOutputTokensPerSecond: stats.avgOutputTokensPerSecond,
    }
  }
  return {
    summary: summary(rows),
    trendGranularity: 'day',
    dailyTrend: dailyTrend(rows).map((day) => ({
      ...day,
      ...summary(rows.filter((row) => dayOf(row) === day.date)),
      requests: rows.filter((row) => dayOf(row) === day.date).length,
    })),
  }
}
