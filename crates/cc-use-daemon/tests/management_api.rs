use axum::body::Body;
use axum::http::{Request, StatusCode};
use cc_use_daemon::management::DaemonState;
use cc_use_daemon::runtime::build_daemon_router;
use cc_use_lib::{
    db::Database,
    models::{CreateApiKeyInput, CreateProviderInput, ManagedInstance, ProxySession},
    proxy::build_proxy_state,
};
use std::sync::{Arc, Mutex};
use tower::ServiceExt;

fn app_with_db() -> (axum::Router, Arc<Mutex<Database>>) {
    let path = std::env::temp_dir().join(format!("cc-use-daemon-test-{}.db", nanoid::nanoid!(8)));
    let db = Arc::new(Mutex::new(
        Database::open_at(&path).expect("create temp db"),
    ));
    let proxy_state = build_proxy_state(db.clone()).expect("build proxy state");
    let app = build_daemon_router(DaemonState {
        db: db.clone(),
        proxy_state,
        management_token: "mgmt-test".to_string(),
    });
    (app, db)
}

fn app() -> axum::Router {
    app_with_db().0
}

fn seed_managed_instance(db: &Database) -> String {
    let provider = db
        .provider_create(&CreateProviderInput {
            name: "Managed Provider".to_string(),
            base_url: "https://example.com".to_string(),
            provider_type: Some("claude".to_string()),
            website: None,
            remark: None,
            token: None,
            icon: None,
            wallet_balance_type: None,
            wallet_balance_url: None,
            wallet_balance_path: None,
            wallet_balance_headers: None,
            wallet_balance_user_id: None,
            usage_type: None,
            usage_url: None,
            usage_path: None,
            usage_headers: None,
            api_format: None,
            transform_enabled: None,
        })
        .expect("create provider");
    let api_key = db
        .api_key_create(&CreateApiKeyInput {
            provider_id: provider.id.clone(),
            alias: Some("managed".to_string()),
            value: "sk-managed".to_string(),
            types: Some(vec!["claude".to_string()]),
            priority: Some(0),
            is_active: Some(true),
            config: None,
            cost_multiplier: None,
            usage_type: None,
            usage_url: None,
            usage_path: None,
            usage_headers: None,
            model_mapping: None,
            api_format: None,
            transform_enabled: None,
            client_configs: None,
        })
        .expect("create api key");
    let session_token = "session-managed".to_string();
    db.proxy_session_create(&ProxySession {
        session_token: session_token.clone(),
        provider_id: provider.id.clone(),
        api_key_id: api_key.id.clone(),
        project_id: None,
        created_at: "2026-04-14T16:00:00Z".to_string(),
        cli_type: None,
    })
    .expect("create proxy session");
    let instance_id = "instance-managed".to_string();
    db.managed_instance_create(&ManagedInstance {
        id: instance_id.clone(),
        session_token,
        project_id: None,
        provider_id: Some(provider.id),
        api_key_id: Some(api_key.id),
        cli_type: "claude".to_string(),
        terminal_type: "terminal".to_string(),
        project_path: "/tmp/project-1".to_string(),
        shell_pid: None,
        process_pid: None,
        status: "launching".to_string(),
        assignment_source: Some("project_launch".to_string()),
        last_seen_at: "2026-04-14T16:00:00Z".to_string(),
        launched_at: "2026-04-14T16:00:00Z".to_string(),
        stopped_at: None,
        stop_reason: None,
        exit_code: None,
    })
    .expect("create managed instance");
    instance_id
}

#[tokio::test]
async fn rejects_management_request_without_token() {
    let response = app()
        .oneshot(
            Request::builder()
                .uri("/_management/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn rejects_management_request_with_wrong_token() {
    let response = app()
        .oneshot(
            Request::builder()
                .uri("/_management/health")
                .header("x-cc-use-management-token", "wrong-token")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn accepts_management_request_with_token() {
    let response = app()
        .oneshot(
            Request::builder()
                .uri("/_management/health")
                .header("x-cc-use-management-token", "mgmt-test")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn proxy_path_without_auth_is_still_rejected() {
    let response = app()
        .oneshot(
            Request::builder()
                .uri("/claude/v1/messages")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn heartbeat_updates_managed_instance_status_and_pids() {
    let (app, db) = app_with_db();
    let instance_id = {
        let db = db.lock().expect("lock db");
        seed_managed_instance(&db)
    };

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/_management/instances/heartbeat")
                .header("x-cc-use-management-token", "mgmt-test")
                .header("content-type", "application/json")
                .body(Body::from(format!(
                    r#"{{"instanceId":"{}","shellPid":123,"processPid":456}}"#,
                    instance_id
                )))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let db = db.lock().expect("lock db");
    let instance = db
        .managed_instance_get(&instance_id)
        .expect("query instance")
        .expect("instance exists");
    assert_eq!(instance.status, "running");
    assert_eq!(instance.shell_pid, Some(123));
    assert_eq!(instance.process_pid, Some(456));
}

#[tokio::test]
async fn stop_marks_managed_instance_as_stopped() {
    let (app, db) = app_with_db();
    let instance_id = {
        let db = db.lock().expect("lock db");
        seed_managed_instance(&db)
    };

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/_management/instances/stop")
                .header("x-cc-use-management-token", "mgmt-test")
                .header("content-type", "application/json")
                .body(Body::from(format!(
                    r#"{{"instanceId":"{}","shellPid":123,"processPid":456,"stopReason":"process_exit","exitCode":0}}"#,
                    instance_id
                )))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let db = db.lock().expect("lock db");
    let instance = db
        .managed_instance_get(&instance_id)
        .expect("query instance")
        .expect("instance exists");
    assert_eq!(instance.status, "stopped");
    assert_eq!(instance.stop_reason, Some("process_exit".to_string()));
    assert_eq!(instance.exit_code, Some(0));
}

/// The console SSE endpoint must require the same management token auth
/// as the other `/_management/*` routes — nobody on localhost should be
/// able to tap the live proxy traffic without proving they're us.
#[tokio::test]
async fn console_stream_rejects_without_token() {
    let response = app()
        .oneshot(
            Request::builder()
                .uri("/_management/console/stream")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn console_stream_rejects_with_wrong_token() {
    let response = app()
        .oneshot(
            Request::builder()
                .uri("/_management/console/stream")
                .header("x-cc-use-management-token", "wrong-token")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn console_stream_accepts_with_token_and_returns_sse_content_type() {
    let response = app()
        .oneshot(
            Request::builder()
                .uri("/_management/console/stream")
                .header("x-cc-use-management-token", "mgmt-test")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    assert!(
        content_type.starts_with("text/event-stream"),
        "expected text/event-stream content-type, got {:?}",
        content_type
    );
}
