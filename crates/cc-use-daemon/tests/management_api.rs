use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Request, StatusCode};
use cc_use_daemon::management::DaemonState;
use cc_use_daemon::runtime::build_daemon_router;
use cc_use_lib::{
    db::Database,
    models::{CreateApiKeyInput, CreateProviderInput, ManagedInstance, ProxySession},
    proxy::build_proxy_state,
    services::console_log_store::{ConsoleLogHandle, ConsoleLogSource},
};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use tower::ServiceExt;

fn app_with_db() -> (axum::Router, Arc<Mutex<Database>>) {
    let path = std::env::temp_dir().join(format!("cc-use-daemon-test-{}.db", nanoid::nanoid!(8)));
    let db = Arc::new(Mutex::new(
        Database::open_at(&path).expect("create temp db"),
    ));
    let proxy_state = build_proxy_state(db.clone()).expect("build proxy state");
    let log_dir = std::env::temp_dir().join(format!("cc-use-daemon-logs-{}", nanoid::nanoid!(8)));
    let console_log = Arc::new(
        ConsoleLogHandle::spawn(log_dir, ConsoleLogSource::Daemon).expect("console log store"),
    );
    let app = build_daemon_router(DaemonState {
        db: db.clone(),
        proxy_state,
        console_log,
        management_token: "mgmt-test".to_string(),
    });
    (app, db)
}

fn app() -> axum::Router {
    app_with_db().0
}

/// Same router, but the caller keeps the console log store so it can assert on
/// what the daemon has written and cleared.
fn app_with_console_log() -> (axum::Router, Arc<ConsoleLogHandle>, std::path::PathBuf) {
    let path = std::env::temp_dir().join(format!("cc-use-daemon-test-{}.db", nanoid::nanoid!(8)));
    let db = Arc::new(Mutex::new(
        Database::open_at(&path).expect("create temp db"),
    ));
    let proxy_state = build_proxy_state(db.clone()).expect("build proxy state");
    let log_dir = std::env::temp_dir().join(format!("cc-use-daemon-logs-{}", nanoid::nanoid!(8)));
    let console_log = Arc::new(
        ConsoleLogHandle::spawn(log_dir.clone(), ConsoleLogSource::Daemon)
            .expect("console log store"),
    );
    let app = build_daemon_router(DaemonState {
        db,
        proxy_state,
        console_log: Arc::clone(&console_log),
        management_token: "mgmt-test".to_string(),
    });
    (app, console_log, log_dir)
}

