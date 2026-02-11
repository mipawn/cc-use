import { describe, it, expect } from 'vitest'

import { normalizeNewApiModelName, isModelAllowedForPricingSync } from '../pricingSyncService'

describe('pricingSyncService', () => {
  describe('normalizeNewApiModelName', () => {
    it('strips namespaces and normalizes case/separators', () => {
      expect(normalizeNewApiModelName('OpenAI/gpt_4o')).toBe('gpt-4o')
      expect(normalizeNewApiModelName('openai:gpt-4o@2024')).toBe('gpt-4o')
      expect(normalizeNewApiModelName('gpt-4o (vision)')).toBe('gpt-4o')
    })

    it('normalizes unicode dashes to hyphen-minus', () => {
      // U+2011 non-breaking hyphen
      const raw = `gpt‑5.1-codex`
      expect(normalizeNewApiModelName(raw)).toBe('gpt-5.1-codex')
    })
  })

  describe('isModelAllowedForPricingSync', () => {
    it('allows OpenAI and Claude families', () => {
      expect(isModelAllowedForPricingSync('gpt-5.1-codex')).toBe(true)
      expect(isModelAllowedForPricingSync('o1-mini')).toBe(true)
      expect(isModelAllowedForPricingSync('claude-sonnet-4-5-20250929')).toBe(true)
    })

    it('blocks other families', () => {
      expect(isModelAllowedForPricingSync('gemini-3-flash-preview')).toBe(false)
      expect(isModelAllowedForPricingSync('qwen2.5')).toBe(false)
    })
  })
})
