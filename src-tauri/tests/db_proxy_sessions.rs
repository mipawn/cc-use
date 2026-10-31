mod support;

use support::{create_proxy_session, TempDb};

#[test]
fn legacy_proxy_sessions_gain_lifecycle_metadata_without_expiring_desktop_takeover() {
    let path = std::env::temp_dir().join(format!(
        "cc-use-session-migration-{}.db",
        nanoid::nanoid!(8)
    ));
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "CREATE TABLE proxy_sessions (
            session_token TEXT PRIMARY KEY,
            provider_id TEXT NOT NULL,
            api_key_id TEXT NOT NULL,
            project_id TEXT,
            created_at TEXT NOT NULL,
            cli_type TEXT
         );
         INSERT INTO proxy_sessions VALUES (
            'session-desktop', 'provider', 'key', NULL,
            '2025-01-01T00:00:00Z', 'codex-app'
         );",
    )
    .unwrap();
    drop(conn);

    let db = cc_use_lib::db::Database::open_at(&path).unwrap();
    let session = db.proxy_session_get("session-desktop").unwrap().unwrap();
    assert_eq!(session.session_kind, "desktop");
    assert_eq!(session.last_seen_at, "2025-01-01T00:00:00Z");
    assert_eq!(db.proxy_session_cleanup_stale(30).unwrap(), 0);
    assert!(db.proxy_session_get("session-desktop").unwrap().is_some());

    drop(db);
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(path.with_extension("db-wal"));
    let _ = std::fs::remove_file(path.with_extension("db-shm"));
}

#[test]
fn proxy_session_update_by_project_updates_only_matching_project_sessions() {
    let fixture = TempDb::new();
    create_proxy_session(
        &fixture.db,
        "session-1",
        "provider-a",
        "key-a",
        Some("project-1"),
    );
    create_proxy_session(
        &fixture.db,
        "session-2",
        "provider-b",
        "key-b",
        Some("project-1"),
    );
    create_proxy_session(
        &fixture.db,
        "session-3",
        "provider-c",
        "key-c",
        Some("project-2"),
    );
    create_proxy_session(&fixture.db, "session-4", "provider-d", "key-d", None);

    fixture
        .db
        .proxy_session_update_by_project("project-1", "provider-new", "key-new")
        .unwrap();

    let session_1 = fixture.db.proxy_session_get("session-1").unwrap().unwrap();
    let session_2 = fixture.db.proxy_session_get("session-2").unwrap().unwrap();
    let session_3 = fixture.db.proxy_session_get("session-3").unwrap().unwrap();
    let session_4 = fixture.db.proxy_session_get("session-4").unwrap().unwrap();

    assert_eq!(session_1.provider_id, "provider-new");
    assert_eq!(session_1.api_key_id, "key-new");
    assert_eq!(session_2.provider_id, "provider-new");
    assert_eq!(session_2.api_key_id, "key-new");
    assert_eq!(session_3.provider_id, "provider-c");
    assert_eq!(session_3.api_key_id, "key-c");
    assert_eq!(session_4.provider_id, "provider-d");
    assert_eq!(session_4.api_key_id, "key-d");
}

#[test]
fn proxy_session_update_provider_key_updates_single_session() {
    let fixture = TempDb::new();
    create_proxy_session(
        &fixture.db,
        "session-1",
        "provider-a",
        "key-a",
        Some("project-1"),
    );
    create_proxy_session(
        &fixture.db,
        "session-2",
        "provider-b",
        "key-b",
        Some("project-2"),
    );

    let changed = fixture
        .db
        .proxy_session_update_provider_key("session-1", "provider-new", "key-new")
        .unwrap();

    assert!(changed);
    let session_1 = fixture.db.proxy_session_get("session-1").unwrap().unwrap();
    let session_2 = fixture.db.proxy_session_get("session-2").unwrap().unwrap();
    assert_eq!(session_1.provider_id, "provider-new");
    assert_eq!(session_1.api_key_id, "key-new");
    assert_eq!(session_2.provider_id, "provider-b");
    assert_eq!(session_2.api_key_id, "key-b");
}