fn seed_managed_instance(db: &Database) -> String {
    let provider = db
        .provider_create(&CreateProviderInput {
            request_headers: None,
            wallet_balance_script: None,
            name: "Managed Provider".to_string(),
            base_url: "https://example.com".to_string(),
            http_proxy: None,
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
            preset_id: None,
            default_key_config: None,
            request_adapter: None,
        })
        .expect("create provider");
    let api_key = db
        .api_key_create(&CreateApiKeyInput {
            usage_script: None,
            provider_id: provider.id.clone(),
            alias: Some("managed".to_string()),
            value: "sk-managed".to_string(),
            types: Some(vec!["claude".to_string()]),
            priority: Some(0),
            is_active: Some(true),
            config: None,
            usage_type: None,
            usage_url: None,
            usage_path: None,
            usage_headers: None,
            model_mapping: None,
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
        session_kind: "managed".to_string(),
        last_seen_at: "2026-04-14T16:00:00Z".to_string(),
        expires_at: None,
        revoked_at: None,
        revoked_reason: None,
        cli_type: None,
        display_name: None,
        is_active: true,
        connection_config: None,
        model_policy: None,
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
async fn launching_heartbeat_preserves_launching_until_the_cli_starts() {
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
                    r#"{{"instanceId":"{}","shellPid":123,"phase":"launching"}}"#,
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
    assert_eq!(instance.status, "launching");
    assert_eq!(instance.shell_pid, Some(123));
    assert_eq!(instance.process_pid, None);
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
    let session = db
        .proxy_session_get(&instance.session_token)
        .expect("query session")
        .expect("session exists");
    assert!(session.revoked_at.is_some());
    assert_eq!(session.revoked_reason.as_deref(), Some("stopped"));
}

#[tokio::test]
async fn terminal_instances_ignore_late_heartbeats_and_duplicate_stop_events() {
    let (app, db) = app_with_db();
    let instance_id = {
        let db = db.lock().expect("lock db");
        seed_managed_instance(&db)
    };
    let stop_body = format!(
        r#"{{"instanceId":"{}","stopReason":"prelaunch_failed","exitCode":2}}"#,
        instance_id
    );

    let stop_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/_management/instances/stop")
                .header("x-cc-use-management-token", "mgmt-test")
                .header("content-type", "application/json")
                .body(Body::from(stop_body.clone()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(stop_response.status(), StatusCode::OK);

    let duplicate_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/_management/instances/stop")
                .header("x-cc-use-management-token", "mgmt-test")
                .header("content-type", "application/json")
                .body(Body::from(stop_body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(duplicate_response.status(), StatusCode::OK);

    let heartbeat_response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/_management/instances/heartbeat")
                .header("x-cc-use-management-token", "mgmt-test")
                .header("content-type", "application/json")
                .body(Body::from(format!(
                    r#"{{"instanceId":"{}","phase":"running"}}"#,
                    instance_id
                )))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(heartbeat_response.status(), StatusCode::CONFLICT);

    let db = db.lock().expect("lock db");
    let instance = db
        .managed_instance_get(&instance_id)
        .expect("query instance")
        .expect("instance exists");
    assert_eq!(instance.status, "failed");
    assert_eq!(instance.stop_reason.as_deref(), Some("prelaunch_failed"));
    assert_eq!(instance.exit_code, Some(2));
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

/// Clearing the console must authenticate like every other management route.
#[tokio::test]
async fn console_clear_requires_the_management_token() {
    let response = app()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/_management/console/clear")
                .header("x-cc-use-management-token", "wrong-token")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

/// The GUI clears its own files and asks the daemon to clear its own; only the
/// owning process may remove a file that is still being appended to.
#[tokio::test]
async fn console_clear_drops_the_daemons_own_history() {
    use cc_use_lib::services::console_log_store::read_recent;

    let (app, console_log, log_dir) = app_with_console_log();
    console_log.record(cc_use_lib::proxy::console::ConsoleEvent::log(
        "info",
        "daemon",
        Some("cc_use_daemon::runtime"),
        "before clear",
    ));
    console_log
        .flush_and_wait(std::time::Duration::from_secs(5))
        .expect("flush ack");
    assert_eq!(
        read_recent(&log_dir, &[ConsoleLogSource::Daemon], 10)
            .records
            .len(),
        1,
        "the daemon records its own history"
    );

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/_management/console/clear")
                .header("x-cc-use-management-token", "mgmt-test")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    // A 200 is a real acknowledgement: the files are already gone when the
    // response arrives, so a caller may re-read immediately.
    let after = read_recent(&log_dir, &[ConsoleLogSource::Daemon], 10);
    assert!(
        after.records.is_empty(),
        "cleared history does not come back"
    );
}

/// The status route reports the daemon's own per-owner counters, not a bare
/// legacy total, and it keeps the management token gate.
#[tokio::test]
async fn console_log_status_reports_per_owner_counters() {
    let (app, console_log, _log_dir) = app_with_console_log();
    console_log.record(cc_use_lib::proxy::console::ConsoleEvent::log(
        "info",
        "daemon",
        Some("cc_use_daemon::runtime"),
        "status seed",
    ));
    console_log
        .flush_and_wait(std::time::Duration::from_secs(5))
        .expect("flush ack");

    let read = |app: axum::Router, token: &'static str| async move {
        app.oneshot(
            Request::builder()
                .uri("/_management/console/log-status")
                .header("x-cc-use-management-token", token)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
    };

    let unauthorized = read(app.clone(), "wrong-token").await;
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

    let response = read(app, "mgmt-test").await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), 4096)
        .await
        .unwrap();
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["available"], serde_json::json!(true));
    assert_eq!(value["dropped"], serde_json::json!(0));
    assert_eq!(value["writeFailed"], serde_json::json!(0));
    assert_eq!(value["trimmed"], serde_json::json!(0));
    assert_eq!(value["capacityEvicted"], serde_json::json!(false));
}

/// A clear only answers after the new generation is on disk, and two clears
/// never lose each other's generation update.
#[tokio::test]
async fn console_clear_acks_the_real_generation_change() {
    let (app, console_log, log_dir) = app_with_console_log();

    let clear = |app: axum::Router| async move {
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/_management/console/clear")
                    .header("x-cc-use-management-token", "mgmt-test")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        serde_json::from_slice::<serde_json::Value>(&body).unwrap()
    };

    let first = clear(app.clone()).await;
    let second = clear(app).await;
    let first_generation = first["generation"].as_str().expect("generation");
    let second_generation = second["generation"].as_str().expect("generation");
    assert!(!first_generation.is_empty());
    assert_ne!(
        first_generation, second_generation,
        "each clear advances the generation; a concurrent write cannot drop it"
    );
    let page = cc_use_lib::services::console_log_store::read_recent(
        &log_dir,
        &[ConsoleLogSource::Daemon],
        10,
    );
    assert_eq!(page.generation, second_generation);
    let _ = console_log;
}

/// The GUI reads this back after a reload: the flag lives in the daemon, so
/// assuming it is off would show the wrong switch position.
#[tokio::test]
async fn console_detail_mode_can_be_read_back() {
    let (app, _console_log, _dir) = app_with_console_log();

    let read = |app: axum::Router| async move {
        app.oneshot(
            Request::builder()
                .uri("/_management/console/detail-mode")
                .header("x-cc-use-management-token", "mgmt-test")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
    };

    let response = read(app.clone()).await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), 4096)
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&body).unwrap()["enabled"],
        serde_json::json!(false)
    );

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/_management/console/detail-mode")
                .header("x-cc-use-management-token", "mgmt-test")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"enabled":true}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let response = read(app).await;
    let body = axum::body::to_bytes(response.into_body(), 4096)
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&body).unwrap()["enabled"],
        serde_json::json!(true)
    );
}

