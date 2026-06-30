use crate::db::Database;
use crate::models::GlobalSettings;

impl Database {
    pub fn settings_get(&self) -> Result<GlobalSettings, rusqlite::Error> {
        let mut settings = GlobalSettings::default();

        let mut stmt = self.conn.prepare("SELECT key, value FROM settings")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })?;

        for row in rows {
            let (key, value) = row?;
            if let Some(val) = value {
                match key.as_str() {
                    "defaultProviderType" => settings.default_provider_type = val,
                    "proxyPort" => settings.proxy_port = val.parse().unwrap_or(12345),
                    "defaultTerminalType" => settings.default_terminal_type = val,
                    "closeToTray" => settings.close_to_tray = val == "true",
                    "daemonEnabled" => settings.daemon_enabled = val == "true",
                    "claudeConfig" => settings.claude_config = serde_json::from_str(&val).ok(),
                    "codexConfig" => settings.codex_config = serde_json::from_str(&val).ok(),
                    _ => {}
                }
            }
        }

        Ok(settings)
    }

    pub fn settings_update(
        &self,
        updates: &serde_json::Value,
    ) -> Result<GlobalSettings, rusqlite::Error> {
        if let Some(obj) = updates.as_object() {
            for (key, value) in obj {
                let val_str = match value {
                    serde_json::Value::String(s) => s.clone(),
                    serde_json::Value::Bool(b) => b.to_string(),
                    serde_json::Value::Number(n) => n.to_string(),
                    _ => serde_json::to_string(value).unwrap_or_default(),
                };

                self.conn.execute(
                    "INSERT INTO settings (key, value) VALUES (?1, ?2)
                     ON CONFLICT(key) DO UPDATE SET value = ?2",
                    rusqlite::params![key, val_str],
                )?;
            }
        }

        self.settings_get()
    }

    pub fn settings_get_value(&self, key: &str) -> Result<Option<String>, rusqlite::Error> {
        let mut stmt = self
            .conn
            .prepare("SELECT value FROM settings WHERE key = ?1")?;
        let mut rows = stmt.query_map([key], |row| row.get(0))?;
        match rows.next() {
            Some(Ok(val)) => Ok(val),
            Some(Err(e)) => Err(e),
            None => Ok(None),
        }
    }

    pub fn settings_set_value(&self, key: &str, value: &str) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = ?2",
            rusqlite::params![key, value],
        )?;
        Ok(())
    }

    pub fn settings_delete_value(&self, key: &str) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "DELETE FROM settings WHERE key = ?1",
            rusqlite::params![key],
        )?;
        Ok(())
    }
}
