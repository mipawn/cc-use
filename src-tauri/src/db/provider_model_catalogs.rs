//! Explicit provider model inventories; independent of per-client runtime catalogs.
use crate::db::Database;
use crate::models::ProviderModelCatalog;
use crate::shared_runtime::{gateway_model_policy::valid_model_id, model_mapping::ClientModel};
use rusqlite::OptionalExtension;
use std::collections::HashSet;

impl Database {
    pub fn provider_model_catalog_get(
        &self,
        provider_id: &str,
    ) -> Result<ProviderModelCatalog, String> {
        if self
            .provider_get(provider_id)
            .map_err(|e| e.to_string())?
            .is_none()
        {
            return Err("Provider not found".into());
        }
        self.conn.query_row("SELECT models_json, revision, updated_at FROM provider_model_catalogs WHERE provider_id=?1", [provider_id], |row| {
            let raw: String = row.get(0)?;
            let models = serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
            Ok(ProviderModelCatalog {models, revision: row.get(1)?, updated_at: Some(row.get(2)?)})
        }).optional().map_err(|_| "Cannot read provider model catalog".to_string()).map(|v| v.unwrap_or(ProviderModelCatalog {models: vec![], revision: 0, updated_at: None}))
    }

    pub fn provider_model_catalog_save(
        &self,
        provider_id: &str,
        models: &[ClientModel],
        revision: i64,
    ) -> Result<ProviderModelCatalog, String> {
        if models.len() > 10_000 {
            return Err("Provider model catalog is too large".into());
        }
        let mut seen = HashSet::new();
        let mut normalized = Vec::new();
        for model in models {
            if !valid_model_id(&model.id)
                || model.display_name.len() > 1024
                || model.display_name.chars().any(char::is_control)
            {
                return Err("Provider model ID or display name is invalid".into());
            }
            if seen.insert(model.id.clone()) {
                let mut model = model.clone();
                model.display_name = model.display_name.trim().to_string();
                if model.display_name.is_empty() {
                    model.display_name = model.id.clone();
                }
                normalized.push(model);
            }
        }
        let raw = serde_json::to_string(&normalized)
            .map_err(|_| "Cannot encode provider model catalog")?;
        if raw.len() > 8 * 1024 * 1024 {
            return Err("Provider model catalog is too large".into());
        }
        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(|_| "Cannot save provider model catalog")?;
        let now = chrono::Utc::now().to_rfc3339();
        // Conditional UPSERT makes optimistic concurrency atomic, including first save.
        let current: Option<i64> = tx
            .query_row(
                "SELECT revision FROM provider_model_catalogs WHERE provider_id=?1",
                [provider_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| "Cannot read provider model catalog")?;
        if current.unwrap_or(0) != revision {
            return Err("Provider model catalog changed; reload before saving".into());
        }
        let next = revision
            .checked_add(1)
            .filter(|v| *v > 0)
            .ok_or("Invalid provider model catalog revision")?;
        tx.execute("INSERT INTO provider_model_catalogs(provider_id,models_json,revision,updated_at) VALUES (?1,?2,?3,?4) ON CONFLICT(provider_id) DO UPDATE SET models_json=excluded.models_json,revision=excluded.revision,updated_at=excluded.updated_at", rusqlite::params![provider_id, raw, next, now]).map_err(|_| "Cannot save provider model catalog")?;
        tx.commit()
            .map_err(|_| "Cannot save provider model catalog")?;
        Ok(ProviderModelCatalog {
            models: normalized,
            revision: next,
            updated_at: Some(now),
        })
    }
}
