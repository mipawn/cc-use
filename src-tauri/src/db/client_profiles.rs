use crate::db::Database;
use crate::models::{
    ClientProfile, ClientProfileConnectionConfig, CreateClientProfileInput,
    UpdateClientProfileInput,
};
use crate::shared_runtime::model_mapping;
use nanoid::nanoid;

const CLIENT_PROFILE_SELECT: &str = "SELECT id, name, client_kind, provider_id, api_key_id,
        model_config, connection_config, launch_env, is_default, sort_order,
        created_at, updated_at
 FROM client_profiles";

pub fn normalize_profile_client_kind(kind: &str) -> Option<&'static str> {
    match kind.trim() {
        "claude" | "claude_code" => Some("claude_code"),
        "grok" => Some("grok"),
        "codex" | "codex-app" => Some("codex"),
        "claude_desktop" => Some("claude_desktop"),
        _ => None,
    }
}

pub fn normalize_connection_config(
    config: Option<ClientProfileConnectionConfig>,
) -> Option<ClientProfileConnectionConfig> {
    let cfg = config?;
    let base_url = cfg
        .base_url
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let auth_scheme = cfg
        .auth_scheme
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s != "default");
    let user_agent = cfg
        .user_agent
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    if base_url.is_none() && auth_scheme.is_none() && user_agent.is_none() {
        None
    } else {
        Some(ClientProfileConnectionConfig {
            base_url,
            auth_scheme,
            user_agent,
        })
    }
}

