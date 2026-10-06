use super::Database;
use serde_json::Value;

impl Database {
    pub(super) fn clear_retired_model_overrides(&self) -> Result<(), rusqlite::Error> {
        let marker = "migration.v3.11.0.model-overrides-removed";
        if self.settings_get_value(marker)?.is_some() {
            return Ok(());
        }
        let transaction = self.conn.unchecked_transaction()?;
        let mut affected = Vec::new();
        {
            let mut statement = transaction.prepare(
                "SELECT id, model_mapping FROM api_keys WHERE model_mapping IS NOT NULL",
            )?;
            let rows = statement.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            for row in rows {
                let (id, raw) = row?;
                let Ok(mut mapping) = serde_json::from_str::<Value>(&raw) else {
                    continue;
                };
                if crate::shared_runtime::model_mapping::remove_retired_rules(&mut mapping) {
                    affected.push(id.clone());
                    transaction.execute(
                        "UPDATE api_keys SET model_mapping = ?1 WHERE id = ?2",
                        rusqlite::params![
                            crate::shared_runtime::model_mapping::sanitize_mapping(Some(
                                &mapping.to_string()
                            )),
                            id
                        ],
                    )?;
                }
            }
        }
        {
            let mut statement = transaction.prepare(
                "SELECT id, default_key_config FROM providers WHERE default_key_config IS NOT NULL",
            )?;
            let rows = statement.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            for row in rows {
                let (id, raw) = row?;
                let Ok(mut defaults) = serde_json::from_str::<Value>(&raw) else {
                    continue;
                };
                let Some(mapping_raw) = defaults["modelMapping"].as_str() else {
                    continue;
                };
                let Ok(mut mapping) = serde_json::from_str::<Value>(mapping_raw) else {
                    continue;
                };
                if crate::shared_runtime::model_mapping::remove_retired_rules(&mut mapping) {
                    defaults["modelMapping"] =
                        crate::shared_runtime::model_mapping::sanitize_mapping(Some(
                            &mapping.to_string(),
                        ))
                        .map(Value::String)
                        .unwrap_or(Value::Null);
                    transaction.execute(
                        "UPDATE providers SET default_key_config = ?1 WHERE id = ?2",
                        rusqlite::params![defaults.to_string(), id],
                    )?;
                }
            }
        }
        transaction.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
            rusqlite::params![
                "model-mapping-retired-api-key-ids",
                serde_json::to_string(&affected).unwrap_or_else(|_| "[]".into())
            ],
        )?;
        transaction.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, 'true')",
            [marker],
        )?;
        transaction.commit()
    }
}
