use crate::db::Database;
use crate::models::{ApiKey, CreateApiKeyInput, UpdateApiKeyInput, UsageData};

fn non_empty(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn normalize_model_mapping(value: Option<&String>) -> Option<String> {
    crate::shared_runtime::model_mapping::sanitize_mapping(value.map(String::as_str))
}

fn row_to_api_key(row: &rusqlite::Row) -> Result<ApiKey, rusqlite::Error> {
    // SELECT: id(0), provider_id(1), alias(2), value(3), priority(4),
    //         is_exhausted(5), is_active(6), config(7), usage_type(8),
    //         usage_url(9), usage_path(10), usage_headers(11),
    //         cached_usage(12), last_usage_checked_at(13), model_mapping(14),
    //         types(15), client_configs(16), usage_script(17), query_config(18)
    let config_str: Option<String> = row.get(7)?;
    let config = config_str.and_then(|s| serde_json::from_str(&s).ok());
    let client_configs_str: Option<String> = row.get(16)?;
    let client_configs = client_configs_str.and_then(|s| serde_json::from_str(&s).ok());
    let types = row
        .get::<_, Option<String>>(15)?
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .filter(|types| !types.is_empty())
        .unwrap_or_else(|| vec!["claude_code".to_string()]);

    Ok(ApiKey {
        id: row.get(0)?,
        provider_id: row.get(1)?,
        alias: row.get(2)?,
        value: row.get(3)?,
        types,
        priority: row.get(4)?,
        is_exhausted: row.get::<_, i32>(5)? != 0,
        is_active: row.get::<_, i32>(6)? != 0,
        config,
        usage_type: row
            .get::<_, Option<String>>(8)?
            .unwrap_or_else(|| "none".to_string()),
        usage_url: row.get(9)?,
        usage_path: row.get(10)?,
        usage_headers: row.get(11)?,
        cached_usage: row
            .get::<_, Option<String>>(12)?
            .and_then(|s| serde_json::from_str::<UsageData>(&s).ok()),
        last_usage_checked_at: row.get(13)?,
        model_mapping: crate::shared_runtime::model_mapping::sanitize_mapping(
            row.get::<_, Option<String>>(14)?.as_deref(),
        ),
        client_configs,
        usage_script: row
            .get::<_, Option<String>>(17)?
            .filter(|value| !value.trim().is_empty()),
        query_config: crate::shared_runtime::query_schemes::parse_query_config(
            row.get::<_, Option<String>>(18)?.as_deref(),
        ),
    })
}

/// Column list shared by every key read, in `row_to_api_key` order.
const API_KEY_COLUMNS: &str = "id, provider_id, alias, value, priority, is_exhausted, is_active,
        config, usage_type, usage_url, usage_path, usage_headers,
        cached_usage, last_usage_checked_at, model_mapping, types,
        client_configs, usage_script, query_config";

/// The credential the provider's account query would borrow right now, read
/// straight from storage.
///
/// Mirrors `balance_service::pick_first_available_key` over enabled, active,
/// unexhausted keys by priority; a SQL twin lives here because the
/// invalidation compares before/after *inside* this layer's transaction.
fn pick_first_available_key_sql(
    conn: &rusqlite::Connection,
    provider_id: &str,
) -> Result<Option<String>, rusqlite::Error> {
    conn.query_row(
        "SELECT value FROM api_keys
         WHERE provider_id = ?1 AND is_active = 1 AND is_exhausted = 0
           AND TRIM(COALESCE(value, '')) <> ''
         ORDER BY priority ASC
         LIMIT 1",
        [provider_id],
        |row| row.get::<_, String>(0),
    )
    .map(Some)
    .or_else(|error| match error {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other),
    })
}

/// The account cache belongs to the borrowed credential; when that moves, any
/// stored account answer stops being current.
fn clear_provider_account_cache(
    conn: &rusqlite::Connection,
    provider_id: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE providers SET cached_wallet_balance = NULL,
            cached_wallet_balance_currency = NULL, cached_usage = NULL,
            last_balance_checked_at = NULL, last_usage_checked_at = NULL
         WHERE id = ?1",
        [provider_id],
    )?;
    Ok(())
}

