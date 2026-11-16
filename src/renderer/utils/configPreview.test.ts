import { describe, expect, it } from 'vitest'
import { redactConfigPreview } from './configPreview'

describe('read-only config preview', () => {
  it('masks nested Desktop and environment credentials but keeps public settings', () => {
    const value = redactConfigPreview(
      JSON.stringify({
        inferenceGatewayApiKey: 'private-route',
        profiles: [{ baseUrl: 'http://localhost:12345', env: { ANTHROPIC_AUTH_TOKEN: 'secret' } }],
      }),
    )
    expect(value).not.toContain('private-route')
    expect(value).not.toContain('"secret"')
    expect(value).toContain('http://localhost:12345')
  })
  it('masks Codex TOML credentials, multiline secrets and credential-shaped strings', () => {
    const value = redactConfigPreview(
      '[model_providers.cc-use]\nexperimental_bearer_token = "session-private"\napi_key = """lineone\nlinetwo"""\nmodel = "gpt"\n# session-another-private',
    )
    expect(value).not.toMatch(/private|lineone|linetwo/)
    expect(value).toContain('model = "gpt"')
    expect(value).toContain('experimental_bearer_token = "***"')
  })
})