#[test]
fn proxy_session_update_provider_key_cli_type_repairs_existing_session_kind() {
    let fixture = TempDb::new();
    create_proxy_session(
        &fixture.db,
        "session-1",
        "provider-a",
        "key-a",
        Some("project-1"),
    );

    let changed = fixture
        .db
        .proxy_session_update_provider_key_cli_type(
            "session-1",
            "provider-new",
            "key-new",
            "codex-app",
        )
        .unwrap();

    assert!(changed);
    let session = fixture.db.proxy_session_get("session-1").unwrap().unwrap();
    assert_eq!(session.provider_id, "provider-new");
    assert_eq!(session.api_key_id, "key-new");
    assert_eq!(session.cli_type.as_deref(), Some("codex-app"));
    assert_eq!(session.session_kind, "desktop");
    assert!(session.revoked_at.is_none());
}

#[test]
fn proxy_session_revoke_and_touch_persist_lifecycle_state() {
    let fixture = TempDb::new();
    create_proxy_session(&fixture.db, "session-1", "provider-a", "key-a", None);

    fixture
        .db
        .proxy_session_touch("session-1", "2026-07-12T01:00:00Z")
        .unwrap();
    fixture
        .db
        .proxy_session_revoke("session-1", "manual_revoke", "2026-07-12T02:00:00Z")
        .unwrap();

    let session = fixture.db.proxy_session_get("session-1").unwrap().unwrap();
    assert_eq!(session.last_seen_at, "2026-07-12T01:00:00Z");
    assert_eq!(session.revoked_at.as_deref(), Some("2026-07-12T02:00:00Z"));
    assert_eq!(session.revoked_reason.as_deref(), Some("manual_revoke"));
}

#[test]
fn reopening_the_database_keeps_gateway_rows() {
    use cc_use_lib::commands::gateways::gateway_create_inner;
    use support::{create_api_key, create_provider};

    let path = std::env::temp_dir().join(format!(
        "cc-use-gateway-migration-{}.db",
        nanoid::nanoid!(8)
    ));
    let db = cc_use_lib::db::Database::open_at(&path).unwrap();
    let provider = create_provider(&db, "gateway-provider", "custom");
    let key = create_api_key(&db, &provider.id, "claude_code");
    let gateway = gateway_create_inner(&db, "outlet", &provider.id, &key.id, None).unwrap();

    // Simulate an older build's boot-time backfill corrupting the row.
    db.conn
        .execute(
            "UPDATE proxy_sessions SET session_kind = 'manual' WHERE session_token = ?1",
            [&gateway.session_token],
        )
        .unwrap();
    drop(db);

    let db = cc_use_lib::db::Database::open_at(&path).unwrap();
    let restored = db
        .gateway_get(&gateway.session_token)
        .unwrap()
        .expect("gateway row should survive the reopen");
    assert_eq!(restored.display_name, "outlet");
    assert_eq!(restored.provider_id, provider.id);
    drop(db);

    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(path.with_extension("db-wal"));
    let _ = std::fs::remove_file(path.with_extension("db-shm"));
}

// ────────────────────────────────────────────────────────────────────────────
// T01: gateway_connection_config column + marker-guarded one-shot migration.
// Every case reopens the database file, not just an in-memory object.
// ────────────────────────────────────────────────────────────────────────────

const GATEWAY_CONFIG_MARKER: &str = "migration.gatewayConnectionConfig.v1";

fn temp_db_path(tag: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("cc-use-{tag}-{}.db", nanoid::nanoid!(8)))
}

fn cleanup_db(path: &std::path::Path) {
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(path.with_extension("db-wal"));
    let _ = std::fs::remove_file(path.with_extension("db-shm"));
}

/// Reopen raw so the test can simulate pre-upgrade rows: clear the new column,
/// remove the marker, and put legacy values in the bound key.
fn simulate_legacy_gateway_row(path: &std::path::Path, client_configs: Option<&str>, extra: &str) {
    let conn = rusqlite::Connection::open(path).unwrap();
    conn.execute(
        "UPDATE proxy_sessions SET gateway_connection_config = NULL",
        [],
    )
    .unwrap();
    conn.execute(
        "DELETE FROM settings WHERE key = ?1",
        [GATEWAY_CONFIG_MARKER],
    )
    .unwrap();
    if let Some(client_configs) = client_configs {
        conn.execute("UPDATE api_keys SET client_configs = ?1", [client_configs])
            .unwrap();
    }
    if !extra.is_empty() {
        conn.execute_batch(extra).unwrap();
    }
}

