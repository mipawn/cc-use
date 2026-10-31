use crate::db::Database;
use crate::models::{Gateway, GatewayConnectionConfig, ProxySession};

const GATEWAY_SELECT: &str = "SELECT ps.session_token, COALESCE(ps.display_name, ''),
        ps.provider_id, COALESCE(p.name, ''),
        ps.api_key_id, k.alias,
        ps.is_active, ps.created_at, ps.last_seen_at,
        ps.gateway_connection_config, ps.gateway_model_policy
 FROM proxy_sessions ps
 LEFT JOIN providers p ON p.id = ps.provider_id
 LEFT JOIN api_keys k ON k.id = ps.api_key_id";

const PROXY_SESSION_SELECT: &str = "SELECT session_token, provider_id, api_key_id, project_id,
        created_at, cli_type, session_kind, last_seen_at, expires_at, revoked_at,
        revoked_reason, display_name, is_active, gateway_connection_config, gateway_model_policy
 FROM proxy_sessions";

/// A corrupt stored connection configuration is reported as a database error
/// whose message never repeats the stored JSON (it can contain configuration
/// the user typed).
fn connection_config_error(message: String) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Text,
        Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            message,
        )),
    )
}

fn read_connection_config(
    raw: Option<String>,
) -> Result<Option<GatewayConnectionConfig>, rusqlite::Error> {
    crate::shared_runtime::gateway_connection::config_from_json(raw.as_deref())
        .map_err(connection_config_error)
}

/// `Gateway.connectionConfig` is normalized: a SQL NULL (legacy row that the
/// marker-guarded migration has not touched yet) reads as the Bearer default.
fn read_gateway_connection_config(
    raw: Option<String>,
) -> Result<GatewayConnectionConfig, rusqlite::Error> {
    Ok(read_connection_config(raw)?.unwrap_or_default())
}

fn row_to_gateway(row: &rusqlite::Row) -> Result<Gateway, rusqlite::Error> {
    Ok(Gateway {
        session_token: row.get(0)?,
        display_name: row.get(1)?,
        provider_id: row.get(2)?,
        provider_name: row.get(3)?,
        api_key_id: row.get(4)?,
        key_alias: row.get(5)?,
        is_active: row.get::<_, i32>(6)? != 0,
        created_at: row.get(7)?,
        last_seen_at: row.get(8)?,
        connection_config: read_gateway_connection_config(row.get(9)?)?,
        model_policy: crate::shared_runtime::gateway_model_policy::from_json(
            row.get::<_, Option<String>>(10)?.as_deref(),
        )
        .map_err(connection_config_error)?,
    })
}

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
        display_name: row.get(11)?,
        is_active: row.get::<_, i32>(12)? != 0,
        connection_config: read_connection_config(row.get(13)?)?,
        model_policy: row
            .get::<_, Option<String>>(14)?
            .map(|raw| crate::shared_runtime::gateway_model_policy::from_json(Some(&raw)))
            .transpose()
            .map_err(connection_config_error)?,
    })
}

