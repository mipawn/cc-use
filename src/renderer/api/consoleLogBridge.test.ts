import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConsoleLogAppendResult, RendererLogRecord } from '../../shared/types'

const appendRendererLogs = vi.fn()
const onEvent = vi.fn()
const readRecent = vi.fn()
const clearHistory = vi.fn()
const logStatus = vi.fn()

vi.mock('./index', () => ({
  getApi: () => ({
    console: { appendRendererLogs, onEvent, readRecent, clearHistory, logStatus },
  }),
}))

type BusModule = typeof import('./consoleBus')
type BridgeModule = typeof import('./consoleLogBridge')

/**
 * `main.tsx` installs the tap before the bridge; mirror that order for each
 * fresh module instance. The real console methods are replaced by spies so a
 * test run does not print the captured lines and so a recursion regression can
 * be asserted by call count.
 */
interface ConsoleSpies {
  log: ReturnType<typeof vi.fn>
  info: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
  error: ReturnType<typeof vi.fn>
  debug: ReturnType<typeof vi.fn>
}

async function freshModules(): Promise<{
  bus: BusModule
  bridge: BridgeModule
  consoleSpies: ConsoleSpies
}> {
  vi.resetModules()
  const consoleSpies: ConsoleSpies = {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }
  const assign = (method: 'log' | 'info' | 'warn' | 'error' | 'debug') => {
    console[method] = consoleSpies[method] as unknown as typeof console[typeof method]
  }
  assign('log')
  assign('info')
  assign('warn')
  assign('error')
  assign('debug')
  const bus = await import('./consoleBus')
  const bridge = await import('./consoleLogBridge')
  bus.installRendererConsoleTap()
  bridge.installRendererLogBridge()
  return { bus, bridge, consoleSpies }
}

function batchOf(callIndex: number): RendererLogRecord[] {
  return appendRendererLogs.mock.calls[callIndex][0] as RendererLogRecord[]
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length
}

