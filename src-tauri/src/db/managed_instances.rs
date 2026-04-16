use crate::db::Database;
use crate::models::ManagedInstance;

fn row_to_managed_instance(row: &rusqlite::Row) -> Result<ManagedInstance, rusqlite::Error> {
    Ok(ManagedInstance {
        id: row.get(0)?,
        session_token: row.get(1)?,
        project_id: row.get(2)?,
        provider_id: row.get(3)?,
        api_key_id: row.get(4)?,
        cli_type: row.get(5)?,
        terminal_type: row.get(6)?,
        project_path: row.get(7)?,
        shell_pid: row.get(8)?,
        process_pid: row.get(9)?,
        status: row.get(10)?,
        assignment_source: row.get(11)?,
        last_seen_at: row.get(12)?,
        launched_at: row.get(13)?,
        stopped_at: row.get(14)?,
        stop_reason: row.get(15)?,
        exit_code: row.get(16)?,
    })
}

impl Database {
    pub fn managed_instance_create(
        &self,
        instance: &ManagedInstance,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO managed_instances (
                id, session_token, project_id, provider_id, api_key_id, cli_type, terminal_type,
                project_path, shell_pid, process_pid, status, assignment_source, last_seen_at,
                launched_at, stopped_at, stop_reason, exit_code
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
            rusqlite::params![
                instance.id,
                instance.session_token,
                instance.project_id,
                instance.provider_id,
                instance.api_key_id,
                instance.cli_type,
                instance.terminal_type,
                instance.project_path,
                instance.shell_pid,
                instance.process_pid,
                instance.status,
                instance.assignment_source,
                instance.last_seen_at,
                instance.launched_at,
                instance.stopped_at,
                instance.stop_reason,
                instance.exit_code,
            ],
        )?;
        Ok(())
    }

    pub fn managed_instance_get(
        &self,
        id: &str,
    ) -> Result<Option<ManagedInstance>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, session_token, project_id, provider_id, api_key_id, cli_type, terminal_type,
                    project_path, shell_pid, process_pid, status, assignment_source, last_seen_at,
                    launched_at, stopped_at, stop_reason, exit_code
             FROM managed_instances
             WHERE id = ?1",
        )?;

        let mut rows = stmt.query_map([id], row_to_managed_instance)?;
        match rows.next() {
            Some(Ok(instance)) => Ok(Some(instance)),
            Some(Err(error)) => Err(error),
            None => Ok(None),
        }
    }

    pub fn managed_instance_list_active(&self) -> Result<Vec<ManagedInstance>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, session_token, project_id, provider_id, api_key_id, cli_type, terminal_type,
                    project_path, shell_pid, process_pid, status, assignment_source, last_seen_at,
                    launched_at, stopped_at, stop_reason, exit_code
             FROM managed_instances
             WHERE status IN ('launching', 'running', 'stale')
             ORDER BY launched_at DESC",
        )?;

        let rows = stmt.query_map([], row_to_managed_instance)?;
        rows.collect()
    }

    pub fn managed_instance_update_assignment(
        &self,
        id: &str,
        provider_id: &str,
        api_key_id: &str,
        assignment_source: Option<&str>,
    ) -> Result<bool, rusqlite::Error> {
        let changed = self.conn.execute(
            "UPDATE managed_instances
             SET provider_id = ?1,
                 api_key_id = ?2,
                 assignment_source = ?3
             WHERE id = ?4",
            rusqlite::params![provider_id, api_key_id, assignment_source, id],
        )?;
        Ok(changed > 0)
    }

    pub fn managed_instance_touch_heartbeat(
        &self,
        id: &str,
        shell_pid: Option<i32>,
        process_pid: Option<i32>,
        last_seen_at: &str,
    ) -> Result<bool, rusqlite::Error> {
        let changed = self.conn.execute(
            "UPDATE managed_instances
             SET shell_pid = COALESCE(?1, shell_pid),
                 process_pid = COALESCE(?2, process_pid),
                 status = 'running',
                 last_seen_at = ?3
             WHERE id = ?4",
            rusqlite::params![shell_pid, process_pid, last_seen_at, id],
        )?;
        Ok(changed > 0)
    }

    pub fn managed_instance_mark_stopped(
        &self,
        id: &str,
        shell_pid: Option<i32>,
        process_pid: Option<i32>,
        status: &str,
        stop_reason: Option<&str>,
        exit_code: Option<i32>,
        stopped_at: &str,
    ) -> Result<bool, rusqlite::Error> {
        let changed = self.conn.execute(
            "UPDATE managed_instances
             SET shell_pid = COALESCE(?1, shell_pid),
                 process_pid = COALESCE(?2, process_pid),
                 status = ?3,
                 last_seen_at = ?4,
                 stopped_at = ?4,
                 stop_reason = ?5,
                 exit_code = ?6
             WHERE id = ?7",
            rusqlite::params![
                shell_pid,
                process_pid,
                status,
                stopped_at,
                stop_reason,
                exit_code,
                id,
            ],
        )?;
        Ok(changed > 0)
    }

    pub fn managed_instance_mark_stale_older_than(
        &self,
        cutoff: &str,
    ) -> Result<usize, rusqlite::Error> {
        let changed = self.conn.execute(
            "UPDATE managed_instances
             SET status = 'stale',
                 stop_reason = CASE
                   WHEN stop_reason IS NULL OR stop_reason = '' THEN 'heartbeat_timeout'
                   ELSE stop_reason
                 END
             WHERE status IN ('launching', 'running')
               AND last_seen_at < ?1",
            [cutoff],
        )?;
        Ok(changed)
    }

    pub fn managed_instance_stop_stale_older_than(
        &self,
        cutoff: &str,
    ) -> Result<usize, rusqlite::Error> {
        let changed = self.conn.execute(
            "UPDATE managed_instances
             SET status = 'stopped',
                 stopped_at = ?1,
                 stop_reason = CASE
                   WHEN stop_reason IS NULL OR stop_reason = '' THEN 'stale_timeout'
                   ELSE stop_reason
                 END
             WHERE status = 'stale'
               AND last_seen_at < ?1",
            [cutoff],
        )?;
        Ok(changed)
    }

    pub fn managed_instance_cleanup_inactive(&self) -> Result<usize, rusqlite::Error> {
        let now = chrono::Utc::now().to_rfc3339();
        // Mark all stale/launching instances as stopped
        let stale_count = self.conn.execute(
            "UPDATE managed_instances
             SET status = 'stopped',
                 stopped_at = ?1,
                 stop_reason = CASE
                   WHEN stop_reason IS NULL OR stop_reason = '' THEN 'manual_cleanup'
                   ELSE stop_reason
                 END
             WHERE status IN ('stale', 'launching')",
            [&now],
        )?;
        // Delete all stopped/failed instances
        let deleted_count = self.conn.execute(
            "DELETE FROM managed_instances WHERE status IN ('stopped', 'failed')",
            [],
        )?;
        Ok(stale_count + deleted_count)
    }
}
