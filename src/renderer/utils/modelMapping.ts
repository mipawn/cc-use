import type { ClientKind, ClientModel } from '@shared/types'
export type { ClientModel } from '@shared/types'

export const CLAUDE_CODE_MODEL_ENV_KEYS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
] as const

export type CatalogMode = 'provider' | 'append' | 'custom'
export type ForwardMode = 'follow' | 'fixed' | 'family'

/** Claude Desktop role slots. Each exposes one catalog model under a
 * canonical Claude route id so Desktop's tier and effort controls apply. */
export type ClientRole = 'sonnet' | 'opus' | 'haiku' | 'fable'
export const CLIENT_ROLES: ClientRole[] = ['sonnet', 'opus', 'haiku', 'fable']
export const ROLE_ROUTE_IDS: Record<ClientRole, string> = {
  sonnet: 'claude-sonnet-5',
  opus: 'claude-opus-5',
  haiku: 'claude-haiku-4-5',
  fable: 'claude-fable-5',
}
export type ClientRoles = Record<ClientRole, string>
export const emptyRoles = (): ClientRoles => ({ sonnet: '', opus: '', haiku: '', fable: '' })

export interface ClientCatalog {
  models: ClientModel[]
  fromCache: boolean
  fetchedAt: string
  error?: string
}

/** Match the exact client ID, including the supported 1M spelling offered by Code. */
export function isCatalogModelId(models: readonly ClientModel[], id: string): boolean {
  return models.some(
    (model) => model.id === id || (model.supports1m === true && `${model.id}[1m]` === id),
  )
}

