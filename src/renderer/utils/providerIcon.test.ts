import { describe, expect, it } from 'vitest'
import { PROVIDER_ICON_CHOICES, providerIconSrc } from './providerIcon'

describe('providerIconSrc', () => {
  it('resolves every mark the editor offers', () => {
    for (const choice of PROVIDER_ICON_CHOICES) {
      expect(providerIconSrc(choice.key)).toBeTruthy()
    }
  })

  it('treats the blank template marker as "no mark", not as a path', () => {
    // The blank preset stores the literal `custom`. Reading it as a filesystem
    // path is what produced a `file://custom` image that never loaded.
    expect(providerIconSrc('custom')).toBeNull()
  })

  it('has no mark when there is no icon', () => {
    expect(providerIconSrc(null)).toBeNull()
    expect(providerIconSrc(undefined)).toBeNull()
    expect(providerIconSrc('   ')).toBeNull()
  })

  it('loads an uploaded file from its path', () => {
    expect(providerIconSrc('/Users/me/icon.png')).toBe('file:///Users/me/icon.png')
    expect(providerIconSrc('file:///Users/me/icon.png')).toBe('file:///Users/me/icon.png')
  })

  it('keeps the client-kind aliases pointing at their vendor mark', () => {
    // Rows written before the icon set existed store these labels, and they
    // name a client rather than a vendor.
    expect(providerIconSrc('codex')).toBe(providerIconSrc('openai'))
    expect(providerIconSrc('claude_code')).toBe(providerIconSrc('claude'))
  })
})
