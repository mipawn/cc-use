import { describe, expect, it } from 'vitest'
import type { ApiKey } from '@shared/types'
import {
  buildDuplicatedKeyDraft,
  newKeyDefaults,
  toCreateApiKeyInput,
  toUpdateApiKeyInput,
} from './apiKeyEditor'

const clientConfigs = {
  claude_code: {
    baseUrl: 'https://gateway.example.com',
    authScheme: 'bearer' as const,
  },
}

describe('API key editor payloads', () => {
  it('keeps client authentication overrides when creating a key', () => {
    const input = toCreateApiKeyInput({
      mode: 'create',
      providerId: 'provider-1',
      alias: 'company account',
      value: 'employee-id',
      types: ['claude_code'],
      clientConfigs,
    })

    expect(input.clientConfigs).toEqual(clientConfigs)
    expect(input).not.toHaveProperty('mode')
  })

  it('keeps client authentication overrides when updating a key', () => {
    const input = toUpdateApiKeyInput({
      mode: 'edit',
      id: 'key-1',
      providerId: 'provider-1',
      alias: 'company account',
      value: 'employee-id',
      types: ['claude_code'],
      clientConfigs,
    })

    expect(input).toMatchObject({
      id: 'key-1',
      clientConfigs,
    })
    expect(input).not.toHaveProperty('providerId')
    expect(input).not.toHaveProperty('mode')
  })

  it('saves a duplicated draft as a new record with the source configuration', () => {
    const draft = buildDuplicatedKeyDraft(sourceKey())
    const input = toCreateApiKeyInput({
      mode: 'duplicate',
      providerId: draft.providerId,
      alias: draft.alias ?? undefined,
      value: draft.value,
      types: draft.types,
      usageType: draft.usageType,
      modelMapping: draft.modelMapping ?? undefined,
      clientConfigs: draft.clientConfigs,
    })

    expect(input).not.toHaveProperty('id')
    expect(input).not.toHaveProperty('mode')
    expect(input).toMatchObject({
      providerId: 'provider-1',
      alias: 'daily (copy)',
      value: 'sk-secret',
      types: ['claude_code'],
      modelMapping: '{"haiku":"deepseek-v4-flash"}',
      clientConfigs,
    })
  })
})

function sourceKey(): ApiKey {
  return {
    id: 'key-1',
    providerId: 'provider-1',
    alias: 'daily',
    value: 'sk-secret',
    types: ['claude_code'],
    priority: 3,
    isExhausted: true,
    isActive: true,
    config: { prelaunchCommand: 'echo hi' },
    usageType: 'custom',
    usageUrl: 'https://quota.example.com',
    usagePath: 'data.remaining',
    usageHeaders: '{"x-token":"abc"}',
    cachedUsage: {
      total: 10,
      used: 4,
      remaining: 6,
      unit: 'USD',
      isUnlimited: false,
    },
    lastUsageCheckedAt: '2026-09-10T12:00:00Z',
    modelMapping: '{"haiku":"deepseek-v4-flash"}',
    clientConfigs,
    cooldownUntil: '2026-09-10T13:00:00Z',
    lastErrorAt: '2026-09-10T12:30:00Z',
    lastErrorKind: 'rate_limit',
    consecutiveErrors: 2,
  }
}

describe('duplicated key drafts', () => {
  it('keeps the credential and copyable configuration', () => {
    const draft = buildDuplicatedKeyDraft(sourceKey())

    expect(draft.value).toBe('sk-secret')
    expect(draft.types).toEqual(['claude_code'])
    expect(draft.config).toEqual({ prelaunchCommand: 'echo hi' })
    expect(draft.clientConfigs).toEqual(clientConfigs)
    expect(draft.modelMapping).toBe('{"haiku":"deepseek-v4-flash"}')
    expect(draft.usageType).toBe('custom')
    expect(draft.usageUrl).toBe('https://quota.example.com')
    expect(draft.usagePath).toBe('data.remaining')
    expect(draft.usageHeaders).toBe('{"x-token":"abc"}')
  })

  it('drops identity and per-instance state', () => {
    const draft = buildDuplicatedKeyDraft(sourceKey())

    expect(draft.id).toBe('')
    expect(draft.cachedUsage).toBeNull()
    expect(draft.lastUsageCheckedAt).toBeNull()
    expect(draft.isExhausted).toBe(false)
    expect(draft.cooldownUntil).toBeNull()
    expect(draft.lastErrorAt).toBeNull()
    expect(draft.lastErrorKind).toBeNull()
    expect(draft.consecutiveErrors).toBe(0)
    expect(draft.priority).toBe(0)
  })

  it('marks the alias as a copy and leaves an unnamed key unnamed', () => {
    expect(buildDuplicatedKeyDraft(sourceKey()).alias).toBe('daily (copy)')
    expect(buildDuplicatedKeyDraft(sourceKey(), '（副本）').alias).toBe('daily（副本）')
    expect(buildDuplicatedKeyDraft({ ...sourceKey(), alias: null }).alias).toBe('')
  })

  it('deep copies json payloads so editing the copy cannot reach the source', () => {
    const source = sourceKey()
    const draft = buildDuplicatedKeyDraft(source)

    expect(draft.clientConfigs).not.toBe(source.clientConfigs)
    expect(draft.config).not.toBe(source.config)
    ;(draft.clientConfigs!.claude_code as { baseUrl?: string }).baseUrl = 'https://changed.example'
    expect(source.clientConfigs?.claude_code?.baseUrl).toBe('https://gateway.example.com')
  })
})

describe('new key defaults', () => {
  it('starts a new key with Auto mode on', () => {
    // Auto mode only reshapes the permission-classifier requests; leaving it
    // off makes the classifier answer about a model the user did not pick.
    expect(newKeyDefaults(null, false).mapping.autoMode.enabled).toBe(true)
  })

  it('lets a provider template turn Auto mode off', () => {
    const defaults = newKeyDefaults(
      { modelMapping: JSON.stringify({ autoMode: { enabled: false } }) },
      false,
    )

    expect(defaults.mapping.autoMode.enabled).toBe(false)
  })

  it('keeps the family mapping a template supplies alongside it', () => {
    const defaults = newKeyDefaults(
      { modelMapping: JSON.stringify({ haiku: 'fast', sonnet: 'big' }) },
      false,
    )

    expect(defaults.mapping).toMatchObject({
      haiku: 'fast',
      sonnet: 'big',
      autoMode: { enabled: true },
    })
  })
})