fn raw_gateway_config(path: &std::path::Path) -> Option<String> {
    let conn = rusqlite::Connection::open(path).unwrap();
    conn.query_row(
        "SELECT gateway_connection_config FROM proxy_sessions WHERE session_kind = 'gateway'",
        [],
        |row| row.get::<_, Option<String>>(0),
    )
    .unwrap_or(None)
}

fn raw_marker(path: &std::path::Path) -> Option<String> {
    let conn = rusqlite::Connection::open(path).unwrap();
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        [GATEWAY_CONFIG_MARKER],
        |row| row.get::<_, String>(0),
    )
    .ok()
}

#[test]
fn legacy_gateway_rows_snapshot_explicit_claude_code_connection() {
    use cc_use_lib::commands::gateways::gateway_create_inner;
    use support::{create_api_key, create_provider};

    let path = temp_db_path("gateway-snapshot");
    let db = cc_use_lib::db::Database::open_at(&path).unwrap();
    let provider = create_provider(&db, "gateway-provider", "custom");
    let key = create_api_key(&db, &provider.id, "claude_code");
    let gateway = gateway_create_inner(&db, "outlet", &provider.id, &key.id, None).unwrap();
    db.conn
        .execute(
            "UPDATE api_keys SET types = ?1, model_mapping = ?2 WHERE id = ?3",
            rusqlite::params![
                r#"["claude_code","codex"]"#,
                r#"{"mode":"fixed","model":"do-not-copy"}"#,
                key.id
            ],
        )
        .unwrap();
    drop(db);

    simulate_legacy_gateway_row(
        &path,
        Some(
            r#"{
                "claude_code": {
                    "baseUrl": "https://legacy.example.com/api/v1",
                    "authScheme": "x-api-key",
                    "proxyUserAgent": "legacy-agent/1",
                    "defaultModel": "do-not-copy",
                    "roles": {"sonnet": "do-not-copy"}
                },
                "codex": {
                    "baseUrl": "https://codex.example.com/v1",
                    "authScheme": "bearer",
                    "proxyUserAgent": "codex-agent/1"
                }
            }"#,
        ),
        "UPDATE proxy_sessions SET display_name = 'Kept name', is_active = 0, last_seen_at = '2026-01-02T03:04:05Z'",
    );

    let db = cc_use_lib::db::Database::open_at(&path).unwrap();
    let restored = db
        .gateway_get(&gateway.session_token)
        .unwrap()
        .expect("gateway row survives");
    assert_eq!(restored.display_name, "Kept name");
    assert!(!restored.is_active);
    assert_eq!(restored.last_seen_at, "2026-01-02T03:04:05Z");
    assert_eq!(restored.provider_id, provider.id);
    assert_eq!(restored.api_key_id, key.id);
    assert_eq!(
        restored.connection_config.base_url.as_deref(),
        Some("https://legacy.example.com/api/v1")
    );
    assert_eq!(restored.connection_config.auth_scheme, "x-api-key");
    assert_eq!(
        restored.connection_config.user_agent.as_deref(),
        Some("legacy-agent/1")
    );
    // Model mapping / roles / startup parameters are never migrated.
    let mapping: String = db
        .conn
        .query_row(
            "SELECT model_mapping FROM api_keys WHERE id = ?1",
            [&key.id],
            |row| row.get(0),
        )
        .unwrap();
    assert!(mapping.contains("do-not-copy"));
    assert_eq!(raw_marker(&path).as_deref(), Some("1"));
    drop(db);
    cleanup_db(&path);
}

