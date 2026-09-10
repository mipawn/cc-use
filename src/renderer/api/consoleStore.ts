/**
 * Process-long console event store.
 *
 * Events accumulate for the lifetime of the renderer process, and the recent
 * ones are seeded back from the bounded on-disk history so a reload or an app
 * restart no longer starts from an empty console. Navigating away from the
 * Console page does NOT clear history; only the explicit clear action does.
 *
 * Sources (installed once at app boot via `installConsoleStore`):
 * - Tauri `proxy:consoleEvent` (daemon forwarded + app-local Rust logs)
 * - renderer `console.*` bus (patched in `consoleBus.ts`)
 *
 * Subscribers (Console page) use `useSyncExternalStore` for tear-free reads.
 */
import type { ConsoleEvent } from '../../shared/types'
import { subscribeRendererConsole } from './consoleBus'
import { getApi } from './index'

const BUFFER_LIMIT = 500
/** Secondary guard: 500 records of long detail could still be tens of MiB. */
const BUFFER_BYTE_LIMIT = 8 * 1024 * 1024

let events: ConsoleEvent[] = []
let generation: string | null = null
const bus = new EventTarget()
const CHANGE = 'change'

/**
 * Row identity: one row per proxied request, one per log record.
 *
 * A request keeps a single row across its whole lifecycle, so the live
 * `pending` event and the replayed `ok` from disk land on the same row. Logs
 * carry an id assigned when they were created, which is what lets a replayed
 * line collapse into the live one instead of appearing twice.
 */
function rowKey(event: ConsoleEvent): string | null {
  if (event.category === 'request') return event.requestId ?? null
  return event.id ?? null
}

function isPending(event: ConsoleEvent): boolean {
  return event.category === 'request' && event.kind === 'pending'
}

const sizeCache = new WeakMap<ConsoleEvent, number>()

function eventBytes(event: ConsoleEvent): number {
  const cached = sizeCache.get(event)
  if (cached !== undefined) return cached
  let size: number
  try {
    size = JSON.stringify(event).length
  } catch {
    size = 0
  }
  sizeCache.set(event, size)
  return size
}

/** Newest-first byte walk, so the most recent records are the ones kept. */
function trim(buffer: ConsoleEvent[]): ConsoleEvent[] {
  let next = buffer
  if (next.length > BUFFER_LIMIT) {
    next = next.slice(next.length - BUFFER_LIMIT)
  }
  let bytes = 0
  let keepFrom = 0
  for (let index = next.length - 1; index >= 0; index -= 1) {
    bytes += eventBytes(next[index])
    if (bytes > BUFFER_BYTE_LIMIT) {
      keepFrom = index + 1
      break
    }
  }
  return keepFrom === 0 ? next : next.slice(keepFrom)
}

function commit(next: ConsoleEvent[]) {
  // New array reference every commit so useSyncExternalStore's snapshot
  // equality check triggers a re-render.
  events = trim(next)
  bus.dispatchEvent(new Event(CHANGE))
}

function append(event: ConsoleEvent) {
  commit(mergeConsoleEventList(events, event))
}

/**
 * Fold one event into the buffer, or append it when it has no stable identity.
 *
 * A replayed `pending` never overwrites a row that already reached a terminal
 * state: the file records every stage, and a reload must not walk a finished
 * request backwards.
 */
export function mergeConsoleEventList(
  current: ConsoleEvent[],
  event: ConsoleEvent,
): ConsoleEvent[] {
  const key = rowKey(event)
  if (!key) {
    return current.concat(event)
  }

  const existingIndex = current.findIndex((item) => rowKey(item) === key)
  if (existingIndex === -1) {
    return current.concat(event)
  }

  const previous = current[existingIndex]
  if (isPending(event) && !isPending(previous)) {
    return current
  }

  const next = current.slice()
  next[existingIndex] =
    previous.category === 'request' && event.category === 'request'
      ? {
          ...previous,
          ...event,
          // A later stage often omits detail; keep whatever we already captured.
          requestHeaders: event.requestHeaders ?? previous.requestHeaders,
          requestBody: event.requestBody ?? previous.requestBody,
          responseHeaders: event.responseHeaders ?? previous.responseHeaders,
          responseBody: event.responseBody ?? previous.responseBody,
        }
      : event
  return next
}

function mergeConsoleEventListAll(
  current: ConsoleEvent[],
  incoming: ConsoleEvent[],
): ConsoleEvent[] {
  return incoming.reduce((buffer, event) => mergeConsoleEventList(buffer, event), current)
}

export function getConsoleEvents(): ConsoleEvent[] {
  return events
}

/** Drop the in-memory buffer. Files are cleared by `clearConsoleHistory`. */
export function clearConsoleEvents(): void {
  if (events.length === 0) return
  commit([])
}

/**
 * Seed the buffer from the bounded on-disk history.
 *
 * Safe to call more than once and safe to race with the live stream: rows are
 * merged by identity, so an event that arrived live is not duplicated. When the
 * generation changed, history was cleared elsewhere and the buffer is dropped
 * first rather than merged across the clear.
 */
export async function hydrateConsoleHistory(): Promise<void> {
  let page: Awaited<ReturnType<ReturnType<typeof getApi>['console']['readRecent']>>
  try {
    page = await getApi().console.readRecent(['daemon', 'app'], BUFFER_LIMIT)
  } catch (error) {
    console.error('Failed to restore console history:', error)
    return
  }

  const replacedGeneration = generation !== null && page.generation !== generation
  generation = page.generation
  const restored = page.records.map((record) => record.event)
  commit(mergeConsoleEventListAll(replacedGeneration ? [] : events, restored))
}

/**
 * Clear the console for real: in-memory buffer, the cursor, and the on-disk
 * history of both processes. Statistics and Auto mode audit rows live in the
 * database and are deliberately untouched.
 */
export async function clearConsoleHistory(): Promise<void> {
  await getApi().console.clearHistory()
  generation = null
  commit([])
}

/** How many records this process could not persist since it started. */
export async function consoleLogDroppedCount(): Promise<number> {
  try {
    const status = await getApi().console.logStatus()
    return status.dropped
  } catch {
    return 0
  }
}

export function subscribeConsoleStore(listener: () => void): () => void {
  bus.addEventListener(CHANGE, listener)
  return () => bus.removeEventListener(CHANGE, listener)
}

let installed = false

/// Wire up the event sources and restore recent history. Idempotent — safe to
/// call more than once. Call this at app bootstrap so events start accumulating
/// even before the user visits the Console page.
export function installConsoleStore(): void {
  if (installed) return
  installed = true
  getApi().console.onEvent(append)
  subscribeRendererConsole(append)
  void hydrateConsoleHistory()
}

export const CONSOLE_BUFFER_LIMIT = BUFFER_LIMIT
