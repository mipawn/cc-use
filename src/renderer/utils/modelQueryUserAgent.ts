import type { ApiKey, ClientKind } from '@shared/types'
import { getApi } from '../api'

const writes = new Map<string, Promise<void>>()
const scope = (providerId: string, clientKind: ClientKind) =>
  JSON.stringify([providerId, clientKind])

export async function readQueryUserAgent(
  providerId: string,
  clientKind: ClientKind,
  fallback = '',
) {
  await writes.get(scope(providerId, clientKind))?.catch(() => {})
  return (await getApi().userAgent.getQueryPreference(providerId, clientKind)) ?? fallback
}

/** Serialize writes so a slow earlier selection cannot overwrite a newer one. */
export function rememberQueryUserAgent(providerId: string, clientKind: ClientKind, value: string) {
  const key = scope(providerId, clientKind)
  const next = (writes.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(() => getApi().userAgent.saveQueryPreference(providerId, clientKind, value.trim()))
  writes.set(key, next)
  const cleanup = () => {
    if (writes.get(key) === next) writes.delete(key)
  }
  void next.then(cleanup, cleanup)
  return next
}

/** Matches the provider query's preferred route, including legacy Claude keys. */
export function modelQueryClientKind(key: Pick<ApiKey, 'types'>): ClientKind {
  // Stored rows can still carry the legacy `claude` type.
  const kinds = (key.types as string[]).map((kind) => (kind === 'claude' ? 'claude_code' : kind))
  const preferred = (['codex', 'grok'] as const).find((kind) => kinds.includes(kind))
  return (preferred ?? kinds[0] ?? 'claude_code') as ClientKind
}
