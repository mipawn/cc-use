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
 */
import type { ConsoleLogEvent } from '../../shared/types'

type Level = 'error' | 'warn' | 'info' | 'debug'

const EVENT_NAME = 'cc-use:renderer-console'
const bus = new EventTarget()

let installed = false
// Re-entry guard: if a subscriber synchronously calls `console.*`, the patched
// method must still write to the real console (preserving devtools output)
// but must not dispatch a second bus event — that would recurse forever.
let dispatching = false

/// Subscribe to renderer console events. Returns an unsubscribe fn.
export function subscribeRendererConsole(
  callback: (event: ConsoleLogEvent) => void,
): () => void {
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

  const patch = (level: Level) => (...args: unknown[]) => {
    original[level](...args)
    if (dispatching) return
    dispatching = true
    try {
      bus.dispatchEvent(
        new CustomEvent<ConsoleLogEvent>(EVENT_NAME, {
          detail: {
            category: 'log',
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

function nowTimestamp(): string {
  const d = new Date()
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  const ss = String(d.getUTCSeconds()).padStart(2, '0')
  return `${y}-${m}-${dd} ${hh}:${mm}:${ss}`
}
