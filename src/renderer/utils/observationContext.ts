import type { RequestLogFilter, RequestLogSource, StatsTimeRange } from '@shared/types'

type RequestLogOutcome = NonNullable<RequestLogFilter['outcome']>

export interface ObservationContext {
  timeRange: StatsTimeRange
  filter: RequestLogFilter
  page: number
  pageSize: number
}

const ranges = new Set([
  'today',
  'yesterday',
  'week',
  'last30Days',
  'lastYear',
  'month',
  'lastMonth',
  'year',
  'all',
])
export const observationOutcomes: RequestLogOutcome[] = [
  'success',
  'failed',
  'client_error',
  'upstream_error',
  'transport_error',
]
export const observationSources: RequestLogSource[] = [
  'proxy',
  'antigravity_desktop',
  'antigravity_cli',
]

/** Antigravity rows carry their own TTFT / generation split instead of proxy latency. */
export function isAntigravitySource(source: string | null | undefined): boolean {
  return source === 'antigravity_desktop' || source === 'antigravity_cli'
}
const allowed = new Set([
  'timeRange',
  'startDate',
  'endDate',
  'providerId',
  'apiKeyId',
  'instanceId',
  'outcome',
  'population',
  'source',
  'page',
  'pageSize',
  'requestId',
  'requestDate',
])
const resourceKeys = ['providerId', 'apiKeyId', 'instanceId'] as const

export function isObservationId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value)
}

export function isLocalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T12:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

export function requestLocalDate(timestamp: string): string | undefined {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return undefined
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function parseObservationContext(search: string) {
  const params = new URLSearchParams(search)
  let invalid = false
  for (const key of params.keys()) {
    if (!allowed.has(key) || params.getAll(key).length !== 1) invalid = true
  }
  let timeRange: StatsTimeRange = 'week'
  const rawRange = params.get('timeRange')
  if (rawRange !== null) {
    const custom = /^custom:(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/.exec(rawRange)
    if (
      ranges.has(rawRange) ||
      (custom && isLocalDate(custom[1]) && isLocalDate(custom[2]) && custom[1] <= custom[2])
    ) {
      timeRange = rawRange as StatsTimeRange
    } else invalid = true
  }
  const startDate = params.get('startDate')
  const endDate = params.get('endDate')
  if (startDate !== null || endDate !== null) {
    if (
      startDate &&
      endDate &&
      isLocalDate(startDate) &&
      isLocalDate(endDate) &&
      startDate <= endDate
    ) {
      const custom = `custom:${startDate}:${endDate}` as const
      if (rawRange !== null && rawRange !== custom) invalid = true
      else timeRange = custom
    } else invalid = true
  }
  const filter: RequestLogFilter = {}
  for (const key of resourceKeys) {
    const value = params.get(key)
    if (value === null) continue
    if (!isObservationId(value)) invalid = true
    else filter[key] = value
  }
  const outcome = params.get('outcome')
  if (outcome !== null) {
    if (observationOutcomes.includes(outcome as RequestLogOutcome))
      filter.outcome = outcome as RequestLogOutcome
    else invalid = true
  }
  const population = params.get('population')
  if (population !== null) {
    if (population === 'all' || population === 'with_usage') filter.population = population
    else invalid = true
  }
  const source = params.get('source')
  if (source !== null) {
    if (observationSources.includes(source as RequestLogSource))
      filter.source = source as RequestLogSource
    else invalid = true
  }
  const number = (key: string, fallback: number, max: number) => {
    const raw = params.get(key)
    if (raw === null) return fallback
    const value = Number(raw)
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(value) || value > max) {
      invalid = true
      return fallback
    }
    return value
  }
  const page = number('page', 1, Number.MAX_SAFE_INTEGER)
  const pageSize = number('pageSize', 10, 100)
  const requestId = params.get('requestId') ?? undefined
  const requestDate = params.get('requestDate') ?? undefined
  if (requestId !== undefined && !isObservationId(requestId)) invalid = true
  if (requestDate !== undefined && !isLocalDate(requestDate)) invalid = true
  return {
    context: { timeRange, filter, page, pageSize } satisfies ObservationContext,
    // Invalid queries never become a request lookup or an all-records query.
    requestId: invalid ? undefined : requestId,
    requestDate: invalid ? undefined : requestDate,
    invalid,
  }
}

/** Whitelist serialization; never forward raw query strings or location state. */
export function observationSearch(context: Partial<ObservationContext> = {}): string {
  const params = new URLSearchParams()
  params.set('timeRange', context.timeRange ?? 'week')
  for (const key of resourceKeys) {
    if (context.filter?.[key] !== undefined) params.set(key, context.filter[key])
  }
  if (context.filter?.outcome) params.set('outcome', context.filter.outcome)
  if (context.filter?.population) params.set('population', context.filter.population)
  if (context.filter?.source) params.set('source', context.filter.source)
  params.set('page', String(context.page ?? 1))
  params.set('pageSize', String(context.pageSize ?? 10))
  const result = params.toString()
  if (parseObservationContext(result).invalid) throw new Error('Invalid observation context')
  return result
}

export function buildStatisticsUrl(context: Partial<ObservationContext> = {}): string {
  return `/stats?${observationSearch(context)}`
}

export function buildConsoleUrl(
  context: Partial<ObservationContext>,
  requestId: string,
  requestDate?: string,
): string {
  if (!isObservationId(requestId) || (requestDate !== undefined && !isLocalDate(requestDate))) {
    throw new Error('Invalid request locator')
  }
  const params = new URLSearchParams(observationSearch(context))
  params.set('requestId', requestId)
  if (requestDate) params.set('requestDate', requestDate)
  return `/console?${params}`
}

export function withObservationOutcome(
  context: ObservationContext,
  outcome?: RequestLogOutcome,
): ObservationContext {
  return {
    ...context,
    page: 1,
    filter: {
      ...context.filter,
      outcome,
      ...(outcome && outcome !== 'success' ? { population: 'all' as const } : {}),
    },
  }
}
