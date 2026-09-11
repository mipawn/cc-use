use crate::db::Database;
use crate::models::{CreateProviderInput, Provider, UpdateProviderInput, UsageData};

fn row_to_provider(row: &rusqlite::Row) -> Result<Provider, rusqlite::Error> {
    Ok(Provider {
        id: row.get(0)?,
        name: row.get(1)?,
        base_url: row.get(2)?,
        http_proxy: row.get(3)?,
        website: row.get(4)?,
        remark: row.get(5)?,
        token: row.get(6)?,
        icon: row.get(7)?,
        wallet_balance_type: row
            .get::<_, Option<String>>(8)?
            .unwrap_or_else(|| "none".to_string()),
        wallet_balance_url: row.get(9)?,
        wallet_balance_path: row.get(10)?,
        wallet_balance_headers: row.get(11)?,
        wallet_balance_user_id: row.get(12)?,
        cached_wallet_balance: row.get(13)?,
        cached_wallet_balance_currency: row.get(25)?,
        last_balance_checked_at: row.get(14)?,
        usage_type: row
            .get::<_, Option<String>>(15)?
            .unwrap_or_else(|| "none".to_string()),
        usage_url: row.get(16)?,
        usage_path: row.get(17)?,
        usage_headers: row.get(18)?,
        cached_usage: row
            .get::<_, Option<String>>(19)?
            .and_then(|s| serde_json::from_str::<UsageData>(&s).ok()),
        last_usage_checked_at: row.get(20)?,
        is_active: row.get::<_, i32>(21)? != 0,
        sort_order: row.get(22)?,
        preset_id: row
            .get::<_, Option<String>>(23)?
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(crate::shared_runtime::default_preset_id),
        default_key_config: crate::shared_runtime::parse_default_key_config(
            row.get::<_, Option<String>>(24)?.as_deref(),
        ),
        request_adapter: row
            .get::<_, Option<String>>(26)?
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(crate::shared_runtime::default_request_adapter_string),
        wallet_balance_script: row
            .get::<_, Option<String>>(27)?
            .filter(|value| !value.trim().is_empty()),
    })
}

/// Column list shared by every provider read, in `row_to_provider` order.
const PROVIDER_COLUMNS: &str = "id, name, base_url, http_proxy, website, remark, token, icon,
        wallet_balance_type, wallet_balance_url, wallet_balance_path,
        wallet_balance_headers, wallet_balance_user_id,
        cached_wallet_balance, last_balance_checked_at,
        usage_type, usage_url, usage_path, usage_headers,
        cached_usage, last_usage_checked_at,
        is_active, sort_order, preset_id, default_key_config, cached_wallet_balance_currency,
        request_adapter, wallet_balance_script";

