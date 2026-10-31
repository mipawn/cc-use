import { expect, it } from 'vitest'
import {
  EMPTY_MODEL_MAPPING,
  parseModelMapping,
  serializeModelMapping,
  modelMappingValueForSave,
  validateModelMapping,
  isCatalogModelId,
} from './modelMapping'

it('accepts exact 1M client IDs only for catalog models that support 1M', () => {
  const models = [
    { id: 'large', displayName: 'Large', supports1m: true },
    { id: 'small', displayName: 'Small', supports1m: false },
  ]
  expect(isCatalogModelId(models, 'large')).toBe(true)
  expect(isCatalogModelId(models, 'large[1m]')).toBe(true)
  expect(isCatalogModelId(models, 'small')).toBe(true)
  for (const id of ['small[1m]', 'large[1M]', 'LARGE[1m]', 'large[1m][1m]', 'unknown[1m]']) {
    expect(isCatalogModelId(models, id)).toBe(false)
  }
})

it('reads legacy family settings only into Code and keeps empty scoped clients independent', () => {
  const legacy = parseModelMapping('{"haiku":"fast","sonnet":"pro","grok":"grok-real"}')
  expect(legacy.clients.claude_code).toMatchObject({
    forwardMode: 'family',
    haiku: 'fast',
    sonnet: 'pro',
  })
  expect(legacy.clients.claude_desktop.forwardMode).toBe('follow')
  expect(legacy.clients.grok).toMatchObject({
    defaultModel: 'grok-real',
    upstreamModel: 'grok-real',
  })
  const scoped = parseModelMapping(
    '{"version":2,"clients":{"claude_code":{"upstream":{"mode":"follow","sonnet":"ignored"}}}}',
  )
  expect(scoped.clients.claude_code.forwardMode).toBe('follow')
  expect(scoped.clients.claude_desktop.models).toEqual([])
})

it('preserves catalog modes and fixed forwarding as separate choices', () => {
  const fields = parseModelMapping(
    '{"version":2,"clients":{"codex":{"catalog":{"mode":"custom","models":[{"id":" real ","displayName":" Work "}],"defaultModel":"real"},"upstream":{"mode":"fixed","model":" target "}}}}',
  )
  const saved = JSON.parse(serializeModelMapping(fields)!)
  expect(saved.clients.codex.catalog).toEqual({
    mode: 'custom',
    models: [{ id: 'real', displayName: 'Work' }],
    defaultModel: 'real',
  })
  expect(saved.clients.codex.upstream).toEqual({ mode: 'fixed', model: 'target' })
})

it('keeps an empty custom directory invalid instead of falling back to provider discovery', () => {
  const fields = parseModelMapping(
    '{"version":2,"clients":{"claude_desktop":{"catalog":{"mode":"custom","models":[]}}}}',
  )
  expect(validateModelMapping(fields)).toEqual({
    key: 'clientModelsRequired',
    clientKind: 'claude_desktop',
  })
  expect(serializeModelMapping(fields)).toBeDefined()
  expect(modelMappingValueForSave(EMPTY_MODEL_MAPPING, true)).toBe('')
  expect(modelMappingValueForSave(EMPTY_MODEL_MAPPING, false)).toBeUndefined()
})

it('keeps the classifier model in Code and drops the retired thinking field', () => {
  const fields = parseModelMapping(
    '{"autoMode":{"enabled":true,"model":" glm-5-air ","thinking":"disabled"}}',
  )
  expect(fields.autoMode).toEqual({ enabled: true, model: ' glm-5-air ' })
  expect(JSON.parse(serializeModelMapping(fields)!).clients.claude_code.upstream.autoMode).toEqual({
    enabled: true,
    model: 'glm-5-air',
  })

  const withoutModel = parseModelMapping('{"autoMode":{"enabled":true}}')
  expect(
    JSON.parse(serializeModelMapping(withoutModel)!).clients.claude_code.upstream.autoMode,
  ).toEqual({ enabled: true })

  for (const raw of ['null', '[]', '{bad'])
    expect(parseModelMapping(raw)).toEqual(EMPTY_MODEL_MAPPING)
})

