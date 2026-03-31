use crate::db::Database;
use crate::models::{Provider, CreateProviderInput, UpdateProviderInput, UsageData};

fn row_to_provider(row: &rusqlite::Row) -> Result<Provider, rusqlite::Error> {
    Ok(Provider {
        id: row.get(0)?,
        name: row.get(1)?,
        base_url: row.get(2)?,
        provider_type: row.get(3)?,
        website: row.get(4)?,
        remark: row.get(5)?,
        token: row.get(6)?,
        icon: row.get(7)?,
        wallet_balance_type: row.get::<_, Option<String>>(8)?.unwrap_or_else(|| "none".to_string()),
        wallet_balance_url: row.get(9)?,
        wallet_balance_path: row.get(10)?,
        wallet_balance_headers: row.get(11)?,
        wallet_balance_user_id: row.get(12)?,
        cached_wallet_balance: row.get(13)?,
        last_balance_checked_at: row.get(14)?,
        usage_type: row.get::<_, Option<String>>(15)?.unwrap_or_else(|| "none".to_string()),
        usage_url: row.get(16)?,
        usage_path: row.get(17)?,
        usage_headers: row.get(18)?,
        cached_usage: row.get::<_, Option<String>>(19)?
            .and_then(|s| serde_json::from_str::<UsageData>(&s).ok()),
        last_usage_checked_at: row.get(20)?,
        cost_multiplier: row.get(21)?,
        is_active: row.get::<_, i32>(22)? != 0,
    })
}

