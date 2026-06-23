import { describe, it, expect } from 'vitest'
import {
  ClientKind,
  IntegrationForm,
  ProtocolFormat,
  CLIENT_KIND_CONFIGS,
  getClientKindConfig,
  providerTypeToClientKind,
  clientKindToProviderType,
} from '../index'

describe('ClientKind types (v3.2.0)', () => {
  it('should have 3 client kinds', () => {
    const kinds: ClientKind[] = ['codex', 'claude_code', 'claude_desktop']
    expect(kinds).toHaveLength(3)
  })

  it('should have correct integration forms', () => {
    const forms: IntegrationForm[] = ['process_injection', 'config_takeover']
    expect(forms).toHaveLength(2)
  })

  it('should have correct protocol formats', () => {
    const formats: ProtocolFormat[] = ['codex_responses', 'openai_chat', 'anthropic_messages']
    expect(formats).toHaveLength(3)
  })

  it('should have client kind configs', () => {
    expect(CLIENT_KIND_CONFIGS).toHaveLength(3)

    const claudeCodeConfig = CLIENT_KIND_CONFIGS.find(c => c.kind === 'claude_code')
    expect(claudeCodeConfig).toBeDefined()
    expect(claudeCodeConfig?.label).toBe('Claude Code')
    expect(claudeCodeConfig?.form).toBe('process_injection')
    expect(claudeCodeConfig?.defaultProtocol).toBe('anthropic_messages')
    expect(claudeCodeConfig?.cliCommand).toBe('claude')

    const codexConfig = CLIENT_KIND_CONFIGS.find(c => c.kind === 'codex')
    expect(codexConfig).toBeDefined()
    expect(codexConfig?.label).toBe('Codex Desktop')
    expect(codexConfig?.form).toBe('config_takeover')
    expect(codexConfig?.defaultProtocol).toBe('codex_responses')

    const desktopConfig = CLIENT_KIND_CONFIGS.find(c => c.kind === 'claude_desktop')
    expect(desktopConfig).toBeDefined()
    expect(desktopConfig?.label).toBe('Claude Desktop')
    expect(desktopConfig?.form).toBe('config_takeover')
    expect(desktopConfig?.defaultProtocol).toBe('anthropic_messages')
  })

  it('should get client kind config', () => {
    const config = getClientKindConfig('claude_code')
    expect(config.kind).toBe('claude_code')
    expect(config.label).toBe('Claude Code')
  })

  it('should fallback to claude_code for unknown kind', () => {
    const config = getClientKindConfig('unknown' as ClientKind)
    expect(config.kind).toBe('claude_code')
  })

  it('should convert ProviderType to ClientKind', () => {
    expect(providerTypeToClientKind('claude')).toBe('claude_code')
    expect(providerTypeToClientKind('claude_code')).toBe('claude_code')
    expect(providerTypeToClientKind('codex')).toBe('codex')
    expect(providerTypeToClientKind('claude_desktop')).toBe('claude_desktop')
  })

  it('should convert ClientKind to ProviderType', () => {
    expect(clientKindToProviderType('claude_code')).toBe('claude_code')
    expect(clientKindToProviderType('codex')).toBe('codex')
    expect(clientKindToProviderType('claude_desktop')).toBeNull()
  })
})