fn normalize_optional_string(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

impl Database {
    pub fn provider_list(&self) -> Result<Vec<Provider>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {} FROM providers ORDER BY sort_order ASC, name ASC",
            PROVIDER_COLUMNS
        ))?;

        let rows = stmt.query_map([], row_to_provider)?;
        rows.collect()
    }

    pub fn provider_get(&self, id: &str) -> Result<Option<Provider>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {} FROM providers WHERE id = ?1",
            PROVIDER_COLUMNS
        ))?;

        let mut rows = stmt.query_map([id], row_to_provider)?;

        match rows.next() {
            Some(Ok(p)) => Ok(Some(p)),
            Some(Err(e)) => Err(e),
            None => Ok(None),
        }
    }

    pub fn provider_create(
        &self,
        input: &CreateProviderInput,
    ) -> Result<Provider, rusqlite::Error> {
        let id = nanoid::nanoid!();
        // Auto-assign next sort_order (max + 1)
        let next_sort: i32 = self
            .conn
            .query_row(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM providers",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);
        let token = normalize_optional_string(input.token.as_deref());
        // An unrecognised preset id is kept as origin information rather than
        // rewritten, and a missing one means the provider was hand-rolled.
        let preset_id = input
            .preset_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(crate::shared_runtime::PRESET_CUSTOM);
        let default_key_config = input
            .default_key_config
            .as_ref()
            .and_then(crate::shared_runtime::serialize_default_key_config);
        self.conn.execute(
            "INSERT INTO providers (id, name, base_url, http_proxy, website, remark, token, token_secret_ref, icon,
                wallet_balance_type, wallet_balance_url, wallet_balance_path, wallet_balance_headers,
                wallet_balance_user_id, usage_type, usage_url, usage_path, usage_headers, is_active,
                sort_order, preset_id, default_key_config, request_adapter, wallet_balance_script)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, 1, ?18, ?19, ?20, ?21, ?22)",
            rusqlite::params![
                id,
                input.name,
                input.base_url,
                normalize_optional_string(input.http_proxy.as_deref()),
                input.website,
                input.remark,
                token,
                input.icon,
                input.wallet_balance_type.as_deref().unwrap_or("none"),
                input.wallet_balance_url,
                input.wallet_balance_path,
                input.wallet_balance_headers,
                input.wallet_balance_user_id,
                input.usage_type.as_deref().unwrap_or("none"),
                input.usage_url,
                input.usage_path,
                input.usage_headers,
                next_sort,
                preset_id,
                default_key_config,
                input
                    .request_adapter
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(crate::shared_runtime::default_request_adapter_string),
                input
                    .wallet_balance_script
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty()),
            ],
        )?;

        self.provider_get(&id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)
    }

    pub fn provider_update(
        &self,
        input: &UpdateProviderInput,
    ) -> Result<Provider, rusqlite::Error> {
        // Build dynamic UPDATE query
        let mut sets = Vec::new();
        let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        add_field!(input.name, "name", sets, params);
        add_field!(input.base_url, "base_url", sets, params);
        if input.http_proxy.is_some() {
            sets.push("http_proxy = ?".to_string());
            params.push(Box::new(normalize_optional_string(
                input.http_proxy.as_deref(),
            )));
        }
        add_field!(input.website, "website", sets, params);
        add_field!(input.remark, "remark", sets, params);
        if let Some(ref token) = input.token {
            sets.push("token = ?".to_string());
            params.push(Box::new(normalize_optional_string(Some(token.as_str()))));
            sets.push("token_secret_ref = NULL".to_string());
        }
        add_field!(input.icon, "icon", sets, params);
        add_field!(
            input.wallet_balance_type,
            "wallet_balance_type",
            sets,
            params
        );
        add_field!(input.wallet_balance_url, "wallet_balance_url", sets, params);
        add_field!(
            input.wallet_balance_path,
            "wallet_balance_path",
            sets,
            params
        );
        add_field!(
            input.wallet_balance_headers,
            "wallet_balance_headers",
            sets,
            params
        );
        add_field!(
            input.wallet_balance_user_id,
            "wallet_balance_user_id",
            sets,
            params
        );
        add_field!(input.usage_type, "usage_type", sets, params);
        add_field!(input.usage_url, "usage_url", sets, params);
        add_field!(input.usage_path, "usage_path", sets, params);
        add_field!(input.usage_headers, "usage_headers", sets, params);
        add_field!(
            input.wallet_balance_script,
            "wallet_balance_script",
            sets,
            params
        );
        add_field!(
            input.cached_wallet_balance,
            "cached_wallet_balance",
            sets,
            params
        );
        if input.cached_wallet_balance_currency.is_some() {
            sets.push("cached_wallet_balance_currency = ?".to_string());
            params.push(Box::new(input.cached_wallet_balance_currency.clone()));
        }
        add_field!(
            input.last_balance_checked_at,
            "last_balance_checked_at",
            sets,
            params
        );
        add_field!(
            input.last_usage_checked_at,
            "last_usage_checked_at",
            sets,
            params
        );

        if let Some(ref val) = input.is_active {
            sets.push("is_active = ?".to_string());
            params.push(Box::new(if *val { 1i32 } else { 0i32 }));
        }

        if let Some(ref val) = input.cached_usage {
            sets.push("cached_usage = ?".to_string());
            params.push(Box::new(serde_json::to_string(val).unwrap_or_default()));
        }

        if input.request_adapter.is_some() {
            sets.push("request_adapter = ?".to_string());
            params.push(Box::new(
                input
                    .request_adapter
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(crate::shared_runtime::default_request_adapter_string),
            ));
        }

        if input.preset_id.is_some() {
            sets.push("preset_id = ?".to_string());
            params.push(Box::new(
                input
                    .preset_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or(crate::shared_runtime::PRESET_CUSTOM)
                    .to_string(),
            ));
        }

        // `Some(defaults)` replaces the stored defaults; `Some(empty)` clears
        // them. Absent leaves whatever is stored untouched.
        if let Some(ref defaults) = input.default_key_config {
            sets.push("default_key_config = ?".to_string());
            params.push(Box::new(
                crate::shared_runtime::serialize_default_key_config(defaults),
            ));
        }

        if sets.is_empty() {
            return self
                .provider_get(&input.id)?
                .ok_or(rusqlite::Error::QueryReturnedNoRows);
        }

        let sql = format!("UPDATE providers SET {} WHERE id = ?", sets.join(", "));
        params.push(Box::new(input.id.clone()));

        let param_refs: Vec<&dyn rusqlite::types::ToSql> =
            params.iter().map(|p| p.as_ref()).collect();
        self.conn.execute(&sql, param_refs.as_slice())?;

        self.provider_get(&input.id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)
    }

    pub fn provider_reorder(
        &self,
        provider_ids: &[String],
    ) -> Result<Vec<Provider>, rusqlite::Error> {
        for (i, id) in provider_ids.iter().enumerate() {
            self.conn.execute(
                "UPDATE providers SET sort_order = ?1 WHERE id = ?2",
                rusqlite::params![i as i32, id],
            )?;
        }
        self.provider_list()
    }

    pub fn provider_delete(&self, id: &str) -> Result<(), rusqlite::Error> {
        // Backfill snapshot column before deletion so request_logs retain the display name
        self.conn.execute(
            "UPDATE request_logs SET provider_name = (SELECT name FROM providers WHERE id = ?1)
             WHERE provider_id = ?1 AND provider_name IS NULL",
            [id],
        )?;
        self.conn
            .execute("DELETE FROM providers WHERE id = ?1", [id])?;
        Ok(())
    }
}
