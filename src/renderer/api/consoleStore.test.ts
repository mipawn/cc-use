import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConsoleEvent } from '../../shared/types'

const readRecent = vi.fn()
const clearHistory = vi.fn()
const logStatus = vi.fn()

vi.mock('./index', () => ({
  getApi: () => ({
    console: { readRecent, clearHistory, logStatus, onEvent: () => () => {} },
  }),
}))

type ConsoleStore = typeof import('./consoleStore')

/**
 * The store keeps module-level buffer and generation state, so each hydration
 * test needs its own instance rather than inheriting the previous one's.
 */
async function freshStore(): Promise<ConsoleStore> {
  vi.resetModules()
  return await import('./consoleStore')
}

const { mergeConsoleEventList } = await import('./consoleStore')

function pendingRequest(overrides: Partial<ConsoleEvent> = {}): ConsoleEvent {
  return {
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
    ...overrides,
  } as ConsoleEvent
}

function logEvent(id: string | undefined, message: string): ConsoleEvent {
  return {
    category: 'log',
    ...(id ? { id } : {}),
    timestamp: '2026-07-06 10:00:00',
    level: 'info',
    source: 'daemon',
    target: null,
    message,
  } as ConsoleEvent
}

describe('mergeConsoleEventList', () => {
  it('replaces a pending request with the final event by requestId', () => {
    const final: ConsoleEvent = pendingRequest({
      timestamp: '2026-07-06 10:00:01',
      status: 200,
      latencyMs: 1200,
      kind: 'ok',
      responseHeaders: ['content-type: text/event-stream'],
      responseBody: 'done',
    })

    const merged = mergeConsoleEventList([pendingRequest()], final)

    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      requestId: 'req-1',
      kind: 'ok',
      status: 200,
      latencyMs: 1200,
      // Detail captured on the earlier stage is not lost when the final one
      // does not repeat it.
      requestBody: '{"model":"claude"}',
      responseBody: 'done',
    })
  })

  it('does not walk a finished request back to pending when history is replayed', () => {
    const finished = pendingRequest({ kind: 'ok', status: 200 })

    const merged = mergeConsoleEventList([finished], pendingRequest())

    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ kind: 'ok', status: 200 })
  })

  it('collapses a replayed log line into the live one by event id', () => {
    const live = logEvent('log-abc', 'daemon booted')

    const merged = mergeConsoleEventList([live], logEvent('log-abc', 'daemon booted'))

    expect(merged).toHaveLength(1)
  })

  it('appends log records that carry no id, and requests without a requestId', () => {
    const anonymousLog = logEvent(undefined, 'ready')
    const anonymousRequest = pendingRequest({ requestId: undefined, path: '/v1/models' })

    expect(mergeConsoleEventList([anonymousLog], anonymousRequest)).toHaveLength(2)
  })
})

describe('console history hydration', () => {
  beforeEach(() => {
    readRecent.mockReset()
    clearHistory.mockReset()
  })

  it('restores records from disk without duplicating what is already on screen', async () => {
    const { getConsoleEvents, hydrateConsoleHistory } = await freshStore()
    readRecent.mockResolvedValue({
      generation: 'g1',
      truncated: false,
      records: [
        {
          source: 'daemon',
          epoch: 'e',
          seq: 1,
          at: '',
          id: 'req-1:ok',
          event: pendingRequest({ kind: 'ok', status: 200 }),
        },
        {
          source: 'daemon',
          epoch: 'e',
          seq: 2,
          at: '',
          id: 'log-1',
          event: logEvent('log-1', 'from disk'),
        },
      ],
    })

    await hydrateConsoleHistory()

    const restored = getConsoleEvents()
    expect(restored).toHaveLength(2)
    expect(
      restored.map((event) => (event.category === 'log' ? event.message : event.kind)),
    ).toEqual(['ok', 'from disk'])
  })

  it('drops the buffer when the on-disk generation changed', async () => {
    const { getConsoleEvents, hydrateConsoleHistory } = await freshStore()
    readRecent.mockResolvedValueOnce({
      generation: 'g1',
      truncated: false,
      records: [
        {
          source: 'daemon',
          epoch: 'e',
          seq: 1,
          at: '',
          id: 'log-1',
          event: logEvent('log-1', 'old'),
        },
      ],
    })
    await hydrateConsoleHistory()
    expect(getConsoleEvents()).toHaveLength(1)

    // Cleared elsewhere: the second read reports a new generation and the
    // records it returns must replace, not merge with, the stale buffer.
    readRecent.mockResolvedValueOnce({
      generation: 'g2',
      truncated: false,
      records: [
        {
          source: 'daemon',
          epoch: 'e',
          seq: 1,
          at: '',
          id: 'log-2',
          event: logEvent('log-2', 'new'),
        },
      ],
    })
    await hydrateConsoleHistory()

    const events = getConsoleEvents()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ message: 'new' })
  })

  it('keeps the console usable when history cannot be read', async () => {
    const { hydrateConsoleHistory } = await freshStore()
    readRecent.mockRejectedValue(new Error('unavailable'))

    await expect(hydrateConsoleHistory()).resolves.toBeUndefined()
  })
})

describe('clearing the console', () => {
  it('drops the buffer and the on-disk history together', async () => {
    const { getConsoleEvents, clearConsoleHistory } = await freshStore()
    clearHistory.mockResolvedValue(undefined)
    await clearConsoleHistory()

    expect(clearHistory).toHaveBeenCalledTimes(1)
    expect(getConsoleEvents()).toEqual([])
  })
})
