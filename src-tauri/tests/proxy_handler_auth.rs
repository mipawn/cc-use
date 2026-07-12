mod support;

use axum::body::Body;
use axum::extract::State as AxumState;
use axum::http::{Request, StatusCode};
use cc_use_lib::db::Database;
use cc_use_lib::models::ProxySession;
use cc_use_lib::proxy::handler::{error_response, proxy_handler};
use support::{build_proxy_state, create_api_key, create_provider};

fn create_proxy_state() -> std::sync::Arc<cc_use_lib::proxy::ProxyState> {
    let path = std::env::temp_dir().join(format!("cc-use-proxy-auth-{}.db", nanoid::nanoid!(8)));
    let db = Database::open_at(&path).expect("create temp database");
    build_proxy_state(db)
}

fn create_session_state(
    key_type: &str,
    cli_type: &str,
    configure_session: impl FnOnce(&mut ProxySession),
    configure_db: impl FnOnce(&Database, &str, &str),
) -> (std::sync::Arc<cc_use_lib::proxy::ProxyState>, String) {
    let path = std::env::temp_dir().join(format!(
        "cc-use-proxy-session-state-{}.db",
        nanoid::nanoid!(8)
    ));
    let db = Database::open_at(&path).expect("create temp database");
    let provider = create_provider(&db, "session-provider", "custom");
    let api_key = create_api_key(&db, &provider.id, key_type);
    let session_token = format!("session-{}", nanoid::nanoid!(16));
    let now = chrono::Utc::now().to_rfc3339();
    let mut session = ProxySession {
        session_token: session_token.clone(),
        provider_id: provider.id.clone(),
        api_key_id: api_key.id.clone(),
        project_id: None,
        created_at: now.clone(),
        session_kind: "manual".to_string(),
        last_seen_at: now,
        expires_at: None,
        revoked_at: None,
        revoked_reason: None,
        cli_type: Some(cli_type.to_string()),
    };
    configure_session(&mut session);
    db.proxy_session_create(&session)
        .expect("create proxy session");
    configure_db(&db, &provider.id, &api_key.id);
    (build_proxy_state(db), session_token)
}

async fn rejected_session_status(
    state: std::sync::Arc<cc_use_lib::proxy::ProxyState>,
    session_token: &str,
) -> StatusCode {
    let request = Request::builder()
        .uri("/v1/messages")
        .header("authorization", format!("Bearer {}", session_token))
        .body(Body::from(r#"{"model":"claude-sonnet-4"}"#))
        .unwrap();

    proxy_handler(AxumState(state), request)
        .await
        .expect_err("request should be rejected before upstream dispatch")
        .status()
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

#[tokio::test]
async fn rejects_revoked_session() {
    let (state, token) = create_session_state(
        "claude_code",
        "claude_code",
        |session| {
            session.revoked_at = Some(chrono::Utc::now().to_rfc3339());
            session.revoked_reason = Some("test_revoke".to_string());
        },
        |_, _, _| {},
    );

    assert_eq!(
        rejected_session_status(state, &token).await,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn rejects_expired_session() {
    let (state, token) = create_session_state(
        "claude_code",
        "claude_code",
        |session| {
            session.expires_at =
                Some((chrono::Utc::now() - chrono::Duration::minutes(1)).to_rfc3339());
        },
        |_, _, _| {},
    );

    assert_eq!(
        rejected_session_status(state, &token).await,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn rejects_disabled_or_exhausted_key() {
    for column in ["is_active = 0", "is_exhausted = 1"] {
        let (state, token) = create_session_state(
            "claude_code",
            "claude_code",
            |_| {},
            |db, _, key_id| {
                db.conn
                    .execute(
                        &format!("UPDATE api_keys SET {} WHERE id = ?1", column),
                        [key_id],
                    )
                    .unwrap();
            },
        );

        assert_eq!(
            rejected_session_status(state, &token).await,
            StatusCode::FORBIDDEN
        );
    }
}

#[tokio::test]
async fn rejects_disabled_provider_and_client_mismatch() {
    let (disabled_state, disabled_token) = create_session_state(
        "claude_code",
        "claude_code",
        |_| {},
        |db, provider_id, _| {
            db.conn
                .execute(
                    "UPDATE providers SET is_active = 0 WHERE id = ?1",
                    [provider_id],
                )
                .unwrap();
        },
    );
    assert_eq!(
        rejected_session_status(disabled_state, &disabled_token).await,
        StatusCode::FORBIDDEN
    );

    let (mismatch_state, mismatch_token) =
        create_session_state("codex", "claude_code", |_| {}, |_, _, _| {});
    assert_eq!(
        rejected_session_status(mismatch_state, &mismatch_token).await,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn deleted_session_is_not_resurrected_from_startup_cache() {
    let (state, token) = create_session_state("claude_code", "claude_code", |_| {}, |_, _, _| {});
    state
        .db
        .lock()
        .unwrap()
        .proxy_session_delete(&token)
        .unwrap();

    assert_eq!(
        rejected_session_status(state, &token).await,
        StatusCode::UNAUTHORIZED
    );
}