impl Database {
    pub fn api_key_list(&self, provider_id: &str) -> Result<Vec<ApiKey>, rusqlite::Error> {
        let mut stmt = self.conn.prepare_cached(&format!(
            "SELECT {API_KEY_COLUMNS} FROM api_keys WHERE provider_id = ?1 ORDER BY priority ASC"
        ))?;

        let rows = stmt.query_map([provider_id], row_to_api_key)?;
        rows.collect()
    }

    pub fn api_key_get(&self, id: &str) -> Result<Option<ApiKey>, rusqlite::Error> {
        let mut stmt = self.conn.prepare_cached(&format!(
            "SELECT {API_KEY_COLUMNS} FROM api_keys WHERE id = ?1"
        ))?;

        let mut rows = stmt.query_map([id], row_to_api_key)?;

        match rows.next() {
            Some(Ok(key)) => Ok(Some(key)),
            Some(Err(e)) => Err(e),
            None => Ok(None),
        }
    }

    pub fn api_key_create(&self, input: &CreateApiKeyInput) -> Result<ApiKey, rusqlite::Error> {
        let id = nanoid::nanoid!();
        self.api_key_create_with_id(&id, input)
    }

    pub fn api_key_create_with_id(
        &self,
        id: &str,
        input: &CreateApiKeyInput,
    ) -> Result<ApiKey, rusqlite::Error> {
        let config_json = input
            .config
            .as_ref()
            .map(|c| serde_json::to_string(c).unwrap_or_default());
        let types = input
            .types
            .as_ref()
            .filter(|types| !types.is_empty())
            .cloned()
            .unwrap_or_else(|| vec!["claude_code".to_string()]);
        let types_json =
            serde_json::to_string(&types).unwrap_or_else(|_| "[\"claude_code\"]".to_string());
        let client_configs_json = input
            .client_configs
            .as_ref()
            .map(|c| serde_json::to_string(c).unwrap_or_default());
        let model_mapping = normalize_model_mapping(input.model_mapping.as_ref());

        // One transaction: insert plus the invalidation the new credential
        // can force. A new key can become the account query's lowest-priority
        // credential — an account answer cached from a different credential
        // must not present itself as current.
        let transaction = self.conn.unchecked_transaction()?;
        let borrowed_before = pick_first_available_key_sql(&transaction, &input.provider_id)?;

        transaction.execute(
            "INSERT INTO api_keys (id, provider_id, alias, value, secret_ref, types, priority, is_exhausted, is_active,
                config, usage_type, usage_url, usage_path, usage_headers, model_mapping,
                client_configs, usage_script, query_config)
             VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, 0, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
            rusqlite::params![
                id,
                input.provider_id,
                input.alias,
                input.value,
                types_json,
                input.priority.unwrap_or(0),
                if input.is_active.unwrap_or(true) { 1 } else { 0 },
                config_json,
                input.usage_type.as_deref().unwrap_or("none"),
                input.usage_url,
                input.usage_path,
                input.usage_headers,
                model_mapping,
                client_configs_json,
                non_empty(input.usage_script.as_deref()),
                crate::shared_runtime::query_schemes::effective_query_config(
                    input.query_config.as_ref(),
                    input.usage_script.as_deref(),
                )
                .as_ref()
                .and_then(crate::shared_runtime::query_schemes::serialize_query_config),
            ],
        )?;

        let borrowed_after = pick_first_available_key_sql(&transaction, &input.provider_id)?;
        if borrowed_before != borrowed_after {
            clear_provider_account_cache(&transaction, &input.provider_id)?;
        }

        transaction.commit()?;

