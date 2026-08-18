import { describe, expect, it } from 'vitest'
import type { ApiKey, Provider } from '@shared/types'
import { isOfficialDeepSeekProvider } from './officialProviders'
import { supportsKeyClient } from './clientSupport'

const deepseekProvider = {
  id: 'deepseek',
  name: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com',
  icon: 'deepseek',
} as Provider

const multiClientKey = {
  id: 'key',
  providerId: 'deepseek',
  types: ['claude_code', 'grok', 'codex', 'claude_desktop'],
} as ApiKey

describe('official provider compatibility', () => {
  it('recognizes the official DeepSeek host independently of its display icon', () => {
    expect(isOfficialDeepSeekProvider(deepseekProvider)).toBe(true)
    expect(
      isOfficialDeepSeekProvider({
        ...deepseekProvider,
        icon: 'claude',
        baseUrl: 'https://API.DEEPSEEK.COM/anthropic',
      }),
    ).toBe(true)
    expect(
      isOfficialDeepSeekProvider({
        ...deepseekProvider,
        baseUrl: 'https://gateway.example.com',
      }),
    ).toBe(false)
    expect(isOfficialDeepSeekProvider({ ...deepseekProvider, baseUrl: 'not-a-url' })).toBe(false)
  })

  it('keeps DeepSeek on Codex and Claude but excludes Grok', () => {
    expect(supportsKeyClient(deepseekProvider, multiClientKey, 'codex')).toBe(true)
    expect(supportsKeyClient(deepseekProvider, multiClientKey, 'claude_code')).toBe(true)
    expect(supportsKeyClient(deepseekProvider, multiClientKey, 'claude_desktop')).toBe(true)
    expect(supportsKeyClient(deepseekProvider, multiClientKey, 'grok')).toBe(false)
  })
})
