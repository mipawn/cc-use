mod support;

use support::{
    create_api_key, create_managed_instance, create_project, create_provider, create_proxy_session,
    TempDb,
};

#[test]
fn managed_instance_round_trip_and_active_list() {
    let fixture = TempDb::new();
    let provider = create_provider(&fixture.db, "Provider", "claude");
    let api_key = create_api_key(&fixture.db, &provider.id, "claude");
    let project = create_project(
        &fixture.db,
        Some(provider.id.clone()),
        Some(api_key.id.clone()),
        "claude",
    );
    create_proxy_session(
        &fixture.db,
        "session-1",
        &provider.id,
        &api_key.id,
        Some(&project.id),
    );

    create_managed_instance(
        &fixture.db,
        "instance-1",
        "session-1",
        Some(&project.id),
        Some(&provider.id),
        Some(&api_key.id),
        "claude",
    );

    let stored = fixture
        .db
        .managed_instance_get("instance-1")
        .unwrap()
        .unwrap();
    assert_eq!(stored.session_token, "session-1");
    assert_eq!(stored.status, "running");
    assert_eq!(stored.project_id, Some(project.id.clone()));

    let active = fixture.db.managed_instance_list_active().unwrap();
    assert_eq!(active.len(), 1);
    assert_eq!(active[0].id, "instance-1");
}

#[test]
fn managed_instance_update_assignment_updates_provider_and_key() {
    let fixture = TempDb::new();
    let provider_a = create_provider(&fixture.db, "Provider A", "claude");
    let key_a = create_api_key(&fixture.db, &provider_a.id, "claude");
    let provider_b = create_provider(&fixture.db, "Provider B", "claude");
    let key_b = create_api_key(&fixture.db, &provider_b.id, "claude");
    create_proxy_session(&fixture.db, "session-1", &provider_a.id, &key_a.id, None);
    create_managed_instance(
        &fixture.db,
        "instance-1",
        "session-1",
        None,
        Some(&provider_a.id),
        Some(&key_a.id),
        "claude",
    );

    let changed = fixture
        .db
        .managed_instance_update_assignment(
            "instance-1",
            &provider_b.id,
            &key_b.id,
            Some("manual_ui"),
        )
        .unwrap();
    assert!(changed);

    let stored = fixture
        .db
        .managed_instance_get("instance-1")
        .unwrap()
        .unwrap();
    assert_eq!(stored.provider_id, Some(provider_b.id));
    assert_eq!(stored.api_key_id, Some(key_b.id));
    assert_eq!(stored.assignment_source, Some("manual_ui".to_string()));
}

#[test]
fn managed_instance_heartbeat_and_stop_update_lifecycle_fields() {
    let fixture = TempDb::new();
    let provider = create_provider(&fixture.db, "Provider", "claude");
    let api_key = create_api_key(&fixture.db, &provider.id, "claude");
    create_proxy_session(&fixture.db, "session-1", &provider.id, &api_key.id, None);
    create_managed_instance(
        &fixture.db,
        "instance-1",
        "session-1",
        None,
        Some(&provider.id),
        Some(&api_key.id),
        "claude",
    );

    fixture
        .db
        .managed_instance_touch_heartbeat(
            "instance-1",
            Some(2001),
            Some(2002),
            "2026-04-14T16:05:00Z",
        )
        .unwrap();
    let running = fixture
        .db
        .managed_instance_get("instance-1")
        .unwrap()
        .unwrap();
    assert_eq!(running.shell_pid, Some(2001));
    assert_eq!(running.process_pid, Some(2002));
    assert_eq!(running.status, "running");
    assert_eq!(running.last_seen_at, "2026-04-14T16:05:00Z");

    fixture
        .db
        .managed_instance_mark_stopped(
            "instance-1",
            Some(2001),
            Some(2002),
            "stopped",
            Some("process_exit"),
            Some(0),
            "2026-04-14T16:06:00Z",
        )
        .unwrap();
    let stopped = fixture
        .db
        .managed_instance_get("instance-1")
        .unwrap()
        .unwrap();
    assert_eq!(stopped.status, "stopped");
    assert_eq!(stopped.stop_reason, Some("process_exit".to_string()));
    assert_eq!(stopped.exit_code, Some(0));
    assert_eq!(stopped.stopped_at, Some("2026-04-14T16:06:00Z".to_string()));
}

#[test]
fn managed_instance_mark_stale_only_affects_running_records() {
    let fixture = TempDb::new();
    let provider = create_provider(&fixture.db, "Provider", "claude");
    let api_key = create_api_key(&fixture.db, &provider.id, "claude");
    create_proxy_session(
        &fixture.db,
        "session-running",
        &provider.id,
        &api_key.id,
        None,
    );
    create_proxy_session(
        &fixture.db,
        "session-stopped",
        &provider.id,
        &api_key.id,
        None,
    );

    create_managed_instance(
        &fixture.db,
        "instance-running",
        "session-running",
        None,
        Some(&provider.id),
        Some(&api_key.id),
        "claude",
    );
    create_managed_instance(
        &fixture.db,
        "instance-stopped",
        "session-stopped",
        None,
        Some(&provider.id),
        Some(&api_key.id),
        "claude",
    );

    fixture
        .db
        .managed_instance_mark_stopped(
            "instance-stopped",
            None,
            None,
            "stopped",
            Some("process_exit"),
            Some(0),
            "2026-04-14T16:02:00Z",
        )
        .unwrap();

    let changed = fixture
        .db
        .managed_instance_mark_stale_older_than("2026-04-14T16:10:00Z")
        .unwrap();
    assert_eq!(changed, 1);

    let running = fixture
        .db
        .managed_instance_get("instance-running")
        .unwrap()
        .unwrap();
    let stopped = fixture
        .db
        .managed_instance_get("instance-stopped")
        .unwrap()
        .unwrap();
    assert_eq!(running.status, "stale");
    assert_eq!(running.stop_reason, Some("heartbeat_timeout".to_string()));
    assert_eq!(stopped.status, "stopped");
}