#[test]
fn gateway_connection_migration_does_not_overwrite_or_rerun() {
    use cc_use_lib::commands::gateways::gateway_create_inner;
    use support::{create_api_key, create_provider};

    let path = temp_db_path("gateway-idempotent");
    let db = cc_use_lib::db::Database::open_at(&path).unwrap();
    let provider = create_provider(&db, "gateway-provider", "custom");
    let key = create_api_key(&db, &provider.id, "claude_code");
    let gateway = gateway_create_inner(&db, "outlet", &provider.id, &key.id, None).unwrap();
    drop(db);

    // A non-NULL stored value is authoritative even without the marker (for
    // example a failed marker write or a hand-restored row).
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute(
        "UPDATE proxy_sessions SET gateway_connection_config = ?1 WHERE session_token = ?2",
        rusqlite::params![
            r#"{"baseUrl":null,"authScheme":"none","userAgent":null}"#,
            gateway.session_token
        ],
    )
    .unwrap();
    conn.execute(
        "DELETE FROM settings WHERE key = ?1",
        [GATEWAY_CONFIG_MARKER],
    )
    .unwrap();
    drop(conn);

    let db = cc_use_lib::db::Database::open_at(&path).unwrap();
    let restored = db.gateway_get(&gateway.session_token).unwrap().unwrap();
    assert_eq!(restored.connection_config.auth_scheme, "none");
    assert!(restored.connection_config.base_url.is_none());
    drop(db);

    // Re-running with the marker present changes nothing.
    let db = cc_use_lib::db::Database::open_at(&path).unwrap();
    let restored = db.gateway_get(&gateway.session_token).unwrap().unwrap();
    assert_eq!(restored.connection_config.auth_scheme, "none");
    drop(db);
    cleanup_db(&path);
}

#[test]
fn gateway_connection_migration_defaults_without_a_claude_code_config() {
    use cc_use_lib::commands::gateways::gateway_create_inner;
    use support::{create_api_key, create_provider};

    let path = temp_db_path("gateway-default");
    let db = cc_use_lib::db::Database::open_at(&path).unwrap();
    let provider = create_provider(&db, "gateway-provider", "custom");
    let key = create_api_key(&db, &provider.id, "claude_code");
    let gateway = gateway_create_inner(&db, "outlet", &provider.id, &key.id, None).unwrap();
    drop(db);
    simulate_legacy_gateway_row(&path, None, "");

    let db = cc_use_lib::db::Database::open_at(&path).unwrap();
    let restored = db.gateway_get(&gateway.session_token).unwrap().unwrap();
    assert_eq!(restored.connection_config.auth_scheme, "bearer");
    assert!(restored.connection_config.base_url.is_none());
    assert!(restored.connection_config.user_agent.is_none());
    drop(db);
    cleanup_db(&path);
}

#[test]
fn gateway_connection_migration_writes_its_marker_without_gateway_rows() {
    let path = temp_db_path("gateway-none");
    let db = cc_use_lib::db::Database::open_at(&path).unwrap();
    assert_eq!(db.gateway_list().unwrap().len(), 0);
    drop(db);
    assert_eq!(raw_marker(&path).as_deref(), Some("1"));
    // Re-running is a no-op on a new install as well.
    let db = cc_use_lib::db::Database::open_at(&path).unwrap();
    assert_eq!(db.gateway_list().unwrap().len(), 0);
    drop(db);
    cleanup_db(&path);
}

#[test]
fn non_gateway_sessions_keep_a_null_connection_config() {
    use support::create_proxy_session;

    let path = temp_db_path("gateway-nongateway");
    let db = cc_use_lib::db::Database::open_at(&path).unwrap();
    create_proxy_session(&db, "session-manual", "provider", "key", None);
    let session = db.proxy_session_get("session-manual").unwrap().unwrap();
    assert!(session.connection_config.is_none());
    assert!(raw_gateway_config(&path).is_none());
    drop(db);
    cleanup_db(&path);
}

