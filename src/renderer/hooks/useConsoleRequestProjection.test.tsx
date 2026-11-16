// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConsoleEvent, ConsoleLogPage } from '@shared/types'
import { useConsoleRequestProjection } from './useConsoleRequestProjection'
import {
  clearConsoleHistory,
  getConsoleClearRevision,
  getConsoleEvents,
  hydrateConsoleHistory,
  isConsoleHistoryClearing,
} from '../api/consoleStore'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const api = vi.hoisted(() => ({ readRequest: vi.fn(), readRecent: vi.fn(), clearHistory: vi.fn() }))
vi.mock('../api', () => ({ getApi: () => ({ console: api }) }))
vi.mock('../api/consoleLogBridge', () => ({
  beginRendererLogClear: vi.fn(async () => {}),
  endRendererLogClear: vi.fn(),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function event(id = 'target', overrides: Partial<ConsoleEvent> = {}): ConsoleEvent {
  return {
    category: 'request',
    requestId: id,
    timestamp: new Date().toISOString().slice(0, 19).replace('T', ' '),
    method: 'POST',
    path: '/v1/messages',
    status: 200,
    latencyMs: 10,
    upstream: 'https://example.invalid',
    provider: 'fixture',
    keyAlias: 'test',
    kind: 'ok',
    ...overrides,
  } as ConsoleEvent
}
function page(events: ConsoleEvent[], generation = 'g1'): ConsoleLogPage {
  return {
    generation,
    truncated: false,
    records: events.map((event, seq) => ({
      source: 'daemon',
      epoch: 'e',
      seq,
      at: '',
      id: `event-${seq}`,
      event,
    })),
  }
}

let snapshot: ReturnType<typeof useConsoleRequestProjection>
let root: ReturnType<typeof createRoot>
let container: HTMLDivElement
function Harness({ requestId }: { requestId?: string }) {
  snapshot = useConsoleRequestProjection(requestId)
  return null
}
async function render(requestId?: string) {
  await act(async () => {
    root.render(<Harness requestId={requestId} />)
  })
}
beforeEach(async () => {
  api.clearHistory.mockResolvedValue({ ok: true, app: true, daemon: true })
  await clearConsoleHistory()
  api.readRecent.mockResolvedValue(page([]))
  api.readRequest.mockReset().mockResolvedValue(page([]))
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.useRealTimers()
})

describe('independent exact request projection', () => {
  it('finds a retained request beyond 500 global rows without changing the buffer', async () => {
    api.readRecent.mockResolvedValue(
      page(Array.from({ length: 501 }, (_, i) => event(i === 0 ? 'target' : `other-${i}`))),
    )
    await hydrateConsoleHistory()
    expect(getConsoleEvents()).toHaveLength(500)
    expect(
      getConsoleEvents().some((e) => e.category === 'request' && e.requestId === 'target'),
    ).toBe(false)
    const globalBuffer = getConsoleEvents()
    api.readRequest.mockResolvedValue(
      page([
        event('target', { kind: 'pending', requestBody: 'body' }),
        event('other'),
        event('target'),
      ]),
    )
    await render('target')
    expect(api.readRequest).toHaveBeenCalledWith('target', 500)
    expect(snapshot.events).toHaveLength(1)
    expect(snapshot.events[0]).toMatchObject({
      requestId: 'target',
      kind: 'ok',
      requestBody: 'body',
    })
    expect(getConsoleEvents()).toBe(globalBuffer)
  })

  it('never starts a lookup without a request ID', async () => {
    await render()
    expect(api.readRequest).not.toHaveBeenCalled()
    expect(snapshot.loading).toBe(false)
  })

  it('drops a late response when the request identity changes', async () => {
    const old = deferred<ConsoleLogPage>()
    api.readRequest.mockReturnValueOnce(old.promise).mockResolvedValueOnce(page([event('new')]))
    await render('old')
    expect(snapshot.loading).toBe(true)
    await render('new')
    await act(async () => old.resolve(page([event('old')])))
    expect(snapshot.events[0]).toMatchObject({ requestId: 'new' })
  })

  it('invalidates in-flight reads at both ends of global clear', async () => {
    const oldRead = deferred<ConsoleLogPage>()
    const clear = deferred<{ ok: boolean; app: boolean; daemon: boolean }>()
    api.readRequest.mockReturnValueOnce(oldRead.promise).mockResolvedValue(page([], 'g2'))
    await render('target')
    const before = getConsoleClearRevision()
    api.clearHistory.mockReturnValueOnce(clear.promise)
    let clearing!: Promise<unknown>
    await act(async () => {
      clearing = clearConsoleHistory()
    })
    expect(isConsoleHistoryClearing()).toBe(true)
    expect(getConsoleClearRevision()).toBe(before + 1)
    await act(async () => oldRead.resolve(page([event('target')])))
    expect(snapshot.events).toEqual([])
    expect(api.readRequest).toHaveBeenCalledTimes(1)
    await act(async () => {
      clear.resolve({ ok: true, app: true, daemon: true })
      await clearing
    })
    expect(getConsoleClearRevision()).toBe(before + 2)
    expect(isConsoleHistoryClearing()).toBe(false)
    expect(snapshot.events).toEqual([])
    expect(snapshot.failed).toBe(false)
    expect(api.readRequest).toHaveBeenCalledTimes(2)
  })

  it('rejects a lookup from a stale persisted generation', async () => {
    api.readRecent.mockResolvedValue(page([], 'new-generation'))
    await hydrateConsoleHistory()
    api.readRequest.mockResolvedValue(page([event()], 'old-generation'))
    await render('target')
    expect(snapshot.events).toEqual([])
    expect(snapshot.failed).toBe(true)
  })

  it('keeps read failures distinct from empty retained results and allows retry', async () => {
    api.readRequest
      .mockRejectedValueOnce(new Error('private-route-token'))
      .mockResolvedValueOnce(page([]))
    await render('target')
    expect(snapshot.failed).toBe(true)
    expect(snapshot.page).toBeNull()
    expect(JSON.stringify(snapshot)).not.toContain('private-route-token')
    await act(async () => snapshot.refresh())
    expect(snapshot.failed).toBe(false)
    expect(snapshot.page?.records).toEqual([])
  })

  it('prunes expired projection events on focus without writing the global store', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 8, 11, 12))
    api.readRequest.mockResolvedValue(page([event()]))
    await render('target')
    expect(snapshot.events).toHaveLength(1)
    vi.setSystemTime(new Date(2026, 8, 14, 12))
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(snapshot.events).toEqual([])
    expect(getConsoleEvents()).toEqual([])
  })
})
