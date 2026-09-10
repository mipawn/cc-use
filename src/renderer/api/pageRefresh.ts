/**
 * Per-page refresh registry.
 *
 * `⌘R` re-reads what is on screen instead of reloading the whole WebView, so
 * time ranges, filters, pagination, scroll position and unsaved drafts survive.
 * Every mounted data source registers its own loading routine; an embedded page
 * contributes alongside the shell that hosts it, and both unregister on unmount.
 *
 * This stays a registry rather than a cache framework: refreshing means calling
 * the loader each part already uses.
 */

export type PageRefreshHandler = () => void | Promise<void>

const handlers = new Set<PageRefreshHandler>()

/** Register a refresh routine; returns the unregister function. */
export function registerPageRefresh(handler: PageRefreshHandler): () => void {
  handlers.add(handler)
  return () => {
    handlers.delete(handler)
  }
}

/** Whether anything mounted can refresh its own data. */
export function hasPageRefresh(): boolean {
  return handlers.size > 0
}

/**
 * Refresh everything currently mounted. Resolves `false` when nothing was
 * registered, so callers can say so instead of falling back to a full reload.
 *
 * Each handler guards its own staleness, and one failure does not stop the
 * others.
 */
export async function refreshCurrentPage(): Promise<boolean> {
  if (handlers.size === 0) return false
  const pending = Array.from(handlers, (handler) => Promise.resolve().then(handler))
  await Promise.allSettled(pending)
  return true
}
