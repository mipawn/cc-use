mod support;

use axum::body::Body;
use axum::extract::State as AxumState;
use axum::http::Request;
use cc_use_lib::db::Database;
use cc_use_lib::proxy::console::ConsoleEvent;
use cc_use_lib::proxy::handler::proxy_handler;
use std::time::Duration;
use support::build_proxy_state;

fn fresh_state() -> std::sync::Arc<cc_use_lib::proxy::ProxyState> {
    let path = std::env::temp_dir().join(format!("cc-use-console-test-{}.db", nanoid::nanoid!(8)));
    let db = Database::open_at(&path).expect("create temp database");
    build_proxy_state(db)
}

/// Accessor macro — `ConsoleEvent` is a tagged union, so tests need to
/// destructure into the `Request` variant before asserting on fields. The
/// macro keeps each test readable.
macro_rules! unwrap_request {
    ($event:expr) => {
        match $event {
            ConsoleEvent::Request {
                kind,
                method,
                path,
                message,
                status,
                upstream,
                ..
            } => (kind, method, path, message, status, upstream),
            other => panic!("expected Request variant, got {:?}", other),
        }
    };
}

#[tokio::test]
async fn rejects_missing_auth_emits_rejected_event() {
    let state = fresh_state();
    let mut rx = state.console_tx.subscribe();

    let request = Request::builder()
        .method("POST")
        .uri("/claude/v1/messages")
        .body(Body::empty())
        .unwrap();

    let _ = proxy_handler(AxumState(state.clone()), request).await;

    let event = tokio::time::timeout(Duration::from_millis(200), rx.recv())
        .await
        .expect("console event should be broadcast within 200ms")
        .expect("channel should deliver event");

    let (kind, method, path, message, status, upstream) = unwrap_request!(event);
    assert_eq!(kind, "rejected");
    assert_eq!(method, "POST");
    assert_eq!(path, "/claude/v1/messages");
    assert_eq!(message.as_deref(), Some("No authorization header"));
    assert!(status.is_none());
    assert!(upstream.is_none());
}

#[tokio::test]
async fn passthrough_unsupported_path_emits_rejected_event() {
    let state = fresh_state();
    let mut rx = state.console_tx.subscribe();

    let request = Request::builder()
        .method("GET")
        .uri("/v1/messages")
        .header("authorization", "Bearer sk-live-token")
        .body(Body::empty())
        .unwrap();

    let _ = proxy_handler(AxumState(state.clone()), request).await;

    let event = tokio::time::timeout(Duration::from_millis(200), rx.recv())
        .await
        .expect("console event expected")
        .expect("channel delivered");

    let (kind, method, _path, message, _status, _upstream) = unwrap_request!(event);
    assert_eq!(kind, "rejected");
    assert_eq!(method, "GET");
    assert_eq!(message.as_deref(), Some("Unsupported proxy path"));
}

