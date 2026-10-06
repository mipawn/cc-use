import { expect, it } from 'vitest'
import {
  EMPTY_MODEL_MAPPING,
  parseModelMapping,
  serializeModelMapping,
  modelMappingValueForSave,
  validateModelMapping,
} from './modelMapping'

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

it('keeps classifier configuration in Code and ignores malformed mapping JSON', () => {
  const fields = parseModelMapping('{"autoMode":{"enabled":true,"thinking":"disabled"}}')
  expect(JSON.parse(serializeModelMapping(fields)!).clients.claude_code.upstream.autoMode).toEqual({
    enabled: true,
    thinking: 'disabled',
  })
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
