pub mod providers;
pub mod api_keys;
pub mod projects;
pub mod settings;
pub mod usage_logs;
pub mod request_logs;
pub mod proxy_sessions;

use rusqlite::Connection;
use std::path::PathBuf;

pub struct Database {
    pub conn: Connection,
}

impl Database {
    pub fn new() -> Result<Self, rusqlite::Error> {
        let db_path = Self::get_db_path();

        // Ensure parent directory exists
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).ok();
        }

        let conn = Connection::open(&db_path)?;
        conn.execute_batch("PRAGMA journal_mode = WAL;")?;
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;

        let db = Self { conn };
        db.run_migrations()?;
        Ok(db)
    }

    #[cfg(test)]
    pub fn new_in_memory() -> Result<Self, rusqlite::Error> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        let db = Self { conn };
        db.run_migrations()?;
        Ok(db)
    }

    fn get_db_path() -> PathBuf {
        let base = dirs_next().unwrap_or_else(|| PathBuf::from("."));
        base.join("data").join("cc-use.db")
    }

    /// Get the path to the old Electron version's DB file.
    pub fn get_electron_db_path() -> PathBuf {
        let electron_dir_name = "cc-use";
        #[cfg(target_os = "macos")]
        let base = dirs::data_dir().map(|p| p.join(electron_dir_name));
        #[cfg(target_os = "windows")]
        let base = dirs::data_dir().map(|p| p.join(electron_dir_name));
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let base: Option<PathBuf> = None;

        base.unwrap_or_else(|| PathBuf::from("."))
            .join("data")
            .join("cc-use.db")
    }

    fn run_migrations(&self) -> Result<(), rusqlite::Error> {
        self.conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS providers (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                base_url TEXT NOT NULL,
                type TEXT DEFAULT 'claude',
                website TEXT,
                remark TEXT,
                token TEXT,
                icon TEXT,
                wallet_balance_type TEXT DEFAULT 'none',
                wallet_balance_url TEXT,
                wallet_balance_path TEXT,
                wallet_balance_headers TEXT,
                wallet_balance_user_id TEXT,
                cached_wallet_balance REAL,
                last_balance_checked_at TEXT,
                usage_type TEXT DEFAULT 'none',
                usage_url TEXT,
                usage_path TEXT,
                usage_headers TEXT,
                cached_usage TEXT,
                last_usage_checked_at TEXT,
                cost_multiplier REAL DEFAULT 1,
                cached_model_pricing TEXT,
                last_pricing_synced_at TEXT,
                is_active INTEGER DEFAULT 1
            );

            CREATE TABLE IF NOT EXISTS api_keys (
                id TEXT PRIMARY KEY,
                provider_id TEXT REFERENCES providers(id) ON DELETE CASCADE,
                alias TEXT,
                value TEXT NOT NULL,
                types TEXT DEFAULT '[\"claude\"]',
                priority INTEGER DEFAULT 0,
                is_exhausted INTEGER DEFAULT 0,
                is_active INTEGER DEFAULT 1,
                config TEXT,
                usage_type TEXT DEFAULT 'none',
                usage_url TEXT,
                usage_path TEXT,
                usage_headers TEXT,
                cached_usage TEXT,
                last_usage_checked_at TEXT,
                cost_multiplier REAL DEFAULT 1
            );

            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                path TEXT NOT NULL UNIQUE,
                remark TEXT,
                provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,
                api_key_id TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
                cli_type TEXT DEFAULT 'claude',
                terminal_type TEXT DEFAULT 'iterm2',
                last_opened_at TEXT
            );

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT
            );

            CREATE TABLE IF NOT EXISTS usage_logs (
                id TEXT PRIMARY KEY,
                project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
                project_name TEXT NOT NULL,
                provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,
                provider_name TEXT,
                api_key_id TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
                api_key_alias TEXT,
                key_type TEXT,
                launched_at TEXT NOT NULL,
                duration INTEGER
            );

            CREATE TABLE IF NOT EXISTS request_logs (
                id TEXT PRIMARY KEY,
                provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,
                api_key_id TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
                project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
                session_id TEXT,
                model TEXT,
                request_model TEXT,
                input_tokens INTEGER DEFAULT 0,
                output_tokens INTEGER DEFAULT 0,
                cache_read_tokens INTEGER DEFAULT 0,
                cache_creation_tokens INTEGER DEFAULT 0,
                input_cost_usd REAL DEFAULT 0,
                output_cost_usd REAL DEFAULT 0,
                cache_read_cost_usd REAL DEFAULT 0,
                cache_creation_cost_usd REAL DEFAULT 0,
                total_cost_usd REAL DEFAULT 0,
                cost_multiplier REAL DEFAULT 1,
                latency_ms INTEGER,
                first_token_ms INTEGER,
                status_code INTEGER,
                error_message TEXT,
                is_streaming INTEGER DEFAULT 0,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS proxy_sessions (
                session_token TEXT PRIMARY KEY,
                provider_id TEXT NOT NULL,
                api_key_id TEXT NOT NULL,
                project_id TEXT,
                created_at TEXT NOT NULL
            );
            "
        )?;

        // Run ALTER TABLE migrations for backward compatibility with existing databases
        self.run_alter_migrations();

        Ok(())
    }

    /// Open a Database from a specific file path (used for migration).
    pub fn open_at(path: &std::path::Path) -> Result<Self, rusqlite::Error> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        let conn = Connection::open(path)?;
        conn.execute_batch("PRAGMA journal_mode = WAL;")?;
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        let db = Self { conn };
        db.run_migrations()?;
        Ok(db)
    }

    /// Check if the database is empty (no providers).
    pub fn is_empty(&self) -> bool {
        self.conn
            .query_row("SELECT COUNT(*) FROM providers", [], |row| row.get::<_, i32>(0))
            .unwrap_or(0)
            == 0
    }

    /// Get row counts for migration statistics.
    pub fn get_migration_stats(&self) -> (i32, i32, i32, i32, i32) {
        let count = |table: &str| -> i32 {
            self.conn
                .query_row(&format!("SELECT COUNT(*) FROM {}", table), [], |row| {
                    row.get(0)
                })
                .unwrap_or(0)
        };
        (
            count("providers"),
            count("api_keys"),
            count("projects"),
            count("request_logs"),
            count("usage_logs"),
        )
    }

    pub fn time_range_where(&self, col: &str, time_range: &str) -> String {
        match time_range {
            "today" => format!("WHERE DATE({}) = DATE('now', 'localtime')", col),
            "yesterday" => format!("WHERE DATE({}) = DATE('now', 'localtime', '-1 day')", col),
            "week" => format!("WHERE {} >= DATE('now', 'localtime', '-7 days')", col),
            "month" => format!("WHERE {} >= DATE('now', 'localtime', '-30 days')", col),
            _ => String::new(), // "all"
        }
    }

    fn run_alter_migrations(&self) {
        // These are safe to run even if columns already exist — we just ignore errors
        let alter_statements = [
            "ALTER TABLE providers ADD COLUMN type TEXT DEFAULT 'claude'",
            "ALTER TABLE providers ADD COLUMN website TEXT",
            "ALTER TABLE providers ADD COLUMN remark TEXT",
            "ALTER TABLE providers ADD COLUMN token TEXT",
            "ALTER TABLE providers ADD COLUMN icon TEXT",
            "ALTER TABLE providers ADD COLUMN usage_type TEXT DEFAULT 'none'",
            "ALTER TABLE providers ADD COLUMN usage_url TEXT",
            "ALTER TABLE providers ADD COLUMN usage_path TEXT",
            "ALTER TABLE providers ADD COLUMN usage_headers TEXT",
            "ALTER TABLE providers ADD COLUMN cached_usage TEXT",
            "ALTER TABLE providers ADD COLUMN last_usage_checked_at TEXT",
            "ALTER TABLE providers ADD COLUMN cost_multiplier REAL DEFAULT 1",
            "ALTER TABLE providers ADD COLUMN wallet_balance_user_id TEXT",
            "ALTER TABLE providers ADD COLUMN cached_model_pricing TEXT",
            "ALTER TABLE providers ADD COLUMN last_pricing_synced_at TEXT",
            "ALTER TABLE api_keys ADD COLUMN is_active INTEGER DEFAULT 1",
            "ALTER TABLE api_keys ADD COLUMN config TEXT",
            "ALTER TABLE api_keys ADD COLUMN types TEXT DEFAULT '[\"claude\"]'",
            "ALTER TABLE api_keys ADD COLUMN usage_type TEXT DEFAULT 'none'",
            "ALTER TABLE api_keys ADD COLUMN usage_url TEXT",
            "ALTER TABLE api_keys ADD COLUMN usage_path TEXT",
            "ALTER TABLE api_keys ADD COLUMN usage_headers TEXT",
            "ALTER TABLE api_keys ADD COLUMN cached_usage TEXT",
            "ALTER TABLE api_keys ADD COLUMN last_usage_checked_at TEXT",
            "ALTER TABLE api_keys ADD COLUMN cost_multiplier REAL DEFAULT 1",
            "ALTER TABLE projects ADD COLUMN api_key_id TEXT REFERENCES api_keys(id) ON DELETE SET NULL",
            "ALTER TABLE projects ADD COLUMN terminal_type TEXT DEFAULT 'iterm2'",
            "ALTER TABLE projects ADD COLUMN remark TEXT",
            "ALTER TABLE projects ADD COLUMN cli_type TEXT DEFAULT 'claude'",
        ];

        for stmt in &alter_statements {
            let _ = self.conn.execute(stmt, []);
        }
    }
}

