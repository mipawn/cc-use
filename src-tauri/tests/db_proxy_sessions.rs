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