#[test]
fn corrupt_client_configs_roll_back_the_migration_tx() {
    use cc_use_lib::commands::gateways::gateway_create_inner;
    use support::{create_api_key, create_provider};

    let path = temp_db_path("gateway-corrupt");
    let db = cc_use_lib::db::Database::open_at(&path).unwrap();
    let provider = create_provider(&db, "gateway-provider", "custom");
    let key = create_api_key(&db, &provider.id, "claude_code");
    let gateway = gateway_create_inner(&db, "outlet", &provider.id, &key.id, None).unwrap();
    drop(db);
    simulate_legacy_gateway_row(
        &path,
        Some(r#"{"claude_code": {"baseUrl": "SECRET-RAW-VALUE""#),
        "",
    );

    let error = cc_use_lib::db::Database::open_at(&path)
        .err()
        .expect("corrupt JSON must fail the migration");
    let message = error.to_string();
    assert!(
        !message.contains("SECRET-RAW-VALUE"),
        "database error must not echo raw stored JSON: {message}"
    );
    // Whole tx rolled back: column stays NULL and the marker was not written,
    // so a repaired database can retry on the next boot.
    assert!(raw_gateway_config(&path).is_none());
    assert!(raw_marker(&path).is_none());

    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute(
        "UPDATE api_keys SET client_configs = ?1",
        [r#"{"claude_code":{"baseUrl":"https://repaired.example.com","authScheme":"none"}}"#],
    )
    .unwrap();
    drop(conn);
    let db = cc_use_lib::db::Database::open_at(&path).unwrap();
    let restored = db.gateway_get(&gateway.session_token).unwrap().unwrap();
    assert_eq!(
        restored.connection_config.base_url.as_deref(),
        Some("https://repaired.example.com")
    );
    assert_eq!(restored.connection_config.auth_scheme, "none");
    drop(db);
    cleanup_db(&path);
}

#[tokio::test]
async fn invalid_historical_connection_values_survive_until_used() {
    use cc_use_lib::commands::gateways::gateway_create_inner;
    use support::{create_api_key, create_provider};

    let path = temp_db_path("gateway-invalid-history");
    let db = cc_use_lib::db::Database::open_at(&path).unwrap();
    let provider = create_provider(&db, "gateway-provider", "custom");
    let key = create_api_key(&db, &provider.id, "claude_code");
    let gateway = gateway_create_inner(&db, "outlet", &provider.id, &key.id, None).unwrap();
    drop(db);
    simulate_legacy_gateway_row(
        &path,
        Some(
            r#"{"claude_code":{"baseUrl":"not-a-real-url","authScheme":"x-api-key","proxyUserAgent":"bad\nagent"}}"#,
        ),
        "",
    );

    // The upgrade itself succeeds and keeps the values visible for repair.
    let db = cc_use_lib::db::Database::open_at(&path).unwrap();
    let restored = db.gateway_get(&gateway.session_token).unwrap().unwrap();
    assert_eq!(
        restored.connection_config.base_url.as_deref(),
        Some("not-a-real-url")
    );
    assert_eq!(
        restored.connection_config.user_agent.as_deref(),
        Some("bad\nagent")
    );

    // Explicitly re-saving the configuration validates and reports the field.
    let error = cc_use_lib::commands::gateways::gateway_update_inner(
        &db,
        &gateway.session_token,
        None,
        None,
        None,
        None,
        Some(&cc_use_lib::models::GatewayConnectionConfig {
            base_url: Some("not-a-real-url".to_string()),
            auth_scheme: "bearer".to_string(),
            user_agent: None,
        }),
    )
    .unwrap_err();
    assert!(error.contains("Base URL"));
    assert!(!error.contains("not-a-real-url"));

    // Using the connection fails with a locatable, non-echoing error.
    let state = support::build_proxy_state(db);
    let request = axum::http::Request::builder()
        .uri("/v1/messages")
        .method("POST")
        .header("authorization", format!("Bearer {}", gateway.session_token))
        .header("content-type", "application/json")
        .body(axum::body::Body::from(r#"{"model":"m"}"#))
        .unwrap();
    let response = cc_use_lib::proxy::handler::proxy_handler(axum::extract::State(state), request)
        .await
        .expect_err("invalid stored URL must be refused on use");
    assert_eq!(response.status(), axum::http::StatusCode::BAD_GATEWAY);
    let body = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    let message = String::from_utf8_lossy(&body);
    assert!(message.contains("Base URL"));
    assert!(!message.contains("not-a-real-url"));

    cleanup_db(&path);
}
