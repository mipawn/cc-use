import { describe, expect, it } from 'vitest'
import {
  formatRequestBlock,
  headersToStoredValue,
  isStoredHeadersUnreadable,
  parseRequestBlock,
  storedValueToHeaders,
} from './providerRequestBlock'

describe('formatRequestBlock', () => {
  it('writes the request as it will be sent', () => {
    expect(
      formatRequestBlock({
        url: '{baseUrl}/api/user/self',
        headers: [
          { name: 'Authorization', value: '{token}' },
          { name: 'New-Api-User', value: '{userId}' },
        ],
      }),
    ).toBe(
      ['GET {baseUrl}/api/user/self', 'Authorization: {token}', 'New-Api-User: {userId}'].join(
        '\n',
      ),
    )
  })

  it('writes nothing for a request that is not configured', () => {
    expect(formatRequestBlock({ url: '', headers: [] })).toBe('')
  })
})

describe('parseRequestBlock', () => {
  it('round-trips what it wrote', () => {
    const block = formatRequestBlock({
      url: 'https://example.com/balance',
      headers: [{ name: 'Authorization', value: 'Bearer sk-1' }],
    })

    const parsed = parseRequestBlock(block)
    expect(parsed).toEqual({
      ok: true,
      request: {
        url: 'https://example.com/balance',
        headers: [{ name: 'Authorization', value: 'Bearer sk-1' }],
      },
    })
  })

  it('accepts a bare URL, which is what a person types by hand', () => {
    const parsed = parseRequestBlock('https://example.com/balance')
    expect(parsed).toEqual({ ok: true, request: { url: 'https://example.com/balance', headers: [] } })
  })

  it('keeps a header whose value is itself a URL', () => {
    const parsed = parseRequestBlock('GET https://a.example.com\nX-Target: https://b.example.com/x')
    expect(parsed).toEqual({
      ok: true,
      request: {
        url: 'https://a.example.com',
        headers: [{ name: 'X-Target', value: 'https://b.example.com/x' }],
      },
    })
  })

  it('ignores blank lines rather than turning them into headers', () => {
    const parsed = parseRequestBlock('GET https://a.example.com\n\n\nX-A: 1\n')
    expect(parsed.ok && parsed.request.headers).toEqual([{ name: 'X-A', value: '1' }])
  })

  it('refuses a method other than GET instead of sending something else', () => {
    const parsed = parseRequestBlock('POST https://a.example.com')
    expect(parsed.ok).toBe(false)
    expect(parsed.ok === false && parsed.error).toContain('只支持 GET')
  })

  it('refuses two URLs rather than silently keeping one', () => {
    const parsed = parseRequestBlock('GET https://a.example.com\nGET https://b.example.com')
    expect(parsed).toEqual({ ok: false, error: '第 2 行：只能有一个 URL' })
  })

  it('points at the line it could not read', () => {
    const parsed = parseRequestBlock('GET https://a.example.com\nthis is not a header')
    expect(parsed.ok).toBe(false)
    expect(parsed.ok === false && parsed.error).toContain('第 2 行')
  })

  it('catches a URL written as a header', () => {
    const parsed = parseRequestBlock('GET: https://a.example.com')
    expect(parsed.ok).toBe(false)
    expect(parsed.ok === false && parsed.error).toContain('应写成 GET <url>')
  })
})

describe('stored headers', () => {
  it('round-trips through the stored JSON object', () => {
    const headers = [
      { name: 'Authorization', value: 'Bearer {key}' },
      { name: 'New-Api-User', value: '{userId}' },
    ]
    expect(storedValueToHeaders(headersToStoredValue(headers))).toEqual(headers)
  })

  it('stores and reads back nothing when there are no headers', () => {
    expect(headersToStoredValue([])).toBe('')
    expect(headersToStoredValue([{ name: '  ', value: 'x' }])).toBe('')
    expect(storedValueToHeaders('')).toEqual([])
    expect(storedValueToHeaders(null)).toEqual([])
  })

  it('reports a value it cannot read rather than pretending there was none', () => {
    // Reporting it as empty would let the next save erase it silently.
    expect(isStoredHeadersUnreadable('not json')).toBe(true)
    expect(isStoredHeadersUnreadable('["an", "array"]')).toBe(true)
    expect(isStoredHeadersUnreadable('{"Authorization": "{token}"}')).toBe(false)
    expect(isStoredHeadersUnreadable('')).toBe(false)
    expect(isStoredHeadersUnreadable(null)).toBe(false)
  })
})
