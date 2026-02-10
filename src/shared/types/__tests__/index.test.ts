import { describe, it, expect } from 'vitest'
import {
  getProviderTypeConfig,
  generateTerminalCommand,
  PROVIDER_TYPE_CONFIGS,
  type ProviderType,
} from '../index'

describe('Provider Type Config', () => {
  describe('PROVIDER_TYPE_CONFIGS', () => {
    it('should have 2 predefined provider types', () => {
      expect(PROVIDER_TYPE_CONFIGS).toHaveLength(2)
    })

    it('should include claude config', () => {
      const claude = PROVIDER_TYPE_CONFIGS.find((c) => c.type === 'claude')
      expect(claude).toBeDefined()
      expect(claude?.envKeyName).toBe('ANTHROPIC_API_KEY')
      expect(claude?.envBaseUrlName).toBe('ANTHROPIC_BASE_URL')
      expect(claude?.cliCommand).toBe('claude')
    })

    it('should include codex config', () => {
      const codex = PROVIDER_TYPE_CONFIGS.find((c) => c.type === 'codex')
      expect(codex).toBeDefined()
      expect(codex?.envKeyName).toBe('OPENAI_API_KEY')
      expect(codex?.envBaseUrlName).toBe('OPENAI_BASE_URL')
      expect(codex?.cliCommand).toBe('codex')
    })
  })

  describe('getProviderTypeConfig', () => {
    it('should return claude config for claude type', () => {
      const config = getProviderTypeConfig('claude')
      expect(config.type).toBe('claude')
      expect(config.envKeyName).toBe('ANTHROPIC_API_KEY')
    })

    it('should return codex config for codex type', () => {
      const config = getProviderTypeConfig('codex')
      expect(config.type).toBe('codex')
      expect(config.envKeyName).toBe('OPENAI_API_KEY')
    })

    it('should fallback to claude config for unknown type', () => {
      const config = getProviderTypeConfig('unknown' as ProviderType)
      expect(config.type).toBe('claude')
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
        'ANTHROPIC_BASE_URL="https://api.anthropic.com" ANTHROPIC_API_KEY="sk-test-key" claude',
      )
    })

    it('should generate correct command for codex provider in direct mode', () => {
      const provider = {
        type: 'codex' as ProviderType,
        baseUrl: 'https://api.openai.com',
      }
      const command = generateTerminalCommand(provider, 'sk-openai-key')

      expect(command).toBe(
        'OPENAI_BASE_URL="https://api.openai.com" OPENAI_API_KEY="sk-openai-key" codex',
      )
    })

    it('should generate correct command in proxy mode', () => {
      const provider = {
        type: 'claude' as ProviderType,
        baseUrl: 'https://api.anthropic.com',
      }
      const command = generateTerminalCommand(provider, 'sk-test-key', true, 12345)

      expect(command).toBe(
        'ANTHROPIC_BASE_URL="http://localhost:12345" ANTHROPIC_API_KEY="proxy" claude',
      )
    })

    it('should generate Windows CMD command when terminal type is cmd', () => {
      const provider = {
        type: 'claude' as ProviderType,
        baseUrl: 'https://api.anthropic.com',
      }
      const command = generateTerminalCommand(provider, 'sk-test-key', false, 12345, 'cmd')

      expect(command).toBe(
        'set ANTHROPIC_BASE_URL=https://api.anthropic.com && set ANTHROPIC_API_KEY=sk-test-key && claude',
      )
    })

    it('should generate PowerShell command when terminal type is powershell', () => {
      const provider = {
        type: 'claude' as ProviderType,
        baseUrl: 'https://api.anthropic.com',
      }
      const command = generateTerminalCommand(provider, 'sk-test-key', false, 12345, 'powershell')

      expect(command).toBe(
        '$env:ANTHROPIC_BASE_URL="https://api.anthropic.com"; $env:ANTHROPIC_API_KEY="sk-test-key"; claude',
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
