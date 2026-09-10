import type { ApiKey, ClientKind, CreateApiKeyInput, UpdateApiKeyInput } from '@shared/types'

/**
 * How the editor was opened. Both `create` and `duplicate` produce a new record
 * and only differ in where their initial values come from; `edit` writes back to
 * an existing id. Keeping this explicit means the flow never depends on an empty
 * id standing in for "new".
 */
export type KeyEditMode = 'create' | 'edit' | 'duplicate'

export type ApiKeyEditorInput = Omit<CreateApiKeyInput, 'types'> & {
  id?: string
  mode: KeyEditMode
  types: ClientKind[]
}

export function toCreateApiKeyInput(input: ApiKeyEditorInput): CreateApiKeyInput {
  const { id, mode, ...createInput } = input
  void id
  void mode
  return createInput
}

export function toUpdateApiKeyInput(input: ApiKeyEditorInput): UpdateApiKeyInput {
  if (!input.id) {
    throw new Error('API key id is required when updating')
  }

  const { id, mode, providerId, ...updateInput } = input
  void mode
  void providerId
  return { id, ...updateInput }
}

/**
 * Draft for "copy key": the same credential and configuration, aimed at a
 * second model mapping. The key value, client overrides, model mapping, CLI
 * config and quota settings all carry over.
 *
 * Identity and per-instance state do not: the copy gets a fresh id from the
 * create path, and starts without cached quota, exhaustion, failover state or
 * request history. Json payloads are cloned so editing the draft cannot reach
 * back into the source key.
 */
export function buildDuplicatedKeyDraft(source: ApiKey, aliasSuffix = ' (copy)'): ApiKey {
  return {
    ...source,
    id: '',
    alias: source.alias ? `${source.alias}${aliasSuffix}` : '',
    types: [...source.types],
    config: cloneJson(source.config),
    clientConfigs: cloneJson(source.clientConfigs),
    priority: 0,
    isExhausted: false,
    cachedUsage: null,
    lastUsageCheckedAt: null,
    cooldownUntil: null,
    lastErrorAt: null,
    lastErrorKind: null,
    consecutiveErrors: 0,
  }
}

function cloneJson<T>(value: T | undefined): T | undefined {
  if (value === undefined || value === null) return value
  return JSON.parse(JSON.stringify(value)) as T
}
