import { describe, expect, it } from 'vitest'
import type { ConsoleEvent } from '@shared/types'
import { eventRowKey, isProblemEvent, matchesQuery } from './Console'

function request(overrides: Partial<ConsoleEvent> = {}): ConsoleEvent {
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
  } as ConsoleEvent
}

describe('console row identity', () => {
  it('keys a request row by its request id, not its position', () => {
    expect(eventRowKey(request(), 7)).toBe('req-1')
  })

  it('keys a log row by the id it was created with', () => {
    const log = {
      category: 'log',
      id: 'log-abc',
      timestamp: '2026-09-11 10:00:00',
      level: 'info',
      source: 'daemon',
      target: null,
      message: 'ready',
    } as ConsoleEvent
    expect(eventRowKey(log, 3)).toBe('log-abc')
  })

  it('falls back to the position only when an event has no identity', () => {
    expect(eventRowKey(request({ requestId: undefined }), 4)).toBe('request-4')
  })
})

describe('console problem detection', () => {
  it('flags upstream failures, rejections and 4xx/5xx, but not success', () => {
    expect(isProblemEvent(request({ kind: 'upstream_error', status: null }))).toBe(true)
    expect(isProblemEvent(request({ kind: 'rejected', status: null }))).toBe(true)
    expect(isProblemEvent(request({ status: 429 }))).toBe(true)
    expect(isProblemEvent(request({ status: 200 }))).toBe(false)
    // A websocket upgrade is not a failure.
    expect(isProblemEvent(request({ kind: 'ws' }))).toBe(false)
  })

  it('treats warn and error logs as problems, info as not', () => {
    const log = (level: string) =>
      ({
        category: 'log',
        id: 'l',
        timestamp: '',
        level,
        source: 'daemon',
        target: null,
        message: '',
      }) as ConsoleEvent
    expect(isProblemEvent(log('error'))).toBe(true)
    expect(isProblemEvent(log('warn'))).toBe(true)
    expect(isProblemEvent(log('info'))).toBe(false)
  })
})

describe('console search', () => {
  it('covers the model, route, summary and request id', () => {
    const event = request({})
    for (const needle of ['deepseek', 'Example', 'daily', '/v1/messages', 'req-1', '200']) {
      expect(matchesQuery(event, needle)).toBe(true)
    }
  })

  it('does not scan the request body', () => {
    const event = request({ requestBody: 'sk-secret-in-body' })
    expect(matchesQuery(event, 'sk-secret-in-body')).toBe(false)
  })

  it('matches log records on their message, source and level', () => {
    const log = {
      category: 'log',
      id: 'l',
      timestamp: '',
      level: 'warn',
      source: 'daemon',
      target: 'cc_use_daemon::runtime',
      message: 'queue is full',
    } as ConsoleEvent
    expect(matchesQuery(log, 'queue')).toBe(true)
    expect(matchesQuery(log, 'daemon')).toBe(true)
    expect(matchesQuery(log, 'warn')).toBe(true)
    expect(matchesQuery(log, 'absent')).toBe(false)
  })

  it('is case insensitive', () => {
    expect(matchesQuery(request({}), 'DEEPSEEK')).toBe(true)
  })
})
