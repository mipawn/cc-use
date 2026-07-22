mod support;

use cc_use_lib::commands::managed_instances::{
    managed_instance_cleanup_inner, managed_instance_update_assignment_inner,
};
use cc_use_lib::models::UpdateManagedInstanceAssignmentInput;
use support::{
    create_api_key, create_managed_instance, create_provider, create_proxy_session, TempDb,
};

#[test]
fn assignment_rejects_a_key_from_another_cli_type() {
    let fixture = TempDb::new();
    let claude_provider = create_provider(&fixture.db, "Claude Provider", "claude_code");
    let claude_key = create_api_key(&fixture.db, &claude_provider.id, "claude_code");
    let grok_provider = create_provider(&fixture.db, "Grok Provider", "grok");
    let grok_key = create_api_key(&fixture.db, &grok_provider.id, "grok");
    create_proxy_session(
        &fixture.db,
        "session-claude",
        &claude_provider.id,
        &claude_key.id,
        None,
    );
    create_managed_instance(
        &fixture.db,
        "instance-claude",
        "session-claude",
        None,
        Some(&claude_provider.id),
        Some(&claude_key.id),
        "claude_code",
    );

    let error = managed_instance_update_assignment_inner(
        &fixture.db,
        &UpdateManagedInstanceAssignmentInput {
            id: "instance-claude".to_string(),
            provider_id: grok_provider.id,
            api_key_id: grok_key.id,
            assignment_source: Some("manual_ui".to_string()),
        },
    )
    .unwrap_err();

    assert!(error.contains("not compatible with claude_code"));
    let stored = fixture
        .db
        .managed_instance_get("instance-claude")
        .unwrap()
        .unwrap();
    assert_eq!(stored.api_key_id, Some(claude_key.id));
}

#[test]
fn assignment_accepts_legacy_claude_instance_type_for_claude_code_keys() {
    let fixture = TempDb::new();
    let provider = create_provider(&fixture.db, "Claude Provider", "claude_code");
    let first_key = create_api_key(&fixture.db, &provider.id, "claude_code");
    let next_key = create_api_key(&fixture.db, &provider.id, "claude_code");
    create_proxy_session(
        &fixture.db,
        "session-claude",
        &provider.id,
        &first_key.id,
        None,
    );
    create_managed_instance(
        &fixture.db,
        "instance-claude",
        "session-claude",
        None,
        Some(&provider.id),
        Some(&first_key.id),
        "claude",
    );

    let updated = managed_instance_update_assignment_inner(
        &fixture.db,
        &UpdateManagedInstanceAssignmentInput {
            id: "instance-claude".to_string(),
            provider_id: provider.id,
            api_key_id: next_key.id.clone(),
            assignment_source: Some("manual_ui".to_string()),
        },
    )
    .unwrap();

    assert_eq!(updated.api_key_id, Some(next_key.id));
}

#[test]
fn cleanup_only_removes_instances_for_the_requested_cli_type() {
    let fixture = TempDb::new();
    let provider = create_provider(&fixture.db, "Provider", "claude_code");
    let key = create_api_key(&fixture.db, &provider.id, "claude_code");

    for (id, token, cli_type) in [
        ("instance-claude", "session-claude", "claude"),
        ("instance-grok", "session-grok", "grok"),
    ] {
        create_proxy_session(&fixture.db, token, &provider.id, &key.id, None);
        create_managed_instance(
            &fixture.db,
            id,
            token,
            None,
            Some(&provider.id),
            Some(&key.id),
            cli_type,
        );
    }
    fixture
        .db
        .managed_instance_mark_stale_older_than("2027-01-01T00:00:00Z")
        .unwrap();

    managed_instance_cleanup_inner(&fixture.db, "claude_code").unwrap();

    assert!(fixture
        .db
        .managed_instance_get("instance-claude")
        .unwrap()
        .is_none());
    assert!(fixture
        .db
        .managed_instance_get("instance-grok")
        .unwrap()
        .is_some());
}
