import { describe, expect, it } from 'vitest'
import { hasClientOverride, mergeClientConfig } from './clientConfig'

describe('mergeClientConfig', () => {
  it('keeps a User-Agent that was chosen on its own', () => {
    // The regression this exists for: the entry used to be dropped whenever
    // baseUrl and authScheme were both empty, taking the UA with it.
    const next = mergeClientConfig({}, 'claude_code', { proxyUserAgent: 'claude-cli/2.1.161' })

    expect(next.claude_code?.proxyUserAgent).toBe('claude-cli/2.1.161')
  })

  it('keeps every field alongside the others', () => {
    let configs = mergeClientConfig({}, 'codex', { baseUrl: 'https://example.com' })
    configs = mergeClientConfig(configs, 'codex', { authScheme: 'bearer' })
    configs = mergeClientConfig(configs, 'codex', { proxyUserAgent: 'codex_cli_rs/0.153.4' })

    expect(configs.codex).toEqual({
      baseUrl: 'https://example.com',
      authScheme: 'bearer',
      proxyUserAgent: 'codex_cli_rs/0.153.4',
    })
  })

  it('treats a blank field as unset rather than storing an empty string', () => {
    const configs = mergeClientConfig(
      { claude_code: { baseUrl: 'https://example.com' } },
      'claude_code',
      { proxyUserAgent: '   ' },
    )

    expect(configs.claude_code).toEqual({ baseUrl: 'https://example.com' })
  })

  it('drops the entry once nothing is left', () => {
    const configs = mergeClientConfig(
      { claude_code: { baseUrl: 'https://example.com' } },
      'claude_code',
      { baseUrl: '' },
    )

    expect(configs.claude_code).toBeUndefined()
  })

  it('clears a User-Agent without disturbing the rest of the entry', () => {
    const configs = mergeClientConfig(
      { codex: { baseUrl: 'https://example.com', proxyUserAgent: 'codex_cli_rs/0.153.4' } },
      'codex',
      { proxyUserAgent: '' },
    )

    expect(configs.codex).toEqual({ baseUrl: 'https://example.com' })
  })

  it('leaves other clients alone', () => {
    const configs = mergeClientConfig(
      { codex: { baseUrl: 'https://codex.example.com' } },
      'claude_code',
      { proxyUserAgent: 'claude-cli/2.1.161' },
    )

    expect(configs.codex).toEqual({ baseUrl: 'https://codex.example.com' })
    expect(configs.claude_code?.proxyUserAgent).toBe('claude-cli/2.1.161')
  })

  it('does not mutate the map it was given', () => {
    const before = { codex: { baseUrl: 'https://example.com' } }
    mergeClientConfig(before, 'codex', { baseUrl: '' })

    expect(before.codex).toEqual({ baseUrl: 'https://example.com' })
  })
})

describe('hasClientOverride', () => {
  it('counts any field as an override', () => {
    expect(hasClientOverride(undefined)).toBe(false)
    expect(hasClientOverride({})).toBe(false)
    expect(hasClientOverride({ baseUrl: 'https://example.com' })).toBe(true)
    expect(hasClientOverride({ authScheme: 'bearer' })).toBe(true)
    expect(hasClientOverride({ proxyUserAgent: 'claude-cli/2.1.161' })).toBe(true)
    expect(hasClientOverride({ proxyUserAgent: '   ' })).toBe(false)
  })
})
