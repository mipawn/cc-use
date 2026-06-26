mod support;

use axum::body::Body;
use axum::extract::State as AxumState;
use axum::http::{Request, StatusCode};
use cc_use_lib::db::Database;
use cc_use_lib::proxy::handler::{error_response, proxy_handler};
use support::build_proxy_state;

fn create_proxy_state() -> std::sync::Arc<cc_use_lib::proxy::ProxyState> {
    let path = std::env::temp_dir().join(format!("cc-use-proxy-auth-{}.db", nanoid::nanoid!(8)));
    let db = Database::open_at(&path).expect("create temp database");
    build_proxy_state(db)
}

#[test]
fn error_response_does_not_panic() {
    let response = error_response(StatusCode::BAD_REQUEST, "test error");
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[test]
fn error_response_contains_json_body() {
    let response = error_response(StatusCode::NOT_FOUND, "not found");
    assert_eq!(
        response
            .headers()
            .get("content-type")
            .unwrap()
            .to_str()
            .unwrap(),
        "application/json",
    );
}

#[test]
fn error_response_various_status_codes() {
    for status in [
        StatusCode::UNAUTHORIZED,
        StatusCode::INTERNAL_SERVER_ERROR,
        StatusCode::BAD_GATEWAY,
    ] {
        let response = error_response(status, "msg");
        assert_eq!(response.status(), status);
    }
}

#[tokio::test]
async fn rejects_missing_authorization() {
    let state = create_proxy_state();
    let request = Request::builder()
        .uri("/claude/v1/messages")
        .body(Body::empty())
        .unwrap();

    let response = proxy_handler(AxumState(state), request).await.unwrap_err();

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn accepts_non_session_token_for_passthrough_path() {
    let state = create_proxy_state();
    let request = Request::builder()
        .uri("/claude/v1/messages")
        .header("authorization", "Bearer sk-live-token")
        .body(Body::from(r#"{"model":"claude-3-5-sonnet"}"#))
        .unwrap();

    let response = proxy_handler(AxumState(state), request).await;

    assert!(response.is_ok() || response.unwrap_err().status() != StatusCode::UNAUTHORIZED);
}

/// Regression: Claude Code CLI uses ANTHROPIC_BASE_URL without any path
/// prefix, so the request lands on the proxy as `/v1/messages`, not
/// `/claude/v1/messages`. Earlier builds rejected these with 404 before
/// routing could even inspect the session token, which the CLI surfaced
/// as a cryptic "selected model may not exist". The handler must now
/// only apply path-based family inference inside PassThrough.
#[tokio::test]
async fn session_routed_request_without_claude_prefix_is_not_404() {
    let state = create_proxy_state();
    let request = Request::builder()
        .uri("/v1/messages")
        .header("authorization", "Bearer session-deadbeefcafebabe")
        .body(Body::from(r#"{"model":"claude-3-5-sonnet"}"#))
        .unwrap();

    let response = proxy_handler(AxumState(state), request).await;

    // The session does not exist in this empty DB, so we expect a 401
    // from resolve_session_resources — NOT a 404 "Unsupported proxy path".
    match response {
        Ok(_) => panic!("unexpected success on an empty-DB session lookup"),
        Err(resp) => assert_ne!(
            resp.status(),
            StatusCode::NOT_FOUND,
            "session-routed request with bare /v1 path should not 404"
        ),
    }
}

#[tokio::test]
async fn lowercase_bearer_session_token_is_session_routed() {
    let state = create_proxy_state();
    let request = Request::builder()
        .uri("/claude-desktop/v1/models")
        .header("authorization", "bearer session-deadbeefcafebabe")
        .body(Body::empty())
        .unwrap();

    let response = proxy_handler(AxumState(state), request).await;

    // Empty DB means the session lookup fails, but the lowercase bearer
    // scheme must still be recognized as a session token rather than falling
    // through to path-based passthrough routing.
    match response {
        Ok(_) => panic!("unexpected success on an empty-DB session lookup"),
        Err(resp) => assert_ne!(resp.status(), StatusCode::NOT_FOUND),
    }
}

/// PassThrough (no session token, just a raw provider key) still requires
/// a family-hinting prefix since we don't know where to forward it.
#[tokio::test]
async fn passthrough_still_requires_family_prefix() {
    let state = create_proxy_state();
    let request = Request::builder()
        .uri("/v1/messages")
        .header("authorization", "Bearer sk-live-token")
        .body(Body::empty())
        .unwrap();

    let response = proxy_handler(AxumState(state), request).await;

    let err = response.err().expect("expected rejection");
    assert_eq!(err.status(), StatusCode::NOT_FOUND);
}
