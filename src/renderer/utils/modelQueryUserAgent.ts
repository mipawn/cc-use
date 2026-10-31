import type { ClientKind } from '@shared/types'
import { getApi } from '../api'

/**
 * Read the legacy per-provider/launchpad query User-Agent preference.
 *
 * The model management flow treats the query UA as a per-query draft: it is
 * seeded from this value once, and applying a new UA re-queries with that value
 * instead of remembering it. Nothing in the renderer writes this preference any
 * more, so the forwarded User-Agent saved on the connection tab is never
 * affected by a model query. This also removes the old codex → grok → first
 * client preference picker that silently chose a different launchpad.
 */
export async function readQueryUserAgent(
  providerId: string,
  clientKind: ClientKind,
  fallback = '',
) {
  return (await getApi().userAgent.getQueryPreference(providerId, clientKind)) ?? fallback
}
