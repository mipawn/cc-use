/**
 * What a hand-written query script is actually asking about.
 *
 * The key scope answers one question only: how much does this key have left.
 * A script whose request points at an account endpoint asks the account
 * question, and the runtime refuses to run it as a key quota. Detecting the
 * shape here is only an explanation, never a rewrite: the original text stays
 * stored verbatim and the user is pointed at the built-in per-key scheme.
 */

/** Substrings that make a script read as an account-level query. */
const ACCOUNT_SCRIPT_MARKERS = [
  '/api/user/self',
  '/api/user/balance',
  'api.deepseek.com/user/balance',
]

/**
 * Whether the script likely targets an account endpoint instead of this key.
 * Comparison is case-insensitive on the raw text; matching is a prompt for
 * repair, not proof — the runtime guard stays the authority.
 */
export function isAccountShapedScript(script: string | null | undefined): boolean {
  const text = (script ?? '').toLowerCase()
  if (!text.trim()) return false
  return ACCOUNT_SCRIPT_MARKERS.some((marker) => text.includes(marker))
}
