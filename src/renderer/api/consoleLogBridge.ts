/**
 * Renderer → Rust console persistence bridge.
 *
 * The renderer's `console.*` calls are already captured into `consoleBus` for
 * the in-process Console page. This module adds the second half of R3: they are
 * also batched and written through the Tauri command
 * `console_log_append_renderer` so they survive a reload and are visible to the
 * app/daemon recovery path.
 *
 * Installed once at app startup from `main.tsx`, independent of whether the
 * Console page was ever opened. It subscribes to the *raw renderer bus* only:
 * subscribing to the Tauri `proxy:consoleEvent` channel would recycle replayed
 * app/daemon records back into the store, duplicating them on disk forever.
 *
 * Bounds (frozen contract):
 * - batch: at most 50 records, at most 64 KiB of serialized UTF-8, at most
 *   16 KiB per body (oversized bodies are truncated before batching, and the
 *   backend rejects anything that still violates a limit);
 * - local buffer: at most 1,000 records / 1 MiB, evicting the oldest pending;
 * - flush every 500 ms or when a full batch is ready;
 * - at most one IPC in flight; a failed batch is dropped and counted, never
 *   retried in a storm and never reported through `console.*` (which would
 *   re-enter the same channel).
 *
 * Clearing: `consoleStore.clearConsoleHistory` first calls
 * {@link beginRendererLogClear}, which bumps the write generation, drops unsent
 * batches and waits for the in-flight batch to settle. Only then does the
 * backend clear the files. Records that arrive during the clear are buffered in
 * the next generation and sent after {@link endRendererLogClear}, so an old
 * batch can never resurrect deleted history.
 */
import type { ConsoleLogEvent, RendererLogRecord } from '../../shared/types'
import { nextRendererEventId, subscribeRendererConsole } from './consoleBus'
import { getApi } from './index'

export const RENDERER_BATCH_MAX_RECORDS = 50
export const RENDERER_BATCH_MAX_BYTES = 64 * 1024
export const RENDERER_MESSAGE_MAX_BYTES = 16 * 1024
export const RENDERER_BUFFER_MAX_RECORDS = 1_000
export const RENDERER_BUFFER_MAX_BYTES = 1024 * 1024
export const RENDERER_FLUSH_INTERVAL_MS = 500

const TRUNCATION_MARKER = '…[truncated]'

type PersistableLevel = 'error' | 'warn' | 'info' | 'debug'

/** Renderer-local persistence counters. `queueOverflow` never reaches Rust. */
export interface RendererLogBridgeStatus {
  /** Pending records evicted because the local buffer exceeded its cap. */
  queueOverflow: number
  /** Batches dropped because the IPC call itself failed. */
  ipcFailed: number
  /** Records the backend counted as rejected (invalid or over quota). */
  rejected: number
  /** Pending records discarded because a clear moved to a new generation. */
  droppedByClear: number
}

const counters: RendererLogBridgeStatus = {
  queueOverflow: 0,
  ipcFailed: 0,
  rejected: 0,
  droppedByClear: 0,
}

interface PendingRecord {
  record: RendererLogRecord
  bytes: number
}

let pending: PendingRecord[] = []
let pendingBytes = 0
/** Bumped on clear; a response from an older generation is ignored. */
let writeGeneration = 0
let paused = false
let inFlight: Promise<void> | null = null
let installed = false
let timer: ReturnType<typeof setInterval> | null = null
let unsubscribeBus: (() => void) | null = null
const listeners = new Set<() => void>()

const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null

/** UTF-8 byte length; the backend limits are byte-based, not char-based. */
function utf8Bytes(text: string): number {
  if (encoder) return encoder.encode(text).length
  let bytes = 0
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return bytes
}

/** Truncate to the per-body limit on a UTF-8 boundary, keeping a marker. */
function truncateMessage(message: string): string {
  if (utf8Bytes(message) <= RENDERER_MESSAGE_MAX_BYTES) return message
  const budget = Math.max(0, RENDERER_MESSAGE_MAX_BYTES - utf8Bytes(TRUNCATION_MARKER))
  let bytes = 0
  let end = 0
  for (const character of message) {
    const size = utf8Bytes(character)
    if (bytes + size > budget) break
    bytes += size
    end += character.length
  }
  return `${message.slice(0, end)}${TRUNCATION_MARKER}`
}

function isPersistable(event: ConsoleLogEvent): boolean {
  if (event.category !== 'log') return false
  if (event.source !== 'renderer') return false
  return event.level === 'error' || event.level === 'warn' || event.level === 'info' || event.level === 'debug'
}

