/// Shared macro for building dynamic UPDATE queries.
/// Pushes `"$col = ?"` into `$sets` and boxes the value into `$params`
/// when the Option field is Some.
macro_rules! add_field {
    ($field:expr, $col:expr, $sets:expr, $params:expr) => {
        if let Some(ref val) = $field {
            $sets.push(format!("{} = ?", $col));
            $params.push(Box::new(val.clone()));
        }
    };
}

pub mod api_keys;
pub mod gateway_metrics;
pub mod managed_instances;
pub mod projects;
pub mod providers;
pub mod proxy_sessions;
pub mod request_logs;
mod secret_store;
pub mod settings;
pub mod usage_logs;

use rusqlite::Connection;
use secret_store::{MemorySecretStore, SecretStore, SystemSecretStore};
use std::{path::PathBuf, sync::Arc};

pub struct Database {
    pub conn: Connection,
    secret_store: Arc<dyn SecretStore>,
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

        let db = Self {
            conn,
            secret_store: Arc::new(SystemSecretStore),
        };
        db.run_migrations()?;
        Ok(db)
    }

    #[cfg(test)]
    pub fn new_in_memory() -> Result<Self, rusqlite::Error> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        let db = Self {
            conn,
            secret_store: Arc::new(MemorySecretStore::default()),
        };
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
        #[cfg(not(target_os = "macos"))]
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
                http_proxy TEXT,
                website TEXT,
                remark TEXT,
                token TEXT,
                token_secret_ref TEXT,
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
                is_active INTEGER DEFAULT 1,
                sort_order INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS api_keys (
                id TEXT PRIMARY KEY,
                provider_id TEXT REFERENCES providers(id) ON DELETE CASCADE,
                alias TEXT,
                value TEXT NOT NULL,
                secret_ref TEXT,
                types TEXT DEFAULT '[\"claude_code\"]',
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
                cost_multiplier REAL DEFAULT 1,
                client_configs TEXT
            );

            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                path TEXT NOT NULL UNIQUE,
                remark TEXT,
                provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,
                api_key_id TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
                cli_type TEXT DEFAULT 'claude_code',
                terminal_type TEXT DEFAULT 'iterm2',
                prelaunch_command TEXT,
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
                created_at TEXT NOT NULL,
                cli_type TEXT,
                session_kind TEXT NOT NULL DEFAULT 'managed',
                last_seen_at TEXT NOT NULL,
                expires_at TEXT,
                revoked_at TEXT,
                revoked_reason TEXT
            );

            CREATE TABLE IF NOT EXISTS gateway_request_events (
                id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                kind TEXT NOT NULL,
                method TEXT NOT NULL,
                path TEXT NOT NULL,
                status_code INTEGER,
                latency_ms INTEGER,
                provider_name TEXT,
                key_alias TEXT,
                is_streaming INTEGER DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_gateway_request_events_created
            ON gateway_request_events(created_at DESC);

            CREATE TABLE IF NOT EXISTS managed_instances (
                id TEXT PRIMARY KEY,
                session_token TEXT NOT NULL UNIQUE REFERENCES proxy_sessions(session_token) ON DELETE CASCADE,
                project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
                provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,
                api_key_id TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
                cli_type TEXT NOT NULL,
                terminal_type TEXT NOT NULL,
                project_path TEXT NOT NULL,
                shell_pid INTEGER,
                process_pid INTEGER,
                status TEXT NOT NULL DEFAULT 'launching',
                assignment_source TEXT,
                last_seen_at TEXT NOT NULL,
                launched_at TEXT NOT NULL,
                stopped_at TEXT,
                stop_reason TEXT,
                exit_code INTEGER
            );

            CREATE INDEX IF NOT EXISTS idx_managed_instances_status_seen
            ON managed_instances(status, last_seen_at DESC);

            CREATE TABLE IF NOT EXISTS discovered_sessions (
                id TEXT PRIMARY KEY,
                pid INTEGER NOT NULL,
                process_name TEXT NOT NULL,
                executable_path TEXT,
                cwd TEXT,
                cli_type TEXT NOT NULL DEFAULT 'unknown',
                provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,
                api_key_id TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
                routing_mode TEXT NOT NULL DEFAULT 'pass_through',
                assignment_source TEXT,
                source_port_last_seen INTEGER,
                last_upstream_family TEXT,
                last_error TEXT,
                is_active INTEGER DEFAULT 1,
                last_seen_at TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
",
        )?;

        // Run ALTER TABLE migrations for backward compatibility with existing databases
        self.run_alter_migrations();
        self.migrate_api_key_secrets()?;
        self.migrate_provider_token_secrets()?;

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
        let db = Self {
            conn,
            secret_store: Arc::new(MemorySecretStore::default()),
        };
        db.run_migrations()?;
        Ok(db)
    }

    /// Check if the database is empty (no providers).
    pub fn is_empty(&self) -> bool {
        self.conn
            .query_row("SELECT COUNT(*) FROM providers", [], |row| {
                row.get::<_, i32>(0)
            })
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
        let local_date = Self::local_date_expr(col);
        match time_range {
            "today" => format!("WHERE {} = DATE('now', 'localtime')", local_date),
            "yesterday" => format!("WHERE {} = DATE('now', 'localtime', '-1 day')", local_date),
            "week" => format!(
                "WHERE {} >= DATE('now', 'localtime', '-7 days')",
                local_date
            ),
            "month" => format!(
                "WHERE {} >= DATE('now', 'localtime', '-30 days')",
                local_date
            ),
            _ => String::new(), // "all"
        }
    }

    pub fn local_date_expr(col: &str) -> String {
        format!("DATE({}, 'localtime')", col)
    }

    fn run_alter_migrations(&self) {
        // These are safe to run even if columns already exist — we just ignore errors
        let alter_statements = [
            "ALTER TABLE providers ADD COLUMN http_proxy TEXT",
            "ALTER TABLE providers ADD COLUMN website TEXT",
            "ALTER TABLE providers ADD COLUMN remark TEXT",
            "ALTER TABLE providers ADD COLUMN token TEXT",
            "ALTER TABLE providers ADD COLUMN token_secret_ref TEXT",
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
            "ALTER TABLE providers ADD COLUMN sort_order INTEGER DEFAULT 0",
            "ALTER TABLE api_keys ADD COLUMN is_active INTEGER DEFAULT 1",
            "ALTER TABLE api_keys ADD COLUMN config TEXT",
            "ALTER TABLE api_keys ADD COLUMN types TEXT DEFAULT '[\\\"claude_code\\\"]'",
            "ALTER TABLE api_keys ADD COLUMN usage_type TEXT DEFAULT 'none'",
            "ALTER TABLE api_keys ADD COLUMN usage_url TEXT",
            "ALTER TABLE api_keys ADD COLUMN usage_path TEXT",
            "ALTER TABLE api_keys ADD COLUMN usage_headers TEXT",
            "ALTER TABLE api_keys ADD COLUMN cached_usage TEXT",
            "ALTER TABLE api_keys ADD COLUMN last_usage_checked_at TEXT",
            "ALTER TABLE api_keys ADD COLUMN cost_multiplier REAL DEFAULT 1",
            "ALTER TABLE api_keys ADD COLUMN client_configs TEXT",
            "ALTER TABLE api_keys ADD COLUMN secret_ref TEXT",
            "ALTER TABLE projects ADD COLUMN api_key_id TEXT REFERENCES api_keys(id) ON DELETE SET NULL",
            "ALTER TABLE projects ADD COLUMN terminal_type TEXT DEFAULT 'iterm2'",
            "ALTER TABLE projects ADD COLUMN remark TEXT",
            "ALTER TABLE projects ADD COLUMN cli_type TEXT DEFAULT 'claude_code'",
            "ALTER TABLE projects ADD COLUMN prelaunch_command TEXT",
            // Snapshot columns on request_logs — preserve display names after entity deletion
            "ALTER TABLE request_logs ADD COLUMN key_alias TEXT",
            "ALTER TABLE request_logs ADD COLUMN provider_name TEXT",
            "ALTER TABLE request_logs ADD COLUMN project_name TEXT",
            "ALTER TABLE api_keys ADD COLUMN model_mapping TEXT",
            // proxy_sessions records the client marker for config-takeover routing.
            "ALTER TABLE proxy_sessions ADD COLUMN cli_type TEXT",
            "ALTER TABLE proxy_sessions ADD COLUMN session_kind TEXT NOT NULL DEFAULT 'managed'",
            "ALTER TABLE proxy_sessions ADD COLUMN last_seen_at TEXT",
            "ALTER TABLE proxy_sessions ADD COLUMN expires_at TEXT",
            "ALTER TABLE proxy_sessions ADD COLUMN revoked_at TEXT",
            "ALTER TABLE proxy_sessions ADD COLUMN revoked_reason TEXT",
        ];

        for stmt in &alter_statements {
            let _ = self.conn.execute(stmt, []);
        }

        // Backfill lifecycle metadata for sessions created before v3.3.0.
        let _ = self.conn.execute(
            "UPDATE proxy_sessions
             SET session_kind = CASE
                   WHEN project_id IS NULL AND cli_type IN ('codex', 'codex-app', 'claude_desktop')
                     THEN 'desktop'
                   WHEN project_id IS NULL THEN 'manual'
                   ELSE 'managed'
                 END,
                 last_seen_at = COALESCE(last_seen_at, created_at)",
            [],
        );

        // v3.2.0: Migrate api_keys.types from legacy 'claude' to ClientKind 'claude_code'.
        // Codex terminal launch removed; only 3 clients: claude_code / codex / claude_desktop.
        self.migrate_api_key_types_to_client_kind();
        self.migrate_projects_cli_type_to_client_kind();

        // v3.2.3: Drop transform-related columns (provider_type, api_format, transform_enabled).
        self.drop_transform_columns();
    }

    fn migrate_api_key_secrets(&self) -> Result<(), rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, value FROM api_keys
             WHERE (secret_ref IS NULL OR secret_ref = '') AND value != ''",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let legacy_keys = rows.collect::<Result<Vec<_>, _>>()?;
        drop(stmt);

        for (id, value) in legacy_keys {
            let secret_ref = Self::api_key_secret_ref(&id);
            self.secret_store
                .set(&secret_ref, &value)
                .map_err(secret_store::to_sqlite_error)?;
            self.conn.execute(
                "UPDATE api_keys SET value = '', secret_ref = ?1 WHERE id = ?2",
                rusqlite::params![secret_ref, id],
            )?;
        }
        Ok(())
    }

    pub(crate) fn api_key_secret_ref(id: &str) -> String {
        format!("api-key:{}", id)
    }

    pub(crate) fn provider_token_secret_ref(id: &str) -> String {
        format!("provider-token:{}", id)
    }

    fn migrate_provider_token_secrets(&self) -> Result<(), rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, token FROM providers
             WHERE (token_secret_ref IS NULL OR token_secret_ref = '')
               AND token IS NOT NULL AND token != ''",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let legacy_tokens = rows.collect::<Result<Vec<_>, _>>()?;
        drop(stmt);

        for (id, token) in legacy_tokens {
            let secret_ref = Self::provider_token_secret_ref(&id);
            self.secret_store
                .set(&secret_ref, &token)
                .map_err(secret_store::to_sqlite_error)?;
            self.conn.execute(
                "UPDATE providers SET token = NULL, token_secret_ref = ?1 WHERE id = ?2",
                rusqlite::params![secret_ref, id],
            )?;
        }
        Ok(())
    }

    /// Migrate api_keys.types: replace 'claude' with 'claude_code' (v3.2.0 ClientKind).
    /// Idempotent — safe to run multiple times.
    fn migrate_api_key_types_to_client_kind(&self) {
        let _ = self.conn.execute(
            r#"
            UPDATE api_keys
            SET types = REPLACE(types, '"claude"', '"claude_code"')
            WHERE types LIKE '%"claude"%'
            "#,
            [],
        );
    }

    /// Migrate projects.cli_type: 'claude' → 'claude_code' (v3.2.0 ClientKind).
    fn migrate_projects_cli_type_to_client_kind(&self) {
        let _ = self.conn.execute(
            r#"
            UPDATE projects
            SET cli_type = 'claude_code'
            WHERE cli_type = 'claude'
            "#,
            [],
        );
    }

    /// v3.2.3: Drop transform-related columns (provider_type, api_format, transform_enabled).
    /// SQLite 3.35.0+ supports DROP COLUMN; older versions silently ignore the error.
    fn drop_transform_columns(&self) {
        let drop_statements = [
            "ALTER TABLE providers DROP COLUMN type",
            "ALTER TABLE providers DROP COLUMN api_format",
            "ALTER TABLE providers DROP COLUMN transform_enabled",
            "ALTER TABLE api_keys DROP COLUMN api_format",
            "ALTER TABLE api_keys DROP COLUMN transform_enabled",
        ];

        for stmt in &drop_statements {
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
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}
