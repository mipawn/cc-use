import { describe, it, expect } from 'vitest'
import { validateExportData } from '../importExportService'

describe('importExportService', () => {
  describe('validateExportData', () => {
    it('should return true for valid export data', () => {
      const validData = {
        version: '1.0',
        exportedAt: '2025-02-04T12:00:00Z',
        providers: [
          {
            name: 'Test Provider',
            type: 'claude',
            baseUrl: 'https://api.example.com',
            apiKeys: [],
          },
        ],
      }
      expect(validateExportData(validData)).toBe(true)
    })

    it('should return true for valid data with multiple providers', () => {
      const validData = {
        version: '1.0',
        exportedAt: '2025-02-04T12:00:00Z',
        providers: [
          {
            name: 'Provider 1',
            type: 'claude',
            baseUrl: 'https://api1.example.com',
            apiKeys: [{ alias: 'Key 1', value: 'sk-xxx', priority: 0 }],
          },
          {
            name: 'Provider 2',
            type: 'codex',
            baseUrl: 'https://api2.example.com',
            apiKeys: [],
          },
        ],
      }
      expect(validateExportData(validData)).toBe(true)
    })

    it('should return false for null', () => {
      expect(validateExportData(null)).toBe(false)
    })

    it('should return false for undefined', () => {
      expect(validateExportData(undefined)).toBe(false)
    })

    it('should return false for non-object', () => {
      expect(validateExportData('string')).toBe(false)
      expect(validateExportData(123)).toBe(false)
    })

    it('should return false for missing version', () => {
      const data = {
        exportedAt: '2025-02-04T12:00:00Z',
        providers: [],
      }
      expect(validateExportData(data)).toBe(false)
    })

    it('should return false for missing providers array', () => {
      const data = {
        version: '1.0',
        exportedAt: '2025-02-04T12:00:00Z',
      }
      expect(validateExportData(data)).toBe(false)
    })

    it('should return false for non-array providers', () => {
      const data = {
        version: '1.0',
        exportedAt: '2025-02-04T12:00:00Z',
        providers: 'not-an-array',
      }
      expect(validateExportData(data)).toBe(false)
    })

    it('should return false for provider missing name', () => {
      const data = {
        version: '1.0',
        exportedAt: '2025-02-04T12:00:00Z',
        providers: [
          {
            type: 'claude',
            baseUrl: 'https://api.example.com',
            apiKeys: [],
          },
        ],
      }
      expect(validateExportData(data)).toBe(false)
    })

    it('should return false for provider missing baseUrl', () => {
      const data = {
        version: '1.0',
        exportedAt: '2025-02-04T12:00:00Z',
        providers: [
          {
            name: 'Test Provider',
            type: 'claude',
            apiKeys: [],
          },
        ],
      }
      expect(validateExportData(data)).toBe(false)
    })

    it('should return true for empty providers array', () => {
      const data = {
        version: '1.0',
        exportedAt: '2025-02-04T12:00:00Z',
        providers: [],
      }
      expect(validateExportData(data)).toBe(true)
    })
  })
})
