import type {
  ApiKey,
  ClientConfig,
  CliConfig,
  ClientKind,
  CreateApiKeyInput,
  ProviderDefaultKeyConfig,
  UpdateApiKeyInput,
} from '@shared/types'
import { parseModelMapping, type ModelMappingFields } from './modelMapping'
import { STARTER_ACCOUNT_SCRIPT } from './providerQueryDefaults'

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

/** Everything a brand-new key starts with, before the user types anything. */
export interface NewKeyDefaults {
  types: ClientKind[]
  clientConfigs: Partial<Record<ClientKind, ClientConfig>>
  claudeConfigJson: string
  /**
   * This key's own quota query. Filled in from the start so the shape is
   * visible; whether it runs is decided by the caller's switch, not by the
   * field being non-empty.
   */
  usageScript: string
  mapping: ReturnType<typeof parseModelMapping>
}

/**
 * The mapping a brand-new key starts from.
 *
 * Auto mode is on unless the provider's template says otherwise: it only
 * reshapes the permission-classifier requests, and leaving it off means the
 * classifier answers about a model the user did not pick. A template that
 * states `autoMode.enabled` explicitly still wins, so a provider that cannot
 * take the rewrite can say so.
 */
function newKeyMapping(json: string | null | undefined): ModelMappingFields {
  const mapping = parseModelMapping(json)
  if (!statesAutoMode(json)) {
    return { ...mapping, autoMode: { ...mapping.autoMode, enabled: true } }
  }
  return mapping
}

function statesAutoMode(json: string | null | undefined): boolean {
  if (!json) return false
  try {
    const parsed = JSON.parse(json) as { autoMode?: { enabled?: unknown } } | null
    return typeof parsed?.autoMode?.enabled === 'boolean'
  } catch {
    return false
  }
}

/**
 * Starting values for a new key.
 *
 * A provider created from a preset carries a complete `defaultKeyConfig`, and
 * that is what a new key inherits — so filling in only the key value still
 * stores the endpoints, model mapping and config. Providers saved before
 * v3.10.0 have none, and keep the behaviour they had: the DeepSeek detection
 * below, or a bare Claude Code default.
 *
 * The defaults are a snapshot, not a live link: changing the provider later
 * never rewrites an existing key.
 */
export function newKeyDefaults(
  providerDefault: ProviderDefaultKeyConfig | null | undefined,
  legacyOfficialDeepSeek: boolean,
): NewKeyDefaults {
  const empty: NewKeyDefaults = {
    types: ['claude_code'],
    clientConfigs: {},
    claudeConfigJson: '{}',
    usageScript: STARTER_ACCOUNT_SCRIPT,
    mapping: newKeyMapping(null),
  }

  if (!providerDefault) {
    if (!legacyOfficialDeepSeek) return empty
    // v3.10.0-era behaviour for a DeepSeek provider that predates presets.
    return {
      ...empty,
      types: ['claude_code', 'codex', 'claude_desktop'],
      clientConfigs: {
        claude_code: { baseUrl: 'https://api.deepseek.com/anthropic', authScheme: 'bearer' },
        codex: { baseUrl: 'https://api.deepseek.com', authScheme: 'bearer' },
        claude_desktop: {
          baseUrl: 'https://api.deepseek.com/anthropic',
          authScheme: 'bearer',
        },
      },
      mapping: newKeyMapping(
        JSON.stringify({
          haiku: 'deepseek-v4-flash',
          sonnet: 'deepseek-v4-pro[1m]',
          opus: 'deepseek-v4-pro[1m]',
        }),
      ),
    }
  }

  const claudeConfig = { ...(providerDefault.config ?? {}) } as CliConfig
  delete claudeConfig.prelaunchCommand

  return {
    types: providerDefault.types?.length ? [...providerDefault.types] : empty.types,
    clientConfigs: cloneJson(providerDefault.clientConfigs) ?? {},
    claudeConfigJson: JSON.stringify(claudeConfig, null, 2),
    usageScript: providerDefault.usageScript || STARTER_ACCOUNT_SCRIPT,
    mapping: newKeyMapping(providerDefault.modelMapping),
  }
}