export interface ClientModelConfig {
  catalogMode: CatalogMode
  models: ClientModel[]
  /** Existing provider-mode runtime metadata; ordinary selection drafts never populate this. */
  providerRuntimeModels?: ClientModel[]
  roles: ClientRoles
  defaultModel: string
  forwardMode: ForwardMode
  upstreamModel: string
  haiku: string
  sonnet: string
  opus: string
}
export interface ModelMappingFields {
  clients: Record<ClientKind, ClientModelConfig>
  autoMode: { enabled: boolean; model: string }
}
const emptyClient = (): ClientModelConfig => ({
  catalogMode: 'provider',
  models: [],
  roles: emptyRoles(),
  defaultModel: '',
  forwardMode: 'follow',
  upstreamModel: '',
  haiku: '',
  sonnet: '',
  opus: '',
})
export const EMPTY_MODEL_MAPPING: ModelMappingFields = {
  clients: {
    claude_code: emptyClient(),
    claude_desktop: emptyClient(),
    codex: emptyClient(),
    grok: emptyClient(),
  },
  autoMode: { enabled: false, model: '' },
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const string = (value: unknown) => (typeof value === 'string' ? value : '')
const readModels = (value: unknown): ClientModel[] =>
  Array.isArray(value)
    ? value.flatMap((item) => {
        const model = object(item)
        return typeof model.id === 'string'
          ? [
              {
                id: model.id,
                displayName: string(model.displayName),
                supports1m: model.supports1m === true,
              },
            ]
          : []
      })
    : []
const kinds: ClientKind[] = ['claude_code', 'claude_desktop', 'codex', 'grok']

export function parseModelMapping(value?: string | null): ModelMappingFields {
  let parsed: Record<string, unknown> = {}
  try {
    parsed = object(JSON.parse(value || '{}'))
  } catch {
    /* Invalid stored JSON starts empty. */
  }
  const scoped = parsed.version === 2
  const scopes = object(parsed.clients)
  const clients = Object.fromEntries(
    kinds.map((kind) => {
      const scope = object(scopes[kind])
      const catalog = object(scope.catalog)
      const upstream = scoped ? object(scope.upstream) : parsed
      const upstreamModel = string(
        scoped ? upstream.model : kind === 'codex' || kind === 'grok' ? parsed[kind] : undefined,
      )
      const family = {
        haiku: string(upstream.haiku),
        sonnet: string(upstream.sonnet),
        opus: string(upstream.opus),
      }
      const runtimeModels = catalog.models ?? scope.models
      // Provider-mode selections are editor state, not runtime catalog overrides.
      const draftOnly = catalog.mode === 'provider' && Array.isArray(catalog.draftModels)
      const providerRuntimeModels = readModels(runtimeModels)
      const models = draftOnly ? readModels(catalog.draftModels) : providerRuntimeModels
      const catalogMode: CatalogMode =
        catalog.mode === 'append' || catalog.mode === 'custom'
          ? catalog.mode
          : !Object.keys(catalog).length && models.length
            ? 'custom'
            : 'provider'
      // Provider roles stay explicit: inferring from legacy metadata would
      // change existing configurations and resurrect cleared role slots.
      const roleModelIds = models.map((model) => model.id)
      const rawRoles = object(catalog.roles ?? scope.roles)
      const roles = emptyRoles()
      for (const role of CLIENT_ROLES) {
        const assigned = string(rawRoles[role]).trim()
        roles[role] =
          assigned ||
          (kind === 'claude_desktop' && catalogMode !== 'provider'
            ? (roleModelIds.find((id) => id.toLowerCase().includes(role)) ?? '')
            : '')
      }
      const forwardMode: ForwardMode =
        upstream.mode === 'follow'
          ? 'follow'
          : kind === 'claude_code' &&
              (upstream.mode === 'family' ||
                (!upstream.mode && Object.values(family).some(Boolean)))
            ? 'family'
            : upstream.mode === 'fixed' || (!upstream.mode && upstreamModel)
              ? 'fixed'
              : 'follow'
      return [
        kind,
        {
          ...emptyClient(),
          catalogMode,
          models,
          ...(catalogMode === 'provider' && providerRuntimeModels.length
            ? { providerRuntimeModels }
            : {}),
          roles,
          defaultModel: string(
            kind === 'grok' ? (scoped ? scope.model : parsed.grok) : catalog.defaultModel,
          ),
          forwardMode,
          upstreamModel,
          ...(kind === 'claude_code' ? family : {}),
        },
      ]
    }),
  ) as Record<ClientKind, ClientModelConfig>
  const code = scoped ? object(object(scopes.claude_code).upstream) : parsed
  const auto = object(code.autoMode)
  return {
    clients,
    autoMode: {
      enabled: auto.enabled === true,
      model: string(auto.model),
    },
  }
}

export function serializeModelMapping(fields: ModelMappingFields): string | undefined {
  let configured = fields.autoMode.enabled
  const clients = Object.fromEntries(
    kinds.map((kind) => {
      const config = fields.clients[kind]
      const upstream: Record<string, unknown> = { mode: config.forwardMode }
      if (config.forwardMode === 'fixed') upstream.model = config.upstreamModel.trim()
      if (kind === 'claude_code' && config.forwardMode === 'family') {
        for (const family of ['haiku', 'sonnet', 'opus'] as const)
          if (config[family].trim()) upstream[family] = config[family].trim()
      }
      if (kind === 'claude_code' && fields.autoMode.enabled)
        upstream.autoMode = {
          enabled: true,
          ...(fields.autoMode.model.trim() ? { model: fields.autoMode.model.trim() } : {}),
        }
      const roles = Object.fromEntries(
        CLIENT_ROLES.map((role) => [role, config.roles[role].trim()]),
      ) as ClientRoles
      const assignedRoles =
        kind === 'claude_desktop'
          ? Object.fromEntries(Object.entries(roles).filter(([, model]) => Boolean(model)))
          : {}
      const providerRuntimeModels =
        config.catalogMode === 'provider' ? (config.providerRuntimeModels ?? []) : []
      const serializeModels = (models: ClientModel[]) =>
        models.map(({ id, displayName, supports1m }) => ({
          id: id.trim(),
          displayName: displayName.trim() || id.trim(),
          ...(supports1m ? { supports1m: true } : {}),
        }))
      configured ||= kind !== 'grok' && providerRuntimeModels.length > 0
      const catalog = {
        mode: config.catalogMode,
        ...(config.catalogMode !== 'provider' ||
        config.models.length ||
        providerRuntimeModels.length
          ? {
              [config.catalogMode === 'provider' ? 'draftModels' : 'models']: serializeModels(
                config.models,
              ),
            }
          : {}),
        ...(providerRuntimeModels.length ? { models: serializeModels(providerRuntimeModels) } : {}),
        ...(Object.keys(assignedRoles).length ? { roles: assignedRoles } : {}),
        ...(kind === 'codex' && config.defaultModel.trim()
          ? { defaultModel: config.defaultModel.trim() }
          : {}),
      }
      configured ||=
        config.forwardMode !== 'follow' ||
        Boolean(config.defaultModel.trim()) ||
        Object.keys(assignedRoles).length > 0 ||
        (kind !== 'grok' && (config.catalogMode !== 'provider' || config.models.length > 0))
      return [
        kind,
        {
          ...(kind === 'grok'
            ? config.defaultModel.trim()
              ? { model: config.defaultModel.trim() }
              : {}
            : { catalog }),
          upstream,
        },
      ]
    }),
  )
  return configured ? JSON.stringify({ version: 2, clients }) : undefined
}

export function modelMappingValueForSave(
  fields: ModelMappingFields,
  editing: boolean,
): string | undefined {
  return serializeModelMapping(fields) ?? (editing ? '' : undefined)
}

export function validateModelMapping(
  fields: ModelMappingFields,
  types: ClientKind[] = kinds,
): { key: string; clientKind: ClientKind } | undefined {
  for (const kind of types) {
    const config = fields.clients[kind]
    if (config.forwardMode === 'fixed' && !config.upstreamModel.trim())
      return { key: 'upstreamModelRequired', clientKind: kind }
    if (kind === 'claude_desktop' && config.catalogMode !== 'provider') {
      const ids = config.models.map(({ id }) => id.trim())
      const orphaned = CLIENT_ROLES.find(
        (role) => config.roles[role].trim() && !ids.includes(config.roles[role].trim()),
      )
      if (orphaned) return { key: 'clientRoleModelInvalid', clientKind: kind }
    }
    if (kind === 'grok') continue
    if (config.catalogMode === 'custom' && !config.models.length)
      return { key: 'clientModelsRequired', clientKind: kind }
    if (config.catalogMode !== 'provider') {
      if (
        config.models.some(
          ({ id }) => !id.trim() || /^https?:\/\//i.test(id.trim()) || /\s/.test(id.trim()),
        )
      )
        return { key: 'clientModelIdRequired', clientKind: kind }
      const ids = config.models.map(({ id }) => id.trim())
      if (new Set(ids).size !== ids.length) return { key: 'clientModelDuplicate', clientKind: kind }
      if (
        kind === 'codex' &&
        config.catalogMode === 'custom' &&
        config.defaultModel &&
        !ids.includes(config.defaultModel.trim())
      )
        return { key: 'clientDefaultInvalid', clientKind: kind }
    }
  }
}
