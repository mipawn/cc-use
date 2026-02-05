import { describe, it, expect } from 'vitest'
import { isRetryableError } from '../keySelector'

describe('keySelector', () => {
  describe('isRetryableError', () => {
    it('should return true for 401 Unauthorized', () => {
      expect(isRetryableError(401)).toBe(true)
    })

    it('should return true for 402 Payment Required', () => {
      expect(isRetryableError(402)).toBe(true)
    })

    it('should return true for 429 Too Many Requests', () => {
      expect(isRetryableError(429)).toBe(true)
    })

    it('should return false for 200 OK', () => {
      expect(isRetryableError(200)).toBe(false)
    })

    it('should return false for 400 Bad Request', () => {
      expect(isRetryableError(400)).toBe(false)
    })

    it('should return false for 403 Forbidden', () => {
      expect(isRetryableError(403)).toBe(false)
    })

    it('should return false for 404 Not Found', () => {
      expect(isRetryableError(404)).toBe(false)
    })

    it('should return false for 500 Internal Server Error', () => {
      expect(isRetryableError(500)).toBe(false)
    })

    it('should return false for 502 Bad Gateway', () => {
      expect(isRetryableError(502)).toBe(false)
    })

    it('should return false for 503 Service Unavailable', () => {
      expect(isRetryableError(503)).toBe(false)
    })
  })
})
