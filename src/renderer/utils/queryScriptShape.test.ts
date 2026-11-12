import { describe, expect, it } from 'vitest'
import { isAccountShapedScript } from './queryScriptShape'

describe('account-shaped query scripts', () => {
  it('recognises each known account endpoint', () => {
    expect(isAccountShapedScript('{{baseUrl}}/api/user/self')).toBe(true)
    expect(isAccountShapedScript('GET {{baseUrl}}/api/user/balance')).toBe(true)
    expect(isAccountShapedScript('https://api.deepseek.com/user/balance')).toBe(true)
  })

  it('leaves command-code endpoints alone: they are legitimate per-key targets', () => {
    expect(isAccountShapedScript('https://api.commandcode.ai/alpha/billing/subscriptions')).toBe(
      false,
    )
    expect(isAccountShapedScript('https://api.commandcode.ai/alpha/billing/usage')).toBe(false)
  })

  it('is case-insensitive and tolerant of surrounding whitespace', () => {
    expect(isAccountShapedScript('  HTTPS://RELAY.EXAMPLE.COM/API/USER/SELF  ')).toBe(true)
  })

  it('reads an empty script as not account-shaped', () => {
    expect(isAccountShapedScript('')).toBe(false)
    expect(isAccountShapedScript('   ')).toBe(false)
    expect(isAccountShapedScript(undefined)).toBe(false)
    expect(isAccountShapedScript(null)).toBe(false)
  })

  it('leaves per-key scripts alone', () => {
    expect(isAccountShapedScript('{{baseUrl}}/api/usage/token/')).toBe(false)
    expect(isAccountShapedScript('({ request: { url: "https://quota.example.com" } })')).toBe(false)
  })
})
