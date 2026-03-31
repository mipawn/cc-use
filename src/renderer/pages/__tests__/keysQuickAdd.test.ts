import { describe, expect, it } from 'vitest'
import { buildQuickAddPayload } from '../keysQuickAdd'

describe('buildQuickAddPayload', () => {
  it('uses the first selected type as provider type and preserves all key types', () => {
    const result = buildQuickAddPayload({
      providerName: 'Test Provider',
      providerBaseUrl: 'https://example.com',
      providerIcon: 'claude',
      keyAlias: 'main',
      keyValue: 'secret',
      keyType: ['codex', 'claude'],
    })

    expect(result.provider).toEqual({
      name: 'Test Provider',
      baseUrl: 'https://example.com',
      icon: 'claude',
      type: 'codex',
    })

    expect(result.apiKey).toEqual({
      alias: 'main',
      value: 'secret',
      types: ['codex', 'claude'],
    })
  })

  it('falls back to claude when no type is selected', () => {
    const result = buildQuickAddPayload({
      providerName: 'Test Provider',
      providerBaseUrl: 'https://example.com',
      providerIcon: 'claude',
      keyValue: 'secret',
      keyType: [],
    })

    expect(result.provider.type).toBe('claude')
    expect(result.apiKey.types).toEqual([])
  })
})
