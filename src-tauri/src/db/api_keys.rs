use crate::db::Database;
use crate::models::{ApiKey, CreateApiKeyInput, UpdateApiKeyInput, UsageData};

fn row_to_api_key(row: &rusqlite::Row) -> Result<ApiKey, rusqlite::Error> {
    // SELECT: id(0), provider_id(1), alias(2), value(3), priority(4),
    //         is_exhausted(5), is_active(6), config(7), usage_type(8),
    //         usage_url(9), usage_path(10), usage_headers(11),
    //         cached_usage(12), last_usage_checked_at(13), cost_multiplier(14), model_mapping(15),
    //         types(16), client_configs(17)
    let config_str: Option<String> = row.get(7)?;
    let config = config_str.and_then(|s| serde_json::from_str(&s).ok());
    let client_configs_str: Option<String> = row.get(17)?;
    let client_configs = client_configs_str.and_then(|s| serde_json::from_str(&s).ok());
    let types = row
        .get::<_, Option<String>>(16)?
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
        cost_multiplier: row.get::<_, Option<f64>>(14)?.unwrap_or(1.0),
        model_mapping: row.get(15)?,
        client_configs,
    })
}

impl Database {
    pub fn api_key_list(&self, provider_id: &str) -> Result<Vec<ApiKey>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, provider_id, alias, value, priority, is_exhausted, is_active,
                    config, usage_type, usage_url, usage_path, usage_headers,
                    cached_usage, last_usage_checked_at, cost_multiplier, model_mapping, types,
                    client_configs
             FROM api_keys WHERE provider_id = ?1 ORDER BY priority ASC",
        )?;

        let rows = stmt.query_map([provider_id], row_to_api_key)?;
        rows.collect()
    }

    pub fn api_key_get(&self, id: &str) -> Result<Option<ApiKey>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, provider_id, alias, value, priority, is_exhausted, is_active,
                    config, usage_type, usage_url, usage_path, usage_headers,
                    cached_usage, last_usage_checked_at, cost_multiplier, model_mapping, types,
                    client_configs
             FROM api_keys WHERE id = ?1",
        )?;

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

        self.conn.execute(
            "INSERT INTO api_keys (id, provider_id, alias, value, secret_ref, types, priority, is_exhausted, is_active,
                config, usage_type, usage_url, usage_path, usage_headers, cost_multiplier, model_mapping,
                client_configs)
             VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, 0, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
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
                input.cost_multiplier.unwrap_or(1.0),
                input.model_mapping,
                client_configs_json,
            ],
        )?;

        self.api_key_get(&id)?
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
        add_field!(input.cost_multiplier, "cost_multiplier", sets, params);
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
        add_field!(input.model_mapping, "model_mapping", sets, params);
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

        if sets.is_empty() {
            return self
                .api_key_get(&input.id)?
                .ok_or(rusqlite::Error::QueryReturnedNoRows);
        }

        let sql = format!("UPDATE api_keys SET {} WHERE id = ?", sets.join(", "));
        params.push(Box::new(input.id.clone()));

        let param_refs: Vec<&dyn rusqlite::types::ToSql> =
            params.iter().map(|p| p.as_ref()).collect();
        self.conn.execute(&sql, param_refs.as_slice())?;

        self.api_key_get(&input.id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)
    }

    pub fn api_key_delete(&self, id: &str) -> Result<(), rusqlite::Error> {
        // Backfill snapshot column before deletion so request_logs retain the display name
        self.conn.execute(
            "UPDATE request_logs SET key_alias = (SELECT alias FROM api_keys WHERE id = ?1)
             WHERE api_key_id = ?1 AND key_alias IS NULL",
            [id],
        )?;
        self.conn
            .execute("DELETE FROM api_keys WHERE id = ?1", [id])?;
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
