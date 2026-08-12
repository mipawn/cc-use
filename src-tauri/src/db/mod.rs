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
mod keychain_migration;
pub mod managed_instances;
pub mod projects;
pub mod providers;
pub mod proxy_sessions;
pub mod request_logs;
pub mod settings;
pub mod usage_logs;

use rusqlite::Connection;
use std::path::PathBuf;

use keychain_migration::{LegacySecretReadError, LegacySecretReader, SystemKeychainReader};

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
        db.run_migrations(Some(&SystemKeychainReader))?;
        Ok(db)
    }

    #[cfg(test)]
    pub fn new_in_memory() -> Result<Self, rusqlite::Error> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        let db = Self { conn };
        db.run_migrations(None)?;
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

    fn run_migrations(
        &self,
        legacy_secret_reader: Option<&dyn LegacySecretReader>,
    ) -> Result<(), rusqlite::Error> {
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
                client_configs TEXT
            );

            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                path TEXT NOT NULL UNIQUE,
                group_name TEXT,
                remark TEXT,
                provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,
                api_key_id TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
                cli_type TEXT DEFAULT 'claude_code',
                terminal_type TEXT DEFAULT 'iterm2',
                prelaunch_command TEXT,
                last_opened_at TEXT
            );

            CREATE TABLE IF NOT EXISTS project_client_bindings (
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                cli_type TEXT NOT NULL,
                provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,
                api_key_id TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
                terminal_type TEXT NOT NULL DEFAULT 'iterm2',
                prelaunch_command TEXT,
                PRIMARY KEY (project_id, cli_type)
            );

            CREATE INDEX IF NOT EXISTS idx_project_client_bindings_cli
            ON project_client_bindings(cli_type, project_id);

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
                latency_ms INTEGER,
                first_token_ms INTEGER,
                status_code INTEGER,
                error_message TEXT,
                outcome TEXT,
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