impl Database {
    pub fn proxy_session_create(&self, session: &ProxySession) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT OR REPLACE INTO proxy_sessions (
                session_token, provider_id, api_key_id, project_id, created_at, cli_type,
                session_kind, last_seen_at, expires_at, revoked_at, revoked_reason,
                display_name, is_active, gateway_connection_config, gateway_model_policy
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
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
                session.display_name,
                session.is_active as i32,
                session
                    .connection_config
                    .as_ref()
                    .map(crate::shared_runtime::gateway_connection::config_to_json)
                    .transpose()
                    .map_err(connection_config_error)?,
                if session.session_kind == "gateway" {
                    session
                        .model_policy
                        .as_ref()
                        .map(crate::shared_runtime::gateway_model_policy::to_json)
                        .transpose()
                        .map_err(connection_config_error)?
                } else {
                    None
                },
            ],
        )?;
        Ok(())
    }

    pub fn proxy_session_get(&self, token: &str) -> Result<Option<ProxySession>, rusqlite::Error> {
        let mut stmt = self
            .conn
            .prepare(&format!("{PROXY_SESSION_SELECT} WHERE session_token = ?1"))?;

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
        let mut stmt = self.conn.prepare(&format!(
            "{PROXY_SESSION_SELECT} WHERE session_kind != 'gateway' ORDER BY created_at DESC"
        ))?;

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
             WHERE session_kind NOT IN ('desktop', 'gateway')
               AND COALESCE(last_seen_at, created_at) < ?1",
            [&cutoff_str],
        )?;
        Ok(deleted as i64)
    }

    pub fn gateway_list(&self) -> Result<Vec<Gateway>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(&format!(
            "{GATEWAY_SELECT} WHERE ps.session_kind = 'gateway' ORDER BY ps.created_at DESC"
        ))?;
        let rows = stmt.query_map([], row_to_gateway)?;
        rows.collect()
    }

    pub fn gateway_get(&self, session_token: &str) -> Result<Option<Gateway>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(&format!(
            "{GATEWAY_SELECT} WHERE ps.session_kind = 'gateway' AND ps.session_token = ?1"
        ))?;
        let mut rows = stmt.query_map([session_token], row_to_gateway)?;
        match rows.next() {
            Some(Ok(gateway)) => Ok(Some(gateway)),
            Some(Err(error)) => Err(error),
            None => Ok(None),
        }
    }

    /// Update only gateway rows. `None` leaves a field unchanged; the
    /// connection configuration is replaced wholesale when supplied (callers
    /// always store a complete normalized object, never a partial patch).
    pub fn gateway_update(
        &self,
        session_token: &str,
        display_name: Option<&str>,
        provider_id: Option<&str>,
        api_key_id: Option<&str>,
        is_active: Option<bool>,
        connection_config: Option<&str>,
    ) -> Result<bool, rusqlite::Error> {
        self.gateway_update_with_policy(
            session_token,
            display_name,
            provider_id,
            api_key_id,
            is_active,
            connection_config,
            None,
        )
    }

    // Mirrors the atomic gateway update fields; None consistently means preserve.
    #[allow(clippy::too_many_arguments)]
    pub fn gateway_update_with_policy(
        &self,
        session_token: &str,
        display_name: Option<&str>,
        provider_id: Option<&str>,
        api_key_id: Option<&str>,
        is_active: Option<bool>,
        connection_config: Option<&str>,
        model_policy: Option<&str>,
    ) -> Result<bool, rusqlite::Error> {
        let changed = self.conn.execute(
            "UPDATE proxy_sessions
             SET display_name = COALESCE(?1, display_name),
                 provider_id = COALESCE(?2, provider_id),
                 api_key_id = COALESCE(?3, api_key_id),
                 is_active = COALESCE(?4, is_active),
                 gateway_connection_config = COALESCE(?5, gateway_connection_config),
                 gateway_model_policy = COALESCE(?6, gateway_model_policy)
             WHERE session_token = ?7 AND session_kind = 'gateway'",
            rusqlite::params![
                display_name,
                provider_id,
                api_key_id,
                is_active.map(|value| value as i32),
                connection_config,
                model_policy,
                session_token,
            ],
        )?;
        Ok(changed > 0)
    }

    pub fn gateway_delete(&self, session_token: &str) -> Result<bool, rusqlite::Error> {
        let changed = self.conn.execute(
            "DELETE FROM proxy_sessions
             WHERE session_token = ?1 AND session_kind = 'gateway'",
            [session_token],
        )?;
        Ok(changed > 0)
    }

    /// Remove outlets whose bound key was deleted; gateway rows have no FK.
    pub fn gateway_delete_by_api_key(&self, api_key_id: &str) -> Result<usize, rusqlite::Error> {
        self.conn.execute(
            "DELETE FROM proxy_sessions
             WHERE session_kind = 'gateway' AND api_key_id = ?1",
            [api_key_id],
        )
    }

    /// Remove outlets whose provider (and therefore keys) was deleted.
    pub fn gateway_delete_by_provider(&self, provider_id: &str) -> Result<usize, rusqlite::Error> {
        self.conn.execute(
            "DELETE FROM proxy_sessions
             WHERE session_kind = 'gateway' AND provider_id = ?1",
            [provider_id],
        )
    }
}
