use crate::db::Database;
use crate::models::{UsageLog, UsageStats, ProjectUsageCount, KeyUsageCount, DateCount};

impl Database {
    pub fn usage_log_get_stats(&self, time_range: &str) -> Result<UsageStats, rusqlite::Error> {
        let where_clause = self.time_range_where("launched_at", time_range);

        let total_launches: i64 = self.conn.query_row(
            &format!("SELECT COUNT(*) FROM usage_logs {}", where_clause),
            [],
            |row| row.get(0),
        )?;

        let unique_projects: i64 = self.conn.query_row(
            &format!("SELECT COUNT(DISTINCT project_id) FROM usage_logs {}", where_clause),
            [],
            |row| row.get(0),
        )?;

        let unique_keys: i64 = self.conn.query_row(
            &format!("SELECT COUNT(DISTINCT api_key_id) FROM usage_logs {}", where_clause),
            [],
            |row| row.get(0),
        )?;

        let mut by_project_stmt = self.conn.prepare(
            &format!(
                "SELECT project_id, project_name, COUNT(*) as cnt FROM usage_logs {} GROUP BY project_id ORDER BY cnt DESC",
                where_clause
            )
        )?;
        let by_project: Vec<ProjectUsageCount> = by_project_stmt
            .query_map([], |row| {
                Ok(ProjectUsageCount {
                    project_id: row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                    project_name: row.get(1)?,
                    count: row.get(2)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();

        let mut by_key_stmt = self.conn.prepare(
            &format!(
                "SELECT api_key_id, COALESCE(api_key_alias, ''), COALESCE(provider_name, ''), COALESCE(key_type, 'claude'), COUNT(*) as cnt
                 FROM usage_logs {} GROUP BY api_key_id ORDER BY cnt DESC",
                where_clause
            )
        )?;
        let by_key: Vec<KeyUsageCount> = by_key_stmt
            .query_map([], |row| {
                Ok(KeyUsageCount {
                    key_id: row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                    key_alias: row.get(1)?,
                    provider_name: row.get(2)?,
                    key_type: row.get(3)?,
                    count: row.get(4)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();

        let mut by_date_stmt = self.conn.prepare(
            &format!(
                "SELECT DATE(launched_at) as d, COUNT(*) as cnt FROM usage_logs {} GROUP BY d ORDER BY d DESC LIMIT 30",
                where_clause
            )
        )?;
        let by_date: Vec<DateCount> = by_date_stmt
            .query_map([], |row| {
                Ok(DateCount {
                    date: row.get(0)?,
                    count: row.get(1)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();

        Ok(UsageStats {
            total_launches,
            unique_projects,
            unique_keys,
            by_project,
            by_key,
            by_date,
        })
    }

    pub fn usage_log_get_recent(&self, limit: i64) -> Result<Vec<UsageLog>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, project_id, project_name, provider_id, provider_name,
                    api_key_id, api_key_alias, key_type, launched_at, duration
             FROM usage_logs ORDER BY launched_at DESC LIMIT ?1"
        )?;

        let rows = stmt.query_map([limit], |row| {
            Ok(UsageLog {
                id: row.get(0)?,
                project_id: row.get(1)?,
                project_name: row.get(2)?,
                provider_id: row.get(3)?,
                provider_name: row.get(4)?,
                api_key_id: row.get(5)?,
                api_key_alias: row.get(6)?,
                key_type: row.get(7)?,
                launched_at: row.get(8)?,
                duration: row.get(9)?,
            })
        })?;

        rows.collect()
    }

    pub fn usage_log_today_quick_stats(&self) -> Result<serde_json::Value, rusqlite::Error> {
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();

        let launches: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM usage_logs WHERE DATE(launched_at) = ?1",
            [&today],
            |row| row.get(0),
        )?;

        let unique_projects: i64 = self.conn.query_row(
            "SELECT COUNT(DISTINCT project_id) FROM usage_logs WHERE DATE(launched_at) = ?1",
            [&today],
            |row| row.get(0),
        )?;

        let unique_keys: i64 = self.conn.query_row(
            "SELECT COUNT(DISTINCT api_key_id) FROM usage_logs WHERE DATE(launched_at) = ?1",
            [&today],
            |row| row.get(0),
        )?;

        Ok(serde_json::json!({
            "launches": launches,
            "uniqueProjects": unique_projects,
            "uniqueKeys": unique_keys,
        }))
    }

    pub fn usage_log_create(&self, log: &UsageLog) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO usage_logs (id, project_id, project_name, provider_id, provider_name,
                api_key_id, api_key_alias, key_type, launched_at, duration)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            rusqlite::params![
                log.id, log.project_id, log.project_name, log.provider_id, log.provider_name,
                log.api_key_id, log.api_key_alias, log.key_type, log.launched_at, log.duration,
            ],
        )?;
        Ok(())
    }

    // time_range_where is defined in db/mod.rs
}
