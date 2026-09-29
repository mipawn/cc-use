import type { ClientConfig, ClientKind } from '@shared/types'

/** The per-client configuration map stored on a key. */
export type ClientConfigs = Partial<Record<ClientKind, ClientConfig>>

/**
 * Apply a patch to one client's configuration.
 *
 * Two rules, both about not storing noise:
 *
 * - A field that is blank after trimming is removed rather than saved as an
 *   empty string, so "not set" and "set to nothing" stay the same state.
 * - The entry itself is removed once no field is left. The danger is the
 *   inverse: every field has to be counted in that test. A field left out of
 *   it silently takes the whole entry with it, which is how a User-Agent
 *   chosen on its own disappears the moment it is saved.
 */
export function mergeClientConfig(
  configs: ClientConfigs,
  clientKind: ClientKind,
  patch: Partial<ClientConfig>,
): ClientConfigs {
  const next = { ...configs }
  const merged: ClientConfig = { ...(next[clientKind] || {}), ...patch }

  if (!merged.baseUrl?.trim()) delete merged.baseUrl
  if (!merged.authScheme) delete merged.authScheme
  if (!merged.proxyUserAgent?.trim()) delete merged.proxyUserAgent

  if (!merged.baseUrl && !merged.authScheme && !merged.proxyUserAgent) {
    delete next[clientKind]
  } else {
    next[clientKind] = merged
  }

  return next
}

/** Whether a client has anything configured of its own. */
export function hasClientOverride(config: ClientConfig | undefined): boolean {
  return Boolean(
    config && (config.baseUrl?.trim() || config.authScheme || config.proxyUserAgent?.trim()),
  )
}