        self.api_key_get(id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)
    }

    pub fn api_key_update(&self, input: &UpdateApiKeyInput) -> Result<ApiKey, rusqlite::Error> {
        let mut sets = Vec::new();
        let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        add_field!(input.alias, "alias", sets, params);
        if let Some(ref value) = input.value {
            sets.push("value = ?".to_string());
            params.push(Box::new(value.clone()));
            sets.push("secret_ref = NULL".to_string());
        }
        add_field!(input.priority, "priority", sets, params);
        add_field!(input.usage_type, "usage_type", sets, params);
        add_field!(input.usage_url, "usage_url", sets, params);
        add_field!(input.usage_path, "usage_path", sets, params);
        add_field!(input.usage_headers, "usage_headers", sets, params);
        add_field!(
            input.last_usage_checked_at,
            "last_usage_checked_at",
            sets,
            params
        );
        if input.model_mapping.is_some() {
            if let Some(value) = normalize_model_mapping(input.model_mapping.as_ref()) {
                sets.push("model_mapping = ?".to_string());
                params.push(Box::new(value));
            } else {
                sets.push("model_mapping = NULL".to_string());
            }
        }
        if input.usage_script.is_some() {
            sets.push("usage_script = ?".to_string());
            params.push(Box::new(input.usage_script.clone()));
        }
        if let Some(ref val) = input.client_configs {
            sets.push("client_configs = ?".to_string());
            params.push(Box::new(serde_json::to_string(val).unwrap_or_default()));
        }

        if let Some(ref val) = input.types {
            sets.push("types = ?".to_string());
            params.push(Box::new(
                serde_json::to_string(val).unwrap_or_else(|_| "[\"claude_code\"]".to_string()),
            ));
        }

        if let Some(ref val) = input.is_exhausted {
            sets.push("is_exhausted = ?".to_string());
            params.push(Box::new(if *val { 1i32 } else { 0i32 }));
        }

        if let Some(ref val) = input.is_active {
            sets.push("is_active = ?".to_string());
            params.push(Box::new(if *val { 1i32 } else { 0i32 }));
        }

        if let Some(ref val) = input.config {
            sets.push("config = ?".to_string());
            params.push(Box::new(serde_json::to_string(val).unwrap_or_default()));
        }

        if let Some(ref val) = input.cached_usage {
            sets.push("cached_usage = ?".to_string());
            params.push(Box::new(serde_json::to_string(val).unwrap_or_default()));
        }

        // `Some(config)` replaces the whole quota config (switch + scheme);
        // absent leaves the stored one untouched.
        if let Some(ref config) = input.query_config {
            sets.push("query_config = ?".to_string());
            params.push(Box::new(
                crate::shared_runtime::query_schemes::serialize_query_config(config),
            ));
        }

        if sets.is_empty() {
            return self
                .api_key_get(&input.id)?
                .ok_or(rusqlite::Error::QueryReturnedNoRows);
        }

        let sql = format!("UPDATE api_keys SET {} WHERE id = ?", sets.join(", "));
        params.push(Box::new(input.id.clone()));

        let param_refs: Vec<&dyn rusqlite::types::ToSql> =
            params.iter().map(|p| p.as_ref()).collect();

        // One transaction: the change and the cache invalidation land together
        // or not at all. Previously THIS key's quota cache (its credential,
        // script or switch changed); and, when the credit the account query
        // borrows moved, the provider's account cache too.
        let transaction = self.conn.unchecked_transaction()?;
        let previous = transaction
            .prepare_cached(&format!(
                "SELECT {API_KEY_COLUMNS} FROM api_keys WHERE id = ?1"
            ))?
            .query_row([input.id.as_str()], row_to_api_key)
            .ok();
        // The borrow comparison must see the old table: a probe after the
        // update would read whatever the update just made.
        let borrowed_before = previous
            .as_ref()
            .map(|key| pick_first_available_key_sql(&transaction, &key.provider_id))
            .transpose()?;
        transaction.execute(&sql, param_refs.as_slice())?;

        let updated = transaction
            .prepare_cached(&format!(
                "SELECT {API_KEY_COLUMNS} FROM api_keys WHERE id = ?1"
            ))?
            .query_row([input.id.as_str()], row_to_api_key)?;

        if let Some(previous) = previous {
            // This key's own quota: a new credential value, script, scheme or
            // switch means a saved answer may not present itself as current.
            if previous.value != updated.value
                || previous.usage_script != updated.usage_script
                || previous.query_config != updated.query_config
            {
                transaction.execute(
                    "UPDATE api_keys SET cached_usage = NULL, last_usage_checked_at = NULL
                     WHERE id = ?1",
                    [input.id.as_str()],
                )?;
            }

            // The account query borrows the lowest-priority enabled, active
            // key. If this save moved who that is (or emptied it), a cached
            // account answer is no longer the answer of the credential that
            // would run now. `borrowed_before` was read above, before the
            // update landed — re-reading here would compare the update to
            // itself and never notice the moment a credential moved.
            let borrowed_after = pick_first_available_key_sql(&transaction, &updated.provider_id)?;
            if borrowed_before != Some(borrowed_after) {
                transaction.execute(
                    "UPDATE providers SET cached_wallet_balance = NULL,
                        cached_wallet_balance_currency = NULL, cached_usage = NULL,
                        last_balance_checked_at = NULL, last_usage_checked_at = NULL
                     WHERE id = ?1",
                    [updated.provider_id.as_str()],
                )?;
            }
        }
        transaction.commit()?;

        if input.model_mapping.is_some() {
            if let Some(report) = self.settings_get_value("model-mapping-retired-api-key-ids")? {
                if let Ok(mut ids) = serde_json::from_str::<Vec<String>>(&report) {
                    ids.retain(|id| id != &input.id);
                    self.settings_set_value(
                        "model-mapping-retired-api-key-ids",
                        &serde_json::to_string(&ids).unwrap_or_else(|_| "[]".into()),
                    )?;
                }
            }
        }
        Ok(updated)
    }

    pub fn api_key_delete(&self, id: &str) -> Result<(), rusqlite::Error> {
        // One transaction: the deletion and the invalidation its credential
        // moving can force.
        let transaction = self.conn.unchecked_transaction()?;
        let target = transaction
            .prepare_cached(&format!(
                "SELECT {API_KEY_COLUMNS} FROM api_keys WHERE id = ?1"
            ))?
            .query_row([id], row_to_api_key)
            .ok();
        let (provider_id, borrowed_before) = match &target {
            Some(key) => {
                let borrowed = pick_first_available_key_sql(&transaction, &key.provider_id)?;
                (Some(key.provider_id.clone()), borrowed)
            }
            None => (None, None),
        };

        // Backfill snapshot column before deletion so request_logs retain the display name
        transaction.execute(
            "UPDATE request_logs SET key_alias = (SELECT alias FROM api_keys WHERE id = ?1)
             WHERE api_key_id = ?1 AND key_alias IS NULL",
            [id],
        )?;
        // Gateway outlets have no FK to api_keys; remove the ones bound to this key
        // so they cannot linger as permanently failing outlets. The call goes
        // through the shared connection, so it joins the open transaction.
        self.gateway_delete_by_api_key(id)?;
        transaction.execute("DELETE FROM api_keys WHERE id = ?1", [id])?;

        if let Some(provider_id) = provider_id {
            let borrowed_after = pick_first_available_key_sql(&transaction, &provider_id)?;
            if borrowed_before != borrowed_after {
                clear_provider_account_cache(&transaction, &provider_id)?;
            }
        }

        transaction.commit()?;
        Ok(())
    }

    pub fn api_key_reorder(
        &self,
        provider_id: &str,
        key_ids: &[String],
    ) -> Result<Vec<ApiKey>, rusqlite::Error> {
        for (i, id) in key_ids.iter().enumerate() {
            self.conn.execute(
                "UPDATE api_keys SET priority = ?1 WHERE id = ?2 AND provider_id = ?3",
                rusqlite::params![i as i32, id, provider_id],
            )?;
        }
        self.api_key_list(provider_id)
    }
}
