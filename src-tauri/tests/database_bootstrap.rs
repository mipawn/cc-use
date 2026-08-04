mod support;

use support::TempDb;

#[test]
fn database_init_fresh_creates_core_tables() {
    let fixture = TempDb::new();
    let tables: Vec<String> = fixture
        .db
        .conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .filter_map(|row| row.ok())
        .collect();

    assert!(tables.contains(&"providers".to_string()));
    assert!(tables.contains(&"api_keys".to_string()));
    assert!(tables.contains(&"projects".to_string()));
    assert!(tables.contains(&"settings".to_string()));
    assert!(tables.contains(&"usage_logs".to_string()));
    assert!(tables.contains(&"request_logs".to_string()));
    assert!(tables.contains(&"proxy_sessions".to_string()));
    assert!(tables.contains(&"managed_instances".to_string()));
    assert!(tables.contains(&"gateway_request_events".to_string()));

    // v3.7.0 dropped the V1 PID-observation leftover; nothing has read or
    // written it since V2. See docs/v3.7.0/cleanup-legacy.md.
    assert!(!tables.contains(&"discovered_sessions".to_string()));
}

#[test]
fn request_logs_records_request_outcome() {
    let fixture = TempDb::new();
    let columns: Vec<String> = fixture
        .db
        .conn
        .prepare("PRAGMA table_info(request_logs)")
        .unwrap()
        .query_map([], |row| row.get(1))
        .unwrap()
        .filter_map(|row| row.ok())
        .collect();

    assert!(columns.contains(&"outcome".to_string()));
    assert!(columns.contains(&"error_message".to_string()));
}

/// v3.7.0 stops displaying and calculating cost, but preserves existing cost
/// columns and values instead of destructively rewriting user history.
#[test]
fn migration_preserves_legacy_cost_data() {
    use cc_use_lib::db::Database;

    let path = std::env::temp_dir().join(format!(
        "cc-use-migration-test-{}.db",
        std::process::id().to_string() + &format!("{:?}", std::time::Instant::now().elapsed())
    ));
    let _ = std::fs::remove_file(&path);

    // Simulate a pre-v3.7.0 database: current schema plus the old cost columns
    // and a row holding both token and cost data.
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE request_logs (
                id TEXT PRIMARY KEY,
                provider_id TEXT, api_key_id TEXT, project_id TEXT, session_id TEXT,
                model TEXT, request_model TEXT,
                input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
                cache_read_tokens INTEGER DEFAULT 0, cache_creation_tokens INTEGER DEFAULT 0,
                input_cost_usd REAL DEFAULT 0, output_cost_usd REAL DEFAULT 0,
                cache_read_cost_usd REAL DEFAULT 0, cache_creation_cost_usd REAL DEFAULT 0,
                total_cost_usd REAL DEFAULT 0, cost_multiplier REAL DEFAULT 1,
                latency_ms INTEGER, first_token_ms INTEGER, status_code INTEGER,
                error_message TEXT, is_streaming INTEGER DEFAULT 0, created_at TEXT NOT NULL
            );
            INSERT INTO request_logs (id, input_tokens, output_tokens, total_cost_usd, created_at)
            VALUES ('legacy-1', 100, 50, 1.23, '2026-07-01T00:00:00Z');",
        )
        .unwrap();
    }

    // Opening runs migrations.
    let db = Database::open_at(&path).unwrap();

    let columns: Vec<String> = db
        .conn
        .prepare("PRAGMA table_info(request_logs)")
        .unwrap()
        .query_map([], |row| row.get(1))
        .unwrap()
        .filter_map(|row| row.ok())
        .collect();
    assert!(columns.contains(&"total_cost_usd".to_string()));
    assert!(columns.contains(&"cost_multiplier".to_string()));
    assert!(columns.contains(&"outcome".to_string()));

    // Token data survives, and pre-existing rows are backfilled as success.
    let (input, output, cost, outcome): (i64, i64, f64, Option<String>) = db
        .conn
        .query_row(
            "SELECT input_tokens, output_tokens, total_cost_usd, outcome FROM request_logs WHERE id = 'legacy-1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(input, 100);
    assert_eq!(output, 50);
    assert!((cost - 1.23).abs() < 1e-9);
    assert_eq!(outcome.as_deref(), Some("success"));
    drop(db);
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(path.with_extension("db-wal"));
    let _ = std::fs::remove_file(path.with_extension("db-shm"));
}

#[test]
fn database_file_connection_enables_shared_access_pragmas() {
    let fixture = TempDb::new();

    let journal_mode: String = fixture
        .db
        .conn
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .unwrap();
    let busy_timeout: i64 = fixture
        .db
        .conn
        .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
        .unwrap();
    let foreign_keys: i64 = fixture
        .db
        .conn
        .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
        .unwrap();

    assert_eq!(journal_mode.to_lowercase(), "wal");
    assert_eq!(busy_timeout, 5000);
    assert_eq!(foreign_keys, 1);
}
