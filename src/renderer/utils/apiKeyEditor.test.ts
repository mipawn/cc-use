import { describe, expect, it } from 'vitest'
import { toCreateApiKeyInput, toUpdateApiKeyInput } from './apiKeyEditor'

const clientConfigs = {
  claude_code: {
    baseUrl: 'https://gateway.example.com',
    authScheme: 'bearer' as const,
  },
}

describe('API key editor payloads', () => {
  it('keeps client authentication overrides when creating a key', () => {
    const input = toCreateApiKeyInput({
      providerId: 'provider-1',
      alias: 'company account',
      value: 'employee-id',
      types: ['claude_code'],
      clientConfigs,
    })

    expect(input.clientConfigs).toEqual(clientConfigs)
  })

  it('keeps client authentication overrides when updating a key', () => {
    const input = toUpdateApiKeyInput({
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
  })
})
