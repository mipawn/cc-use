use super::Database;
use crate::shared_runtime::user_agent;

impl Database {
    pub fn user_agent_custom_list(&self) -> Result<Vec<String>, String> {
        let mut statement = self
            .conn
            .prepare("SELECT value FROM custom_user_agents ORDER BY rowid DESC")
            .map_err(|error| error.to_string())?;
        let values = statement
            .query_map([], |row| row.get(0))
            .map_err(|error| error.to_string())?;
        values
            .collect::<Result<Vec<String>, _>>()
            .map_err(|error| error.to_string())
    }

    pub fn user_agent_custom_delete(&self, value: &str) -> Result<Vec<String>, String> {
        self.conn
            .execute(
                "DELETE FROM custom_user_agents WHERE value = ?1",
                [value.trim()],
            )
            .map_err(|error| error.to_string())?;
        self.user_agent_custom_list()
    }

    pub fn user_agent_custom_save(&self, raw: &str) -> Result<Vec<String>, String> {
        let value = user_agent::validate(Some(raw))?
            .ok_or_else(|| "User-Agent cannot be empty".to_string())?;
        self.conn
            .execute(
                "INSERT OR IGNORE INTO custom_user_agents (value) VALUES (?1)",
                [&value],
            )
            .map_err(|error| error.to_string())?;
        self.user_agent_custom_list()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deleting_a_custom_user_agent_only_removes_that_saved_value() {
        let db = Database::new_in_memory().unwrap();
        db.user_agent_custom_save("first/1.0").unwrap();
        db.user_agent_custom_save("second/1.0").unwrap();
        assert_eq!(
            db.user_agent_custom_delete(" first/1.0 ").unwrap(),
            vec!["second/1.0"]
        );
        assert_eq!(
            db.user_agent_custom_delete("first/1.0").unwrap(),
            vec!["second/1.0"]
        );
        assert_eq!(db.user_agent_custom_save("first/1.0").unwrap().len(), 2);
    }

    #[test]
    fn custom_user_agents_are_trimmed_deduplicated_and_persisted() {
        let path = std::env::temp_dir().join(format!("cc-use-custom-ua-{}.db", nanoid::nanoid!()));
        {
            let db = Database::open_at(&path).unwrap();
            assert_eq!(
                db.user_agent_custom_save("  my-client/1.0  ").unwrap(),
                vec!["my-client/1.0"]
            );
            assert_eq!(db.user_agent_custom_save("my-client/1.0").unwrap().len(), 1);
            assert!(db.user_agent_custom_save("bad\r\nheader").is_err());
            assert!(db.user_agent_custom_save("   ").is_err());
        }
        let db = Database::open_at(&path).unwrap();
        assert_eq!(db.user_agent_custom_list().unwrap(), vec!["my-client/1.0"]);
        drop(db);
        let _ = std::fs::remove_file(path);
    }
}