function toRecord(event: ConsoleLogEvent): RendererLogRecord {
  return {
    // The bus always assigns it; the fallback keeps the field non-null for a
    // hand-dispatched event without inventing a non-renderer id shape.
    id: event.id && event.id.length > 0 ? event.id : nextRendererEventId(),
    timestamp: event.timestamp,
    level: event.level as PersistableLevel,
    target: event.target ?? null,
    message: truncateMessage(event.message),
  }
}

function notifyStatus(): void {
  for (const listener of listeners) listener()
}

/** Oldest-first eviction keeps the most recent context, as the UI buffer does. */
function enforceBufferLimits(): void {
  while (
    pending.length > RENDERER_BUFFER_MAX_RECORDS ||
    pendingBytes > RENDERER_BUFFER_MAX_BYTES
  ) {
    const evicted = pending.shift()
    if (!evicted) break
    pendingBytes -= evicted.bytes
    counters.queueOverflow += 1
  }
}

function enqueue(event: ConsoleLogEvent): void {
  if (!isPersistable(event)) return
  const record = toRecord(event)
  const bytes = utf8Bytes(JSON.stringify(record))
  pending.push({ record, bytes })
  pendingBytes += bytes
  enforceBufferLimits()
  notifyStatus()
  if (!paused && batchReady()) void scheduleFlush()
}

function batchReady(): boolean {
  return (
    pending.length >= RENDERER_BATCH_MAX_RECORDS ||
    pendingBytes >= RENDERER_BATCH_MAX_BYTES
  )
}

/** Remove up to one batch from the front, respecting both batch limits. */
function takeBatch(): RendererLogRecord[] {
  const batch: RendererLogRecord[] = []
  while (batch.length < RENDERER_BATCH_MAX_RECORDS && pending.length > 0) {
    const next = pending[0]
    batch.push(next.record)
    // Check the real serialized size (the backend re-checks it) rather than
    // adding up per-record estimates.
    if (batch.length > 1 && utf8Bytes(JSON.stringify(batch)) > RENDERER_BATCH_MAX_BYTES) {
      batch.pop()
      break
    }
    pending.shift()
    pendingBytes -= next.bytes
  }
  return batch
}

async function flushOnce(): Promise<void> {
  while (!paused && pending.length > 0) {
    const batch = takeBatch()
    if (batch.length === 0) return
    const generation = writeGeneration
    try {
      const result = await getApi().console.appendRendererLogs(batch)
      if (generation === writeGeneration) {
        counters.rejected += Math.max(0, Number(result?.rejected) || 0)
      }
    } catch {
      if (generation === writeGeneration) counters.ipcFailed += 1
      // The failed batch is dropped; retrying a broken IPC immediately would
      // storm without making progress.
      notifyStatus()
      return
    }
    notifyStatus()
  }
}

function scheduleFlush(): Promise<void> {
  if (inFlight) return inFlight
  const promise = flushOnce()
  const tracked = promise.finally(() => {
    if (inFlight === tracked) inFlight = null
  })
  inFlight = tracked
  return tracked
}

/** Flush whatever is pending now; exposed for tests and shutdown paths. */
export function flushRendererLogBridge(): Promise<void> {
  if (paused) return inFlight ?? Promise.resolve()
  return scheduleFlush()
}

/**
 * Enter the clear protocol: new logs go to the next generation, unsent old
 * batches are dropped, and the in-flight batch is awaited so the caller can
 * clear the files knowing nothing older will arrive afterwards.
 */
export async function beginRendererLogClear(): Promise<void> {
  paused = true
  writeGeneration += 1
  if (pending.length > 0) {
    counters.droppedByClear += pending.length
    pending = []
    pendingBytes = 0
    notifyStatus()
  }
  if (inFlight) {
    try {
      await inFlight
    } catch {
      // A settling failure is already counted; the clear can proceed.
    }
  }
}

/** Leave the clear protocol and send anything buffered during the clear. */
export function endRendererLogClear(): void {
  paused = false
  notifyStatus()
  if (pending.length > 0) void scheduleFlush()
}

export function getRendererLogBridgeStatus(): RendererLogBridgeStatus {
  return { ...counters }
}

export function subscribeRendererLogBridgeStatus(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Install the bridge once. The renderer console tap must already be installed
 * (`installRendererConsoleTap`) so the bus exists; calling order is enforced in
 * `main.tsx`.
 */
export function installRendererLogBridge(): void {
  if (installed) return
  installed = true
  unsubscribeBus = subscribeRendererConsole(enqueue)
  timer = setInterval(() => {
    if (!paused) void scheduleFlush()
  }, RENDERER_FLUSH_INTERVAL_MS)
}

/** Tests can uninstall to avoid leaking a global interval between cases. */
export function uninstallRendererLogBridge(): void {
  if (!installed) return
  installed = false
  unsubscribeBus?.()
  unsubscribeBus = null
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
}