impl Database {
    pub fn provider_list(&self) -> Result<Vec<Provider>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, base_url, type, website, remark, token, icon,
                    wallet_balance_type, wallet_balance_url, wallet_balance_path,
                    wallet_balance_headers, wallet_balance_user_id,
                    cached_wallet_balance, last_balance_checked_at,
                    usage_type, usage_url, usage_path, usage_headers,
                    cached_usage, last_usage_checked_at,
                    cost_multiplier, is_active
             FROM providers ORDER BY name"
        )?;

        let rows = stmt.query_map([], row_to_provider)?;
        rows.collect()
    }

    pub fn provider_get(&self, id: &str) -> Result<Option<Provider>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, base_url, type, website, remark, token, icon,
                    wallet_balance_type, wallet_balance_url, wallet_balance_path,
                    wallet_balance_headers, wallet_balance_user_id,
                    cached_wallet_balance, last_balance_checked_at,
                    usage_type, usage_url, usage_path, usage_headers,
                    cached_usage, last_usage_checked_at,
                    cost_multiplier, is_active
             FROM providers WHERE id = ?1"
        )?;

        let mut rows = stmt.query_map([id], row_to_provider)?;

        match rows.next() {
            Some(Ok(p)) => Ok(Some(p)),
            Some(Err(e)) => Err(e),
            None => Ok(None),
        }
    }

    pub fn provider_create(&self, input: &CreateProviderInput) -> Result<Provider, rusqlite::Error> {
        let id = nanoid::nanoid!();
        self.conn.execute(
            "INSERT INTO providers (id, name, base_url, type, website, remark, token, icon,
                wallet_balance_type, wallet_balance_url, wallet_balance_path, wallet_balance_headers,
                wallet_balance_user_id, usage_type, usage_url, usage_path, usage_headers, is_active)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, 1)",
            rusqlite::params![
                id,
                input.name,
                input.base_url,
                input.provider_type.as_deref().unwrap_or("claude"),
                input.website,
                input.remark,
                input.token,
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
            ],
        )?;

        self.provider_get(&id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
    }

    pub fn provider_update(&self, input: &UpdateProviderInput) -> Result<Provider, rusqlite::Error> {
        // Build dynamic UPDATE query
        let mut sets = Vec::new();
        let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        add_field!(input.name, "name", sets, params);
        add_field!(input.base_url, "base_url", sets, params);
        add_field!(input.provider_type, "type", sets, params);
        add_field!(input.website, "website", sets, params);
        add_field!(input.remark, "remark", sets, params);
        add_field!(input.token, "token", sets, params);
        add_field!(input.icon, "icon", sets, params);
        add_field!(input.wallet_balance_type, "wallet_balance_type", sets, params);
        add_field!(input.wallet_balance_url, "wallet_balance_url", sets, params);
        add_field!(input.wallet_balance_path, "wallet_balance_path", sets, params);
        add_field!(input.wallet_balance_headers, "wallet_balance_headers", sets, params);
        add_field!(input.wallet_balance_user_id, "wallet_balance_user_id", sets, params);
        add_field!(input.usage_type, "usage_type", sets, params);
        add_field!(input.usage_url, "usage_url", sets, params);
        add_field!(input.usage_path, "usage_path", sets, params);
        add_field!(input.usage_headers, "usage_headers", sets, params);
        add_field!(input.cost_multiplier, "cost_multiplier", sets, params);
        add_field!(input.cached_wallet_balance, "cached_wallet_balance", sets, params);
        add_field!(input.last_balance_checked_at, "last_balance_checked_at", sets, params);
        add_field!(input.last_usage_checked_at, "last_usage_checked_at", sets, params);

        if let Some(ref val) = input.is_active {
            sets.push("is_active = ?".to_string());
            params.push(Box::new(if *val { 1i32 } else { 0i32 }));
        }

        if let Some(ref val) = input.cached_usage {
            sets.push("cached_usage = ?".to_string());
            params.push(Box::new(serde_json::to_string(val).unwrap_or_default()));
        }

        if sets.is_empty() {
            return self.provider_get(&input.id)?.ok_or(rusqlite::Error::QueryReturnedNoRows);
        }

        let sql = format!("UPDATE providers SET {} WHERE id = ?", sets.join(", "));
        params.push(Box::new(input.id.clone()));

        let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        self.conn.execute(&sql, param_refs.as_slice())?;

        self.provider_get(&input.id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
    }

    pub fn provider_delete(&self, id: &str) -> Result<(), rusqlite::Error> {
        self.conn.execute("DELETE FROM providers WHERE id = ?1", [id])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::db::Database;
    use crate::models::CreateProviderInput;

    #[test]
    fn test_provider_crud() {
        let db = Database::new_in_memory().unwrap();

        // Create
        let provider = db.provider_create(&CreateProviderInput {
            name: "Test Provider".to_string(),
            base_url: "https://api.test.com".to_string(),
            provider_type: Some("claude".to_string()),
            website: Some("https://test.com".to_string()),
            remark: None,
            token: Some("test-token".to_string()),
            icon: None,
            wallet_balance_type: None,
            wallet_balance_url: None,
            wallet_balance_path: None,
            wallet_balance_headers: None,
            wallet_balance_user_id: None,
            usage_type: None,
            usage_url: None,
            usage_path: None,
            usage_headers: None,
        }).unwrap();

        assert_eq!(provider.name, "Test Provider");
        assert_eq!(provider.base_url, "https://api.test.com");
        assert!(provider.is_active);

        // List
        let providers = db.provider_list().unwrap();
        assert_eq!(providers.len(), 1);

        // Get
        let fetched = db.provider_get(&provider.id).unwrap().unwrap();
        assert_eq!(fetched.name, "Test Provider");

        // Delete
        db.provider_delete(&provider.id).unwrap();
        let providers = db.provider_list().unwrap();
        assert_eq!(providers.len(), 0);
    }

    #[test]
    fn test_provider_create_returns_proper_result() {
        let db = Database::new_in_memory().unwrap();
        let result = db.provider_create(&CreateProviderInput {
            name: "Test".to_string(),
            base_url: "https://api.test.com".to_string(),
            provider_type: None, website: None, remark: None, token: None, icon: None,
            wallet_balance_type: None, wallet_balance_url: None, wallet_balance_path: None,
            wallet_balance_headers: None, wallet_balance_user_id: None,
            usage_type: None, usage_url: None, usage_path: None, usage_headers: None,
        });
        assert!(result.is_ok());
    }

    #[test]
    fn test_provider_get_nonexistent() {
        let db = Database::new_in_memory().unwrap();
        let result = db.provider_get("nonexistent-id").unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_provider_get_direct_query() {
        let db = Database::new_in_memory().unwrap();
        // Create multiple providers
        for i in 0..5 {
            db.provider_create(&CreateProviderInput {
                name: format!("Provider {}", i),
                base_url: format!("https://api{}.test.com", i),
                provider_type: None, website: None, remark: None, token: None, icon: None,
                wallet_balance_type: None, wallet_balance_url: None, wallet_balance_path: None,
                wallet_balance_headers: None, wallet_balance_user_id: None,
                usage_type: None, usage_url: None, usage_path: None, usage_headers: None,
            }).unwrap();
        }

        let all = db.provider_list().unwrap();
        assert_eq!(all.len(), 5);

        // provider_get should find the specific one without loading all
        let target = &all[2];
        let fetched = db.provider_get(&target.id).unwrap().unwrap();
        assert_eq!(fetched.id, target.id);
        assert_eq!(fetched.name, target.name);
    }

    #[test]
    fn test_provider_update_no_changes() {
        use crate::models::UpdateProviderInput;
        let db = Database::new_in_memory().unwrap();
        let provider = db.provider_create(&CreateProviderInput {
            name: "Test".to_string(),
            base_url: "https://api.test.com".to_string(),
            provider_type: None, website: None, remark: None, token: None, icon: None,
            wallet_balance_type: None, wallet_balance_url: None, wallet_balance_path: None,
            wallet_balance_headers: None, wallet_balance_user_id: None,
            usage_type: None, usage_url: None, usage_path: None, usage_headers: None,
        }).unwrap();

        let result = db.provider_update(&UpdateProviderInput {
            id: provider.id.clone(),
            name: None, base_url: None, provider_type: None, website: None,
            remark: None, token: None, icon: None,
            wallet_balance_type: None, wallet_balance_url: None, wallet_balance_path: None,
            wallet_balance_headers: None, wallet_balance_user_id: None,
            cached_wallet_balance: None, last_balance_checked_at: None,
            usage_type: None, usage_url: None, usage_path: None, usage_headers: None,
            cached_usage: None, last_usage_checked_at: None,
            cost_multiplier: None, is_active: None,
        });
        assert!(result.is_ok());
        assert_eq!(result.unwrap().name, "Test");
    }
}
