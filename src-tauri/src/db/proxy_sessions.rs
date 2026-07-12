use crate::db::Database;
use crate::models::ProxySession;

fn row_to_proxy_session(row: &rusqlite::Row) -> Result<ProxySession, rusqlite::Error> {
    Ok(ProxySession {
        session_token: row.get(0)?,
        provider_id: row.get(1)?,
        api_key_id: row.get(2)?,
        project_id: row.get(3)?,
        created_at: row.get(4)?,
        cli_type: row.get(5)?,
        session_kind: row.get(6)?,
        last_seen_at: row.get(7)?,
        expires_at: row.get(8)?,
        revoked_at: row.get(9)?,
        revoked_reason: row.get(10)?,
    })
}

impl Database {
    pub fn proxy_session_create(&self, session: &ProxySession) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT OR REPLACE INTO proxy_sessions (
                session_token, provider_id, api_key_id, project_id, created_at, cli_type,
                session_kind, last_seen_at, expires_at, revoked_at, revoked_reason
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            rusqlite::params![
                session.session_token,
                session.provider_id,
                session.api_key_id,
                session.project_id,
                session.created_at,
                session.cli_type,
                session.session_kind,
                session.last_seen_at,
                session.expires_at,
                session.revoked_at,
                session.revoked_reason,
            ],
        )?;
        Ok(())
    }

    pub fn proxy_session_get(&self, token: &str) -> Result<Option<ProxySession>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT session_token, provider_id, api_key_id, project_id, created_at, cli_type,
                    session_kind, last_seen_at, expires_at, revoked_at, revoked_reason
             FROM proxy_sessions WHERE session_token = ?1",
        )?;

        let mut rows = stmt.query_map([token], row_to_proxy_session)?;

        match rows.next() {
            Some(Ok(s)) => Ok(Some(s)),
            Some(Err(e)) => Err(e),
            None => Ok(None),
        }
    }

    pub fn proxy_session_update_key(
        &self,
        token: &str,
        api_key_id: &str,
    ) -> Result<bool, rusqlite::Error> {
        let changed = self.conn.execute(
            "UPDATE proxy_sessions SET api_key_id = ?1 WHERE session_token = ?2",
            rusqlite::params![api_key_id, token],
        )?;
        Ok(changed > 0)
    }

    pub fn proxy_session_update_provider_key(
        &self,
        token: &str,
        provider_id: &str,
        api_key_id: &str,
    ) -> Result<bool, rusqlite::Error> {
        let changed = self.conn.execute(
            "UPDATE proxy_sessions
             SET provider_id = ?1, api_key_id = ?2
             WHERE session_token = ?3",
            rusqlite::params![provider_id, api_key_id, token],
        )?;
        Ok(changed > 0)
    }

    pub fn proxy_session_update_provider_key_cli_type(
        &self,
        token: &str,
        provider_id: &str,
        api_key_id: &str,
        cli_type: &str,
    ) -> Result<bool, rusqlite::Error> {
        let now = chrono::Utc::now().to_rfc3339();
        let changed = self.conn.execute(
            "UPDATE proxy_sessions
             SET provider_id = ?1,
                 api_key_id = ?2,
                 cli_type = ?3,
                 session_kind = 'desktop',
                 last_seen_at = ?4,
                 expires_at = NULL,
                 revoked_at = NULL,
                 revoked_reason = NULL
             WHERE session_token = ?5",
            rusqlite::params![provider_id, api_key_id, cli_type, now, token],
        )?;
        Ok(changed > 0)
    }

    pub fn proxy_session_delete(&self, token: &str) -> Result<bool, rusqlite::Error> {
        let changed = self.conn.execute(
            "DELETE FROM proxy_sessions WHERE session_token = ?1",
            [token],
        )?;
        Ok(changed > 0)
    }

    pub fn proxy_session_touch(&self, token: &str, now: &str) -> Result<bool, rusqlite::Error> {
        let changed = self.conn.execute(
            "UPDATE proxy_sessions SET last_seen_at = ?1 WHERE session_token = ?2",
            rusqlite::params![now, token],
        )?;
        Ok(changed > 0)
    }

    pub fn proxy_session_revoke(
        &self,
        token: &str,
        reason: &str,
        now: &str,
    ) -> Result<bool, rusqlite::Error> {
        let changed = self.conn.execute(
            "UPDATE proxy_sessions
             SET revoked_at = COALESCE(revoked_at, ?1),
                 revoked_reason = COALESCE(revoked_reason, ?2)
             WHERE session_token = ?3",
            rusqlite::params![now, reason, token],
        )?;
        Ok(changed > 0)
    }

    pub fn proxy_session_revoke_stopped_managed(
        &self,
        now: &str,
    ) -> Result<usize, rusqlite::Error> {
        self.conn.execute(
            "UPDATE proxy_sessions
             SET revoked_at = COALESCE(revoked_at, ?1),
                 revoked_reason = COALESCE(revoked_reason, 'instance_stopped')
             WHERE session_kind = 'managed'
               AND revoked_at IS NULL
               AND session_token IN (
                 SELECT session_token FROM managed_instances
                 WHERE status IN ('stopped', 'failed')
               )",
            [now],
        )
    }

    pub fn proxy_session_list(&self) -> Result<Vec<ProxySession>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT session_token, provider_id, api_key_id, project_id, created_at, cli_type,
                    session_kind, last_seen_at, expires_at, revoked_at, revoked_reason
             FROM proxy_sessions ORDER BY created_at DESC",
        )?;

        let rows = stmt.query_map([], row_to_proxy_session)?;

        rows.collect()
    }

    pub fn proxy_session_update_by_project(
        &self,
        project_id: &str,
        provider_id: &str,
        api_key_id: &str,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE proxy_sessions SET provider_id = ?1, api_key_id = ?2 WHERE project_id = ?3",
            rusqlite::params![provider_id, api_key_id, project_id],
        )?;
        Ok(())
    }

    /// Remove sessions older than the given number of days.
    /// Returns the number of deleted rows.
    pub fn proxy_session_cleanup_stale(&self, max_age_days: i64) -> Result<i64, rusqlite::Error> {
        let cutoff = chrono::Utc::now() - chrono::Duration::days(max_age_days);
        let cutoff_str = cutoff.to_rfc3339();
        let deleted = self.conn.execute(
            "DELETE FROM proxy_sessions
             WHERE session_kind != 'desktop'
               AND COALESCE(last_seen_at, created_at) < ?1",
            [&cutoff_str],
        )?;
        Ok(deleted as i64)
    }
}
