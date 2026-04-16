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
