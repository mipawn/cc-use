import { describe, it, expect, beforeEach } from 'vitest'
import {
  createSession,
  getSession,
  updateSessionKey,
  deleteSession,
  listSessions,
  clearAllSessions,
  parseSessionToken,
  getActiveSessionCount,
} from '../sessionManager'

describe('sessionManager', () => {
  // Clear sessions before each test
  beforeEach(() => {
    clearAllSessions()
  })

  describe('createSession', () => {
    it('should create a new session with sessionToken', () => {
      const session = createSession('provider-1', 'key-1')

      expect(session.sessionToken).toBeDefined()
      expect(session.sessionToken).toMatch(/^session-/)
      expect(session.providerId).toBe('provider-1')
      expect(session.apiKeyId).toBe('key-1')
      expect(session.createdAt).toBeDefined()
    })

    it('should create unique session tokens', () => {
      const session1 = createSession('provider-1', 'key-1')
      const session2 = createSession('provider-1', 'key-2')

      expect(session1.sessionToken).not.toBe(session2.sessionToken)
    })
  })

  describe('getSession', () => {
    it('should return session by token', () => {
      const created = createSession('provider-1', 'key-1')
      const retrieved = getSession(created.sessionToken)

      expect(retrieved).not.toBeNull()
      expect(retrieved?.sessionToken).toBe(created.sessionToken)
      expect(retrieved?.providerId).toBe('provider-1')
    })

    it('should return null for non-existent token', () => {
      const result = getSession('non-existent-token')
      expect(result).toBeNull()
    })
  })

  describe('updateSessionKey', () => {
    it('should update the API key for a session', () => {
      const session = createSession('provider-1', 'key-1')

      const updated = updateSessionKey(session.sessionToken, 'key-2')
      expect(updated).toBe(true)

      const retrieved = getSession(session.sessionToken)
      expect(retrieved?.apiKeyId).toBe('key-2')
    })

    it('should return false for non-existent session', () => {
      const result = updateSessionKey('non-existent', 'key-1')
      expect(result).toBe(false)
    })
  })

  describe('deleteSession', () => {
    it('should delete an existing session', () => {
      const session = createSession('provider-1', 'key-1')

      const deleted = deleteSession(session.sessionToken)
      expect(deleted).toBe(true)

      const retrieved = getSession(session.sessionToken)
      expect(retrieved).toBeNull()
    })

    it('should return false for non-existent session', () => {
      const result = deleteSession('non-existent')
      expect(result).toBe(false)
    })
  })

  describe('listSessions', () => {
    it('should return all sessions', () => {
      createSession('provider-1', 'key-1')
      createSession('provider-2', 'key-2')
      createSession('provider-3', 'key-3')

      const sessions = listSessions()
      expect(sessions).toHaveLength(3)
    })

    it('should return empty array when no sessions', () => {
      const sessions = listSessions()
      expect(sessions).toHaveLength(0)
    })
  })

  describe('parseSessionToken', () => {
    it('should parse session token from header', () => {
      const result = parseSessionToken('session-abc123')
      expect(result).toBe('session-abc123')
    })

    it('should parse session token from Bearer header', () => {
      const result = parseSessionToken('Bearer session-abc123')
      expect(result).toBe('session-abc123')
    })

    it('should return null for regular API key', () => {
      const result = parseSessionToken('sk-abc123')
      expect(result).toBeNull()
    })

    it('should return null for empty header', () => {
      const result = parseSessionToken('')
      expect(result).toBeNull()
    })
  })

  describe('getActiveSessionCount', () => {
    it('should return correct session count', () => {
      expect(getActiveSessionCount()).toBe(0)

      createSession('provider-1', 'key-1')
      expect(getActiveSessionCount()).toBe(1)

      createSession('provider-2', 'key-2')
      expect(getActiveSessionCount()).toBe(2)
    })
  })

  describe('clearAllSessions', () => {
    it('should clear all sessions', () => {
      createSession('provider-1', 'key-1')
      createSession('provider-2', 'key-2')

      clearAllSessions()

      expect(getActiveSessionCount()).toBe(0)
      expect(listSessions()).toHaveLength(0)
    })
  })
})
