import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConsoleEvent, ConsoleLogClearResult, ConsoleLogRetention } from '../../shared/types'

const readRecent = vi.fn()
const clearHistory = vi.fn()
const logStatus = vi.fn()

const { beginRendererLogClear, endRendererLogClear } = vi.hoisted(() => ({
  beginRendererLogClear: vi.fn(async () => {}),
  endRendererLogClear: vi.fn(),
}))

vi.mock('./index', () => ({
  getApi: () => ({
    console: { readRecent, clearHistory, logStatus, onEvent: () => () => {} },
  }),
}))

// The real bridge owns intervals and IPC; the store tests only care that the
// clear protocol is entered before the backend call and left afterwards.
vi.mock('./consoleLogBridge', () => ({ beginRendererLogClear, endRendererLogClear }))

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

/** Render a local Date as the UTC `YYYY-MM-DD HH:MM:SS` record format. */
function renderUtcRecordTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(
    date.getUTCHours(),
  )}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
}

function pageRecord(source: string, seq: number, id: string, event: ConsoleEvent) {
  return { source, epoch: 'e', seq, at: '', id, event }
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
    logStatus.mockReset()
    beginRendererLogClear.mockClear()
    endRendererLogClear.mockClear()
  })

  it('restores records from disk without duplicating what is already on screen', async () => {
    const { getConsoleEvents, hydrateConsoleHistory } = await freshStore()
    readRecent.mockResolvedValue({
      generation: 'g1',
      truncated: false,
      records: [
        pageRecord('daemon', 1, 'req-1:ok', pendingRequest({ kind: 'ok', status: 200 })),
        pageRecord('daemon', 2, 'log-1', logEvent('log-1', 'from disk')),
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
      records: [pageRecord('daemon', 1, 'log-1', logEvent('log-1', 'old'))],
    })
    await hydrateConsoleHistory()
    expect(getConsoleEvents()).toHaveLength(1)

    // Cleared elsewhere: the second read reports a new generation and the
    // records it returns must replace, not merge with, the stale buffer.
    readRecent.mockResolvedValueOnce({
      generation: 'g2',
      truncated: false,
      records: [pageRecord('daemon', 1, 'log-2', logEvent('log-2', 'new'))],
    })
    await hydrateConsoleHistory()

    const events = getConsoleEvents()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ message: 'new' })
  })

  it('uses the durable envelope to deduplicate legacy events without ids across refreshes', async () => {
    const { getConsoleEvents, hydrateConsoleHistory } = await freshStore()
    readRecent.mockImplementation(async () => ({
      generation: 'g1',
      truncated: false,
      records: [
        pageRecord('daemon', 7, 'daemon:e:7', pendingRequest({ requestId: undefined })),
        pageRecord('app', 8, 'app:e:8', logEvent(undefined, 'legacy log')),
      ],
    }))
    await hydrateConsoleHistory()
    await hydrateConsoleHistory()
    expect(getConsoleEvents()).toHaveLength(2)
    expect(getConsoleEvents()[0]).toMatchObject({ requestId: 'daemon:e:7' })
    expect(getConsoleEvents()[1]).toMatchObject({ id: 'app:e:8' })
  })

  it('does not resurrect a cleared window from an earlier in-flight history read', async () => {
    const { getConsoleEvents, hydrateConsoleHistory, clearConsoleHistory } = await freshStore()
    let resolveRead!: (value: unknown) => void
    readRecent.mockReturnValue(
      new Promise((resolve) => {
        resolveRead = resolve
      }),
    )
    const read = hydrateConsoleHistory()
    clearHistory.mockResolvedValue({ ok: true, app: true, daemon: true })
    await clearConsoleHistory()
    resolveRead({
      generation: 'old',
      truncated: false,
      records: [pageRecord('daemon', 1, 'old', logEvent('old', 'cleared'))],
    })
    await read
    expect(getConsoleEvents()).toEqual([])
  })

  it('exposes retention and truncation metadata from the read', async () => {
    const retention: ConsoleLogRetention = {
      retentionStartDate: '2026-07-04',
      capacityEvicted: true,
      trimmed: true,
      corrupted: 2,
      limited: true,
    }
    const { getConsoleHistoryMeta, hydrateConsoleHistory } = await freshStore()
    readRecent.mockResolvedValue({
      generation: 'g9',
      truncated: true,
      retention,
      records: [],
    })

    await hydrateConsoleHistory()

    expect(getConsoleHistoryMeta()).toEqual({
      truncated: true,
      retention,
      error: null,
      generation: 'g9',
    })
  })

  it('keeps the console usable when history cannot be read and records the error', async () => {
    const { getConsoleHistoryMeta, hydrateConsoleHistory } = await freshStore()
    readRecent.mockRejectedValue(new Error('unavailable'))

    await expect(hydrateConsoleHistory()).resolves.toBeUndefined()
    expect(getConsoleHistoryMeta().error).toBe('unavailable')
    expect(getConsoleHistoryMeta().truncated).toBe(false)
  })
})

