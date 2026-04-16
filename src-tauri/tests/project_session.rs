use cc_use_lib::shared_runtime::{
    plan_project_session, ExistingProjectSession, PlanProjectSessionError, ProjectSessionContext,
    ProjectSessionOverrides, ProjectSessionPlan,
};

fn sample_context() -> ProjectSessionContext {
    ProjectSessionContext {
        project_id: "project-1".to_string(),
        provider_id: Some("provider-a".to_string()),
        api_key_id: Some("key-a".to_string()),
    }
}

#[test]
fn plan_project_session_reuses_existing_matching_session() {
    let plan = plan_project_session(
        &sample_context(),
        ProjectSessionOverrides::default(),
        &[ExistingProjectSession {
            session_token: "session-existing".to_string(),
            project_id: Some("project-1".to_string()),
            provider_id: "provider-a".to_string(),
            api_key_id: "key-a".to_string(),
        }],
        || "session-new".to_string(),
    )
    .unwrap();

    assert_eq!(
        plan,
        ProjectSessionPlan::Reuse {
            session_token: "session-existing".to_string(),
            provider_id: "provider-a".to_string(),
            api_key_id: "key-a".to_string(),
        }
    );
}

#[test]
fn plan_project_session_creates_project_session_when_missing() {
    let plan = plan_project_session(
        &sample_context(),
        ProjectSessionOverrides::default(),
        &[],
        || "session-new".to_string(),
    )
    .unwrap();

    assert_eq!(
        plan,
        ProjectSessionPlan::Create {
            session_token: "session-new".to_string(),
            project_id: "project-1".to_string(),
            provider_id: "provider-a".to_string(),
            api_key_id: "key-a".to_string(),
        }
    );
}

#[test]
fn plan_project_session_prefers_overrides_over_project_defaults() {
    let plan = plan_project_session(
        &sample_context(),
        ProjectSessionOverrides {
            provider_id: Some("provider-b".to_string()),
            api_key_id: Some("key-b".to_string()),
        },
        &[],
        || "session-new".to_string(),
    )
    .unwrap();

    assert_eq!(
        plan,
        ProjectSessionPlan::Create {
            session_token: "session-new".to_string(),
            project_id: "project-1".to_string(),
            provider_id: "provider-b".to_string(),
            api_key_id: "key-b".to_string(),
        }
    );
}

#[test]
fn plan_project_session_ignores_sessions_from_other_projects() {
    let plan = plan_project_session(
        &sample_context(),
        ProjectSessionOverrides::default(),
        &[ExistingProjectSession {
            session_token: "session-other-project".to_string(),
            project_id: Some("project-2".to_string()),
            provider_id: "provider-a".to_string(),
            api_key_id: "key-a".to_string(),
        }],
        || "session-new".to_string(),
    )
    .unwrap();

    assert_eq!(
        plan,
        ProjectSessionPlan::Create {
            session_token: "session-new".to_string(),
            project_id: "project-1".to_string(),
            provider_id: "provider-a".to_string(),
            api_key_id: "key-a".to_string(),
        }
    );
}

#[test]
fn plan_project_session_errors_when_provider_or_api_key_missing() {
    let missing_provider = plan_project_session(
        &ProjectSessionContext {
            project_id: "project-1".to_string(),
            provider_id: None,
            api_key_id: Some("key-a".to_string()),
        },
        ProjectSessionOverrides::default(),
        &[],
        || "session-new".to_string(),
    )
    .unwrap_err();
    assert_eq!(missing_provider, PlanProjectSessionError::MissingProvider);

    let missing_api_key = plan_project_session(
        &ProjectSessionContext {
            project_id: "project-1".to_string(),
            provider_id: Some("provider-a".to_string()),
            api_key_id: None,
        },
        ProjectSessionOverrides::default(),
        &[],
        || "session-new".to_string(),
    )
    .unwrap_err();
    assert_eq!(missing_api_key, PlanProjectSessionError::MissingApiKey);
}
