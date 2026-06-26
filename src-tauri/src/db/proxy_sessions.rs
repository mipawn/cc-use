use crate::db::Database;
use crate::models::ProxySession;

impl Database {
    pub fn proxy_session_create(&self, session: &ProxySession) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT OR REPLACE INTO proxy_sessions (session_token, provider_id, api_key_id, project_id, created_at, cli_type)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                session.session_token,
                session.provider_id,
                session.api_key_id,
                session.project_id,
                session.created_at,
                session.cli_type,
            ],
        )?;
        Ok(())
    }

    pub fn proxy_session_get(&self, token: &str) -> Result<Option<ProxySession>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT session_token, provider_id, api_key_id, project_id, created_at, cli_type
             FROM proxy_sessions WHERE session_token = ?1",
        )?;

        let mut rows = stmt.query_map([token], |row| {
            Ok(ProxySession {
                session_token: row.get(0)?,
                provider_id: row.get(1)?,
                api_key_id: row.get(2)?,
                project_id: row.get(3)?,
                created_at: row.get(4)?,
                cli_type: row.get(5)?,
            })
        })?;

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
        let changed = self.conn.execute(
            "UPDATE proxy_sessions
             SET provider_id = ?1, api_key_id = ?2, cli_type = ?3
             WHERE session_token = ?4",
            rusqlite::params![provider_id, api_key_id, cli_type, token],
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

    pub fn proxy_session_list(&self) -> Result<Vec<ProxySession>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT session_token, provider_id, api_key_id, project_id, created_at, cli_type
             FROM proxy_sessions ORDER BY created_at DESC",
        )?;

        let rows = stmt.query_map([], |row| {
            Ok(ProxySession {
                session_token: row.get(0)?,
                provider_id: row.get(1)?,
                api_key_id: row.get(2)?,
                project_id: row.get(3)?,
                created_at: row.get(4)?,
                cli_type: row.get(5)?,
            })
        })?;

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
            "DELETE FROM proxy_sessions WHERE created_at < ?1",
            [&cutoff_str],
        )?;
        Ok(deleted as i64)
    }
}
