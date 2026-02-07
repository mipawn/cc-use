import { nanoid } from 'nanoid'
import type { ProxySession } from '@shared/types'

// In-memory session storage for hot-switching
const sessions = new Map<string, ProxySession>()

// Map to track sessions by project+provider+apiKey combination
const sessionByProject = new Map<string, string>() // key: `${projectId}:${providerId}:${apiKeyId}`, value: sessionToken

function getProjectSessionKey(projectId: string, providerId: string, apiKeyId: string): string {
  return `${projectId}:${providerId}:${apiKeyId}`
}

export function createSession(providerId: string, apiKeyId: string, projectId?: string): ProxySession {
  // If projectId is provided, check if we already have a session for this combination
  if (projectId) {
    const existingToken = sessionByProject.get(getProjectSessionKey(projectId, providerId, apiKeyId))
    if (existingToken) {
      const existingSession = sessions.get(existingToken)
      if (existingSession) {
        // Return existing session
        return existingSession
      }
    }
  }

  // Create new session
  const sessionToken = `session-${nanoid(16)}`
  const session: ProxySession = {
    sessionToken,
    providerId,
    apiKeyId,
    createdAt: new Date().toISOString(),
  }
  sessions.set(sessionToken, session)

  // Track by project if projectId is provided
  if (projectId) {
    sessionByProject.set(getProjectSessionKey(projectId, providerId, apiKeyId), sessionToken)
  }

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
  // Also remove from project mapping
  const session = sessions.get(sessionToken)
  if (session) {
    // Find and remove from sessionByProject
    for (const [key, token] of sessionByProject.entries()) {
      if (token === sessionToken) {
        sessionByProject.delete(key)
        break
      }
    }
  }
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

/**
 * Get existing session for a project+provider+apiKey combination
 */
export function getSessionByProject(projectId: string, providerId: string, apiKeyId: string): ProxySession | null {
  const sessionToken = sessionByProject.get(getProjectSessionKey(projectId, providerId, apiKeyId))
  if (sessionToken) {
    return sessions.get(sessionToken) || null
  }
  return null
}

export function clearAllSessions(): void {
  sessions.clear()
  sessionByProject.clear()
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

/**
 * Update all sessions for a given project to point to a new provider/apiKey.
 * This enables hot-switching: the terminal keeps its session token, but the
 * proxy resolves it to the updated provider/key on the next request.
 */
export function updateSessionsByProject(
  projectId: string,
  newProviderId: string,
  newApiKeyId: string
): number {
  const prefix = `${projectId}:`
  const newKey = getProjectSessionKey(projectId, newProviderId, newApiKeyId)

  // Collect matching entries first to avoid mutating the Map during iteration
  const toUpdate: { oldKey: string; sessionToken: string }[] = []
  for (const [compositeKey, sessionToken] of sessionByProject.entries()) {
    if (compositeKey.startsWith(prefix)) {
      toUpdate.push({ oldKey: compositeKey, sessionToken })
    }
  }

  // Now apply updates
  for (const { oldKey, sessionToken } of toUpdate) {
    const session = sessions.get(sessionToken)
    if (session) {
      session.providerId = newProviderId
      session.apiKeyId = newApiKeyId
    }
    sessionByProject.delete(oldKey)
    sessionByProject.set(newKey, sessionToken)
  }

  return toUpdate.length
}

// Get active session count
export function getActiveSessionCount(): number {
  return sessions.size
}