describe('the three-local-day window', () => {
  beforeEach(() => {
    readRecent.mockReset()
  })

  it('computes the oldest retained local day as today minus two days', async () => {
    const { getConsoleRetentionStartDate } = await freshStore()
    const now = new Date(2026, 9, 29, 12, 0, 0) // local 2026-10-29
    expect(getConsoleRetentionStartDate(now)).toBe('2026-10-27')
  })

  it('prunes expired rows and invalid timestamps from the in-memory list', async () => {
    const {
      getConsoleEvents,
      getConsoleHistoryMeta,
      hydrateConsoleHistory,
      pruneExpiredConsoleEvents,
    } = await freshStore()
    const now = new Date(2026, 9, 29, 12, 0, 0)
    // Local-time instants converted to the UTC format the backend sends; the
    // store must map them back to the same local natural day.
    const inside = renderUtcRecordTimestamp(new Date(2026, 9, 27, 0, 30, 0))
    const expired = renderUtcRecordTimestamp(new Date(2026, 9, 26, 23, 30, 0))
    readRecent.mockResolvedValue({
      generation: 'g1',
      truncated: false,
      records: [
        pageRecord('daemon', 1, 'inside', { ...logEvent('inside', 'kept'), timestamp: inside }),
        pageRecord('daemon', 2, 'expired', { ...logEvent('expired', 'old'), timestamp: expired }),
        pageRecord('daemon', 3, 'bad', {
          ...logEvent('bad', 'invalid'),
          timestamp: 'not-a-timestamp',
        }),
      ],
    })
    await hydrateConsoleHistory()
    expect(getConsoleEvents()).toHaveLength(3)
    expect(getConsoleHistoryMeta().generation).toBe('g1')

    const removed = pruneExpiredConsoleEvents(now)

    expect(removed).toBe(2)
    expect(getConsoleEvents()).toHaveLength(1)
    expect(getConsoleEvents()[0]).toMatchObject({ message: 'kept' })
  })
})

describe('clearing the console', () => {
  beforeEach(() => {
    clearHistory.mockReset()
    beginRendererLogClear.mockClear()
    endRendererLogClear.mockClear()
  })

  it('drops the buffer and the on-disk history together', async () => {
    const { getConsoleEvents, clearConsoleHistory } = await freshStore()
    clearHistory.mockResolvedValue({ ok: true, app: true, daemon: true })
    const result = await clearConsoleHistory()

    expect(result).toEqual({ ok: true, app: true, daemon: true })
    expect(clearHistory).toHaveBeenCalledTimes(1)
    expect(getConsoleEvents()).toEqual([])
  })

  it('enters and leaves the bridge clear protocol around the backend call', async () => {
    const { clearConsoleHistory } = await freshStore()
    clearHistory.mockImplementation(async () => {
      expect(beginRendererLogClear).toHaveBeenCalledTimes(1)
      return { ok: true, app: true, daemon: true }
    })

    await clearConsoleHistory()

    expect(beginRendererLogClear).toHaveBeenCalledTimes(1)
    expect(endRendererLogClear).toHaveBeenCalledTimes(1)
  })

  it('surfaces a partial clear instead of reporting a full success', async () => {
    const { clearConsoleHistory, getConsoleHistoryMeta } = await freshStore()
    const partial: ConsoleLogClearResult = { ok: false, app: true, daemon: false }
    clearHistory.mockResolvedValue(partial)

    const result = await clearConsoleHistory()

    expect(result).toEqual(partial)
    // Clear failures use the per-owner result, not the history-read error channel.
    expect(getConsoleHistoryMeta().error).toBeNull()
    // The bridge protocol is still left, otherwise new logs would never flush.
    expect(endRendererLogClear).toHaveBeenCalledTimes(1)
  })

  it('never rejects when the clear IPC itself fails', async () => {
    const { clearConsoleHistory } = await freshStore()
    clearHistory.mockRejectedValue(new Error('ipc down'))

    const result = await clearConsoleHistory()

    expect(result).toEqual({ ok: false, app: false, daemon: false })
  })
})
