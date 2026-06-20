import { describe, it, expect } from 'vitest'
import {
  normalizeBaseUrl,
  isOriginOnly,
  deriveCodexBaseUrl,
  deriveBaseUrl,
} from '../baseUrlDerivation'

describe('normalizeBaseUrl', () => {
  it('去掉尾部斜杠', () => {
    expect(normalizeBaseUrl('https://api.deepseek.com/')).toBe('https://api.deepseek.com')
    expect(normalizeBaseUrl('https://api.x.com/v1///')).toBe('https://api.x.com/v1')
  })
  it('空白归一为空串', () => {
    expect(normalizeBaseUrl('   ')).toBe('')
  })
})

describe('isOriginOnly', () => {
  it('scheme://host 视为纯 origin', () => {
    expect(isOriginOnly('https://api.deepseek.com')).toBe(true)
    expect(isOriginOnly('https://api.openai.com/')).toBe(true)
  })
  it('host 后带路径不是纯 origin', () => {
    expect(isOriginOnly('https://example.com/openai')).toBe(false)
    expect(isOriginOnly('https://api.x.com/v1')).toBe(false)
  })
})

describe('deriveCodexBaseUrl', () => {
  it('纯 origin 补 /v1', () => {
    expect(deriveCodexBaseUrl('https://api.deepseek.com')).toBe('https://api.deepseek.com/v1')
    expect(deriveCodexBaseUrl('https://api.openai.com/')).toBe('https://api.openai.com/v1')
  })
  it('已有 /v1 原样保留', () => {
    expect(deriveCodexBaseUrl('https://api.example.com/v1')).toBe('https://api.example.com/v1')
  })
  it('自定义路径前缀不强补 /v1', () => {
    expect(deriveCodexBaseUrl('https://example.com/openai')).toBe('https://example.com/openai')
  })
  it('空输入返回空串', () => {
    expect(deriveCodexBaseUrl('')).toBe('')
  })
})

describe('deriveBaseUrl', () => {
  it('codex 走 /v1 派生', () => {
    expect(deriveBaseUrl('https://api.deepseek.com', 'codex')).toBe('https://api.deepseek.com/v1')
  })
  it('claude_code / claude_desktop 直接用 base，不强补 /v1', () => {
    expect(deriveBaseUrl('https://api.anthropic.com', 'claude_code')).toBe('https://api.anthropic.com')
    expect(deriveBaseUrl('https://api.anthropic.com', 'claude_desktop')).toBe('https://api.anthropic.com')
  })
  it('空输入返回空串', () => {
    expect(deriveBaseUrl('', 'codex')).toBe('')
  })
})
