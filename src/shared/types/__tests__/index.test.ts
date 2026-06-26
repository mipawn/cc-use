import { describe, it, expect } from 'vitest'
import {
  getProviderTypeConfig,
  generateTerminalCommand,
  PROVIDER_TYPE_CONFIGS,
  type ProviderType,
} from '../index'

describe('Provider Type Config', () => {
  describe('PROVIDER_TYPE_CONFIGS', () => {
    it('should only include process-launched clients', () => {
      expect(PROVIDER_TYPE_CONFIGS).toHaveLength(1)
    })

    it('should include Claude Code config', () => {
      const claude = PROVIDER_TYPE_CONFIGS.find((c) => c.type === 'claude_code')
      expect(claude).toBeDefined()
      expect(claude?.envKeyName).toBe('ANTHROPIC_AUTH_TOKEN')
      expect(claude?.envBaseUrlName).toBe('ANTHROPIC_BASE_URL')
      expect(claude?.cliCommand).toBe('claude')
    })
  })

  describe('getProviderTypeConfig', () => {
    it('should return claude config for claude type', () => {
      const config = getProviderTypeConfig('claude')
      expect(config.type).toBe('claude_code')
      expect(config.envKeyName).toBe('ANTHROPIC_AUTH_TOKEN')
    })

    it('should fallback to claude config for unknown type', () => {
      const config = getProviderTypeConfig('unknown' as ProviderType)
      expect(config.type).toBe('claude_code')
    })
  })

  describe('generateTerminalCommand', () => {
    it('should generate correct command for claude provider in direct mode', () => {
      const provider = {
        type: 'claude' as ProviderType,
        baseUrl: 'https://api.anthropic.com',
      }
      const command = generateTerminalCommand(provider, 'sk-test-key')

      expect(command).toBe(
        'ANTHROPIC_BASE_URL="https://api.anthropic.com" ANTHROPIC_AUTH_TOKEN="sk-test-key" claude',
      )
    })

    it('should reject Codex Desktop terminal command generation', () => {
      const provider = {
        type: 'codex' as ProviderType,
        baseUrl: 'https://api.openai.com',
      }
      expect(() => generateTerminalCommand(provider, 'sk-openai-key')).toThrow(
        'uses config takeover',
      )
    })

    it('should generate correct command in proxy mode', () => {
      const provider = {
        type: 'claude' as ProviderType,
        baseUrl: 'https://api.anthropic.com',
      }
      const command = generateTerminalCommand(provider, 'sk-test-key', true, 12345)

      expect(command).toBe(
        'ANTHROPIC_BASE_URL="http://localhost:12345" ANTHROPIC_AUTH_TOKEN="proxy" claude',
      )
    })

    it('should use custom proxy port when specified', () => {
      const provider = {
        type: 'claude' as ProviderType,
        baseUrl: 'https://api.anthropic.com',
      }
      const command = generateTerminalCommand(provider, 'sk-test-key', true, 8080)

      expect(command).toContain('http://localhost:8080')
    })

    it('should use default proxy port 12345 when not specified', () => {
      const provider = {
        type: 'claude' as ProviderType,
        baseUrl: 'https://api.anthropic.com',
      }
      const command = generateTerminalCommand(provider, 'sk-test-key', true)

      expect(command).toContain('http://localhost:12345')
    })
  })
})
