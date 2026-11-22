use crate::db::client_profiles::{normalize_connection_config, normalize_profile_client_kind};
use crate::db::Database;
use crate::models::ClientProfileConnectionConfig;
use crate::shared_runtime::model_mapping;
use nanoid::nanoid;
use std::collections::HashMap;

const MIGRATION_MARKER: &str = "migration.clientProfiles.v1";

fn is_official_deepseek(base_url: &str) -> bool {
    url::Url::parse(base_url.trim())
        .ok()
        .and_then(|u| {
            u.host_str()
                .map(|h| h.eq_ignore_ascii_case("api.deepseek.com"))
        })
        .unwrap_or(false)
}

fn extract_connection_config(
    client_configs: Option<&str>,
    client_kind: &str,
) -> Option<ClientProfileConnectionConfig> {
    let raw = client_configs?.trim();
    if raw.is_empty() {
        return None;
    }
    let parsed: serde_json::Value = serde_json::from_str(raw).ok()?;
    let entry = parsed
        .get(client_kind)
        .or_else(|| {
            if client_kind == "claude_code" {
                parsed.get("claude")
            } else {
                None
            }
        })?
        .as_object()?;
    let base_url = entry
        .get("baseUrl")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    let auth_scheme = entry
        .get("authScheme")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    let user_agent = entry
        .get("proxyUserAgent")
        .or_else(|| entry.get("userAgent"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    normalize_connection_config(Some(ClientProfileConnectionConfig {
        base_url,
        auth_scheme,
        user_agent,
    }))
}

impl Database {
    /// One-shot lossless migration from legacy per-key client configurations
    /// (`api_keys.types`, `model_mapping`, `client_configs`, `config`) into
    /// first-class `client_profiles` rows.
    ///
    /// - Guarded by `migration.clientProfiles.v1`.
    /// - Leaves legacy columns on `api_keys` intact for downgrade/export compatibility.
    /// - Backfills `client_profile_id` on active desktop sessions, active managed
    ///   instances, and project client bindings.
    pub(crate) fn migrate_legacy_keys_to_client_profiles(&self) -> Result<(), rusqlite::Error> {
        if self.settings_get_value(MIGRATION_MARKER)?.is_some() {
            return Ok(());
        }

        let tx = self.conn.unchecked_transaction()?;

        // Check existing profile count so an already-populated DB isn't duplicated.
        let existing_count: i64 = tx
            .query_row("SELECT COUNT(*) FROM client_profiles", [], |row| row.get(0))
            .unwrap_or(0);

        if existing_count == 0 {
            let providers: Vec<(String, String, String)> = {
                let mut stmt = tx.prepare(
                    "SELECT id, name, base_url FROM providers ORDER BY sort_order ASC, name ASC",
                )?;
                let rows = stmt.query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })?;
                rows.collect::<Result<Vec<_>, _>>()?
            };

            let provider_map: HashMap<String, (String, String)> = providers
                .iter()
                .map(|(id, name, base_url)| (id.clone(), (name.clone(), base_url.clone())))
                .collect();

            // Count keys per provider for clean naming.
            let mut key_counts: HashMap<String, usize> = HashMap::new();
            let keys: Vec<(
                String,
                String,
                Option<String>,
                Option<String>,
                Option<String>,
                Option<String>,
                Option<String>,
                i32,
            )> = {
                let mut stmt = tx.prepare(
                    "SELECT k.id, k.provider_id, k.alias, k.types, k.config,
                            k.model_mapping, k.client_configs, k.priority
                     FROM api_keys k
                     INNER JOIN providers p ON p.id = k.provider_id
                     ORDER BY p.sort_order ASC, k.priority ASC, k.id ASC",
                )?;
                let rows = stmt.query_map([], |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                    ))
                })?;
                rows.collect::<Result<Vec<_>, _>>()?
            };

            for (_, provider_id, ..) in &keys {
                *key_counts.entry(provider_id.clone()).or_insert(0) += 1;
            }

            let now = chrono::Utc::now().to_rfc3339();
            let mut sort_counters: HashMap<&'static str, i32> = HashMap::new();

            for (
                key_id,
                provider_id,
                alias,
                types_raw,
                config_raw,
                mapping_raw,
                client_configs_raw,
                priority,
            ) in keys
            {
                let Some((provider_name, provider_base_url)) = provider_map.get(&provider_id)
                else {
                    continue;
                };
                let official_deepseek = is_official_deepseek(provider_base_url);
                let parsed_types: Vec<String> = types_raw
                    .as_deref()
                    .and_then(|raw| serde_json::from_str::<Vec<String>>(raw).ok())
                    .unwrap_or_default();
                let mut kinds: Vec<&'static str> = Vec::new();
                for raw_kind in parsed_types {
                    if let Some(normalized) = normalize_profile_client_kind(&raw_kind) {
                        if official_deepseek && normalized == "grok" {
                            continue;
                        }
                        if !kinds.contains(&normalized) {
                            kinds.push(normalized);
                        }
                    }
                }
                if kinds.is_empty() {
                    kinds.push("claude_code");
                }

                let key_count = *key_counts.get(&provider_id).unwrap_or(&1);
                let profile_name = if key_count <= 1 {
                    provider_name.clone()
                } else {
                    let key_label = alias
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(str::to_string)
                        .unwrap_or_else(|| format!("Key {}", priority + 1));
                    format!("{} · {}", provider_name, key_label)
                };

                for client_kind in kinds {
                    let profile_id = nanoid!();
                    let sort_order = *sort_counters.entry(client_kind).or_insert(0);
                    *sort_counters.entry(client_kind).or_insert(0) += 1;
                    let is_default = sort_order == 0;

                    let model_config = model_mapping::extract_single_client_mapping(
                        mapping_raw.as_deref(),
                        client_kind,
                    )
                    .and_then(|s| model_mapping::sanitize_mapping(Some(&s)));
                    let connection_config_str =
                        extract_connection_config(client_configs_raw.as_deref(), client_kind)
                            .and_then(|cfg| serde_json::to_string(&cfg).ok());
                    let launch_env_str = if client_kind == "claude_code" {
                        config_raw
                            .as_deref()
                            .map(str::trim)
                            .filter(|s| !s.is_empty() && *s != "{}")
                            .map(str::to_string)
                    } else {
                        None
                    };

                    tx.execute(
                        "INSERT INTO client_profiles (
                            id, name, client_kind, provider_id, api_key_id,
                            model_config, connection_config, launch_env,
                            is_default, sort_order, created_at, updated_at
                         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                        rusqlite::params![
                            profile_id,
                            profile_name,
                            client_kind,
                            provider_id,
                            key_id,
                            model_config,
                            connection_config_str,
                            launch_env_str,
                            is_default as i32,
                            sort_order,
                            now,
                            now,
                        ],
                    )?;

                    // Backfill active / existing sessions, instances, and project bindings.
                    let cli_aliases: &[&str] = match client_kind {
                        "claude_code" => &["claude_code", "claude"],
                        "codex" => &["codex", "codex-app"],
                        "claude_desktop" => &["claude_desktop"],
                        "grok" => &["grok"],
                        _ => &[client_kind],
                    };
                    for cli_alias in cli_aliases {
                        tx.execute(
                            "UPDATE proxy_sessions
                             SET client_profile_id = ?1
                             WHERE session_kind != 'gateway'
                               AND api_key_id = ?2
                               AND cli_type = ?3
                               AND client_profile_id IS NULL",
                            rusqlite::params![profile_id, key_id, cli_alias],
                        )?;
                        tx.execute(
                            "UPDATE managed_instances
                             SET client_profile_id = ?1
                             WHERE api_key_id = ?2
                               AND cli_type = ?3
                               AND client_profile_id IS NULL",
                            rusqlite::params![profile_id, key_id, cli_alias],
                        )?;
                        tx.execute(
                            "UPDATE project_client_bindings
                             SET client_profile_id = ?1
                             WHERE api_key_id = ?2
                               AND cli_type = ?3
                               AND client_profile_id IS NULL",
                            rusqlite::params![profile_id, key_id, cli_alias],
                        )?;
                    }

                    // Copy any existing alias table for this (key, client) into the profile namespace
                    // so taken-over desktop clients and live sessions resolve immediately without
                    // waiting for a fresh /v1/models call.
                    let legacy_alias_key = model_mapping::alias_table_key(&key_id, client_kind);
                    let existing_alias: Option<String> = tx
                        .query_row(
                            "SELECT value FROM settings WHERE key = ?1",
                            [&legacy_alias_key],
                            |row| row.get(0),
                        )
                        .ok();
                    if let Some(alias_val) = existing_alias {
                        let profile_alias_key =
                            model_mapping::alias_table_key_for_profile(&profile_id);
                        tx.execute(
                            "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
                            rusqlite::params![profile_alias_key, alias_val],
                        )?;
                    }
                }
            }
        }

        tx.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, '1')",
            [MIGRATION_MARKER],
        )?;
        tx.commit()?;
        Ok(())
    }
}
