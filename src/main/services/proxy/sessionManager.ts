import { nanoid } from 'nanoid'
import type { ProxySession } from '@shared/types'

// In-memory session storage for hot-switching
const sessions = new Map<string, ProxySession>()

export function createSession(providerId: string, apiKeyId: string): ProxySession {
  const sessionToken = `session-${nanoid(16)}`
  const session: ProxySession = {
    sessionToken,
    providerId,
    apiKeyId,
    createdAt: new Date().toISOString(),
  }
  sessions.set(sessionToken, session)
  return session
}

export function getSession(sessionToken: string): ProxySession | null {
  return sessions.get(sessionToken) || null
}

export function updateSessionKey(sessionToken: string, apiKeyId: string): boolean {
  const session = sessions.get(sessionToken)
  if (!session) {
    return false
  }
  session.apiKeyId = apiKeyId
  sessions.set(sessionToken, session)
  return true
}

export function deleteSession(sessionToken: string): boolean {
  return sessions.delete(sessionToken)
}

export function listSessions(): ProxySession[] {
  return Array.from(sessions.values())
}

export function getSessionByProvider(providerId: string): ProxySession | null {
  for (const session of sessions.values()) {
    if (session.providerId === providerId) {
      return session
    }
  }
  return null
}

export function clearAllSessions(): void {
  sessions.clear()
}

// Parse session token from API key header
// Format: "session-xxx" or direct API key
export function parseSessionToken(authHeader: string): string | null {
  if (!authHeader) {
    return null
  }

  // Remove "Bearer " prefix if present
  const token = authHeader.replace(/^Bearer\s+/i, '')

  // Check if it's a session token
  if (token.startsWith('session-')) {
    return token
  }

  return null
}

// Get active session count
export function getActiveSessionCount(): number {
  return sessions.size
}
