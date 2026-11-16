import { describe, expect, it } from 'vitest'
import {
  buildConsoleUrl,
  buildStatisticsUrl,
  parseObservationContext,
  requestLocalDate,
  withObservationOutcome,
} from './observationContext'
import type { ObservationContext } from './observationContext'
import { observationEn, observationZh } from '../locales/observation'

const context: ObservationContext = {
  timeRange: 'custom:2026-09-10:2026-09-11',
  filter: {
    providerId: 'provider-1',
    apiKeyId: 'key-2',
    instanceId: 'instance-3',
    population: 'with_usage',
  },
  page: 3,
  pageSize: 20,
}

describe('observation URL contracts', () => {
  it('roundtrips date, stable resource IDs, population and pagination through Console', () => {
    const consoleUrl = buildConsoleUrl(context, 'request-4', '2026-09-11')
    const parsed = parseObservationContext(consoleUrl.split('?')[1])
    expect(parsed).toEqual({
      context,
      requestId: 'request-4',
      requestDate: '2026-09-11',
      invalid: false,
    })
    expect(buildStatisticsUrl(parsed.context)).toBe(buildStatisticsUrl(context))
  })

  it('keeps resource/date scope and cancels the usage restriction when choosing failures', () => {
    const failed = withObservationOutcome(context, 'failed')
    expect(failed).toEqual({
      ...context,
      page: 1,
      filter: { ...context.filter, outcome: 'failed', population: 'all' },
    })
    const all = withObservationOutcome(failed)
    expect(all.filter.population).toBe('all')
    expect(parseObservationContext(buildStatisticsUrl(all).split('?')[1]).context).toEqual(all)
  })

  it('accepts legacy local start/end dates without losing the filter', () => {
    expect(
      parseObservationContext('?startDate=2026-02-28&endDate=2026-03-01&apiKeyId=key-1'),
    ).toMatchObject({
      invalid: false,
      context: { timeRange: 'custom:2026-02-28:2026-03-01', filter: { apiKeyId: 'key-1' } },
    })
  })

  it.each([
    'timeRange=custom:2026-02-30:2026-03-01',
    'timeRange=custom:2026-03-01:2026-02-28',
    'timeRange=other',
    'startDate=2026-01-01',
    'timeRange=week&startDate=2026-01-01&endDate=2026-01-01',
    'providerId=',
    'providerId=p&providerId=q',
    'instanceId=/private/client',
    'outcome=unknown',
    'population=unknown',
    'page=0',
    'page=-1',
    'page=9007199254740992',
    'pageSize=101',
    'pageSize=1.2',
    'requestDate=2026-02-29',
    'requestId=%0Asecret',
    'sessionToken=private-route-token',
    'session_id=private-route-token',
    'client=claude_code',
  ])('rejects malformed scope without exposing a lookup: %s', (query) => {
    const parsed = parseObservationContext(query)
    expect(parsed.invalid).toBe(true)
    expect(parsed.requestId).toBeUndefined()
    expect(parsed.requestDate).toBeUndefined()
  })

  it('serializes only allowed keys and errors without echoing secret input', () => {
    const unsafe = {
      ...context,
      sessionToken: 'private-route-token',
      filter: { ...context.filter, sessionId: 'private-route-token' },
    }
    expect(buildStatisticsUrl(unsafe)).not.toContain('private-route-token')
    expect(() => buildConsoleUrl(context, 'private/route/token')).toThrow('Invalid request locator')
    expect(() => buildStatisticsUrl({ filter: { instanceId: 'private/route/token' } })).toThrow(
      'Invalid observation context',
    )
  })

  it('derives request dates in the local calendar and ignores invalid timestamps', () => {
    const local = new Date(2026, 8, 11, 0, 30)
    expect(requestLocalDate(local.toISOString())).toBe('2026-09-11')
    expect(requestLocalDate('not a timestamp')).toBeUndefined()
  })
})

it('ships matching, non-empty observation locale leaves and interpolation names', () => {
  function compare(zh: Record<string, unknown>, en: Record<string, unknown>) {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    for (const [key, value] of Object.entries(zh)) {
      if (typeof value === 'string') {
        expect(en[key]).toEqual(expect.any(String))
        expect(en[key]).toBeTruthy()
        expect((en[key] as string).match(/\{\{\w+\}\}/g)).toEqual(value.match(/\{\{\w+\}\}/g))
      } else compare(value as Record<string, unknown>, en[key] as Record<string, unknown>)
    }
  }
  compare(observationZh, observationEn)
})
