/**
 * Renderer console tap + in-process event bus.
 *
 * Patches the global `console.*` methods so every `console.log / info / warn /
 * error / debug` call from the renderer is observable on the Console page as
 * a `ConsoleLogEvent` (source = "renderer"). The original console is still
 * called first, so devtools behavior is unchanged.
 *
 * The bus is renderer-local — there's no IPC hop for renderer logs because
 * the Console page runs in the same process. The Console page subscribes to
 * this bus in addition to the Tauri `proxy:consoleEvent` channel, so it
 * observes all three sources (daemon / app / renderer) in one pane.
 *
 * Identity: every renderer line gets `renderer-<startup epoch>-<seq>`. The
 * epoch is random per page load and the sequence is per page, so a record that
 * was replayed from disk after a reload can never collide with a new live
 * line. The live event and the persisted copy share the same id, which is what
 * lets the console store collapse them into one row.
 */
import type { ConsoleLogEvent } from '../../shared/types'

type Level = 'error' | 'warn' | 'info' | 'debug'

const EVENT_NAME = 'cc-use:renderer-console'
const bus = new EventTarget()

/** Random per-page-load identity, sanitised to the backend's id alphabet. */
const STARTUP_EPOCH = createStartupEpoch()

function createStartupEpoch(): string {
  const entropy =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return entropy.replace(/[^a-z0-9]/gi, '').slice(0, 16) || 'epoch'
}

/** The id epoch every renderer line in this page load is stamped with. */
export function getRendererStartupEpoch(): string {
  return STARTUP_EPOCH
}

let installed = false
// Re-entry guard: if a subscriber synchronously calls `console.*`, the patched
// method must still write to the real console (preserving devtools output)
// but must not dispatch a second bus event — that would recurse forever.
let dispatching = false

/// Subscribe to renderer console events. Returns an unsubscribe fn.
export function subscribeRendererConsole(callback: (event: ConsoleLogEvent) => void): () => void {
  const handler = (evt: Event) => {
    callback((evt as CustomEvent<ConsoleLogEvent>).detail)
  }
  bus.addEventListener(EVENT_NAME, handler)
  return () => bus.removeEventListener(EVENT_NAME, handler)
}

/// Install the console patch once. Idempotent — safe to call from multiple
/// entry points, only the first call wins.
export function installRendererConsoleTap(): void {
  if (installed) return
  installed = true

  const original: Record<Level, (...args: unknown[]) => void> = {
    error: console.error.bind(console),
    warn: console.warn.bind(console),
    info: console.info.bind(console),
    debug: console.debug.bind(console),
  }

  const patch =
    (level: Level) =>
    (...args: unknown[]) => {
      original[level](...args)
      if (dispatching) return
      dispatching = true
      try {
        bus.dispatchEvent(
          new CustomEvent<ConsoleLogEvent>(EVENT_NAME, {
            detail: {
              category: 'log',
              // The same id reaches the Console page live and the persistence
              // bridge, so the on-disk copy merges back into one row after a
              // reload instead of duplicating.
              id: nextRendererEventId(),
              timestamp: nowTimestamp(),
              level,
              source: 'renderer',
              target: null,
              message: args.map(formatArg).join(' '),
            },
          }),
        )
      } finally {
        dispatching = false
      }
    }

  console.error = patch('error')
  console.warn = patch('warn')
  console.info = patch('info')
  console.debug = patch('debug')
  // `console.log` has no dedicated log level semantically — convention is
  // "info". Treat it as info so it colors correctly in the Console page.
  console.log = patch('info')
}

function formatArg(arg: unknown): string {
  if (typeof arg === 'string') return arg
  if (arg instanceof Error) {
    return arg.stack || `${arg.name}: ${arg.message}`
  }
  try {
    return JSON.stringify(arg)
  } catch {
    return String(arg)
  }
}

let rendererSeq = 0

/** `renderer-<startup epoch>-<seq>`; unique across page reloads. */
export function nextRendererEventId(): string {
  rendererSeq += 1
  return `renderer-${STARTUP_EPOCH}-${rendererSeq}`
}

/** UTC `YYYY-MM-DD HH:MM:SS`, the format the Rust store parses. */
export function nowTimestamp(): string {
  const d = new Date()
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  const ss = String(d.getUTCSeconds()).padStart(2, '0')
  return `${y}-${m}-${dd} ${hh}:${mm}:${ss}`
}