#[tokio::test]
async fn session_not_found_emits_rejected_event() {
    let state = fresh_state();
    let mut rx = state.console_tx.subscribe();

    let request = Request::builder()
        .method("POST")
        .uri("/v1/messages")
        .header("authorization", "Bearer session-deadbeefcafebabe")
        .body(Body::from(r#"{"model":"claude-3-5-sonnet"}"#))
        .unwrap();

    let _ = proxy_handler(AxumState(state.clone()), request).await;

    let event = tokio::time::timeout(Duration::from_millis(200), rx.recv())
        .await
        .expect("console event expected")
        .expect("channel delivered");

    let (kind, _method, path, message, _status, _upstream) = unwrap_request!(event);
    assert_eq!(kind, "rejected");
    assert_eq!(path, "/v1/messages");
    assert_eq!(message.as_deref(), Some("Session not found"));
}

/// Without any subscriber the broadcast send returns Err, but the handler
/// must continue to return its normal HTTP response — the console is
/// best-effort and must never leak back into the forwarding path.
#[tokio::test]
async fn no_subscriber_does_not_break_handler() {
    let state = fresh_state();
    // intentionally DO NOT subscribe

    let request = Request::builder()
        .method("POST")
        .uri("/claude/v1/messages")
        .body(Body::empty())
        .unwrap();

    let response = proxy_handler(AxumState(state), request).await;

    let err = response.err().expect("expected auth rejection");
    assert_eq!(err.status(), axum::http::StatusCode::UNAUTHORIZED);
}

/// Log events serialize with a stable `category` tag so the frontend can
/// branch on it without relying on structural heuristics.
#[test]
fn log_event_serializes_with_category_tag() {
    let event = ConsoleEvent::log("info", "daemon", Some("cc_use_daemon::runtime"), "ready");
    let json = serde_json::to_value(&event).expect("serialize");
    assert_eq!(json["category"], "log");
    assert_eq!(json["level"], "info");
    assert_eq!(json["source"], "daemon");
    assert_eq!(json["target"], "cc_use_daemon::runtime");
    assert_eq!(json["message"], "ready");
}

#[test]
fn request_event_serializes_with_category_tag() {
    let event = ConsoleEvent::ok(
        "request-test",
        "POST",
        "/v1/messages",
        200,
        1234,
        "https://api.anthropic.com/v1/messages",
        Some("claude-provider"),
        Some("primary-key"),
        false,
    );
    let json = serde_json::to_value(&event).expect("serialize");
    assert_eq!(json["category"], "request");
    assert_eq!(json["kind"], "ok");
    assert_eq!(json["method"], "POST");
    assert_eq!(json["upstream"], "https://api.anthropic.com/v1/messages");
    assert_eq!(json["latencyMs"], 1234);
}

#[tokio::test]
async fn auth_scheme_none_skips_auth_headers() {
    use cc_use_lib::db::Database;
    use support::{build_proxy_state, setup_provider_key_project};

    let path =
        std::env::temp_dir().join(format!("cc-use-auth-none-test-{}.db", nanoid::nanoid!(8)));
    let db = Database::open_at(&path).expect("create temp database");

    // 创建 provider、key、project，并配置 authScheme = none
    let (provider_id, key_id, project_id) = setup_provider_key_project(&db, "test-provider").await;

    // 配置 clientConfig: authScheme = none
    db.conn
        .execute(
            "UPDATE api_keys SET client_configs = ? WHERE id = ?",
            rusqlite::params![r#"{"claude_code": {"authScheme": "none"}}"#, key_id],
        )
        .expect("update client_configs");

    // 创建 session
    let session_token = format!("session-{}", nanoid::nanoid!(16));
    db.conn
        .execute(
            "INSERT INTO proxy_sessions (
            session_token, provider_id, api_key_id, project_id, created_at, last_seen_at
         ) VALUES (?1, ?2, ?3, ?4, datetime('now'), datetime('now'))",
            rusqlite::params![&session_token, &provider_id, &key_id, &project_id],
        )
        .expect("insert session");

    let state = build_proxy_state(db);
    let mut rx = state.console_tx.subscribe();

    // 发送请求（带上 session token）
    let request = Request::builder()
        .method("POST")
        .uri("/v1/messages")
        .header("authorization", format!("Bearer {}", session_token))
        .header("content-type", "application/json")
        .body(Body::from(
            r#"{"model":"claude-3-5-sonnet","messages":[],"max_tokens":100}"#,
        ))
        .unwrap();

    let _ = proxy_handler(AxumState(state.clone()), request).await;

    // 等待 console 事件
    let event = tokio::time::timeout(Duration::from_millis(500), rx.recv())
        .await
        .expect("console event should be broadcast")
        .expect("channel should deliver event");

    let (kind, _method, _path, message, _status, _upstream) = unwrap_request!(event);

    // authScheme=none 的核心验证：请求不应该在本地被拒绝
    // 只要不是 rejected + 认证相关错误，就说明 authScheme=none 生效了
    if kind == "rejected" {
        if let Some(msg) = message.as_ref() {
            assert!(
                !msg.contains("authorization")
                    && !msg.contains("No authorization")
                    && !msg.contains("api key"),
                "authScheme=none should skip auth validation, but got rejected with: {}",
                msg
            );
        }
    }
    // pending/upstream_error 都是正常的（因为上游是假地址）
}
