import { nanoid } from "nanoid";
import type { ProxySession } from "@shared/types";

// In-memory session cache (backed by SQLite for persistence)
const sessions = new Map<string, ProxySession>();

// Map to track sessions by project+provider+apiKey combination
const sessionByProject = new Map<string, string>(); // key: `${projectId}:${providerId}:${apiKeyId}`, value: sessionToken

function getProjectSessionKey(
  projectId: string,
  providerId: string,
  apiKeyId: string,
): string {
  return `${projectId}:${providerId}:${apiKeyId}`;
}

// --- Database persistence helpers ---

function getDb(): ReturnType<
  typeof import("../../database").getDatabase
> | null {
  try {
    // Lazy import to avoid circular dependencies
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getDatabase } =
      require("../../database") as typeof import("../../database");
    return getDatabase();
  } catch {
    return null;
  }
}

function persistSession(session: ProxySession): void {
  try {
    const db = getDb();
    if (!db) return;
    const raw = (
      db as unknown as { $client: import("better-sqlite3").Database }
    ).$client;
    raw
      .prepare(
        `INSERT OR REPLACE INTO proxy_sessions (session_token, provider_id, api_key_id, project_id, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        session.sessionToken,
        session.providerId,
        session.apiKeyId,
        session.projectId,
        session.createdAt,
      );
  } catch (err) {
    console.error("[Session] Failed to persist session:", err);
  }
}

function removePersistedSession(sessionToken: string): void {
  try {
    const db = getDb();
    if (!db) return;
    const raw = (
      db as unknown as { $client: import("better-sqlite3").Database }
    ).$client;
    raw
      .prepare(`DELETE FROM proxy_sessions WHERE session_token = ?`)
      .run(sessionToken);
  } catch (err) {
    console.error("[Session] Failed to remove persisted session:", err);
  }
}

function clearPersistedSessions(): void {
  try {
    const db = getDb();
    if (!db) return;
    const raw = (
      db as unknown as { $client: import("better-sqlite3").Database }
    ).$client;
    raw.prepare(`DELETE FROM proxy_sessions`).run();
  } catch (err) {
    console.error("[Session] Failed to clear persisted sessions:", err);
  }
}

/**
 * Restore sessions from the database into the in-memory cache.
 * Should be called once at proxy startup.
 */
export function restoreSessions(): void {
  try {
    const db = getDb();
    if (!db) return;
    const raw = (
      db as unknown as { $client: import("better-sqlite3").Database }
    ).$client;
    const rows = raw
      .prepare(
        `SELECT session_token, provider_id, api_key_id, project_id, created_at FROM proxy_sessions`,
      )
      .all() as Array<{
      session_token: string;
      provider_id: string;
      api_key_id: string;
      project_id: string | null;
      created_at: string;
    }>;
    for (const row of rows) {
      const session: ProxySession = {
        sessionToken: row.session_token,
        providerId: row.provider_id,
        apiKeyId: row.api_key_id,
        projectId: row.project_id,
        createdAt: row.created_at,
      };
      sessions.set(session.sessionToken, session);
      if (session.projectId) {
        sessionByProject.set(
          getProjectSessionKey(
            session.projectId,
            session.providerId,
            session.apiKeyId,
          ),
          session.sessionToken,
        );
      }
    }
    console.log(`[Session] Restored ${rows.length} sessions from database`);
  } catch (err) {
    console.error("[Session] Failed to restore sessions:", err);
  }
}

// --- Public API (unchanged interface) ---

export function createSession(
  providerId: string,
  apiKeyId: string,
  projectId?: string,
): ProxySession {
  // If projectId is provided, check if we already have a session for this combination
  if (projectId) {
    const existingToken = sessionByProject.get(
      getProjectSessionKey(projectId, providerId, apiKeyId),
    );
    if (existingToken) {
      const existingSession = sessions.get(existingToken);
      if (existingSession) {
        // Return existing session
        return existingSession;
      }
    }
  }

  // Create new session
  const sessionToken = `session-${nanoid(16)}`;
  const session: ProxySession = {
    sessionToken,
    providerId,
    apiKeyId,
    projectId: projectId || null,
    createdAt: new Date().toISOString(),
  };
  sessions.set(sessionToken, session);
  persistSession(session);
  console.log(
    `[Session] Created: token=${sessionToken}, providerId=${providerId}, apiKeyId=${apiKeyId}, projectId=${projectId}, totalSessions=${sessions.size}`,
  );

  // Track by project if projectId is provided
  if (projectId) {
    sessionByProject.set(
      getProjectSessionKey(projectId, providerId, apiKeyId),
      sessionToken,
    );
  }

  return session;
}

export function getSession(sessionToken: string): ProxySession | null {
  console.log(
    `[Session] getSession: token=${sessionToken}, exists=${sessions.has(sessionToken)}, allTokens=[${Array.from(sessions.keys()).join(", ")}]`,
  );
  return sessions.get(sessionToken) || null;
}

export function updateSessionKey(
  sessionToken: string,
  apiKeyId: string,
): boolean {
  const session = sessions.get(sessionToken);
  if (!session) {
    return false;
  }
  session.apiKeyId = apiKeyId;
  sessions.set(sessionToken, session);
  persistSession(session);
  return true;
}

export function deleteSession(sessionToken: string): boolean {
  // Also remove from project mapping
  const session = sessions.get(sessionToken);
  if (session) {
    // Find and remove from sessionByProject
    for (const [key, token] of sessionByProject.entries()) {
      if (token === sessionToken) {
        sessionByProject.delete(key);
        break;
      }
    }
  }
  removePersistedSession(sessionToken);
  return sessions.delete(sessionToken);
}

export function listSessions(): ProxySession[] {
  return Array.from(sessions.values());
}

export function getSessionByProvider(providerId: string): ProxySession | null {
  for (const session of sessions.values()) {
    if (session.providerId === providerId) {
      return session;
    }
  }
  return null;
}

/**
 * Get existing session for a project+provider+apiKey combination
 */
export function getSessionByProject(
  projectId: string,
  providerId: string,
  apiKeyId: string,
): ProxySession | null {
  const sessionToken = sessionByProject.get(
    getProjectSessionKey(projectId, providerId, apiKeyId),
  );
  if (sessionToken) {
    return sessions.get(sessionToken) || null;
  }
  return null;
}

export function clearAllSessions(): void {
  sessions.clear();
  sessionByProject.clear();
  clearPersistedSessions();
}

// Parse session token from API key header
// Format: "session-xxx" or direct API key
export function parseSessionToken(authHeader: string): string | null {
  if (!authHeader) {
    return null;
  }

  // Remove "Bearer " prefix if present
  const token = authHeader.replace(/^Bearer\s+/i, "");

  // Check if it's a session token
  if (token.startsWith("session-")) {
    return token;
  }

  return null;
}

/**
 * Update all sessions for a given project to point to a new provider/apiKey.
 * This enables hot-switching: the terminal keeps its session token, but the
 * proxy resolves it to the updated provider/key on the next request.
 */
export function updateSessionsByProject(
  projectId: string,
  newProviderId: string,
  newApiKeyId: string,
): number {
  const prefix = `${projectId}:`;
  const newKey = getProjectSessionKey(projectId, newProviderId, newApiKeyId);

  // Collect matching entries first to avoid mutating the Map during iteration
  const toUpdate: { oldKey: string; sessionToken: string }[] = [];
  for (const [compositeKey, sessionToken] of sessionByProject.entries()) {
    if (compositeKey.startsWith(prefix)) {
      toUpdate.push({ oldKey: compositeKey, sessionToken });
    }
  }

  // Now apply updates
  for (const { oldKey, sessionToken } of toUpdate) {
    const session = sessions.get(sessionToken);
    if (session) {
      session.providerId = newProviderId;
      session.apiKeyId = newApiKeyId;
      persistSession(session);
    }
    sessionByProject.delete(oldKey);
    sessionByProject.set(newKey, sessionToken);
  }

  return toUpdate.length;
}

// Get active session count
export function getActiveSessionCount(): number {
  return sessions.size;
}