beforeEach(() => {
  vi.useFakeTimers()
  appendRendererLogs.mockReset()
  appendRendererLogs.mockResolvedValue({ accepted: 1, rejected: 0 })
  onEvent.mockReset()
  readRecent.mockReset()
  clearHistory.mockReset()
  logStatus.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('renderer persistence batching', () => {
  it('persists console calls with the same ids the live bus emitted', async () => {
    const { bus } = await freshModules()
    const live: string[] = []
    bus.subscribeRendererConsole((event) => live.push(event.id ?? ''))

    console.log('hello')
    console.warn('careful')
    await vi.advanceTimersByTimeAsync(500)

    expect(appendRendererLogs).toHaveBeenCalledTimes(1)
    const batch = batchOf(0)
    expect(batch).toHaveLength(2)
    expect(batch.map((record) => record.level)).toEqual(['info', 'warn'])
    expect(batch.map((record) => record.id)).toEqual(live)
    expect(batch[0].message).toBe('hello')
    // Only the raw renderer bus is persisted; replay never loops back.
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('stamps ids with a per-page-load epoch that changes across reloads', async () => {
    const first = await freshModules()
    const firstId = first.bus.nextRendererEventId()
    expect(firstId).toMatch(/^renderer-[a-z0-9]+-\d+$/)

    const second = await freshModules()
    const secondId = second.bus.nextRendererEventId()

    const epochOf = (id: string) => id.split('-')[1]
    expect(epochOf(firstId)).toBe(first.bus.getRendererStartupEpoch())
    expect(epochOf(secondId)).toBe(second.bus.getRendererStartupEpoch())
    expect(epochOf(firstId)).not.toBe(epochOf(secondId))
  })

  it('splits work at the fifty-record batch boundary', async () => {
    const { bridge } = await freshModules()
    for (let index = 0; index < 120; index += 1) console.log(`line ${index}`)
    await vi.advanceTimersByTimeAsync(0)
    await bridge.flushRendererLogBridge()

    expect(appendRendererLogs).toHaveBeenCalledTimes(3)
    expect(batchOf(0)).toHaveLength(50)
    expect(batchOf(1)).toHaveLength(50)
    expect(batchOf(2)).toHaveLength(20)
  })

  it('never sends a batch over 64 KiB of serialized UTF-8', async () => {
    const { bridge } = await freshModules()
    // 12 KiB each: six fit under the 64 KiB batch cap, not eight.
    const body = '界'.repeat(4_096)
    for (let index = 0; index < 8; index += 1) console.log(body)
    await vi.advanceTimersByTimeAsync(0)
    await bridge.flushRendererLogBridge()

    expect(appendRendererLogs.mock.calls.length).toBeGreaterThanOrEqual(2)
    for (let index = 0; index < appendRendererLogs.mock.calls.length; index += 1) {
      expect(utf8Bytes(JSON.stringify(batchOf(index)))).toBeLessThanOrEqual(64 * 1024)
    }
  })

  it('truncates a single body to 16 KiB before batching', async () => {
    const { bridge } = await freshModules()
    console.log('x'.repeat(20 * 1024))
    await vi.advanceTimersByTimeAsync(500)
    await bridge.flushRendererLogBridge()

    const batch = batchOf(0)
    expect(batch).toHaveLength(1)
    expect(utf8Bytes(batch[0].message)).toBeLessThanOrEqual(16 * 1024)
    expect(batch[0].message.endsWith('truncated]')).toBe(true)
  })

  it('keeps at most one IPC in flight', async () => {
    const deferred: { resolve: ((value: ConsoleLogAppendResult) => void) | null } = {
      resolve: null,
    }
    appendRendererLogs.mockImplementationOnce(
      () =>
        new Promise<ConsoleLogAppendResult>((resolve) => {
          deferred.resolve = resolve
        }),
    )
    const { bridge } = await freshModules()
    console.log('first')
    await vi.advanceTimersByTimeAsync(500)
    expect(appendRendererLogs).toHaveBeenCalledTimes(1)

    console.log('second')
    await vi.advanceTimersByTimeAsync(500)
    expect(appendRendererLogs).toHaveBeenCalledTimes(1)

    deferred.resolve?.({ accepted: 1, rejected: 0 })
    await vi.advanceTimersByTimeAsync(0)
    await bridge.flushRendererLogBridge()
    expect(appendRendererLogs).toHaveBeenCalledTimes(2)
    expect(batchOf(1)[0].message).toBe('second')
  })

  it('evicts the oldest pending records when the local buffer overflows', async () => {
    const { bridge } = await freshModules()
    // Buffer while paused so the batch-boundary flush cannot drain it.
    await bridge.beginRendererLogClear()
    for (let index = 0; index < 1_005; index += 1) console.log(`buffered ${index}`)

    const status = bridge.getRendererLogBridgeStatus()
    expect(status.queueOverflow).toBeGreaterThanOrEqual(5)
    expect(appendRendererLogs).not.toHaveBeenCalled()
    bridge.endRendererLogClear()
  })

  it('drops a failed IPC batch without retrying in a storm or recursing', async () => {
    appendRendererLogs.mockRejectedValue(new Error('ipc down'))
    const { bridge, consoleSpies } = await freshModules()
    console.log('will fail')
    await vi.advanceTimersByTimeAsync(500)
    await bridge.flushRendererLogBridge()

    expect(appendRendererLogs).toHaveBeenCalledTimes(1)
    expect(bridge.getRendererLogBridgeStatus().ipcFailed).toBe(1)
    // No retry storm for the dropped batch.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(appendRendererLogs).toHaveBeenCalledTimes(1)
    // The bridge must not report its own failure through the console (that
    // would re-enter the same persistence channel).
    expect(consoleSpies.error).not.toHaveBeenCalled()
  })
})

describe('clear generation protocol', () => {
  it('drops unsent batches and sends records buffered during the clear afterwards', async () => {
    const { bridge } = await freshModules()
    console.log('unsent before clear')
    const clearing = bridge.beginRendererLogClear()
    console.log('buffered during clear')
    await clearing

    expect(appendRendererLogs).not.toHaveBeenCalled()
    expect(bridge.getRendererLogBridgeStatus().droppedByClear).toBe(1)

    bridge.endRendererLogClear()
    await vi.advanceTimersByTimeAsync(500)

    expect(appendRendererLogs).toHaveBeenCalledTimes(1)
    const batch = batchOf(0)
    expect(batch.map((record) => record.message)).toEqual(['buffered during clear'])
  })

  it('waits for the in-flight batch to settle before the clear proceeds', async () => {
    const deferred: { settle: ((value: ConsoleLogAppendResult) => void) | null } = {
      settle: null,
    }
    appendRendererLogs.mockImplementationOnce(
      () =>
        new Promise<ConsoleLogAppendResult>((resolve) => {
          deferred.settle = resolve
        }),
    )
    const { bridge } = await freshModules()
    console.log('in flight')
    await vi.advanceTimersByTimeAsync(500)
    expect(appendRendererLogs).toHaveBeenCalledTimes(1)

    let cleared = false
    const clearing = bridge.beginRendererLogClear().then(() => {
      cleared = true
    })
    await Promise.resolve()
    expect(cleared).toBe(false)

    deferred.settle?.({ accepted: 1, rejected: 0 })
    await clearing
    expect(cleared).toBe(true)
  })
})
