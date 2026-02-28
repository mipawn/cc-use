use crate::db::Database;
use crate::models::{Project, CreateProjectInput, UpdateProjectInput};

impl Database {
    pub fn project_list(&self) -> Result<Vec<Project>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, path, remark, provider_id, api_key_id, cli_type, terminal_type, last_opened_at
             FROM projects ORDER BY last_opened_at DESC NULLS LAST"
        )?;

        let rows = stmt.query_map([], |row| {
            Ok(Project {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                remark: row.get(3)?,
                provider_id: row.get(4)?,
                api_key_id: row.get(5)?,
                cli_type: row.get::<_, Option<String>>(6)?.unwrap_or_else(|| "claude".to_string()),
                terminal_type: row.get::<_, Option<String>>(7)?.unwrap_or_else(|| "iterm2".to_string()),
                last_opened_at: row.get(8)?,
            })
        })?;

        rows.collect()
    }

    pub fn project_get(&self, id: &str) -> Result<Option<Project>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, path, remark, provider_id, api_key_id, cli_type, terminal_type, last_opened_at
             FROM projects WHERE id = ?1"
        )?;

        let mut rows = stmt.query_map([id], |row| {
            Ok(Project {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                remark: row.get(3)?,
                provider_id: row.get(4)?,
                api_key_id: row.get(5)?,
                cli_type: row.get::<_, Option<String>>(6)?.unwrap_or_else(|| "claude".to_string()),
                terminal_type: row.get::<_, Option<String>>(7)?.unwrap_or_else(|| "iterm2".to_string()),
                last_opened_at: row.get(8)?,
            })
        })?;

        match rows.next() {
            Some(Ok(p)) => Ok(Some(p)),
            Some(Err(e)) => Err(e),
            None => Ok(None),
        }
    }

    pub fn project_get_by_path(&self, path: &str) -> Result<Option<Project>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, path, remark, provider_id, api_key_id, cli_type, terminal_type, last_opened_at
             FROM projects WHERE path = ?1"
        )?;

        let mut rows = stmt.query_map([path], |row| {
            Ok(Project {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                remark: row.get(3)?,
                provider_id: row.get(4)?,
                api_key_id: row.get(5)?,
                cli_type: row.get::<_, Option<String>>(6)?.unwrap_or_else(|| "claude".to_string()),
                terminal_type: row.get::<_, Option<String>>(7)?.unwrap_or_else(|| "iterm2".to_string()),
                last_opened_at: row.get(8)?,
            })
        })?;

        match rows.next() {
            Some(Ok(p)) => Ok(Some(p)),
            Some(Err(e)) => Err(e),
            None => Ok(None),
        }
    }

    pub fn project_create(&self, input: &CreateProjectInput) -> Result<Project, rusqlite::Error> {
        let id = nanoid::nanoid!();
        self.conn.execute(
            "INSERT INTO projects (id, name, path, remark, provider_id, api_key_id, cli_type, terminal_type)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                id,
                input.name,
                input.path,
                input.remark,
                input.provider_id,
                input.api_key_id,
                input.cli_type.as_deref().unwrap_or("claude"),
                input.terminal_type.as_deref().unwrap_or("iterm2"),
            ],
        )?;

        self.project_get(&id).map(|p| p.unwrap())
    }

    pub fn project_update(&self, input: &UpdateProjectInput) -> Result<Project, rusqlite::Error> {
        let mut sets = Vec::new();
        let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        macro_rules! add_field {
            ($field:expr, $col:expr) => {
                if let Some(ref val) = $field {
                    sets.push(format!("{} = ?", $col));
                    params.push(Box::new(val.clone()));
                }
            };
        }

        add_field!(input.name, "name");
        add_field!(input.remark, "remark");
        add_field!(input.provider_id, "provider_id");
        add_field!(input.api_key_id, "api_key_id");
        add_field!(input.cli_type, "cli_type");
        add_field!(input.terminal_type, "terminal_type");

        if sets.is_empty() {
            return self.project_get(&input.id).map(|p| p.unwrap());
        }

        let sql = format!("UPDATE projects SET {} WHERE id = ?", sets.join(", "));
        params.push(Box::new(input.id.clone()));

        let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        self.conn.execute(&sql, param_refs.as_slice())?;

        self.project_get(&input.id).map(|p| p.unwrap())
    }

    pub fn project_delete(&self, id: &str) -> Result<(), rusqlite::Error> {
        self.conn.execute("DELETE FROM projects WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn project_update_last_opened(&self, id: &str) -> Result<(), rusqlite::Error> {
        let now = chrono::Utc::now().to_rfc3339();
        self.conn.execute(
            "UPDATE projects SET last_opened_at = ?1 WHERE id = ?2",
            rusqlite::params![now, id],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::db::Database;
    use crate::models::CreateProjectInput;

    #[test]
    fn test_project_crud() {
        let db = Database::new_in_memory().unwrap();

        let project = db.project_create(&CreateProjectInput {
            name: "My Project".to_string(),
            path: "/home/user/project".to_string(),
            remark: None,
            provider_id: None,
            api_key_id: None,
            cli_type: None,
            terminal_type: None,
        }).unwrap();

        assert_eq!(project.name, "My Project");
        assert_eq!(project.path, "/home/user/project");

        let by_path = db.project_get_by_path("/home/user/project").unwrap().unwrap();
        assert_eq!(by_path.id, project.id);

        db.project_delete(&project.id).unwrap();
        assert!(db.project_get(&project.id).unwrap().is_none());
    }
}
