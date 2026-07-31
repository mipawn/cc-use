import { describe, expect, it } from 'vitest'
import type { ApiKey, Provider } from '@shared/types'
import { isBuiltinDeepSeekProvider } from './builtinProviders'
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

describe('built-in provider compatibility', () => {
  it('recognizes only the official DeepSeek host with the DeepSeek preset', () => {
    expect(isBuiltinDeepSeekProvider(deepseekProvider)).toBe(true)
    expect(
      isBuiltinDeepSeekProvider({
        ...deepseekProvider,
        baseUrl: 'https://gateway.example.com',
      }),
    ).toBe(false)
  })

  it('keeps DeepSeek on Codex and Claude but excludes Grok', () => {
    expect(supportsKeyClient(deepseekProvider, multiClientKey, 'codex')).toBe(true)
    expect(supportsKeyClient(deepseekProvider, multiClientKey, 'claude_code')).toBe(true)
    expect(supportsKeyClient(deepseekProvider, multiClientKey, 'claude_desktop')).toBe(true)
    expect(supportsKeyClient(deepseekProvider, multiClientKey, 'grok')).toBe(false)
  })
})
