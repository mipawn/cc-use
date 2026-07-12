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
    assert!(tables.contains(&"discovered_sessions".to_string()));
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
