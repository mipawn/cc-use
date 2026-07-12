use crate::db::secret_store;
use crate::db::Database;
use crate::models::{CreateProviderInput, Provider, UpdateProviderInput, UsageData};
use rusqlite::OptionalExtension;

fn row_to_provider(row: &rusqlite::Row, db: &Database) -> Result<Provider, rusqlite::Error> {
    let legacy_token: Option<String> = row.get(6)?;
    let token_secret_ref: Option<String> = row.get(24)?;
    let token = match token_secret_ref
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        Some(reference) => Some(
            db.secret_store
                .get(reference)
                .map_err(secret_store::to_sqlite_error)?,
        ),
        None => legacy_token,
    };

    Ok(Provider {
        id: row.get(0)?,
        name: row.get(1)?,
        base_url: row.get(2)?,
        http_proxy: row.get(3)?,
        website: row.get(4)?,
        remark: row.get(5)?,
        token,
        icon: row.get(7)?,
        wallet_balance_type: row
            .get::<_, Option<String>>(8)?
            .unwrap_or_else(|| "none".to_string()),
        wallet_balance_url: row.get(9)?,
        wallet_balance_path: row.get(10)?,
        wallet_balance_headers: row.get(11)?,
        wallet_balance_user_id: row.get(12)?,
        cached_wallet_balance: row.get(13)?,
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
        cost_multiplier: row.get(21)?,
        is_active: row.get::<_, i32>(22)? != 0,
        sort_order: row.get(23)?,
    })
}

fn normalize_optional_string(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

impl Database {
    pub fn provider_list(&self) -> Result<Vec<Provider>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, base_url, http_proxy, website, remark, token, icon,
                    wallet_balance_type, wallet_balance_url, wallet_balance_path,
                    wallet_balance_headers, wallet_balance_user_id,
                    cached_wallet_balance, last_balance_checked_at,
                    usage_type, usage_url, usage_path, usage_headers,
                    cached_usage, last_usage_checked_at,
                    cost_multiplier, is_active, sort_order, token_secret_ref
             FROM providers ORDER BY sort_order ASC, name ASC",
        )?;

        let rows = stmt.query_map([], |row| row_to_provider(row, self))?;
        rows.collect()
    }

    pub fn provider_get(&self, id: &str) -> Result<Option<Provider>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, base_url, http_proxy, website, remark, token, icon,
                    wallet_balance_type, wallet_balance_url, wallet_balance_path,
                    wallet_balance_headers, wallet_balance_user_id,
                    cached_wallet_balance, last_balance_checked_at,
                    usage_type, usage_url, usage_path, usage_headers,
                    cached_usage, last_usage_checked_at,
                    cost_multiplier, is_active, sort_order, token_secret_ref
             FROM providers WHERE id = ?1",
        )?;

        let mut rows = stmt.query_map([id], |row| row_to_provider(row, self))?;

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
        let token_secret_ref = token
            .as_ref()
            .map(|_| Database::provider_token_secret_ref(&id));
        if let (Some(reference), Some(token)) = (token_secret_ref.as_deref(), token.as_deref()) {
            self.secret_store
                .set(reference, token)
                .map_err(secret_store::to_sqlite_error)?;
        }

        let insert_result = self.conn.execute(
            "INSERT INTO providers (id, name, base_url, http_proxy, website, remark, token, token_secret_ref, icon,
                wallet_balance_type, wallet_balance_url, wallet_balance_path, wallet_balance_headers,
                wallet_balance_user_id, usage_type, usage_url, usage_path, usage_headers, is_active,
                sort_order)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, 1, ?18)",
            rusqlite::params![
                id,
                input.name,
                input.base_url,
                normalize_optional_string(input.http_proxy.as_deref()),
                input.website,
                input.remark,
                token_secret_ref,
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
            ],
        );
        if let Err(error) = insert_result {
            if let Some(reference) = token_secret_ref {
                let _ = self.secret_store.delete(&reference);
            }
            return Err(error);
        }

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
            let secret_ref = Database::provider_token_secret_ref(&input.id);
            if let Some(token) = normalize_optional_string(Some(token.as_str())) {
                self.secret_store
                    .set(&secret_ref, &token)
                    .map_err(secret_store::to_sqlite_error)?;
                sets.push("token = NULL".to_string());
                sets.push("token_secret_ref = ?".to_string());
                params.push(Box::new(secret_ref));
            } else {
                let existing_secret_ref = self
                    .conn
                    .query_row(
                        "SELECT token_secret_ref FROM providers WHERE id = ?1",
                        [&input.id],
                        |row| row.get::<_, Option<String>>(0),
                    )
                    .optional()?
                    .flatten();
                if let Some(existing_secret_ref) = existing_secret_ref {
                    self.secret_store
                        .delete(&existing_secret_ref)
                        .map_err(secret_store::to_sqlite_error)?;
                }
                sets.push("token = NULL".to_string());
                sets.push("token_secret_ref = NULL".to_string());
            }
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
        add_field!(input.cost_multiplier, "cost_multiplier", sets, params);
        add_field!(
            input.cached_wallet_balance,
            "cached_wallet_balance",
            sets,
            params
        );
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
        let secret_refs = self
            .conn
            .prepare(
                "SELECT secret_ref FROM api_keys WHERE provider_id = ?1 AND secret_ref IS NOT NULL",
            )?
            .query_map([id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        let provider_secret_ref = self
            .conn
            .query_row(
                "SELECT token_secret_ref FROM providers WHERE id = ?1",
                [id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?;
        // Backfill snapshot column before deletion so request_logs retain the display name
        self.conn.execute(
            "UPDATE request_logs SET provider_name = (SELECT name FROM providers WHERE id = ?1)
             WHERE provider_id = ?1 AND provider_name IS NULL",
            [id],
        )?;
        self.conn
            .execute("DELETE FROM providers WHERE id = ?1", [id])?;
        for secret_ref in secret_refs {
            self.secret_store
                .delete(&secret_ref)
                .map_err(secret_store::to_sqlite_error)?;
        }
        if let Some(Some(secret_ref)) = provider_secret_ref {
            self.secret_store
                .delete(&secret_ref)
                .map_err(secret_store::to_sqlite_error)?;
        }
        Ok(())
    }
}