fn row_to_client_profile(row: &rusqlite::Row) -> Result<ClientProfile, rusqlite::Error> {
    let connection_config_raw: Option<String> = row.get(6)?;
    let connection_config = connection_config_raw
        .as_deref()
        .and_then(|raw| serde_json::from_str::<ClientProfileConnectionConfig>(raw).ok())
        .and_then(|cfg| normalize_connection_config(Some(cfg)));
    let launch_env_raw: Option<String> = row.get(7)?;
    let launch_env = launch_env_raw
        .as_deref()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok());
    Ok(ClientProfile {
        id: row.get(0)?,
        name: row.get(1)?,
        client_kind: row.get(2)?,
        provider_id: row.get(3)?,
        api_key_id: row.get(4)?,
        model_config: row.get(5)?,
        connection_config,
        launch_env,
        is_default: row.get::<_, i32>(8)? != 0,
        sort_order: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

impl Database {
    pub fn client_profile_list(
        &self,
        client_kind: Option<&str>,
    ) -> Result<Vec<ClientProfile>, rusqlite::Error> {
        if let Some(kind) = client_kind {
            let normalized = normalize_profile_client_kind(kind).unwrap_or(kind);
            let mut stmt = self.conn.prepare(&format!(
                "{CLIENT_PROFILE_SELECT} WHERE client_kind = ?1 ORDER BY sort_order ASC, created_at ASC"
            ))?;
            let rows = stmt.query_map([normalized], row_to_client_profile)?;
            rows.collect()
        } else {
            let mut stmt = self.conn.prepare(&format!(
                "{CLIENT_PROFILE_SELECT} ORDER BY client_kind ASC, sort_order ASC, created_at ASC"
            ))?;
            let rows = stmt.query_map([], row_to_client_profile)?;
            rows.collect()
        }
    }

    pub fn client_profile_get(&self, id: &str) -> Result<Option<ClientProfile>, rusqlite::Error> {
        let mut stmt = self
            .conn
            .prepare(&format!("{CLIENT_PROFILE_SELECT} WHERE id = ?1"))?;
        let mut rows = stmt.query_map([id], row_to_client_profile)?;
        match rows.next() {
            Some(Ok(profile)) => Ok(Some(profile)),
            Some(Err(err)) => Err(err),
            None => Ok(None),
        }
    }

    pub fn client_profile_list_by_key(
        &self,
        api_key_id: &str,
    ) -> Result<Vec<ClientProfile>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(&format!(
            "{CLIENT_PROFILE_SELECT} WHERE api_key_id = ?1 ORDER BY client_kind ASC, sort_order ASC"
        ))?;
        let rows = stmt.query_map([api_key_id], row_to_client_profile)?;
        rows.collect()
    }

    pub fn client_profile_create(
        &self,
        input: &CreateClientProfileInput,
    ) -> Result<ClientProfile, rusqlite::Error> {
        let id = nanoid!();
        let now = chrono::Utc::now().to_rfc3339();
        let client_kind = normalize_profile_client_kind(&input.client_kind)
            .unwrap_or("claude_code")
            .to_string();
        let model_config = model_mapping::sanitize_mapping(input.model_config.as_deref());
        let connection_config = normalize_connection_config(input.connection_config.clone());
        let connection_config_str = connection_config
            .as_ref()
            .and_then(|cfg| serde_json::to_string(cfg).ok());
        let launch_env_str = if client_kind == "claude_code" {
            input
                .launch_env
                .as_ref()
                .and_then(|v| serde_json::to_string(v).ok())
        } else {
            None
        };
        let is_default = input.is_default.unwrap_or(false);

        let tx = self.conn.unchecked_transaction()?;
        let max_order: i32 = tx
            .query_row(
                "SELECT COALESCE(MAX(sort_order), -1) FROM client_profiles WHERE client_kind = ?1",
                [&client_kind],
                |row| row.get(0),
            )
            .unwrap_or(-1);
        let sort_order = max_order + 1;

        if is_default {
            tx.execute(
                "UPDATE client_profiles SET is_default = 0 WHERE client_kind = ?1",
                [&client_kind],
            )?;
        }

        tx.execute(
            "INSERT INTO client_profiles (
                id, name, client_kind, provider_id, api_key_id,
                model_config, connection_config, launch_env,
                is_default, sort_order, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            rusqlite::params![
                id,
                input.name.trim(),
                client_kind,
                input.provider_id,
                input.api_key_id,
                model_config,
                connection_config_str,
                launch_env_str,
                is_default as i32,
                sort_order,
                now,
                now,
            ],
        )?;
        tx.commit()?;

        self.client_profile_get(&id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)
    }

    pub fn client_profile_update(
        &self,
        input: &UpdateClientProfileInput,
    ) -> Result<ClientProfile, rusqlite::Error> {
        let existing = self
            .client_profile_get(&input.id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        let now = chrono::Utc::now().to_rfc3339();
        let next_name = input
            .name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(&existing.name)
            .to_string();
        let next_provider_id = input
            .provider_id
            .clone()
            .unwrap_or_else(|| existing.provider_id.clone());
        let next_api_key_id = input
            .api_key_id
            .clone()
            .unwrap_or_else(|| existing.api_key_id.clone());
        let next_model_config = match &input.model_config {
            Some(raw) => model_mapping::sanitize_mapping(Some(raw.as_str())),
            None => existing.model_config.clone(),
        };
        let next_connection_config = match &input.connection_config {
            Some(cfg) => normalize_connection_config(Some(cfg.clone())),
            None => existing.connection_config.clone(),
        };
        let next_connection_config_str = next_connection_config
            .as_ref()
            .and_then(|cfg| serde_json::to_string(cfg).ok());
        let next_launch_env = if existing.client_kind == "claude_code" {
            match &input.launch_env {
                Some(v) => Some(v.clone()),
                None => existing.launch_env.clone(),
            }
        } else {
            None
        };
        let next_launch_env_str = next_launch_env
            .as_ref()
            .and_then(|v| serde_json::to_string(v).ok());
        let next_is_default = input.is_default.unwrap_or(existing.is_default);

        let binding_changed =
            next_provider_id != existing.provider_id || next_api_key_id != existing.api_key_id;

        let tx = self.conn.unchecked_transaction()?;
        if input.is_default == Some(true) {
            tx.execute(
                "UPDATE client_profiles SET is_default = 0 WHERE client_kind = ?1 AND id != ?2",
                rusqlite::params![existing.client_kind, existing.id],
            )?;
        }

        tx.execute(
            "UPDATE client_profiles
             SET name = ?1,
                 provider_id = ?2,
                 api_key_id = ?3,
                 model_config = ?4,
                 connection_config = ?5,
                 launch_env = ?6,
                 is_default = ?7,
                 updated_at = ?8
             WHERE id = ?9",
            rusqlite::params![
                next_name,
                next_provider_id,
                next_api_key_id,
                next_model_config,
                next_connection_config_str,
                next_launch_env_str,
                next_is_default as i32,
                now,
                existing.id,
            ],
        )?;

        // When rotating the bound key/provider on a profile (e.g. OpenCode Go account swap),
        // update live sessions and active managed instances tied to this profile immediately.
        if binding_changed {
            tx.execute(
                "UPDATE proxy_sessions
                 SET provider_id = ?1, api_key_id = ?2
                 WHERE client_profile_id = ?3
                   AND revoked_at IS NULL",
                rusqlite::params![next_provider_id, next_api_key_id, existing.id],
            )?;
            tx.execute(
                "UPDATE managed_instances
                 SET provider_id = ?1, api_key_id = ?2
                 WHERE client_profile_id = ?3
                   AND status IN ('launching', 'running', 'stale')",
                rusqlite::params![next_provider_id, next_api_key_id, existing.id],
            )?;
        }

        tx.commit()?;

        self.client_profile_get(&existing.id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)
    }

    pub fn client_profile_delete(&self, id: &str) -> Result<bool, rusqlite::Error> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "UPDATE proxy_sessions SET client_profile_id = NULL WHERE client_profile_id = ?1",
            [id],
        )?;
        tx.execute(
            "UPDATE managed_instances SET client_profile_id = NULL WHERE client_profile_id = ?1",
            [id],
        )?;
        tx.execute(
            "UPDATE project_client_bindings SET client_profile_id = NULL WHERE client_profile_id = ?1",
            [id],
        )?;
        tx.execute(
            "DELETE FROM settings WHERE key = ?1",
            [model_mapping::alias_table_key_for_profile(id)],
        )?;
        let changed = tx.execute("DELETE FROM client_profiles WHERE id = ?1", [id])?;
        tx.commit()?;
        Ok(changed > 0)
    }

    pub fn client_profile_reorder(
        &self,
        client_kind: &str,
        ids: &[String],
    ) -> Result<(), rusqlite::Error> {
        let normalized = normalize_profile_client_kind(client_kind).unwrap_or(client_kind);
        let tx = self.conn.unchecked_transaction()?;
        for (index, id) in ids.iter().enumerate() {
            tx.execute(
                "UPDATE client_profiles SET sort_order = ?1 WHERE id = ?2 AND client_kind = ?3",
                rusqlite::params![index as i32, id, normalized],
            )?;
        }
        tx.commit()?;
        Ok(())
    }
}
