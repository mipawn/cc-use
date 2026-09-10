import type {
  ApiKey,
  ClientConfig,
  CliConfig,
  ClientKind,
  CreateApiKeyInput,
  ProviderDefaultKeyConfig,
  UpdateApiKeyInput,
} from '@shared/types'
import { parseModelMapping } from './modelMapping'

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
  usageType: 'none' | 'newapi' | 'custom'
  usageUrl: string
  usagePath: string
  usageHeaders: string
  mapping: ReturnType<typeof parseModelMapping>
}

/**
 * Starting values for a new key.
 *
 * A provider created from a preset carries a complete `defaultKeyConfig`, and
 * that is what a new key inherits — so filling in only the key value still
 * stores the endpoints, model mapping and quota settings. Providers saved
 * before v3.10.0 have none, and keep the behaviour they had: the DeepSeek
 * detection below, or a bare Claude Code default.
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
    usageType: 'none',
    usageUrl: '',
    usagePath: '',
    usageHeaders: '',
    mapping: parseModelMapping(null),
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
      mapping: parseModelMapping(
        JSON.stringify({
          haiku: 'deepseek-v4-flash',
          sonnet: 'deepseek-v4-pro[1m]',
          opus: 'deepseek-v4-pro[1m]',
        }),
      ),
    }
  }

  const mapping = parseModelMapping(providerDefault.modelMapping ?? null)
  const usageType = providerDefault.usageType ?? 'none'
  const claudeConfig = { ...(providerDefault.config ?? {}) } as CliConfig
  delete claudeConfig.prelaunchCommand

  return {
    types: providerDefault.types?.length ? [...providerDefault.types] : empty.types,
    clientConfigs: cloneJson(providerDefault.clientConfigs) ?? {},
    claudeConfigJson: JSON.stringify(claudeConfig, null, 2),
    usageType,
    usageUrl: providerDefault.usageUrl ?? '',
    usagePath: providerDefault.usagePath ?? '',
    usageHeaders: formatJsonOrRaw(providerDefault.usageHeaders),
    mapping,
  }
}

/** Pretty-print a JSON string for an editor, leaving anything else as-is. */
function formatJsonOrRaw(value: string | undefined): string {
  if (!value) return ''
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return value
  }
}
