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
fn recent_list_is_scoped_by_cli_type_and_includes_terminal_history() {
    let fixture = TempDb::new();
    let provider = create_provider(&fixture.db, "Provider", "claude_code");
    let api_key = create_api_key(&fixture.db, &provider.id, "claude_code");
    for (id, token, cli_type) in [
        (
            "instance-claude-running",
            "session-claude-running",
            "claude",
        ),
        (
            "instance-claude-stopped",
            "session-claude-stopped",
            "claude_code",
        ),
        ("instance-grok", "session-grok", "grok"),
    ] {
        create_proxy_session(&fixture.db, token, &provider.id, &api_key.id, None);
        create_managed_instance(
            &fixture.db,
            id,
            token,
            None,
            Some(&provider.id),
            Some(&api_key.id),
            cli_type,
        );
    }
    fixture
        .db
        .managed_instance_mark_stopped(
            "instance-claude-stopped",
            None,
            None,
            "stopped",
            Some("process_exit"),
            Some(0),
            "2026-04-14T16:05:00Z",
        )
        .unwrap();

    let claude = fixture
        .db
        .managed_instance_list_recent_for_cli_type("claude_code", 100)
        .unwrap();
    assert_eq!(claude.len(), 2);
    assert_eq!(claude[0].id, "instance-claude-running");
    assert_eq!(claude[1].id, "instance-claude-stopped");
    assert!(claude.iter().all(|instance| instance.cli_type != "grok"));
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
        .managed_instance_update_assignment_and_session(
            "instance-1",
            "session-1",
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
    assert_eq!(stored.api_key_id, Some(key_b.id.clone()));
    assert_eq!(stored.assignment_source, Some("manual_ui".to_string()));
    let session = fixture.db.proxy_session_get("session-1").unwrap().unwrap();
    assert_eq!(session.api_key_id, key_b.id);
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
            "running",
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

#[test]
fn terminal_instance_cannot_be_revived_by_a_late_heartbeat() {
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
        .managed_instance_mark_stopped(
            "instance-1",
            None,
            None,
            "stopped",
            Some("process_exit"),
            Some(0),
            "2026-04-14T16:05:00Z",
        )
        .unwrap();

    let changed = fixture
        .db
        .managed_instance_touch_heartbeat(
            "instance-1",
            Some(2001),
            Some(2002),
            "running",
            "2026-04-14T16:06:00Z",
        )
        .unwrap();

    assert!(!changed);
    let stored = fixture
        .db
        .managed_instance_get("instance-1")
        .unwrap()
        .unwrap();
    assert_eq!(stored.status, "stopped");
    assert_eq!(stored.stopped_at.as_deref(), Some("2026-04-14T16:05:00Z"));
}

#[test]
fn stale_instance_can_recover_but_launching_heartbeat_preserves_phase() {
    let fixture = TempDb::new();
    let provider = create_provider(&fixture.db, "Provider", "claude");
    let api_key = create_api_key(&fixture.db, &provider.id, "claude");
    create_proxy_session(&fixture.db, "session-1", &provider.id, &api_key.id, None);
    let mut instance = create_managed_instance(
        &fixture.db,
        "instance-running",
        "session-1",
        None,
        Some(&provider.id),
        Some(&api_key.id),
        "claude",
    );
    fixture
        .db
        .managed_instance_mark_stale_older_than("2026-04-14T16:01:00Z")
        .unwrap();
    fixture
        .db
        .managed_instance_touch_heartbeat(
            "instance-running",
            None,
            Some(2002),
            "running",
            "2026-04-14T16:02:00Z",
        )
        .unwrap();
    let recovered = fixture
        .db
        .managed_instance_get("instance-running")
        .unwrap()
        .unwrap();
    assert_eq!(recovered.status, "running");
    assert_eq!(recovered.stop_reason, None);

    create_proxy_session(&fixture.db, "session-2", &provider.id, &api_key.id, None);
    instance.id = "instance-launching".to_string();
    instance.session_token = "session-2".to_string();
    instance.status = "launching".to_string();
    instance.last_seen_at = "2026-04-14T16:00:00Z".to_string();
    fixture.db.managed_instance_create(&instance).unwrap();
    fixture
        .db
        .managed_instance_touch_heartbeat(
            "instance-launching",
            Some(3001),
            None,
            "launching",
            "2026-04-14T16:03:00Z",
        )
        .unwrap();
    let launching = fixture
        .db
        .managed_instance_get("instance-launching")
        .unwrap()
        .unwrap();
    assert_eq!(launching.status, "launching");
    assert_eq!(launching.last_seen_at, "2026-04-14T16:03:00Z");
}

#[test]
fn launch_and_stale_timeouts_use_terminal_timestamps_and_reasons() {
    let fixture = TempDb::new();
    let provider = create_provider(&fixture.db, "Provider", "claude");
    let api_key = create_api_key(&fixture.db, &provider.id, "claude");

    create_proxy_session(
        &fixture.db,
        "session-template",
        &provider.id,
        &api_key.id,
        None,
    );
    let mut launching = create_managed_instance(
        &fixture.db,
        "instance-template",
        "session-template",
        None,
        Some(&provider.id),
        Some(&api_key.id),
        "claude",
    );
    fixture
        .db
        .managed_instance_mark_stopped(
            "instance-template",
            None,
            None,
            "stopped",
            Some("test_cleanup"),
            None,
            "2026-04-14T16:00:01Z",
        )
        .unwrap();
    create_proxy_session(
        &fixture.db,
        "session-launch",
        &provider.id,
        &api_key.id,
        None,
    );
    launching.id = "instance-launch".to_string();
    launching.session_token = "session-launch".to_string();
    launching.status = "launching".to_string();
    launching.stopped_at = None;
    launching.stop_reason = None;
    fixture.db.managed_instance_create(&launching).unwrap();

    assert_eq!(
        fixture
            .db
            .managed_instance_fail_launching_older_than(
                "2026-04-14T16:01:00Z",
                "2026-04-14T16:02:00Z",
            )
            .unwrap(),
        1
    );
    let failed = fixture
        .db
        .managed_instance_get("instance-launch")
        .unwrap()
        .unwrap();
    assert_eq!(failed.status, "failed");
    assert_eq!(failed.stop_reason.as_deref(), Some("launch_timeout"));
    assert_eq!(failed.stopped_at.as_deref(), Some("2026-04-14T16:02:00Z"));

    create_proxy_session(
        &fixture.db,
        "session-stale",
        &provider.id,
        &api_key.id,
        None,
    );
    let stale = create_managed_instance(
        &fixture.db,
        "instance-stale",
        "session-stale",
        None,
        Some(&provider.id),
        Some(&api_key.id),
        "claude",
    );
    assert_eq!(stale.status, "running");
    fixture
        .db
        .managed_instance_mark_stale_older_than("2026-04-14T16:01:00Z")
        .unwrap();
    fixture
        .db
        .managed_instance_stop_stale_older_than("2026-04-14T16:01:00Z", "2026-04-14T16:03:00Z")
        .unwrap();
    let stopped = fixture
        .db
        .managed_instance_get("instance-stale")
        .unwrap()
        .unwrap();
    assert_eq!(stopped.status, "stopped");
    assert_eq!(stopped.stop_reason.as_deref(), Some("stale_timeout"));
    assert_eq!(stopped.stopped_at.as_deref(), Some("2026-04-14T16:03:00Z"));
}