",
        )?;

        // v3.7.0: `discovered_sessions` belonged to the V1 PID-observation model,
        // which V2 replaced with explicit launch-time identity. Nothing has read
        // or written it since; see docs/v3.7.0/cleanup-legacy.md.
        self.conn
            .execute_batch("DROP TABLE IF EXISTS discovered_sessions;")?;

        // Run ALTER TABLE migrations for backward compatibility with existing databases
        self.run_alter_migrations();
        self.restore_legacy_keychain_secrets(legacy_secret_reader)?;

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
        db.run_migrations(None)?;
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
                "WHERE {} >= DATE('now', 'localtime', '-6 days')",
                local_date
            ),
            "last30Days" => format!(
                "WHERE {} >= DATE('now', 'localtime', '-29 days')",
                local_date
            ),
            "lastYear" => format!(
                "WHERE {} >= DATE('now', 'localtime', '-364 days')",
                local_date
            ),
            "month" => format!(
                "WHERE {} >= DATE('now', 'localtime', 'start of month')",
                local_date
            ),
            "lastMonth" => format!(
                "WHERE {} >= DATE('now', 'localtime', 'start of month', '-1 month') AND {} < DATE('now', 'localtime', 'start of month')",
                local_date, local_date
            ),
            "year" => format!(
                "WHERE {} >= DATE('now', 'localtime', 'start of year')",
                local_date
            ),
            custom if custom.starts_with("custom:") => {
                let mut parts = custom.split(':');
                let _ = parts.next();
                let start = parts.next();
                let end = parts.next();
                let no_more = parts.next().is_none();
                match (start, end, no_more) {
                    (Some(start), Some(end), true)
                        if chrono::NaiveDate::parse_from_str(start, "%Y-%m-%d").is_ok()
                            && chrono::NaiveDate::parse_from_str(end, "%Y-%m-%d").is_ok()
                            && start <= end =>
                    {
                        format!(
                            "WHERE {} >= DATE('{}') AND {} <= DATE('{}')",
                            local_date, start, local_date, end
                        )
                    }
                    _ => "WHERE 1 = 0".to_string(),
                }
            }
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
            "ALTER TABLE providers ADD COLUMN wallet_balance_user_id TEXT",
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
            "ALTER TABLE api_keys ADD COLUMN client_configs TEXT",
            "ALTER TABLE api_keys ADD COLUMN secret_ref TEXT",
            "ALTER TABLE projects ADD COLUMN api_key_id TEXT REFERENCES api_keys(id) ON DELETE SET NULL",
            "ALTER TABLE projects ADD COLUMN terminal_type TEXT DEFAULT 'iterm2'",
            "ALTER TABLE projects ADD COLUMN remark TEXT",
            "ALTER TABLE projects ADD COLUMN cli_type TEXT DEFAULT 'claude_code'",
            "ALTER TABLE projects ADD COLUMN prelaunch_command TEXT",
            "ALTER TABLE projects ADD COLUMN group_name TEXT",
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
            // v3.7.0: failed requests are recorded too, so every row states its outcome.
            "ALTER TABLE request_logs ADD COLUMN outcome TEXT",
        ];

        for stmt in &alter_statements {
            let _ = self.conn.execute(stmt, []);
        }

        // Pre-v3.7.0 rows only existed when usage parsed, i.e. the request had
        // succeeded. Backfilling keeps the new outcome filters meaningful over
        // history instead of leaving it NULL.
        let _ = self.conn.execute(
            "UPDATE request_logs SET outcome = 'success' WHERE outcome IS NULL",
            [],
        );

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
        self.backfill_project_client_bindings();

        // v3.2.3: Drop transform-related columns (provider_type, api_format, transform_enabled).
        self.drop_transform_columns();
    }

    fn restore_legacy_keychain_secrets(
        &self,
        reader: Option<&dyn LegacySecretReader>,
    ) -> Result<(), rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, value, secret_ref FROM api_keys
             WHERE secret_ref IS NOT NULL AND secret_ref != ''",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        let legacy_keys = rows.collect::<Result<Vec<_>, _>>()?;
        drop(stmt);

        let mut stmt = self.conn.prepare(
            "SELECT id, token, token_secret_ref FROM providers
             WHERE token_secret_ref IS NOT NULL AND token_secret_ref != ''",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        let legacy_tokens = rows.collect::<Result<Vec<_>, _>>()?;
        drop(stmt);

        let read_secret = |reference: &str| {
            reader
                .ok_or_else(|| LegacySecretReadError::Unavailable(reference.to_string()))?
                .get(reference)
        };
        let restored_keys = legacy_keys
            .into_iter()
            .map(|(id, value, reference)| {
                if value.is_empty() {
                    read_secret(&reference).map(|secret| (id, secret))
                } else {
                    Ok((id, value))
                }
            })
            .collect::<Result<Vec<_>, _>>()
            .map_err(keychain_migration::to_sqlite_error)?;
        let restored_tokens = legacy_tokens
            .into_iter()
            .map(
                |(id, token, reference)| match token.filter(|value| !value.is_empty()) {
                    Some(token) => Ok((id, token)),
                    None => read_secret(&reference).map(|secret| (id, secret)),
                },
            )
            .collect::<Result<Vec<_>, _>>()
            .map_err(keychain_migration::to_sqlite_error)?;

        let transaction = self.conn.unchecked_transaction()?;
        for (id, value) in restored_keys {
            transaction.execute(
                "UPDATE api_keys SET value = ?1, secret_ref = NULL WHERE id = ?2",
                rusqlite::params![value, id],
            )?;
        }
        for (id, token) in restored_tokens {
            transaction.execute(
                "UPDATE providers SET token = ?1, token_secret_ref = NULL WHERE id = ?2",
                rusqlite::params![token, id],
            )?;
        }
        transaction.commit()
    }

    fn backfill_project_client_bindings(&self) {
        let _ = self.conn.execute(
            "INSERT OR IGNORE INTO project_client_bindings
                (project_id, cli_type, provider_id, api_key_id, terminal_type, prelaunch_command)
             SELECT id,
                    CASE WHEN cli_type = 'claude' THEN 'claude_code' ELSE cli_type END,
                    provider_id,
                    api_key_id,
                    COALESCE(terminal_type, 'iterm2'),
                    prelaunch_command
             FROM projects
             WHERE cli_type IS NOT NULL AND cli_type != ''",
            [],
        );
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    struct FakeLegacySecretReader {
        values: HashMap<String, String>,
    }

    impl LegacySecretReader for FakeLegacySecretReader {
        fn get(&self, reference: &str) -> Result<String, LegacySecretReadError> {
            self.values
                .get(reference)
                .cloned()
                .ok_or_else(|| LegacySecretReadError::Backend("access denied".to_string()))
        }
    }

    #[test]
    fn time_ranges_include_rolling_and_calendar_periods() {
        let db = Database::new_in_memory().unwrap();

        let rolling_week = db.time_range_where("created_at", "week");
        let rolling_month = db.time_range_where("created_at", "last30Days");
        let rolling_year = db.time_range_where("created_at", "lastYear");
        let current_year = db.time_range_where("created_at", "year");
        assert!(rolling_week.contains("'-6 days'"));
        assert!(rolling_month.contains("'-29 days'"));
        assert!(rolling_year.contains("'-364 days'"));
        assert!(current_year.contains("'start of year'"));
    }

    fn seed_legacy_keychain_references(db: &Database) {
        db.conn
            .execute(
                "INSERT INTO providers (id, name, base_url, token, token_secret_ref)
                 VALUES ('provider-1', 'Provider', 'https://example.com', NULL, 'provider-token:provider-1')",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO api_keys (id, provider_id, value, secret_ref)
                 VALUES ('key-1', 'provider-1', '', 'api-key:key-1')",
                [],
            )
            .unwrap();
    }

    #[test]
    fn restores_v330_keychain_secrets_to_sqlite() {
        let db = Database::new_in_memory().unwrap();
        seed_legacy_keychain_references(&db);
        let reader = FakeLegacySecretReader {
            values: HashMap::from([
                ("api-key:key-1".to_string(), "sk-restored".to_string()),
                (
                    "provider-token:provider-1".to_string(),
                    "token-restored".to_string(),
                ),
            ]),
        };

        db.restore_legacy_keychain_secrets(Some(&reader)).unwrap();

        let (value, secret_ref): (String, Option<String>) = db
            .conn
            .query_row(
                "SELECT value, secret_ref FROM api_keys WHERE id = 'key-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let (token, token_secret_ref): (Option<String>, Option<String>) = db
            .conn
            .query_row(
                "SELECT token, token_secret_ref FROM providers WHERE id = 'provider-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        assert_eq!(value, "sk-restored");
        assert!(secret_ref.is_none());
        assert_eq!(token.as_deref(), Some("token-restored"));
        assert!(token_secret_ref.is_none());
    }

    #[test]
    fn failed_keychain_restore_preserves_database_references() {
        let db = Database::new_in_memory().unwrap();
        seed_legacy_keychain_references(&db);
        let reader = FakeLegacySecretReader {
            values: HashMap::new(),
        };

        assert!(db.restore_legacy_keychain_secrets(Some(&reader)).is_err());

        let (value, secret_ref): (String, Option<String>) = db
            .conn
            .query_row(
                "SELECT value, secret_ref FROM api_keys WHERE id = 'key-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert!(value.is_empty());
        assert_eq!(secret_ref.as_deref(), Some("api-key:key-1"));
    }

    #[test]
    fn existing_plaintext_clears_stale_reference_without_keychain_access() {
        let db = Database::new_in_memory().unwrap();
        db.conn
            .execute(
                "INSERT INTO providers (id, name, base_url, token, token_secret_ref)
                 VALUES ('provider-1', 'Provider', 'https://example.com', 'plain-token', 'stale-provider-ref')",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO api_keys (id, provider_id, value, secret_ref)
                 VALUES ('key-1', 'provider-1', 'plain-key', 'stale-key-ref')",
                [],
            )
            .unwrap();

        db.restore_legacy_keychain_secrets(None).unwrap();

        let refs: (Option<String>, Option<String>) = db
            .conn
            .query_row(
                "SELECT api_keys.secret_ref, providers.token_secret_ref
                 FROM api_keys JOIN providers ON providers.id = api_keys.provider_id
                 WHERE api_keys.id = 'key-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(refs, (None, None));
    }
}