it('round-trips 1M flags and Desktop role slots, and keeps roles off other clients', () => {
  const fields = parseModelMapping(
    '{"version":2,"clients":{"claude_desktop":{"catalog":{"mode":"custom","models":[{"id":"glm-5.2","displayName":"GLM 5.2","supports1m":true},{"id":"deepseek-v4.1-flash","displayName":"V4"}],"roles":{"sonnet":"glm-5.2","opus":"deepseek-v4.1-flash"}},"upstream":{"mode":"follow"}}}}',
  )
  expect(fields.clients.claude_desktop.roles).toEqual({
    sonnet: 'glm-5.2',
    opus: 'deepseek-v4.1-flash',
    haiku: '',
    fable: '',
  })
  const saved = JSON.parse(serializeModelMapping(fields)!)
  expect(saved.clients.claude_desktop.catalog).toEqual({
    mode: 'custom',
    models: [
      { id: 'glm-5.2', displayName: 'GLM 5.2', supports1m: true },
      { id: 'deepseek-v4.1-flash', displayName: 'V4' },
    ],
    roles: { sonnet: 'glm-5.2', opus: 'deepseek-v4.1-flash' },
  })
  // Roles are a Claude-client concept; Codex keeps its own catalog shape.
  expect(saved.clients.codex.catalog?.roles).toBeUndefined()
})

it('seeds role slots from the catalog ids for Claude Desktop and drops orphaned ones', () => {
  const seeded = parseModelMapping(
    '{"version":2,"clients":{"claude_desktop":{"catalog":{"mode":"custom","models":[{"id":"claude-opus-4-8"},{"id":"claude-haiku-4-5"}]},"upstream":{"mode":"follow"}}}}',
  )
  expect(seeded.clients.claude_desktop.roles).toMatchObject({
    opus: 'claude-opus-4-8',
    haiku: 'claude-haiku-4-5',
  })
  const code = parseModelMapping(
    '{"version":2,"clients":{"claude_code":{"catalog":{"mode":"custom","models":[{"id":"claude-opus-4-8"}]},"upstream":{"mode":"follow"}}}}',
  )
  expect(code.clients.claude_code.roles.opus).toBe('')
  // Codex and Grok have no roles.
  const codex = parseModelMapping(
    '{"version":2,"clients":{"codex":{"catalog":{"mode":"custom","models":[{"id":"claude-opus-4-8"}]},"upstream":{"mode":"follow"}}}}',
  )
  expect(codex.clients.codex.roles.opus).toBe('')

  const orphaned = parseModelMapping(
    '{"version":2,"clients":{"claude_desktop":{"catalog":{"mode":"custom","models":[{"id":"glm-5.2"}],"roles":{"sonnet":"removed-model"}},"upstream":{"mode":"follow"}}}}',
  )
  expect(validateModelMapping(orphaned, ['claude_desktop'])).toEqual({
    key: 'clientRoleModelInvalid',
    clientKind: 'claude_desktop',
  })
})

it('keeps Desktop role inference and 1M metadata for append catalogs', () => {
  const models = [{ id: 'claude-sonnet-4-6', displayName: 'Sonnet', supports1m: true }]
  const fields = parseModelMapping(
    JSON.stringify({
      version: 2,
      clients: { claude_desktop: { catalog: { mode: 'append', models } } },
    }),
  )
  expect(fields.clients.claude_desktop.roles.sonnet).toBe('claude-sonnet-4-6')
  expect(JSON.parse(serializeModelMapping(fields)!).clients.claude_desktop.catalog).toEqual({
    mode: 'append',
    models,
    roles: { sonnet: 'claude-sonnet-4-6' },
  })
})

