mod support;

use axum::body::Body;
use axum::extract::State as AxumState;
use axum::http::{Request, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{any, get, post};
use axum::Router;
use cc_use_lib::commands::gateways::{
    gateway_create_inner, gateway_delete_inner, gateway_list_inner, gateway_update_inner,
};
use cc_use_lib::db::Database;
use cc_use_lib::models::{CreateApiKeyInput, CreateProviderInput};
use cc_use_lib::proxy::handler::proxy_handler;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use support::{build_proxy_state, TempDb};
use tokio::net::TcpListener;

fn open_temp_db() -> (Database, PathBuf) {
    let path = std::env::temp_dir().join(format!("cc-use-gateway-{}.db", nanoid::nanoid!(8)));
    let db = Database::open_at(&path).expect("create temp database");
    (db, path)
}

fn remove_temp_db(path: &PathBuf) {
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(path.with_extension("db-wal"));
    let _ = std::fs::remove_file(path.with_extension("db-shm"));
}

fn create_provider_at(db: &Database, base_url: &str) -> cc_use_lib::models::Provider {
    db.provider_create(&CreateProviderInput {
        request_headers: None,
        wallet_balance_script: None,
        name: "gateway-provider".to_string(),
        base_url: base_url.to_string(),
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
    .expect("create provider")
}

fn create_gateway_key(db: &Database, provider_id: &str, value: &str) -> cc_use_lib::models::ApiKey {
    db.api_key_create(&CreateApiKeyInput {
        usage_script: None,
        provider_id: provider_id.to_string(),
        alias: Some("gateway-key".to_string()),
        value: value.to_string(),
        types: Some(vec!["claude_code".to_string()]),
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
    .expect("create api key")
}

async fn start_upstream(status: StatusCode, body: &'static str) -> u16 {
    let app = Router::new().route(
        "/v1/messages",
        post(move || async move { (status, body).into_response() }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    port
}

async fn start_count_tokens_upstream() -> u16 {
    let app = Router::new().route(
        "/v1/messages/count_tokens",
        any(|| async { StatusCode::NOT_FOUND }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    port
}

#[test]
fn gateway_crud_binds_one_key_and_lists_it() {
    let fixture = TempDb::new();
    let provider = support::create_provider(&fixture.db, "p", "custom");
    let key = support::create_api_key(&fixture.db, &provider.id, "claude_code");

    let gateway =
        gateway_create_inner(&fixture.db, " Work ", &provider.id, &key.id).expect("create gateway");
    assert_eq!(gateway.display_name, "Work");
    assert_eq!(gateway.provider_id, provider.id);
    assert_eq!(gateway.api_key_id, key.id);
    assert!(gateway.is_active);
    assert!(gateway.session_token.starts_with("session-"));

    let list = gateway_list_inner(&fixture.db).expect("list gateways");
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].session_token, gateway.session_token);

    let updated = gateway_update_inner(
        &fixture.db,
        &gateway.session_token,
        Some("Personal"),
        None,
        None,
        Some(false),
    )
    .expect("update gateway");
    assert_eq!(updated.display_name, "Personal");
    assert!(!updated.is_active);

    assert!(gateway_delete_inner(&fixture.db, &gateway.session_token).expect("delete gateway"));
    assert!(gateway_list_inner(&fixture.db)
        .expect("list gateways")
        .is_empty());
}

#[test]
fn gateway_rejects_a_key_from_another_provider() {
    let fixture = TempDb::new();
    let provider_a = support::create_provider(&fixture.db, "a", "custom");
    let provider_b = support::create_provider(&fixture.db, "b", "custom");
    let key_b = support::create_api_key(&fixture.db, &provider_b.id, "claude_code");

    let error = gateway_create_inner(&fixture.db, "bad", &provider_a.id, &key_b.id)
        .expect_err("mismatched key must be rejected");
    assert!(error.contains("does not belong"));
}

#[test]
fn cleanup_keeps_gateway_rows() {
    let fixture = TempDb::new();
    let provider = support::create_provider(&fixture.db, "p", "custom");
    let key = support::create_api_key(&fixture.db, &provider.id, "claude_code");
    let gateway = gateway_create_inner(&fixture.db, "outlet", &provider.id, &key.id).unwrap();

    // Age the outlet beyond the cleanup window.
    fixture
        .db
        .conn
        .execute(
            "UPDATE proxy_sessions SET created_at = '2020-01-01T00:00:00Z',
             last_seen_at = '2020-01-01T00:00:00Z' WHERE session_token = ?1",
            [&gateway.session_token],
        )
        .unwrap();
    assert_eq!(fixture.db.proxy_session_cleanup_stale(30).unwrap(), 0);
    assert!(fixture
        .db
        .gateway_get(&gateway.session_token)
        .unwrap()
        .is_some());
}

#[test]
fn deleting_a_key_or_provider_removes_its_gateway_rows() {
    let fixture = TempDb::new();
    let provider = support::create_provider(&fixture.db, "p", "custom");
    let key = support::create_api_key(&fixture.db, &provider.id, "claude_code");
    let gateway = gateway_create_inner(&fixture.db, "outlet", &provider.id, &key.id).unwrap();

    fixture.db.api_key_delete(&key.id).unwrap();
    assert!(fixture
        .db
        .gateway_get(&gateway.session_token)
        .unwrap()
        .is_none());

    let key2 = support::create_api_key(&fixture.db, &provider.id, "claude_code");
    let gateway2 = gateway_create_inner(&fixture.db, "outlet-2", &provider.id, &key2.id).unwrap();
    fixture.db.provider_delete(&provider.id).unwrap();
    assert!(fixture
        .db
        .gateway_get(&gateway2.session_token)
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn disabled_gateway_is_rejected_before_upstream() {
    let (db, path) = open_temp_db();
    let provider = support::create_provider(&db, "p", "custom");
    let key = support::create_api_key(&db, &provider.id, "claude_code");
    let gateway = gateway_create_inner(&db, "outlet", &provider.id, &key.id).unwrap();
    gateway_update_inner(&db, &gateway.session_token, None, None, None, Some(false)).unwrap();

    let state = build_proxy_state(db);
    let request = Request::builder()
        .uri("/v1/messages")
        .header("authorization", format!("Bearer {}", gateway.session_token))
        .body(Body::from(r#"{"model":"claude-sonnet-4"}"#))
        .unwrap();

    let response = proxy_handler(AxumState(state), request)
        .await
        .expect_err("disabled gateway must be rejected");
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    remove_temp_db(&path);
}

#[tokio::test]
async fn gateway_token_forwards_to_the_bound_key() {
    let port = start_upstream(StatusCode::OK, r#"{"type":"message","content":[]}"#).await;
    let (db, path) = open_temp_db();
    let provider = create_provider_at(&db, &format!("http://127.0.0.1:{port}"));
    let key = create_gateway_key(&db, &provider.id, "sk-real");
    let gateway = gateway_create_inner(&db, "outlet", &provider.id, &key.id).unwrap();

    let state = build_proxy_state(db);
    let request = Request::builder()
        .uri("/v1/messages")
        .method("POST")
        .header("authorization", format!("Bearer {}", gateway.session_token))
        .header("content-type", "application/json")
        .body(Body::from(r#"{"model":"claude-sonnet-4","max_tokens":8}"#))
        .unwrap();

    let response = proxy_handler(AxumState(state), request)
        .await
        .expect("gateway request should reach upstream");
    assert_eq!(response.status(), StatusCode::OK);
    remove_temp_db(&path);
}

#[tokio::test]
async fn gateway_does_not_answer_count_tokens_locally() {
    let port = start_count_tokens_upstream().await;
    let (db, path) = open_temp_db();
    let provider = create_provider_at(&db, &format!("http://127.0.0.1:{port}"));
    let key = create_gateway_key(&db, &provider.id, "sk-real");
    let gateway = gateway_create_inner(&db, "outlet", &provider.id, &key.id).unwrap();

    let state = build_proxy_state(db);
    let request = Request::builder()
        .uri("/v1/messages/count_tokens")
        .method("POST")
        .header("authorization", format!("Bearer {}", gateway.session_token))
        .header("content-type", "application/json")
        .body(Body::from(r#"{"model":"claude-sonnet-4","messages":[]}"#))
        .unwrap();

    let response = proxy_handler(AxumState(state), request)
        .await
        .expect("upstream 404 is forwarded, not replaced by a local estimate");
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    remove_temp_db(&path);
}

async fn start_models_upstream() -> u16 {
    let app = Router::new().route(
        "/v1/models",
        get(|| async { r#"{"data":[{"id":"upstream-model"}]}"# }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    port
}

async fn start_body_capture_upstream() -> (u16, Arc<Mutex<Option<serde_json::Value>>>) {
    let received: Arc<Mutex<Option<serde_json::Value>>> = Arc::new(Mutex::new(None));
    let capture = received.clone();
    let app = Router::new().route(
        "/v1/messages",
        post(move |req: Request<Body>| {
            let capture = capture.clone();
            async move {
                let body = axum::body::to_bytes(req.into_body(), 1024 * 1024)
                    .await
                    .unwrap();
                *capture.lock().unwrap() = serde_json::from_slice(&body).ok();
                (StatusCode::OK, r#"{"type":"message","content":[]}"#).into_response()
            }
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    (port, received)
}

#[test]
fn gateway_rows_are_hidden_from_the_session_list() {
    let fixture = TempDb::new();
    let provider = support::create_provider(&fixture.db, "p", "custom");
    let key = support::create_api_key(&fixture.db, &provider.id, "claude_code");
    let _gateway = gateway_create_inner(&fixture.db, "outlet", &provider.id, &key.id).unwrap();
    support::create_proxy_session(&fixture.db, "session-manual", &provider.id, &key.id, None);

    let sessions = fixture.db.proxy_session_list().unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].session_token, "session-manual");
    assert_eq!(fixture.db.gateway_list().unwrap().len(), 1);
}

#[test]
fn two_gateways_can_bind_the_same_key_independently() {
    let fixture = TempDb::new();
    let provider = support::create_provider(&fixture.db, "p", "custom");
    let key = support::create_api_key(&fixture.db, &provider.id, "claude_code");
    let first = gateway_create_inner(&fixture.db, "first", &provider.id, &key.id).unwrap();
    let second = gateway_create_inner(&fixture.db, "second", &provider.id, &key.id).unwrap();

    assert_eq!(fixture.db.gateway_list().unwrap().len(), 2);
    gateway_delete_inner(&fixture.db, &first.session_token).unwrap();
    let remaining = fixture.db.gateway_list().unwrap();
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].session_token, second.session_token);
}

#[tokio::test]
async fn gateway_models_request_is_answered_by_the_provider_query() {
    let port = start_models_upstream().await;
    let (db, path) = open_temp_db();
    let provider = create_provider_at(&db, &format!("http://127.0.0.1:{port}"));
    let key = create_gateway_key(&db, &provider.id, "sk-real");
    let gateway = gateway_create_inner(&db, "outlet", &provider.id, &key.id).unwrap();

    let state = build_proxy_state(db);
    let request = Request::builder()
        .uri("/v1/models")
        .method("GET")
        .header("authorization", format!("Bearer {}", gateway.session_token))
        .body(Body::empty())
        .unwrap();

    let response = proxy_handler(AxumState(state), request)
        .await
        .expect("gateway models request should reach upstream");
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    assert!(String::from_utf8_lossy(&body).contains("upstream-model"));
    remove_temp_db(&path);
}

#[tokio::test]
async fn gateway_forwards_the_client_model_even_when_the_key_has_a_fixed_mapping() {
    let (port, received) = start_body_capture_upstream().await;
    let (db, path) = open_temp_db();
    let provider = create_provider_at(&db, &format!("http://127.0.0.1:{port}"));
    let key = create_gateway_key(&db, &provider.id, "sk-real");
    db.conn
        .execute(
            "UPDATE api_keys SET model_mapping = ?1 WHERE id = ?2",
            rusqlite::params![r#"{"mode":"fixed","model":"mapped-model"}"#, key.id],
        )
        .unwrap();
    let gateway = gateway_create_inner(&db, "outlet", &provider.id, &key.id).unwrap();

    let state = build_proxy_state(db);
    let request = Request::builder()
        .uri("/v1/messages")
        .method("POST")
        .header("authorization", format!("Bearer {}", gateway.session_token))
        .header("content-type", "application/json")
        .body(Body::from(r#"{"model":"client-model","max_tokens":8}"#))
        .unwrap();

    let response = proxy_handler(AxumState(state), request)
        .await
        .expect("gateway request should reach upstream");
    assert_eq!(response.status(), StatusCode::OK);
    let forwarded = received.lock().unwrap().clone().unwrap();
    assert_eq!(forwarded["model"], "client-model");
    remove_temp_db(&path);
}

#[test]
fn gateway_rejects_disabled_or_exhausted_keys() {
    let fixture = TempDb::new();
    let provider = support::create_provider(&fixture.db, "p", "custom");
    let key = support::create_api_key(&fixture.db, &provider.id, "claude_code");

    fixture
        .db
        .conn
        .execute("UPDATE api_keys SET is_active = 0 WHERE id = ?1", [&key.id])
        .unwrap();
    assert!(
        gateway_create_inner(&fixture.db, "off", &provider.id, &key.id)
            .expect_err("disabled key must be rejected")
            .contains("disabled")
    );

    fixture
        .db
        .conn
        .execute(
            "UPDATE api_keys SET is_active = 1, is_exhausted = 1 WHERE id = ?1",
            [&key.id],
        )
        .unwrap();
    assert!(
        gateway_create_inner(&fixture.db, "empty", &provider.id, &key.id)
            .expect_err("exhausted key must be rejected")
            .contains("exhausted")
    );
}

#[derive(Default)]
struct CapturedRequest {
    path: String,
    user_agent: Option<String>,
    authorization: Option<String>,
    x_api_key: Option<String>,
}

async fn start_capture_upstream(
    route: &'static str,
    method: &'static str,
    response_body: &'static str,
) -> (u16, Arc<Mutex<CapturedRequest>>) {
    let captured: Arc<Mutex<CapturedRequest>> = Arc::new(Mutex::new(CapturedRequest::default()));
    let capture = captured.clone();
    let handler = move |req: Request<Body>| {
        let capture = capture.clone();
        async move {
            let mut entry = capture.lock().unwrap();
            entry.path = req.uri().path().to_string();
            entry.user_agent = req
                .headers()
                .get("user-agent")
                .and_then(|value| value.to_str().ok())
                .map(str::to_string);
            entry.authorization = req
                .headers()
                .get("authorization")
                .and_then(|value| value.to_str().ok())
                .map(str::to_string);
            entry.x_api_key = req
                .headers()
                .get("x-api-key")
                .and_then(|value| value.to_str().ok())
                .map(str::to_string);
            (StatusCode::OK, response_body).into_response()
        }
    };
    let app = if method == "GET" {
        Router::new().route(route, get(handler))
    } else {
        Router::new().route(route, post(handler))
    };
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    (port, captured)
}

#[tokio::test]
async fn gateway_model_discovery_reuses_the_provider_query_settings() {
    let (port, captured) =
        start_capture_upstream("/v1/models", "GET", r#"{"data":[{"id":"m1"},{"id":"m2"}]}"#).await;
    let (db, path) = open_temp_db();
    let provider = create_provider_at(&db, &format!("http://127.0.0.1:{port}"));
    let key = create_gateway_key(&db, &provider.id, "sk-real");
    db.settings_set_value(
        &format!("model-catalog-user-agent.{}.claude_code", provider.id),
        "claude-cli/2.1.161 (external, cli)",
    )
    .unwrap();
    let gateway = gateway_create_inner(&db, "outlet", &provider.id, &key.id).unwrap();

    let state = build_proxy_state(db);
    let request = Request::builder()
        .uri("/models")
        .method("GET")
        .header("authorization", format!("Bearer {}", gateway.session_token))
        .header("user-agent", "DeepSeek-Harness/0.2")
        .body(Body::empty())
        .unwrap();
    let response = proxy_handler(AxumState(state), request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(body["data"][0]["id"], "m1");
    assert_eq!(body["data"][1]["id"], "m2");

    let captured = captured.lock().unwrap();
    assert_eq!(captured.path, "/v1/models");
    assert_eq!(
        captured.user_agent.as_deref(),
        Some("claude-cli/2.1.161 (external, cli)")
    );
    assert_eq!(captured.x_api_key.as_deref(), Some("sk-real"));
    assert_eq!(captured.authorization, None);
    drop(captured);
    remove_temp_db(&path);
}

#[tokio::test]
async fn gateway_inference_uses_the_keys_auth_scheme() {
    let (port, captured) =
        start_capture_upstream("/v1/messages", "POST", r#"{"type":"message","content":[]}"#).await;
    let (db, path) = open_temp_db();
    let provider = create_provider_at(&db, &format!("http://127.0.0.1:{port}"));
    let key = create_gateway_key(&db, &provider.id, "sk-real");
    db.conn
        .execute(
            "UPDATE api_keys SET client_configs = ?1 WHERE id = ?2",
            rusqlite::params![r#"{"claude_code":{"authScheme":"bearer"}}"#, key.id],
        )
        .unwrap();
    let gateway = gateway_create_inner(&db, "outlet", &provider.id, &key.id).unwrap();

    let state = build_proxy_state(db);
    let request = Request::builder()
        .uri("/v1/messages")
        .method("POST")
        .header("authorization", format!("Bearer {}", gateway.session_token))
        .header("content-type", "application/json")
        .body(Body::from(r#"{"model":"m","max_tokens":8}"#))
        .unwrap();
    let response = proxy_handler(AxumState(state), request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let captured = captured.lock().unwrap();
    assert_eq!(captured.authorization.as_deref(), Some("Bearer sk-real"));
    assert_eq!(captured.x_api_key, None);
    drop(captured);
    remove_temp_db(&path);
}

#[tokio::test]
async fn gateway_inference_adds_the_v1_prefix_from_the_provider_base() {
    let (port, captured) =
        start_capture_upstream("/v1/chat/completions", "POST", r#"{"choices":[]}"#).await;
    let (db, path) = open_temp_db();
    let provider = create_provider_at(&db, &format!("http://127.0.0.1:{port}"));
    let key = create_gateway_key(&db, &provider.id, "sk-real");
    let gateway = gateway_create_inner(&db, "outlet", &provider.id, &key.id).unwrap();

    let state = build_proxy_state(db);
    let request = Request::builder()
        .uri("/chat/completions")
        .method("POST")
        .header("authorization", format!("Bearer {}", gateway.session_token))
        .header("content-type", "application/json")
        .body(Body::from(r#"{"model":"m"}"#))
        .unwrap();
    let response = proxy_handler(AxumState(state), request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    assert_eq!(captured.lock().unwrap().path, "/v1/chat/completions");
    remove_temp_db(&path);
}

#[tokio::test]
async fn gateway_inference_uses_the_keys_configured_user_agent() {
    let (port, captured) =
        start_capture_upstream("/v1/messages", "POST", r#"{"type":"message","content":[]}"#).await;
    let (db, path) = open_temp_db();
    let provider = create_provider_at(&db, &format!("http://127.0.0.1:{port}"));
    let key = create_gateway_key(&db, &provider.id, "sk-real");
    db.conn
        .execute(
            "UPDATE api_keys SET client_configs = ?1 WHERE id = ?2",
            rusqlite::params![
                r#"{"claude_code":{"proxyUserAgent":"claude-cli/2.1.291 (external, cli)"}}"#,
                key.id
            ],
        )
        .unwrap();
    let gateway = gateway_create_inner(&db, "outlet", &provider.id, &key.id).unwrap();

    let state = build_proxy_state(db);
    let request = Request::builder()
        .uri("/v1/messages")
        .method("POST")
        .header("authorization", format!("Bearer {}", gateway.session_token))
        .header("user-agent", "DeepSeek-Harness/0.2")
        .header("content-type", "application/json")
        .body(Body::from(r#"{"model":"m","max_tokens":8}"#))
        .unwrap();
    let response = proxy_handler(AxumState(state), request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    assert_eq!(
        captured.lock().unwrap().user_agent.as_deref(),
        Some("claude-cli/2.1.291 (external, cli)")
    );
    remove_temp_db(&path);
}

#[tokio::test]
async fn gateway_inference_falls_back_to_the_provider_query_user_agent() {
    let (port, captured) =
        start_capture_upstream("/v1/messages", "POST", r#"{"type":"message","content":[]}"#).await;
    let (db, path) = open_temp_db();
    let provider = create_provider_at(&db, &format!("http://127.0.0.1:{port}"));
    let key = create_gateway_key(&db, &provider.id, "sk-real");
    db.settings_set_value(
        &format!("model-catalog-user-agent.{}.claude_code", provider.id),
        "claude-cli/2.1.161 (external, cli)",
    )
    .unwrap();
    let gateway = gateway_create_inner(&db, "outlet", &provider.id, &key.id).unwrap();

    let state = build_proxy_state(db);
    let request = Request::builder()
        .uri("/v1/messages")
        .method("POST")
        .header("authorization", format!("Bearer {}", gateway.session_token))
        .header("user-agent", "DeepSeek-Harness/0.2")
        .header("content-type", "application/json")
        .body(Body::from(r#"{"model":"m","max_tokens":8}"#))
        .unwrap();
    let response = proxy_handler(AxumState(state), request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    assert_eq!(
        captured.lock().unwrap().user_agent.as_deref(),
        Some("claude-cli/2.1.161 (external, cli)")
    );
    remove_temp_db(&path);
}
