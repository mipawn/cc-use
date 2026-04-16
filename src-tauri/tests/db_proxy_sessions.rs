mod support;

use support::{create_proxy_session, TempDb};

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