it('round-trips an append catalog with 1M flags and keeps forwarding untouched', () => {
  const fields = parseModelMapping(
    '{"version":2,"clients":{"claude_code":{"catalog":{"mode":"append","models":[{"id":"cloud-model","displayName":"Cloud","supports1m":true}]},"upstream":{"mode":"fixed","model":"target-model"}}}}',
  )
  const saved = JSON.parse(serializeModelMapping(fields)!)
  expect(saved.clients.claude_code.catalog).toEqual({
    mode: 'append',
    models: [{ id: 'cloud-model', displayName: 'Cloud', supports1m: true }],
  })
  expect(saved.clients.claude_code.upstream).toEqual({ mode: 'fixed', model: 'target-model' })
  expect(saved.clients.codex.catalog).toEqual({ mode: 'provider' })
})

it('round-trips dormant provider selections without runtime models, roles or strategy changes', () => {
  const fields = parseModelMapping(
    JSON.stringify({
      version: 2,
      clients: {
        claude_code: {
          catalog: {
            mode: 'provider',
            draftModels: [{ id: 'chosen-code', displayName: 'Code', supports1m: true }],
          },
          upstream: { mode: 'fixed', model: 'target' },
        },
        claude_desktop: {
          catalog: {
            mode: 'provider',
            draftModels: [{ id: 'claude-opus-draft', displayName: 'Draft Opus', supports1m: true }],
          },
          upstream: { mode: 'follow' },
        },
      },
    }),
  )
  expect(fields.clients.claude_code.models[0]).toEqual({
    id: 'chosen-code',
    displayName: 'Code',
    supports1m: true,
  })
  expect(fields.clients.claude_desktop.roles).toEqual({
    sonnet: '',
    opus: '',
    haiku: '',
    fable: '',
  })
  const serialized = serializeModelMapping(fields)!
  const saved = JSON.parse(serialized)
  expect(saved.clients.claude_code.catalog).toEqual({
    mode: 'provider',
    draftModels: [{ id: 'chosen-code', displayName: 'Code', supports1m: true }],
  })
  expect(saved.clients.claude_desktop.catalog).toEqual({
    mode: 'provider',
    draftModels: [{ id: 'claude-opus-draft', displayName: 'Draft Opus', supports1m: true }],
  })
  expect(saved.clients.claude_code.catalog).not.toHaveProperty('models')
  expect(saved.clients.claude_desktop.catalog).not.toHaveProperty('roles')
  const reopened = parseModelMapping(serialized)
  expect(reopened.clients.claude_desktop.roles).toEqual({
    sonnet: '',
    opus: '',
    haiku: '',
    fable: '',
  })
  expect(reopened.clients.claude_code.forwardMode).toBe('fixed')
  expect(reopened.clients.claude_code.upstreamModel).toBe('target')
})

it('persists provider-only selection independently while empty defaults remain absent', () => {
  const fields = parseModelMapping(null)
  fields.clients.codex.models = [{ id: 'kept', displayName: 'Kept', supports1m: true }]
  expect(JSON.parse(modelMappingValueForSave(fields, false)!).clients.codex.catalog).toEqual({
    mode: 'provider',
    draftModels: [{ id: 'kept', displayName: 'Kept', supports1m: true }],
  })
  expect(parseModelMapping(modelMappingValueForSave(fields, false)).clients.codex.models).toEqual(
    fields.clients.codex.models,
  )
  expect(modelMappingValueForSave(parseModelMapping(null), false)).toBeUndefined()
})

it.each(['claude_code', 'claude_desktop', 'codex'] as const)(
  'preserves legacy provider runtime models on an unchanged %s save',
  (kind) => {
    const models = [{ id: 'legacy-sonnet', displayName: 'Legacy label', supports1m: true }]
    const fields = parseModelMapping(
      JSON.stringify({
        version: 2,
        clients: {
          [kind]: {
            catalog: {
              mode: 'provider',
              models,
              ...(kind === 'claude_desktop' ? { roles: { sonnet: 'legacy-sonnet' } } : {}),
            },
            upstream: { mode: 'fixed', model: 'legacy-upstream' },
          },
        },
      }),
    )
    const client = JSON.parse(serializeModelMapping(fields)!).clients[kind]
    expect(client.catalog.models).toEqual(models)
    expect(client.catalog.draftModels).toEqual(models)
    expect(client.upstream).toEqual({ mode: 'fixed', model: 'legacy-upstream' })
    if (kind === 'claude_desktop') expect(client.catalog.roles).toEqual({ sonnet: 'legacy-sonnet' })
  },
)

