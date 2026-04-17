use crate::db::Database;
use crate::models::{ApiKey, CreateApiKeyInput, UpdateApiKeyInput, UsageData};

fn row_to_api_key(row: &rusqlite::Row) -> Result<ApiKey, rusqlite::Error> {
    let types_str: Option<String> = row.get(4)?;
    let types: Vec<String> = types_str
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| vec!["claude".to_string()]);

    let config_str: Option<String> = row.get(8)?;
    let config = config_str.and_then(|s| serde_json::from_str(&s).ok());

    Ok(ApiKey {
        id: row.get(0)?,
        provider_id: row.get(1)?,
        alias: row.get(2)?,
        value: row.get(3)?,
        types,
        priority: row.get(5)?,
        is_exhausted: row.get::<_, i32>(6)? != 0,
        is_active: row.get::<_, i32>(7)? != 0,
        config,
        usage_type: row
            .get::<_, Option<String>>(9)?
            .unwrap_or_else(|| "none".to_string()),
        usage_url: row.get(10)?,
        usage_path: row.get(11)?,
        usage_headers: row.get(12)?,
        cached_usage: row
            .get::<_, Option<String>>(13)?
            .and_then(|s| serde_json::from_str::<UsageData>(&s).ok()),
        last_usage_checked_at: row.get(14)?,
        cost_multiplier: row.get::<_, Option<f64>>(15)?.unwrap_or(1.0),
    })
}

impl Database {
    pub fn api_key_list(&self, provider_id: &str) -> Result<Vec<ApiKey>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, provider_id, alias, value, types, priority, is_exhausted, is_active,
                    config, usage_type, usage_url, usage_path, usage_headers,
                    cached_usage, last_usage_checked_at, cost_multiplier
             FROM api_keys WHERE provider_id = ?1 ORDER BY priority ASC",
        )?;

        let rows = stmt.query_map([provider_id], row_to_api_key)?;
        rows.collect()
    }

    pub fn api_key_get(&self, id: &str) -> Result<Option<ApiKey>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, provider_id, alias, value, types, priority, is_exhausted, is_active,
                    config, usage_type, usage_url, usage_path, usage_headers,
                    cached_usage, last_usage_checked_at, cost_multiplier
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
        let types_json = serde_json::to_string(
            &input
                .types
                .clone()
                .unwrap_or_else(|| vec!["claude".to_string()]),
        )
        .unwrap_or_else(|_| "[\"claude\"]".to_string());
        let config_json = input
            .config
            .as_ref()
            .map(|c| serde_json::to_string(c).unwrap_or_default());

        self.conn.execute(
            "INSERT INTO api_keys (id, provider_id, alias, value, types, priority, is_exhausted, is_active,
                config, usage_type, usage_url, usage_path, usage_headers, cost_multiplier)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
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
            ],
        )?;

        self.api_key_get(&id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)
    }

    pub fn api_key_update(&self, input: &UpdateApiKeyInput) -> Result<ApiKey, rusqlite::Error> {
        let mut sets = Vec::new();
        let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        add_field!(input.alias, "alias", sets, params);
        add_field!(input.value, "value", sets, params);
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

        if let Some(ref types) = input.types {
            sets.push("types = ?".to_string());
            params.push(Box::new(serde_json::to_string(types).unwrap_or_default()));
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
