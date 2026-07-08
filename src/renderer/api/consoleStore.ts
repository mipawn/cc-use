/**
 * Process-long console event store.
 *
 * Behaves like a real terminal buffer: events accumulate for the lifetime of
 * the renderer process. Navigating away from the Console page does NOT clear
 * history; only explicit "clear" button or a full app reload resets it.
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

let events: ConsoleEvent[] = []
const bus = new EventTarget()
const CHANGE = 'change'

function commit(next: ConsoleEvent[]) {
  // New array reference every commit so useSyncExternalStore's snapshot
  // equality check triggers a re-render.
  events = next
  bus.dispatchEvent(new Event(CHANGE))
}

function append(event: ConsoleEvent) {
  const next = mergeConsoleEventList(events, event)
  commit(next.length > BUFFER_LIMIT ? next.slice(next.length - BUFFER_LIMIT) : next)
}

export function mergeConsoleEventList(
  current: ConsoleEvent[],
  event: ConsoleEvent,
): ConsoleEvent[] {
  if (event.category !== 'request' || !event.requestId) {
    return current.concat(event)
  }

  const existingIndex = current.findIndex(
    (item) => item.category === 'request' && item.requestId === event.requestId,
  )
  if (existingIndex === -1) {
    return current.concat(event)
  }

  const next = current.slice()
  const previous = current[existingIndex]
  next[existingIndex] =
    previous.category === 'request'
      ? {
          ...previous,
          ...event,
          requestHeaders: event.requestHeaders ?? previous.requestHeaders,
          requestBody: event.requestBody ?? previous.requestBody,
          responseHeaders: event.responseHeaders ?? previous.responseHeaders,
          responseBody: event.responseBody ?? previous.responseBody,
        }
      : event
  return next
}

export function getConsoleEvents(): ConsoleEvent[] {
  return events
}

export function clearConsoleEvents(): void {
  if (events.length === 0) return
  commit([])
}

export function subscribeConsoleStore(listener: () => void): () => void {
  bus.addEventListener(CHANGE, listener)
  return () => bus.removeEventListener(CHANGE, listener)
}

let installed = false

/// Wire up the two event sources. Idempotent — safe to call more than once.
/// Call this at app bootstrap so events start accumulating even before the
/// user visits the Console page.
export function installConsoleStore(): void {
  if (installed) return
  installed = true
  getApi().console.onEvent(append)
  subscribeRendererConsole(append)
}

export const CONSOLE_BUFFER_LIMIT = BUFFER_LIMIT
