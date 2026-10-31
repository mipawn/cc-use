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
 * The same snapshot also carries the last hydration's retention/truncation
 * metadata and error, so the page can explain a short list without owning the
 * read path.
 */
import type { ConsoleEvent, ConsoleLogClearResult, ConsoleLogRetention } from '../../shared/types'
import { subscribeRendererConsole } from './consoleBus'
import { beginRendererLogClear, endRendererLogClear } from './consoleLogBridge'
import { getApi } from './index'

const BUFFER_LIMIT = 500
/** Secondary guard: 500 records of long detail could still be tens of MiB. */
const BUFFER_BYTE_LIMIT = 8 * 1024 * 1024
/** Time-to-live recheck cadence for the in-memory list (design: <= 30 s). */
const TTL_RECHECK_INTERVAL_MS = 30_000

let events: ConsoleEvent[] = []
let generation: string | null = null
let historyRevision = 0
const bus = new EventTarget()
const CHANGE = 'change'

/** Result of the last history read; the page renders truncation from it. */
export interface ConsoleHistoryMeta {
  /** The last read said something is missing (budget, damage or limit). */
  truncated: boolean
  /** Retention window metadata returned by the store. */
  retention: ConsoleLogRetention | null
  /** Message when the last read failed; cleared by the next successful read. */
  error: string | null
  /** Generation the buffer currently belongs to. */
  generation: string | null
}

let historyMeta: ConsoleHistoryMeta = {
  truncated: false,
  retention: null,
  error: null,
  generation: null,
}

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

function notify(): void {
  bus.dispatchEvent(new Event(CHANGE))
}

function commit(next: ConsoleEvent[]) {
  // New array reference every commit so useSyncExternalStore's snapshot
  // equality check triggers a re-render.
  events = trim(next)
  notify()
}

function commitMeta(next: ConsoleHistoryMeta) {
  historyMeta = next
  // The page subscribes to the same external store, so metadata changes must
  // produce a render too (retention arrives after hydration).
  notify()
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

export function getConsoleHistoryMeta(): ConsoleHistoryMeta {
  return historyMeta
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
 * first rather than merged across the clear. Never throws; a failed read leaves
 * the current buffer usable and records the error in `ConsoleHistoryMeta`.
 */
export async function hydrateConsoleHistory(): Promise<void> {
  const revision = ++historyRevision
  let page: Awaited<ReturnType<ReturnType<typeof getApi>['console']['readRecent']>>
  try {
    page = await getApi().console.readRecent(['daemon', 'app'], BUFFER_LIMIT)
  } catch (error) {
    if (revision !== historyRevision) return
    // A console that cannot restore history must still show live events.
    commitMeta({
      ...historyMeta,
      error: error instanceof Error ? error.message : String(error),
    })
    return
  }

  if (revision !== historyRevision) return

  const replacedGeneration = generation !== null && page.generation !== generation
  generation = page.generation
  const restored = page.records.map((record) => {
    const event = record.event
    // Older events have no lifecycle/log id. Their durable envelope still
    // identifies the same record on every replay; keep it through projection.
    const fallbackId = `${record.source}:${record.epoch}:${record.seq}`
    return event.category === 'request'
      ? { ...event, requestId: event.requestId ?? fallbackId }
      : { ...event, id: event.id ?? fallbackId }
  })
  commit(mergeConsoleEventListAll(replacedGeneration ? [] : events, restored))
  commitMeta({
    truncated: Boolean(page.truncated),
    retention: page.retention ?? null,
    error: null,
    generation,
  })
}

// ── retention / TTL projection ──

function localDateString(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * The oldest local natural day still inside the recovery window:
 * `today + previous two local days`, derived from the record's UTC timestamp.
 */
export function getConsoleRetentionStartDate(now: Date = new Date()): string {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2)
  return localDateString(start)
}

/**
 * Local natural day of a `YYYY-MM-DD HH:MM:SS` record timestamp.
 *
 * The string is UTC by contract; parsing it as a local naive time would shift
 * the day boundary by the machine's offset. Invalid timestamps return `null`
 * so corrupt lines expire instead of living forever.
 */
export function consoleEventLocalDay(timestamp: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(timestamp.trim())
  if (!match) return null
  const [, year, month, day, hour, minute, second] = match
  const utc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  )
  if (Number.isNaN(utc)) return null
  return localDateString(new Date(utc))
}

/**
 * Remove in-memory events outside the three-local-day window (or with an
 * invalid timestamp). Returns how many rows were removed. The page calls this
 * on its <=30 s recheck and on visibility/focus restore; the store also runs it
 * on a timer once installed so a long-open app cannot accumulate stale rows.
 */
export function pruneExpiredConsoleEvents(now: Date = new Date()): number {
  const start = getConsoleRetentionStartDate(now)
  const kept = events.filter((event) => {
    const day = consoleEventLocalDay(event.timestamp)
    return day !== null && day >= start
  })
  if (kept.length === events.length) return 0
  const removed = events.length - kept.length
  commit(kept)
  return removed
}

/**
 * Clear the console for real: in-memory buffer, the cursor, and the on-disk
 * history of both processes. Statistics and Auto mode audit rows live in the
 * database and are deliberately untouched.
 *
 * The renderer persistence bridge is paused first (new generation, unsent
 * batches dropped, in-flight batch settled), so a batch queued before the clear
 * cannot resurrect deleted history. The per-owner result is returned; a partial
 * failure is visible through `ok`, `app` and `daemon` instead of a blanket
 * success. It never rejects, so callers do not need their own fallback.
 */
export async function clearConsoleHistory(): Promise<ConsoleLogClearResult> {
  // Invalidate old reads at both ends, including reads begun while the backend
  // clear was still in flight. They must not repopulate the cleared window.
  historyRevision += 1
  await beginRendererLogClear()
  let result: ConsoleLogClearResult
  try {
    const response = await getApi().console.clearHistory()
    // Older runtimes returned void on success; treat that as a legacy success
    // rather than crashing the page mid-clear.
    result =
      response && typeof response === 'object' ? response : { ok: true, app: true, daemon: true }
  } catch {
    result = { ok: false, app: false, daemon: false }
  } finally {
    endRendererLogClear()
  }

  historyRevision += 1
  generation = null
  commit([])
  commitMeta({
    truncated: false,
    retention: null,
    // A failed clear is reported through the returned per-owner result; the
    // history-read error channel is reserved for failed reads.
    error: null,
    generation: null,
  })
  return result
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
let ttlTimer: ReturnType<typeof setInterval> | null = null

/// Wire up the event sources and restore recent history. Idempotent — safe to
/// call more than once. Call this at app bootstrap so events start accumulating
/// even before the user visits the Console page.
export function installConsoleStore(): void {
  if (installed) return
  installed = true
  getApi().console.onEvent(append)
  subscribeRendererConsole(append)
  void hydrateConsoleHistory()
  // Long-running sessions check the day boundary even with no new traffic; the
  // Console page performs the same check on visibility/focus restore.
  if (typeof window !== 'undefined') {
    ttlTimer = setInterval(() => {
      pruneExpiredConsoleEvents()
    }, TTL_RECHECK_INTERVAL_MS)
  }
}

/** Tests can stop the process-long timer between cases. */
export function uninstallConsoleStore(): void {
  if (!installed) return
  installed = false
  if (ttlTimer !== null) {
    clearInterval(ttlTimer)
    ttlTimer = null
  }
}

export const CONSOLE_BUFFER_LIMIT = BUFFER_LIMIT