// ── R8: the management plane stays loopback-only when the proxy opens to LAN ──

fn with_peer(mut request: Request<Body>, peer: SocketAddr) -> Request<Body> {
    request.extensions_mut().insert(ConnectInfo(peer));
    request
}

fn lan_peer() -> SocketAddr {
    SocketAddr::from(([192, 168, 1, 50], 51234))
}

fn loopback_peer() -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], 51234))
}

fn management_request(
    method: &str,
    uri: &str,
    peer: Option<SocketAddr>,
    body: Option<&str>,
) -> Request<Body> {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header("x-cc-use-management-token", "mgmt-test");
    if body.is_some() {
        builder = builder.header("content-type", "application/json");
    }
    let request = builder
        .body(
            body.map(|json| Body::from(json.to_string()))
                .unwrap_or_else(Body::empty),
        )
        .unwrap();
    match peer {
        Some(peer) => with_peer(request, peer),
        None => request,
    }
}

/// T24/A19: every `/_management/*` surface must answer 403 for a LAN peer even
/// when the request carries the real management token. This is independent of
/// the proxy listen scope — the daemon can bind `0.0.0.0` for the gateway while
/// keeping the management plane loopback-only.
#[tokio::test]
async fn management_routes_reject_non_loopback_peers_on_every_surface() {
    let app = app();
    let peer = lan_peer();
    let surfaces = [
        ("GET", "/_management/health", None),
        ("GET", "/_management/console/detail-mode", None),
        (
            "POST",
            "/_management/console/detail-mode",
            Some(r#"{"enabled":true}"#),
        ),
        ("GET", "/_management/console/log-status", None),
        ("POST", "/_management/console/clear", None),
        ("GET", "/_management/console/stream", None),
        (
            "POST",
            "/_management/instances/heartbeat",
            Some(r#"{"instanceId":"instance-managed"}"#),
        ),
        (
            "POST",
            "/_management/instances/stop",
            Some(r#"{"instanceId":"instance-managed"}"#),
        ),
    ];

    for (method, uri, body) in surfaces {
        let response = app
            .clone()
            .oneshot(management_request(method, uri, Some(peer), body))
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::FORBIDDEN,
            "{} {} must be 403 for a non-loopback peer",
            method,
            uri
        );
        let bytes = axum::body::to_bytes(response.into_body(), 8192)
            .await
            .unwrap();
        let text = String::from_utf8_lossy(&bytes);
        assert!(
            text.contains("loopback"),
            "{} {} must explain the loopback restriction, got {:?}",
            method,
            uri,
            text
        );
        assert!(
            !text.contains("mgmt-test"),
            "{} {} must never echo the management token",
            method,
            uri
        );
    }
}

/// The 403 happens before token validation, so a LAN peer cannot even probe
/// whether it guessed the management token.
#[tokio::test]
async fn non_loopback_peer_cannot_probe_the_management_token() {
    let mut request = management_request("GET", "/_management/health", None, None);
    request
        .headers_mut()
        .insert("x-cc-use-management-token", "wrong-token".parse().unwrap());
    let response = app().oneshot(with_peer(request, lan_peer())).await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

/// IPv6 is treated by the peer check too: `::1` is loopback, any other address
/// is not.
#[tokio::test]
async fn non_loopback_ipv6_peer_is_rejected_and_ipv6_loopback_is_allowed() {
    let ipv6_loopback = SocketAddr::from((std::net::Ipv6Addr::LOCALHOST, 51234));
    let response = app()
        .oneshot(management_request(
            "GET",
            "/_management/health",
            Some(ipv6_loopback),
            None,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let ipv6_lan = SocketAddr::from((
        std::net::Ipv6Addr::new(0x2001, 0x0db8, 0, 0, 0, 0, 0, 5),
        51234,
    ));
    let response = app()
        .oneshot(management_request(
            "GET",
            "/_management/health",
            Some(ipv6_lan),
            None,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

/// T24: loopback peers keep the historical behaviour on every surface.
#[tokio::test]
async fn management_routes_accept_loopback_peers() {
    let app = app();
    let peer = loopback_peer();

    let response = app
        .clone()
        .oneshot(management_request(
            "GET",
            "/_management/health",
            Some(peer),
            None,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let response = app
        .clone()
        .oneshot(management_request(
            "GET",
            "/_management/console/log-status",
            Some(peer),
            None,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let response = app
        .clone()
        .oneshot(management_request(
            "POST",
            "/_management/console/detail-mode",
            Some(peer),
            Some(r#"{"enabled":false}"#),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let response = app
        .clone()
        .oneshot(management_request(
            "GET",
            "/_management/console/stream",
            Some(peer),
            None,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    assert!(
        content_type.starts_with("text/event-stream"),
        "loopback SSE must stay available, got {:?}",
        content_type
    );

    let response = app
        .oneshot(management_request(
            "POST",
            "/_management/console/clear",
            Some(peer),
            None,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

/// The trusted case for in-process use: only the production listener installs
/// `ConnectInfo` (via `into_make_service_with_connect_info`), so a router driven
/// directly by `oneshot` has no peer address. That must keep working for the
/// existing tests; a real LAN client always has the extension and gets 403.
#[tokio::test]
async fn management_routes_treat_missing_connect_info_as_trusted_in_process() {
    let response = app()
        .oneshot(management_request("GET", "/_management/health", None, None))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}
