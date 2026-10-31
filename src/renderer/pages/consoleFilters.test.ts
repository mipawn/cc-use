import { describe, expect, it } from 'vitest'
import type { ConsoleLogEvent, ConsoleRequestEvent } from '@shared/types'
import {
  classifyRequestResult,
  eventRowKey,
  formatLocalDateTime,
  formatLocalTime,
  matchesQuery,
  parseClearResult,
  projectLogEvent,
  projectRequestEvent,
} from './Console'

function request(overrides: Partial<ConsoleRequestEvent> = {}): ConsoleRequestEvent {
  return {
    category: 'request',
    requestId: 'req-1',
    timestamp: '2026-09-11 10:00:00',
    method: 'POST',
    path: '/v1/messages',
    status: 200,
    latencyMs: 120,
    upstream: 'https://upstream.example.com/v1/messages',
    provider: 'Example',
    keyAlias: 'daily',
    kind: 'ok',
    model: 'deepseek-v4-flash',
    ...overrides,
  }
}

function log(overrides: Partial<ConsoleLogEvent> = {}): ConsoleLogEvent {
  return {
    category: 'log',
    id: 'log-1',
    timestamp: '2026-09-11 10:00:00',
    level: 'info',
    source: 'daemon',
    target: 'cc_use_daemon::runtime',
    message: 'ready',
    ...overrides,
  }
}

/** Format a local wall-clock Date the way the Rust side stores timestamps. */
function utcTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return [
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`,
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`,
  ].join(' ')
}

describe('console row identity', () => {
  it('keys a request row by its request id, not its position', () => {
    expect(eventRowKey(request())).toBe('req-1')
  })

  it('keys a log row by the id it was created with', () => {
    expect(eventRowKey(log({ id: 'log-abc' }))).toBe('log-abc')
  })

  it('keeps anonymous row identity when older rows leave the bounded window', () => {
    const anonymous = request({ requestId: undefined })
    const key = eventRowKey(anonymous)
    expect(eventRowKey(anonymous)).toBe(key)
    expect(eventRowKey(request({ requestId: undefined }))).not.toBe(key)
  })
})

describe('request result classification', () => {
  it('classifies the terminal kinds the proxy emits', () => {
    expect(classifyRequestResult(request({ kind: 'ok' }))).toBe('ok')
    expect(classifyRequestResult(request({ kind: 'estimated' }))).toBe('estimated')
    expect(classifyRequestResult(request({ kind: 'rejected', status: null }))).toBe('rejected')
    expect(classifyRequestResult(request({ kind: 'cancelled' }))).toBe('cancelled')
    expect(classifyRequestResult(request({ kind: 'upstream_error', status: 502 }))).toBe(
      'upstream_error',
    )
    expect(classifyRequestResult(request({ kind: 'ws', status: 101 }))).toBe('ws')
    expect(classifyRequestResult(request({ kind: 'pending', status: null }))).toBe('pending')
  })

  it('reclassifies a historical ok row that carried a 4xx/5xx status as a failure', () => {
    expect(classifyRequestResult(request({ kind: 'ok', status: 503 }))).toBe('upstream_error')
    expect(classifyRequestResult(request({ kind: 'ok', status: 401 }))).toBe('upstream_error')
    expect(classifyRequestResult(request({ kind: 'ok', status: 200 }))).toBe('ok')
  })

  it('marks rejected, cancelled, upstream errors and HTTP 4xx/5xx as exceptional', () => {
    for (const event of [
      request({ kind: 'upstream_error', status: null }),
      request({ kind: 'rejected', status: null }),
      request({ kind: 'cancelled', status: 200 }),
      request({ kind: 'ok', status: 429 }),
      request({ kind: 'ok', status: 500 }),
    ]) {
      const projection = projectRequestEvent(event)
      expect(projection.exceptional).toBe(true)
      expect(projection.success).toBe(false)
    }
    expect(projectRequestEvent(request()).exceptional).toBe(false)
  })

  it('keeps pending and websocket upgrades out of completed success', () => {
    const pending = projectRequestEvent(request({ kind: 'pending', status: null }))
    expect(pending).toMatchObject({
      result: 'pending',
      exceptional: false,
      completed: false,
      success: false,
      httpClass: 'none',
    })

    const websocket = projectRequestEvent(request({ kind: 'ws', status: 101 }))
    expect(websocket).toMatchObject({
      result: 'ws',
      exceptional: false,
      completed: false,
      success: false,
      httpClass: 'other',
    })

    expect(projectRequestEvent(request({ kind: 'ok' })).success).toBe(true)
    expect(projectRequestEvent(request({ kind: 'estimated' })).success).toBe(true)
  })

  it('groups HTTP statuses for the terminal result column', () => {
    expect(projectRequestEvent(request({ status: 204 })).httpClass).toBe('success')
    expect(projectRequestEvent(request({ status: 302 })).httpClass).toBe('success')
    expect(projectRequestEvent(request({ status: 404 })).httpClass).toBe('4xx')
    expect(projectRequestEvent(request({ status: 503 })).httpClass).toBe('5xx')
    expect(projectRequestEvent(request({ status: null })).httpClass).toBe('none')
  })
})

describe('keyword projection', () => {
  it('never matches a request by its captured body', () => {
    const event = request({ requestBody: 'sk-secret-in-body' })
    expect(matchesQuery(event, 'sk-secret-in-body')).toBe(false)
  })

  it('matches log records on their message, target, source and level', () => {
    const event = log({ level: 'warn', target: 'cc_use_daemon::runtime', message: 'queue is full' })
    for (const needle of ['queue', 'daemon', 'warn', 'runtime']) {
      expect(matchesQuery(event, needle)).toBe(true)
    }
    expect(matchesQuery(event, 'absent')).toBe(false)
  })

  it('is case insensitive', () => {
    expect(matchesQuery(request({ model: 'DeepSeek' }), 'DEEPSEEK')).toBe(true)
  })

  it('keeps every row for an empty query', () => {
    expect(matchesQuery(request(), '')).toBe(true)
    expect(matchesQuery(log(), '')).toBe(true)
  })

  it('projects a log row for the terminal line', () => {
    const projection = projectLogEvent(log({ level: 'trace', source: 'renderer' }))
    expect(projection.levelGroup).toBe('debug')
    expect(projection.event.source).toBe('renderer')
  })
})

describe('local time projection', () => {
  it('renders stored UTC timestamps as local wall-clock time', () => {
    const local = new Date(2026, 9, 29, 8, 5, 6)
    expect(formatLocalTime(utcTimestamp(local))).toBe('08:05:06')
    expect(formatLocalDateTime(utcTimestamp(local))).toBe('2026-10-29 08:05:06')
  })

  it('keeps a malformed timestamp visible instead of dropping the row', () => {
    expect(formatLocalDateTime('not-a-timestamp')).toBe('not-a-timestamp')
    expect(formatLocalTime('not-a-timestamp')).toBe('not-a-timestamp')
  })
})

describe('clear result parsing', () => {
  it('keeps per-owner partial failures instead of reporting full success', () => {
    expect(parseClearResult({ ok: false, app: true, daemon: false })).toEqual({
      confirmed: true,
      ok: false,
      app: true,
      daemon: false,
    })
  })

  it('treats an old runtime payload as unconfirmed rather than successful', () => {
    expect(parseClearResult(undefined)).toBeNull()
    expect(parseClearResult({})).toBeNull()
    expect(parseClearResult({ ok: true })).toBeNull()
  })
})