it('preserves provider runtime metadata separately from existing dormant selections', () => {
  const runtime = [{ id: 'legacy-sonnet', displayName: 'Legacy label', supports1m: true }]
  const drafts = [{ id: 'draft-only', displayName: 'Dormant', supports1m: true }]
  const fields = parseModelMapping(
    JSON.stringify({
      version: 2,
      clients: {
        claude_desktop: {
          catalog: {
            mode: 'provider',
            models: runtime,
            draftModels: drafts,
            roles: { sonnet: 'legacy-sonnet' },
          },
          upstream: { mode: 'follow' },
        },
      },
    }),
  )
  expect(fields.clients.claude_desktop.models.map(({ id }) => id)).toEqual(['draft-only'])
  const catalog = JSON.parse(serializeModelMapping(fields)!).clients.claude_desktop.catalog
  expect(catalog.models).toEqual(runtime)
  expect(catalog.draftModels).toEqual(drafts)
  expect(catalog.roles).toEqual({ sonnet: 'legacy-sonnet' })
})

it.each([
  { roles: {}, expected: {} },
  { roles: { opus: 'claude-sonnet-4-6' }, expected: { opus: 'claude-sonnet-4-6' } },
  {
    roles: { sonnet: '', opus: 'claude-sonnet-4-6' },
    expected: { opus: 'claude-sonnet-4-6' },
  },
])('preserves only explicit provider Desktop roles on reopen: $roles', ({ roles, expected }) => {
  const models = [{ id: 'claude-sonnet-4-6', displayName: 'Chosen', supports1m: true }]
  const source = JSON.stringify({
    version: 2,
    clients: {
      claude_desktop: { catalog: { mode: 'provider', models, draftModels: models, roles } },
    },
  })
  const saved = serializeModelMapping(parseModelMapping(source))!
  const catalog = JSON.parse(saved).clients.claude_desktop.catalog
  expect(catalog.models).toEqual(models)
  expect(catalog.roles ?? {}).toEqual(expected)
  expect(
    JSON.parse(serializeModelMapping(parseModelMapping(saved))!).clients.claude_desktop.catalog,
  ).toEqual(catalog)
})

it('does not restore an explicitly cleared provider Desktop role from a runtime ID', () => {
  const models = [{ id: 'claude-sonnet-4-6', displayName: 'Chosen', supports1m: true }]
  const fields = parseModelMapping(
    JSON.stringify({
      version: 2,
      clients: {
        claude_desktop: {
          catalog: { mode: 'provider', models, roles: { sonnet: 'claude-sonnet-4-6' } },
        },
      },
    }),
  )
  fields.clients.claude_desktop.roles.sonnet = ''
  const saved = serializeModelMapping(fields)!
  expect(JSON.parse(saved).clients.claude_desktop.catalog.roles).toBeUndefined()
  const reopened = parseModelMapping(saved)
  expect(Object.values(reopened.clients.claude_desktop.roles).every((role) => role === '')).toBe(
    true,
  )
  expect(
    JSON.parse(serializeModelMapping(reopened)!).clients.claude_desktop.catalog.roles,
  ).toBeUndefined()
  expect(reopened.clients.claude_desktop.providerRuntimeModels).toEqual(models)
})

it('clears dormant provider choices without clearing legacy runtime metadata or restoring choices on reopen', () => {
  const models = [{ id: 'legacy', displayName: 'Legacy', supports1m: true }]
  const fields = parseModelMapping(
    JSON.stringify({
      version: 2,
      clients: { claude_code: { catalog: { mode: 'provider', models } } },
    }),
  )
  fields.clients.claude_code.models = []
  const saved = serializeModelMapping(fields)!
  expect(JSON.parse(saved).clients.claude_code.catalog).toEqual({
    mode: 'provider',
    models,
    draftModels: [],
  })
  expect(parseModelMapping(saved).clients.claude_code.models).toEqual([])
})
