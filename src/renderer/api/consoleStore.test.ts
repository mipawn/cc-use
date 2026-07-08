import { describe, expect, it } from 'vitest'
import type { ConsoleEvent } from '../../shared/types'
import { mergeConsoleEventList } from './consoleStore'

describe('mergeConsoleEventList', () => {
  it('replaces a pending request with the final event by requestId', () => {
    const pending: ConsoleEvent = {
      category: 'request',
      requestId: 'req-1',
      timestamp: '2026-07-06 10:00:00',
      method: 'POST',
      path: '/v1/messages',
      status: null,
      latencyMs: null,
      upstream: 'https://example.com/v1/messages',
      provider: 'Claude',
      keyAlias: 'main',
      kind: 'pending',
      requestHeaders: ['content-type: application/json'],
      requestBody: '{"model":"claude"}',
    }
    const final: ConsoleEvent = {
      category: 'request',
      requestId: 'req-1',
      timestamp: '2026-07-06 10:00:01',
      method: 'POST',
      path: '/v1/messages',
      status: 200,
      latencyMs: 1200,
      upstream: 'https://example.com/v1/messages',
      provider: 'Claude',
      keyAlias: 'main',
      kind: 'ok',
      responseHeaders: ['content-type: text/event-stream'],
      responseBody: 'done',
    }

    const merged = mergeConsoleEventList([pending], final)

    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      requestId: 'req-1',
      kind: 'ok',
      status: 200,
      latencyMs: 1200,
      requestBody: '{"model":"claude"}',
      responseBody: 'done',
    })
  })

  it('appends log events and request events without requestId', () => {
    const log: ConsoleEvent = {
      category: 'log',
      timestamp: '2026-07-06 10:00:00',
      level: 'info',
      source: 'renderer',
      target: null,
      message: 'ready',
    }
    const request: ConsoleEvent = {
      category: 'request',
      timestamp: '2026-07-06 10:00:01',
      method: 'GET',
      path: '/v1/models',
      status: 200,
      latencyMs: 10,
      upstream: 'cc-use://local',
      provider: null,
      keyAlias: null,
      kind: 'ok',
    }

    expect(mergeConsoleEventList([log], request)).toHaveLength(2)
  })
})
