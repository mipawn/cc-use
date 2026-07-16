use crate::db::Database;
use crate::models::{
    CreateProjectInput, Project, ProjectClientBinding, UpdateProjectInput,
    UpsertProjectBindingInput,
};
use std::collections::HashMap;

fn normalize_project_cli_type(cli_type: &str) -> &str {
    if cli_type == "claude" {
        "claude_code"
    } else {
        cli_type
    }
}

fn row_to_project(row: &rusqlite::Row) -> Result<Project, rusqlite::Error> {
    Ok(Project {
        id: row.get(0)?,
        name: row.get(1)?,
        path: row.get(2)?,
        remark: row.get(3)?,
        provider_id: row.get(4)?,
        api_key_id: row.get(5)?,
        cli_type: row
            .get::<_, Option<String>>(6)?
            .unwrap_or_else(|| "claude".to_string()),
        terminal_type: row
            .get::<_, Option<String>>(7)?
            .unwrap_or_else(|| "iterm2".to_string()),
        prelaunch_command: row.get(8)?,
        last_opened_at: row.get(9)?,
        bindings: HashMap::new(),
    })
}

impl Database {
    fn project_bindings(
        &self,
        project_id: &str,
    ) -> Result<HashMap<String, ProjectClientBinding>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT cli_type, provider_id, api_key_id, terminal_type, prelaunch_command
             FROM project_client_bindings
             WHERE project_id = ?1",
        )?;
        let rows = stmt.query_map([project_id], |row| {
            let binding = ProjectClientBinding {
                cli_type: row.get(0)?,
                provider_id: row.get(1)?,
                api_key_id: row.get(2)?,
                terminal_type: row
                    .get::<_, Option<String>>(3)?
                    .unwrap_or_else(|| "iterm2".to_string()),
                prelaunch_command: row.get(4)?,
            };
            Ok((binding.cli_type.clone(), binding))
        })?;
        rows.collect()
    }

    fn hydrate_project(&self, mut project: Project) -> Result<Project, rusqlite::Error> {
        project.bindings = self.project_bindings(&project.id)?;
        Ok(project)
    }

    pub fn project_list(&self) -> Result<Vec<Project>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, path, remark, provider_id, api_key_id, cli_type, terminal_type, prelaunch_command, last_opened_at
             FROM projects ORDER BY last_opened_at DESC NULLS LAST"
        )?;

        let rows = stmt
            .query_map([], row_to_project)?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|project| self.hydrate_project(project))
            .collect()
    }

    pub fn project_get(&self, id: &str) -> Result<Option<Project>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, path, remark, provider_id, api_key_id, cli_type, terminal_type, prelaunch_command, last_opened_at
             FROM projects WHERE id = ?1"
        )?;

        let mut rows = stmt.query_map([id], row_to_project)?;

        match rows.next() {
            Some(Ok(p)) => self.hydrate_project(p).map(Some),
            Some(Err(e)) => Err(e),
            None => Ok(None),
        }
    }

    pub fn project_get_by_path(&self, path: &str) -> Result<Option<Project>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, path, remark, provider_id, api_key_id, cli_type, terminal_type, prelaunch_command, last_opened_at
             FROM projects WHERE path = ?1"
        )?;

        let mut rows = stmt.query_map([path], row_to_project)?;

        match rows.next() {
            Some(Ok(p)) => self.hydrate_project(p).map(Some),
            Some(Err(e)) => Err(e),
            None => Ok(None),
        }
    }

    pub fn project_create(&self, input: &CreateProjectInput) -> Result<Project, rusqlite::Error> {
        let id = nanoid::nanoid!();
        let cli_type =
            normalize_project_cli_type(input.cli_type.as_deref().unwrap_or("claude_code"));
        self.conn.execute(
            "INSERT INTO projects (id, name, path, remark, provider_id, api_key_id, cli_type, terminal_type, prelaunch_command)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            rusqlite::params![
                id,
                input.name,
                input.path,
                input.remark,
                input.provider_id,
                input.api_key_id,
                cli_type,
                input.terminal_type.as_deref().unwrap_or("iterm2"),
                input.prelaunch_command,
            ],
        )?;

        self.project_binding_upsert(
            &id,
            &UpsertProjectBindingInput {
                cli_type: cli_type.to_string(),
                provider_id: input.provider_id.clone(),
                api_key_id: input.api_key_id.clone(),
                terminal_type: input.terminal_type.clone(),
                prelaunch_command: input.prelaunch_command.clone(),
            },
        )?;

        self.project_get(&id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)
    }

    pub fn project_update(&self, input: &UpdateProjectInput) -> Result<Project, rusqlite::Error> {
        let mut sets = Vec::new();
        let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        add_field!(input.name, "name", sets, params);
        add_field!(input.remark, "remark", sets, params);
        add_field!(input.provider_id, "provider_id", sets, params);
        add_field!(input.api_key_id, "api_key_id", sets, params);
        add_field!(input.cli_type, "cli_type", sets, params);
        add_field!(input.terminal_type, "terminal_type", sets, params);
        add_field!(input.prelaunch_command, "prelaunch_command", sets, params);

        if sets.is_empty() {
            return self
                .project_get(&input.id)?
                .ok_or(rusqlite::Error::QueryReturnedNoRows);
        }

        let sql = format!("UPDATE projects SET {} WHERE id = ?", sets.join(", "));
        params.push(Box::new(input.id.clone()));

        let param_refs: Vec<&dyn rusqlite::types::ToSql> =
            params.iter().map(|p| p.as_ref()).collect();
        self.conn.execute(&sql, param_refs.as_slice())?;

        self.project_get(&input.id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)
    }

    pub fn project_binding_upsert(
        &self,
        project_id: &str,
        input: &UpsertProjectBindingInput,
    ) -> Result<Project, rusqlite::Error> {
        let cli_type = normalize_project_cli_type(&input.cli_type);
        let terminal_type = input.terminal_type.as_deref().unwrap_or("iterm2");
        self.conn.execute(
            "INSERT INTO project_client_bindings
                (project_id, cli_type, provider_id, api_key_id, terminal_type, prelaunch_command)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(project_id, cli_type) DO UPDATE SET
                provider_id = excluded.provider_id,
                api_key_id = excluded.api_key_id,
                terminal_type = excluded.terminal_type,
                prelaunch_command = excluded.prelaunch_command",
            rusqlite::params![
                project_id,
                cli_type,
                input.provider_id,
                input.api_key_id,
                terminal_type,
                input.prelaunch_command,
            ],
        )?;

        // Keep the legacy columns as a last-used snapshot for older call sites
        // and data exports. Client-specific behavior reads project_client_bindings.
        self.conn.execute(
            "UPDATE projects
             SET provider_id = ?1, api_key_id = ?2, cli_type = ?3,
                 terminal_type = ?4, prelaunch_command = ?5
             WHERE id = ?6",
            rusqlite::params![
                input.provider_id,
                input.api_key_id,
                cli_type,
                terminal_type,
                input.prelaunch_command,
                project_id,
            ],
        )?;

        self.project_get(project_id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)
    }

    pub fn project_delete(&self, id: &str) -> Result<(), rusqlite::Error> {
        // Backfill snapshot column before deletion so request_logs retain the display name
        self.conn.execute(
            "UPDATE request_logs SET project_name = (SELECT name FROM projects WHERE id = ?1)
             WHERE project_id = ?1 AND project_name IS NULL",
            [id],
        )?;
        self.conn
            .execute("DELETE FROM projects WHERE id = ?1", [id])?;
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
