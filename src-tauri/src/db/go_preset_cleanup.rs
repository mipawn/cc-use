use super::Database;
use serde_json::Value;

// Only the exact mapping shipped by 3.10 is a known generated default.
// Different models, extra exact mappings and user-specific fields are preserved.
fn remove_shipped_mapping(raw: &str) -> Option<Option<String>> {
    let mut mapping: Value = serde_json::from_str(raw).ok()?;
    let object = mapping.as_object_mut()?;
    let expected = [
        ("haiku", "deepseek-v4-flash"),
        ("sonnet", "deepseek-v4-pro"),
        ("opus", "deepseek-v4-pro"),
        ("codex", "deepseek-v4-pro"),
    ];
    if expected
        .iter()
        .any(|(key, value)| object.get(*key).and_then(Value::as_str) != Some(*value))
        || object.keys().any(|key| {
            !matches!(
                key.as_str(),
                "haiku" | "sonnet" | "opus" | "codex" | "autoMode"
            )
        })
    {
        return None;
    }
    for (key, _) in expected {
        object.remove(key);
    }
    Some(if object.is_empty() {
        None
    } else {
        Some(mapping.to_string())
    })
}

impl Database {
    pub(super) fn clear_shipped_go_model_defaults(&self) -> Result<(), rusqlite::Error> {
        if self
            .settings_get_value("migration.go-model-defaults-removed")?
            .is_some()
        {
            return Ok(());
        }
        let transaction = self.conn.unchecked_transaction()?;
        {
            let mut statement = transaction.prepare(
                "SELECT id, default_key_config FROM providers WHERE preset_id = 'opencode-go'",
            )?;
            let rows = statement.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
            })?;
            for row in rows {
                let (id, raw) = row?;
                let Some(mut config) = raw.and_then(|s| serde_json::from_str::<Value>(&s).ok())
                else {
                    continue;
                };
                if let Some(replacement) = config
                    .get("modelMapping")
                    .and_then(Value::as_str)
                    .and_then(remove_shipped_mapping)
                {
                    config["modelMapping"] = replacement.map(Value::String).unwrap_or(Value::Null);
                    transaction.execute(
                        "UPDATE providers SET default_key_config = ?1 WHERE id = ?2",
                        rusqlite::params![config.to_string(), id],
                    )?;
                }
            }
        }
        // Existing keys are explicit saved choices: their model mapping must
        // remain editable and is not rewritten based on a provider label.
        transaction.execute("INSERT INTO settings (key, value) VALUES ('migration.go-model-defaults-removed', 'true')", [])?;
        transaction.commit()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clears_only_the_shipped_mapping_and_keeps_auto_mode() {
        let original = serde_json::json!({"haiku":"deepseek-v4-flash","sonnet":"deepseek-v4-pro","opus":"deepseek-v4-pro","codex":"deepseek-v4-pro"});
        assert_eq!(remove_shipped_mapping(&original.to_string()), Some(None));
        let mut custom = original.clone();
        custom["sonnet"] = Value::String("my-model".into());
        assert_eq!(remove_shipped_mapping(&custom.to_string()), None);
        let mut with_auto = original;
        with_auto["autoMode"] = serde_json::json!({"enabled":true});
        let cleaned = remove_shipped_mapping(&with_auto.to_string())
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&cleaned).unwrap(),
            serde_json::json!({"autoMode":{"enabled":true}})
        );
    }
    #[test]
    fn upgrade_cleans_provider_snapshot_once_and_keeps_existing_keys() {
        let db = Database::new_in_memory().unwrap();
        db.conn
            .execute(
                "DELETE FROM settings WHERE key='migration.go-model-defaults-removed'",
                [],
            )
            .unwrap();
        let mapping = serde_json::json!({"haiku":"deepseek-v4-flash","sonnet":"deepseek-v4-pro","opus":"deepseek-v4-pro","codex":"deepseek-v4-pro"}).to_string();
        let config = serde_json::json!({"modelMapping": mapping, "clientConfigs":{"codex":{"authScheme":"bearer"}}}).to_string();
        db.conn.execute("INSERT INTO providers (id, name, base_url, preset_id, default_key_config) VALUES ('go','Go','https://example.com','opencode-go',?1)", [&config]).unwrap();
        db.conn.execute("INSERT INTO api_keys (id, provider_id, value, model_mapping) VALUES ('key','go','test',?1)", [&mapping]).unwrap();
        db.clear_shipped_go_model_defaults().unwrap();
        let raw: String = db
            .conn
            .query_row(
                "SELECT default_key_config FROM providers WHERE id='go'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let cleaned: Value = serde_json::from_str(&raw).unwrap();
        assert!(cleaned["modelMapping"].is_null());
        assert_eq!(cleaned["clientConfigs"]["codex"]["authScheme"], "bearer");
        let key: String = db
            .conn
            .query_row(
                "SELECT model_mapping FROM api_keys WHERE id='key'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(key, mapping);
        db.conn
            .execute(
                "UPDATE providers SET default_key_config=?1 WHERE id='go'",
                [&config],
            )
            .unwrap();
        db.clear_shipped_go_model_defaults().unwrap();
        let after: String = db
            .conn
            .query_row(
                "SELECT default_key_config FROM providers WHERE id='go'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(after, config);
    }
}