/// Get the app data directory name based on build mode
fn app_data_dir_name() -> &'static str {
    if cfg!(debug_assertions) {
        "com.mipawn.cc-use.dev"
    } else {
        "com.mipawn.cc-use"
    }
}

/// Get the application data directory
fn dirs_next() -> Option<PathBuf> {
    let dir_name = app_data_dir_name();
    #[cfg(target_os = "macos")]
    {
        dirs::data_dir().map(|p| p.join(dir_name))
    }
    #[cfg(target_os = "windows")]
    {
        dirs::data_dir().map(|p| p.join(dir_name))
    }
    #[cfg(target_os = "linux")]
    {
        dirs::data_dir().map(|p| p.join(dir_name))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_database_init_fresh() {
        let db = Database::new_in_memory().unwrap();
        // Verify all 7 tables exist
        let tables: Vec<String> = db
            .conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();

        assert!(tables.contains(&"providers".to_string()));
        assert!(tables.contains(&"api_keys".to_string()));
        assert!(tables.contains(&"projects".to_string()));
        assert!(tables.contains(&"settings".to_string()));
        assert!(tables.contains(&"usage_logs".to_string()));
        assert!(tables.contains(&"request_logs".to_string()));
        assert!(tables.contains(&"proxy_sessions".to_string()));
    }
}
