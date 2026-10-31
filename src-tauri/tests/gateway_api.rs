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
use cc_use_lib::commands::providers::{
    provider_model_catalog_query_inner, ProviderModelCatalogQueryInput,
};
use cc_use_lib::db::Database;
use cc_use_lib::models::{CreateApiKeyInput, CreateProviderInput};
use cc_use_lib::proxy::handler::proxy_handler;
use futures::StreamExt;
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

fn connection_config(
    base_url: Option<&str>,
    auth_scheme: &str,
    user_agent: Option<&str>,
) -> cc_use_lib::models::GatewayConnectionConfig {
    cc_use_lib::models::GatewayConnectionConfig {
        base_url: base_url.map(str::to_string),
        auth_scheme: auth_scheme.to_string(),
        user_agent: user_agent.map(str::to_string),
    }
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

    let gateway = gateway_create_inner(&fixture.db, " Work ", &provider.id, &key.id, None)
        .expect("create gateway");
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
        None,
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

    let error = gateway_create_inner(&fixture.db, "bad", &provider_a.id, &key_b.id, None)
        .expect_err("mismatched key must be rejected");
    assert!(error.contains("does not belong"));
}

#[test]
fn cleanup_keeps_gateway_rows() {
    let fixture = TempDb::new();
    let provider = support::create_provider(&fixture.db, "p", "custom");
    let key = support::create_api_key(&fixture.db, &provider.id, "claude_code");
    let gateway = gateway_create_inner(&fixture.db, "outlet", &provider.id, &key.id, None).unwrap();

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
    let gateway = gateway_create_inner(&fixture.db, "outlet", &provider.id, &key.id, None).unwrap();

    fixture.db.api_key_delete(&key.id).unwrap();
    assert!(fixture
        .db
        .gateway_get(&gateway.session_token)
        .unwrap()
        .is_none());

    let key2 = support::create_api_key(&fixture.db, &provider.id, "claude_code");
    let gateway2 =
        gateway_create_inner(&fixture.db, "outlet-2", &provider.id, &key2.id, None).unwrap();
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
    let gateway = gateway_create_inner(&db, "outlet", &provider.id, &key.id, None).unwrap();
    gateway_update_inner(
        &db,
        &gateway.session_token,
        None,
        None,
        None,
        Some(false),
        None,
    )
    .unwrap();

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
    let gateway = gateway_create_inner(&db, "outlet", &provider.id, &key.id, None).unwrap();

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
    let gateway = gateway_create_inner(&db, "outlet", &provider.id, &key.id, None).unwrap();

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
    let _gateway =
        gateway_create_inner(&fixture.db, "outlet", &provider.id, &key.id, None).unwrap();
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
    let first = gateway_create_inner(&fixture.db, "first", &provider.id, &key.id, None).unwrap();
    let second = gateway_create_inner(&fixture.db, "second", &provider.id, &key.id, None).unwrap();

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
    let gateway = gateway_create_inner(&db, "outlet", &provider.id, &key.id, None).unwrap();

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
    let gateway = gateway_create_inner(&db, "outlet", &provider.id, &key.id, None).unwrap();

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
        gateway_create_inner(&fixture.db, "off", &provider.id, &key.id, None)
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
        gateway_create_inner(&fixture.db, "empty", &provider.id, &key.id, None)
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
    /// Every header the upstream actually received (lower-cased names).
    headers: std::collections::BTreeMap<String, String>,
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
            entry.path = req
                .uri()
                .path_and_query()
                .map(|value| value.as_str().to_string())
                .unwrap_or_else(|| req.uri().path().to_string());
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
            entry.headers = req
                .headers()
                .iter()
                .filter_map(|(name, value)| {
                    value
                        .to_str()
                        .ok()
                        .map(|value| (name.as_str().to_string(), value.to_string()))
                })
                .collect();
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
async fn gateway_model_discovery_uses_the_gateway_connection() {
    let (port, captured) =
        start_capture_upstream("/v1/models", "GET", r#"{"data":[{"id":"m1"},{"id":"m2"}]}"#).await;
    let (db, path) = open_temp_db();
    let provider = create_provider_at(&db, &format!("http://127.0.0.1:{port}"));
    let key = create_gateway_key(&db, &provider.id, "sk-real");
    // A saved model-query User-Agent preference is for built-in clients only;
    // the gateway must not read it.
    db.settings_set_value(
        &format!("model-catalog-user-agent.{}.claude_code", provider.id),
        "claude-cli/2.1.161 (external, cli)",
    )
    .unwrap();
    let gateway = gateway_create_inner(&db, "outlet", &provider.id, &key.id, None).unwrap();

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
    assert!(
        captured.path.starts_with("/v1/models"),
        "gateway /models must not add a second /v1: {}",
        captured.path
    );
    assert!(captured.path.contains("limit="));
    assert_eq!(
        captured.user_agent.as_deref(),
        Some("DeepSeek-Harness/0.2"),
        "the client request's own User-Agent is kept"
    );
    assert_eq!(
        captured.authorization.as_deref(),
        Some("Bearer sk-real"),
        "the default gateway scheme is Bearer"
    );
    assert_eq!(captured.x_api_key, None);
    drop(captured);
    remove_temp_db(&path);
}

#[tokio::test]
async fn gateway_inference_uses_the_gateway_auth_scheme_not_the_keys_client_config() {
    let (port, captured) =
        start_capture_upstream("/v1/messages", "POST", r#"{"type":"message","content":[]}"#).await;
    let (db, path) = open_temp_db();
    let provider = create_provider_at(&db, &format!("http://127.0.0.1:{port}"));
    let key = create_gateway_key(&db, &provider.id, "sk-real");
    // The bound key's Claude Code config says Bearer; the gateway explicitly
    // says x-api-key. The gateway choice wins.
    db.conn
        .execute(
            "UPDATE api_keys SET client_configs = ?1 WHERE id = ?2",
            rusqlite::params![r#"{"claude_code":{"authScheme":"bearer"}}"#, key.id],
        )
        .unwrap();
    let gateway = gateway_create_inner(
        &db,
        "outlet",
        &provider.id,
        &key.id,
        Some(&connection_config(None, "x-api-key", None)),
    )
    .unwrap();

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
    assert_eq!(captured.x_api_key.as_deref(), Some("sk-real"));
    assert_eq!(captured.authorization, None);
    drop(captured);
    remove_temp_db(&path);
}

#[tokio::test]
async fn gateway_auth_scheme_none_never_forwards_the_local_session_token() {
    let (port, captured) =
        start_capture_upstream("/v1/messages", "POST", r#"{"type":"message","content":[]}"#).await;
    let (db, path) = open_temp_db();
    let provider = create_provider_at(&db, &format!("http://127.0.0.1:{port}"));
    let key = create_gateway_key(&db, &provider.id, "sk-real");
    let gateway = gateway_create_inner(
        &db,
        "outlet",
        &provider.id,
        &key.id,
        Some(&connection_config(None, "none", None)),
    )
    .unwrap();

    let state = build_proxy_state(db);
    let request = Request::builder()
        .uri("/v1/messages")
        .method("POST")
        .header("authorization", format!("Bearer {}", gateway.session_token))
        .header("x-api-key", "sk-client-claimed")
        .header("content-type", "application/json")
        .body(Body::from(r#"{"model":"m","max_tokens":8}"#))
        .unwrap();
    let response = proxy_handler(AxumState(state), request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let captured = captured.lock().unwrap();
    assert_eq!(captured.authorization, None);
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
    let gateway = gateway_create_inner(&db, "outlet", &provider.id, &key.id, None).unwrap();

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
async fn gateway_inference_uses_the_gateway_user_agent_override() {
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
    let gateway = gateway_create_inner(
        &db,
        "outlet",
        &provider.id,
        &key.id,
        Some(&connection_config(None, "bearer", Some("gateway-agent/9"))),
    )
    .unwrap();

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
        Some("gateway-agent/9"),
        "the gateway override replaces both the client and the key's saved UA"
    );
    remove_temp_db(&path);
}

#[tokio::test]
async fn gateway_inference_keeps_the_inbound_user_agent() {
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
    let gateway = gateway_create_inner(&db, "outlet", &provider.id, &key.id, None).unwrap();

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
        Some("DeepSeek-Harness/0.2"),
        "plain forwarding keeps the client UA and never forces a catalogue UA"
    );
    remove_temp_db(&path);
}

// ────────────────────────────────────────────────────────────────────────────
// P0 evidence / T03: one gateway connection for model discovery and inference.
// ────────────────────────────────────────────────────────────────────────────

async fn start_path_recording_upstream() -> (u16, Arc<Mutex<Vec<String>>>) {
    let paths: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let models_paths = paths.clone();
    let messages_paths = paths.clone();
    let app = Router::new()
        .route(
            "/v1/models",
            get(move || {
                let paths = models_paths.clone();
                async move {
                    paths.lock().unwrap().push("/v1/models".to_string());
                    r#"{"data":[{"id":"provider-model"}]}"#
                }
            }),
        )
        .route(
            "/v1/messages",
            post(move || {
                let paths = messages_paths.clone();
                async move {
                    paths.lock().unwrap().push("/v1/messages".to_string());
                    r#"{"type":"message","content":[]}"#
                }
            }),
        );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    (port, paths)
}

#[tokio::test]
async fn gateway_discovery_and_inference_use_one_connection_not_client_configs() {
    let (provider_port, provider_paths) = start_path_recording_upstream().await;
    let (codex_port, codex_paths) = start_path_recording_upstream().await;
    let (claude_port, claude_paths) = start_path_recording_upstream().await;

    let (db, path) = open_temp_db();
    let provider = create_provider_at(&db, &format!("http://127.0.0.1:{provider_port}"));
    let key = create_gateway_key(&db, &provider.id, "sk-real");
    db.conn
        .execute(
            "UPDATE api_keys SET types = ?1, client_configs = ?2 WHERE id = ?3",
            rusqlite::params![
                r#"["claude_code","codex"]"#,
                format!(
                    r#"{{"claude_code":{{"baseUrl":"http://127.0.0.1:{claude_port}","authScheme":"x-api-key"}},"codex":{{"baseUrl":"http://127.0.0.1:{codex_port}","authScheme":"bearer"}}}}"#
                ),
                key.id
            ],
        )
        .unwrap();
    let gateway = gateway_create_inner(&db, "outlet", &provider.id, &key.id, None).unwrap();

    let state = build_proxy_state(db);
    let models_request = Request::builder()
        .uri("/v1/models")
        .method("GET")
        .header("authorization", format!("Bearer {}", gateway.session_token))
        .body(Body::empty())
        .unwrap();
    let response = proxy_handler(AxumState(state.clone()), models_request)
        .await
        .expect("gateway models request should reach upstream");
    assert_eq!(response.status(), StatusCode::OK);

    let inference_request = Request::builder()
        .uri("/v1/messages")
        .method("POST")
        .header("authorization", format!("Bearer {}", gateway.session_token))
        .header("content-type", "application/json")
        .body(Body::from(r#"{"model":"client-model","max_tokens":8}"#))
        .unwrap();
    let response = proxy_handler(AxumState(state), inference_request)
        .await
        .expect("gateway inference should reach upstream");
    assert_eq!(response.status(), StatusCode::OK);

    assert_eq!(
        *provider_paths.lock().unwrap(),
        vec!["/v1/models".to_string(), "/v1/messages".to_string()],
        "both paths must use the provider/gateway connection"
    );
    assert!(
        codex_paths.lock().unwrap().is_empty(),
        "model discovery must not read the key's codex client config"
    );
    assert!(
        claude_paths.lock().unwrap().is_empty(),
        "inference must not read the key's claude_code client config"
    );
    remove_temp_db(&path);
}

// ────────────────────────────────────────────────────────────────────────────
// T02: connection contract — defaults, whole replacement, clearing, validation
// ────────────────────────────────────────────────────────────────────────────

#[test]
fn gateway_connection_config_defaults_replace_and_clear() {
    let fixture = TempDb::new();
    let provider = support::create_provider(&fixture.db, "p", "custom");
    let key = support::create_api_key(&fixture.db, &provider.id, "claude_code");

    // Omitted on create → creation default, not an absent object.
    let gateway =
        gateway_create_inner(&fixture.db, "default", &provider.id, &key.id, None).unwrap();
    assert_eq!(gateway.connection_config.auth_scheme, "bearer");
    assert!(gateway.connection_config.base_url.is_none());
    assert!(gateway.connection_config.user_agent.is_none());

    // Object replaces the whole configuration and is normalized.
    let created = gateway_create_inner(
        &fixture.db,
        "custom",
        &provider.id,
        &key.id,
        Some(&connection_config(
            Some("  https://gateway.example.com/relay/  "),
            "x-api-key",
            Some("  agent/1  "),
        )),
    )
    .unwrap();
    assert_eq!(
        created.connection_config.base_url.as_deref(),
        Some("https://gateway.example.com/relay")
    );
    assert_eq!(created.connection_config.auth_scheme, "x-api-key");
    assert_eq!(
        created.connection_config.user_agent.as_deref(),
        Some("agent/1")
    );

    // Omitted update keeps the stored override.
    let kept = gateway_update_inner(
        &fixture.db,
        &created.session_token,
        Some("renamed"),
        None,
        None,
        None,
        None,
    )
    .unwrap();
    assert_eq!(kept.display_name, "renamed");
    assert_eq!(
        kept.connection_config.base_url.as_deref(),
        Some("https://gateway.example.com/relay")
    );
    assert_eq!(kept.connection_config.auth_scheme, "x-api-key");
    assert_eq!(
        kept.connection_config.user_agent.as_deref(),
        Some("agent/1")
    );

    // Explicit nulls inside a supplied object clear the overrides; authScheme
    // is always re-stated.
    let cleared = gateway_update_inner(
        &fixture.db,
        &created.session_token,
        None,
        None,
        None,
        None,
        Some(&connection_config(None, "bearer", None)),
    )
    .unwrap();
    assert!(cleared.connection_config.base_url.is_none());
    assert!(cleared.connection_config.user_agent.is_none());
    assert_eq!(cleared.connection_config.auth_scheme, "bearer");

    // The list carries the same normalized object, and the row mapper keeps it.
    let listed = gateway_list_inner(&fixture.db).unwrap();
    assert_eq!(listed.len(), 2);
    let listed_custom = listed
        .iter()
        .find(|entry| entry.session_token == created.session_token)
        .unwrap();
    assert_eq!(listed_custom.connection_config.auth_scheme, "bearer");

    let session = fixture
        .db
        .proxy_session_get(&created.session_token)
        .unwrap()
        .unwrap();
    assert!(session.connection_config.is_some());
}

#[test]
fn gateway_connection_config_validation_does_not_echo_the_value() {
    let fixture = TempDb::new();
    let provider = support::create_provider(&fixture.db, "p", "custom");
    let key = support::create_api_key(&fixture.db, &provider.id, "claude_code");

    let url_error = gateway_create_inner(
        &fixture.db,
        "bad-url",
        &provider.id,
        &key.id,
        Some(&connection_config(
            Some("https://SECRET-URL.example.com/v1?token=SECRET"),
            "bearer",
            None,
        )),
    )
    .unwrap_err();
    assert!(url_error.contains("Base URL"));
    assert!(!url_error.contains("SECRET"), "error must not echo the URL");

    let ua_error = gateway_create_inner(
        &fixture.db,
        "bad-ua",
        &provider.id,
        &key.id,
        Some(&connection_config(None, "bearer", Some("bad\r\nagent"))),
    )
    .unwrap_err();
    assert!(!ua_error.contains("agent"), "error must not echo the UA");

    let scheme_error = gateway_create_inner(
        &fixture.db,
        "bad-scheme",
        &provider.id,
        &key.id,
        Some(&connection_config(None, "basic", None)),
    )
    .unwrap_err();
    assert!(scheme_error.contains("authentication scheme"));
    assert!(gateway_list_inner(&fixture.db).unwrap().is_empty());
}

// ────────────────────────────────────────────────────────────────────────────
// T02: gateway model catalogue preview is read-only and validates the binding
// ────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn provider_model_catalog_query_is_read_only_and_validates_the_binding() {
    let (port, captured) =
        start_capture_upstream("/v1/models", "GET", r#"{"data":[{"id":"draft-model"}]}"#).await;
    let (db, path) = open_temp_db();
    let provider = create_provider_at(&db, &format!("http://127.0.0.1:{port}"));
    let key = create_gateway_key(&db, &provider.id, "sk-real");
    let other_provider = create_provider_at(&db, "https://other.example.com");
    let db = Arc::new(Mutex::new(db));

    let result = provider_model_catalog_query_inner(
        &db,
        ProviderModelCatalogQueryInput {
            provider_id: provider.id.clone(),
            api_key_id: key.id.clone(),
            connection_config: Default::default(),
        },
    )
    .await
    .expect("preview should query the upstream");
    assert_eq!(result.models.len(), 1);
    assert_eq!(result.models[0].id, "draft-model");
    assert!(!result.from_cache);
    assert!(result.error.is_none());
    assert!(captured.lock().unwrap().path.starts_with("/v1/models"));
    // Read-only: no outlet was created or updated.
    assert!(db.lock().unwrap().gateway_list().unwrap().is_empty());

    // Provider/key ownership is validated before any network call.
    let mismatch = provider_model_catalog_query_inner(
        &db,
        ProviderModelCatalogQueryInput {
            provider_id: other_provider.id.clone(),
            api_key_id: key.id.clone(),
            connection_config: Default::default(),
        },
    )
    .await
    .unwrap_err();
    assert!(mismatch.contains("does not belong"));

    // A disabled or exhausted key is refused.
    db.lock()
        .unwrap()
        .conn
        .execute("UPDATE api_keys SET is_active = 0 WHERE id = ?1", [&key.id])
        .unwrap();
    let disabled = provider_model_catalog_query_inner(
        &db,
        ProviderModelCatalogQueryInput {
            provider_id: provider.id.clone(),
            api_key_id: key.id.clone(),
            connection_config: Default::default(),
        },
    )
    .await
    .unwrap_err();
    assert!(disabled.contains("disabled"));
    db.lock()
        .unwrap()
        .conn
        .execute(
            "UPDATE api_keys SET is_active = 1, is_exhausted = 1 WHERE id = ?1",
            [&key.id],
        )
        .unwrap();
    let exhausted = provider_model_catalog_query_inner(
        &db,
        ProviderModelCatalogQueryInput {
            provider_id: provider.id.clone(),
            api_key_id: key.id.clone(),
            connection_config: Default::default(),
        },
    )
    .await
    .unwrap_err();
    assert!(exhausted.contains("exhausted"));

    // Invalid draft fields are refused with safe messages.
    db.lock()
        .unwrap()
        .conn
        .execute(
            "UPDATE api_keys SET is_exhausted = 0 WHERE id = ?1",
            [&key.id],
        )
        .unwrap();
    let invalid = provider_model_catalog_query_inner(
        &db,
        ProviderModelCatalogQueryInput {
            provider_id: provider.id.clone(),
            api_key_id: key.id.clone(),
            connection_config: connection_config(Some("ftp://SECRET.example.com"), "bearer", None),
        },
    )
    .await
    .unwrap_err();
    assert!(!invalid.contains("SECRET"));
    drop(db);
    remove_temp_db(&path);
}

#[tokio::test]
async fn provider_model_catalog_query_uses_the_draft_connection() {
    let (provider_port, provider_captured) =
        start_capture_upstream("/v1/models", "GET", r#"{"data":[{"id":"provider-model"}]}"#).await;
    let (draft_port, draft_captured) =
        start_capture_upstream("/v1/models", "GET", r#"{"data":[{"id":"draft-model"}]}"#).await;
    let (db, path) = open_temp_db();
    let provider = create_provider_at(&db, &format!("http://127.0.0.1:{provider_port}"));
    let key = create_gateway_key(&db, &provider.id, "sk-real");
    let db = Arc::new(Mutex::new(db));

    let result = provider_model_catalog_query_inner(
        &db,
        ProviderModelCatalogQueryInput {
            provider_id: provider.id.clone(),
            api_key_id: key.id.clone(),
            connection_config: connection_config(
                Some(&format!("http://127.0.0.1:{draft_port}")),
                "x-api-key",
                Some("draft-agent/1"),
            ),
        },
    )
    .await
    .expect("draft preview");
    assert_eq!(result.models[0].id, "draft-model");
    assert!(draft_captured
        .lock()
        .unwrap()
        .path
        .starts_with("/v1/models"));
    assert!(
        provider_captured.lock().unwrap().path.is_empty(),
        "the saved provider address must not be queried"
    );
    let captured = draft_captured.lock().unwrap();
    assert_eq!(captured.x_api_key.as_deref(), Some("sk-real"));
    assert_eq!(captured.user_agent.as_deref(), Some("draft-agent/1"));
    drop(captured);
    drop(db);
    remove_temp_db(&path);
}

// ────────────────────────────────────────────────────────────────────────────
// T03: two gateways sharing one key keep independent connections
// ────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn two_gateways_sharing_a_key_keep_their_own_connection() {
    let (a_port, a_captured) =
        start_capture_upstream("/v1/messages", "POST", r#"{"type":"message","content":[]}"#).await;
    let (b_port, b_captured) =
        start_capture_upstream("/v1/messages", "POST", r#"{"type":"message","content":[]}"#).await;
    let (c_port, c_captured) =
        start_capture_upstream("/v1/messages", "POST", r#"{"type":"message","content":[]}"#).await;
    let (db, path) = open_temp_db();
    let provider = create_provider_at(&db, &format!("http://127.0.0.1:{a_port}"));
    let key = create_gateway_key(&db, &provider.id, "sk-real");
    // Deliberately different Claude Code / Codex settings: a gateway must not
    // inherit either of them.
    db.conn
        .execute(
            "UPDATE api_keys SET types = ?1, client_configs = ?2 WHERE id = ?3",
            rusqlite::params![
                r#"["claude_code","codex"]"#,
                format!(
                    r#"{{"claude_code":{{"baseUrl":"http://127.0.0.1:{c_port}"}},"codex":{{"baseUrl":"http://127.0.0.1:{c_port}","authScheme":"bearer"}}}}"#
                ),
                key.id
            ],
        )
        .unwrap();
    let first = gateway_create_inner(&db, "first", &provider.id, &key.id, None).unwrap();
    let second = gateway_create_inner(
        &db,
        "second",
        &provider.id,
        &key.id,
        Some(&connection_config(
            Some(&format!("http://127.0.0.1:{b_port}")),
            "bearer",
            Some("second-agent/1"),
        )),
    )
    .unwrap();

    let state = build_proxy_state(db);
    for gateway in [&first, &second] {
        let request = Request::builder()
            .uri("/v1/messages")
            .method("POST")
            .header("authorization", format!("Bearer {}", gateway.session_token))
            .header("content-type", "application/json")
            .body(Body::from(r#"{"model":"client-model","max_tokens":8}"#))
            .unwrap();
        let response = proxy_handler(AxumState(state.clone()), request)
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let models = Request::builder()
            .uri("/models")
            .method("GET")
            .header("authorization", format!("Bearer {}", gateway.session_token))
            .body(Body::empty())
            .unwrap();
        let response = proxy_handler(AxumState(state.clone()), models).await;
        // The mock only has /v1/messages; /v1/models answers 404. Reaching
        // the right host is what this test proves.
        assert!(response.is_err() || response.unwrap().status() != StatusCode::OK);
    }

    assert_eq!(a_captured.lock().unwrap().path, "/v1/messages");
    assert_eq!(
        b_captured.lock().unwrap().user_agent.as_deref(),
        Some("second-agent/1")
    );
    assert!(c_captured.lock().unwrap().path.is_empty());
    remove_temp_db(&path);
}

// ────────────────────────────────────────────────────────────────────────────
// T04: URL joining, empty catalogue distinct from failure
// ────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn gateway_path_prefix_and_single_v1_are_merged() {
    let captured: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let models_paths = captured.clone();
    let chat_paths = captured.clone();
    let app = Router::new()
        .route(
            "/relay/v1/models",
            get(move || {
                let paths = models_paths.clone();
                async move {
                    paths.lock().unwrap().push("/relay/v1/models".to_string());
                    r#"{"data":[{"id":"prefixed-model"}]}"#
                }
            }),
        )
        .route(
            "/relay/v1/chat/completions",
            post(move |req: Request<Body>| {
                let paths = chat_paths.clone();
                async move {
                    paths.lock().unwrap().push(
                        req.uri()
                            .path_and_query()
                            .map(|value| value.as_str().to_string())
                            .unwrap_or_default(),
                    );
                    (StatusCode::OK, r#"{"choices":[]}"#)
                }
            }),
        );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    tokio::time::sleep(std::time::Duration::from_millis(10)).await;

    let (db, path) = open_temp_db();
    let provider = create_provider_at(&db, &format!("http://127.0.0.1:{port}/relay"));
    let key = create_gateway_key(&db, &provider.id, "sk-real");
    let gateway = gateway_create_inner(&db, "outlet", &provider.id, &key.id, None).unwrap();
    let state = build_proxy_state(db);

    let models = Request::builder()
        .uri("/models")
        .method("GET")
        .header("authorization", format!("Bearer {}", gateway.session_token))
        .body(Body::empty())
        .unwrap();
    let response = proxy_handler(AxumState(state.clone()), models)
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let chat = Request::builder()
        .uri("/v1/chat/completions?x=1")
        .method("POST")
        .header("authorization", format!("Bearer {}", gateway.session_token))
        .header("content-type", "application/json")
        .body(Body::from(r#"{"model":"m"}"#))
        .unwrap();
    let response = proxy_handler(AxumState(state), chat).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    assert_eq!(
        *captured.lock().unwrap(),
        vec![
            "/relay/v1/models".to_string(),
            "/relay/v1/chat/completions?x=1".to_string()
        ]
    );
    remove_temp_db(&path);
}

#[tokio::test]
async fn gateway_empty_catalogue_is_a_success_and_malformed_is_an_error() {
    async fn start(body: &'static str) -> u16 {
        let app = Router::new().route("/v1/models", get(move || async move { body }));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        port
    }

    let empty_port = start(r#"{"data":[],"has_more":false}"#).await;
    let (db, path) = open_temp_db();
    let provider = create_provider_at(&db, &format!("http://127.0.0.1:{empty_port}"));
    let key = create_gateway_key(&db, &provider.id, "sk-real");
    let gateway = gateway_create_inner(&db, "outlet", &provider.id, &key.id, None).unwrap();
    let state = build_proxy_state(db);
    let response = proxy_handler(
        AxumState(state.clone()),
        Request::builder()
            .uri("/v1/models")
            .method("GET")
            .header("authorization", format!("Bearer {}", gateway.session_token))
            .body(Body::empty())
            .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(body["data"], serde_json::json!([]));
    remove_temp_db(&path);

    let malformed_port = start(r#"{"models":[]}"#).await;
    let (db, path) = open_temp_db();
    let provider = create_provider_at(&db, &format!("http://127.0.0.1:{malformed_port}"));
    let key = create_gateway_key(&db, &provider.id, "sk-real");
    let gateway = gateway_create_inner(&db, "outlet", &provider.id, &key.id, None).unwrap();
    let state = build_proxy_state(db);
    let response = proxy_handler(
        AxumState(state),
        Request::builder()
            .uri("/models")
            .method("GET")
            .header("authorization", format!("Bearer {}", gateway.session_token))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    let response = response.expect_err("malformed catalogue must be an error response");
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    remove_temp_db(&path);
}

// ────────────────────────────────────────────────────────────────────────────
// T05: provider headers, protected headers and gateway auth on both paths
// ────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn gateway_provider_headers_apply_with_gateway_auth() {
    let (port, captured) =
        start_capture_upstream("/v1/messages", "POST", r#"{"type":"message","content":[]}"#).await;
    let (db, path) = open_temp_db();
    let provider = create_provider_at(&db, &format!("http://127.0.0.1:{port}"));
    db.conn
        .execute(
            "UPDATE providers SET request_headers = ?1 WHERE id = ?2",
            rusqlite::params![
                format!(
                    r#"{{"X-Relay":"origin={{{{baseUrl}}}}","User-Agent":"provider-agent/1.0","Authorization":"Bearer provider-secret","Upgrade":"h2c","Sec-WebSocket-Key":"injected"}}"#
                ),
                provider.id
            ],
        )
        .unwrap();
    let key = create_gateway_key(&db, &provider.id, "sk-real");
    let gateway = gateway_create_inner(&db, "outlet", &provider.id, &key.id, None).unwrap();
    let state = build_proxy_state(db);

    let request = Request::builder()
        .uri("/v1/messages")
        .method("POST")
        .header("authorization", format!("Bearer {}", gateway.session_token))
        .header("user-agent", "client-agent/1")
        .header("connection", "x-hop")
        .header("x-hop", "drop-me")
        .header("content-type", "application/json")
        .body(Body::from(r#"{"model":"m","max_tokens":8}"#))
        .unwrap();
    let response = proxy_handler(AxumState(state), request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let captured = captured.lock().unwrap();
    let expected_relay = format!("origin=http://127.0.0.1:{port}");
    assert_eq!(
        captured.headers.get("x-relay").map(String::as_str),
        Some(expected_relay.as_str())
    );
    assert_eq!(
        captured.headers.get("user-agent").map(String::as_str),
        Some("client-agent/1"),
        "inbound UA wins over the provider default"
    );
    assert_eq!(
        captured.authorization.as_deref(),
        Some("Bearer sk-real"),
        "provider rules cannot inject an Authorization header"
    );
    assert!(!captured.headers.contains_key("upgrade"));
    assert!(!captured.headers.contains_key("sec-websocket-key"));
    assert!(!captured.headers.contains_key("x-hop"));
    assert!(!captured.headers.contains_key("connection"));
    drop(captured);
    remove_temp_db(&path);
}

// ────────────────────────────────────────────────────────────────────────────
// T21: handler → request_logs → provider/key resource statistics attribution
// ────────────────────────────────────────────────────────────────────────────

const GATEWAY_SSE_OK: &str = "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"model\":\"stream-model\",\"usage\":{\"input_tokens\":7,\"output_tokens\":1}}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"hi\"}}\n\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":3}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";
const GATEWAY_SSE_START: &str = "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":7}}}\n\n";

async fn start_attribution_upstream() -> u16 {
    async fn ok_json() -> impl IntoResponse {
        (
            StatusCode::OK,
            [("content-type", "application/json")],
            r#"{"type":"message","model":"json-model","content":[],"usage":{"input_tokens":10,"output_tokens":5}}"#,
        )
    }
    async fn fail() -> impl IntoResponse {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            [("content-type", "application/json")],
            r#"{"error":{"type":"api_error","message":"upstream exploded"}}"#,
        )
    }
    async fn sse_ok() -> impl IntoResponse {
        (
            StatusCode::OK,
            [("content-type", "text/event-stream")],
            GATEWAY_SSE_OK,
        )
    }
    async fn sse_slow() -> impl IntoResponse {
        let body = axum::body::Body::from_stream(
            futures::stream::iter(vec![Ok::<_, std::io::Error>(
                axum::body::Bytes::from_static(GATEWAY_SSE_START.as_bytes()),
            )])
            .chain(futures::stream::pending()),
        );
        (
            StatusCode::OK,
            [("content-type", "text/event-stream")],
            body,
        )
    }
    async fn models() -> impl IntoResponse {
        (
            StatusCode::OK,
            [("content-type", "application/json")],
            r#"{"data":[{"id":"dir-model"}]}"#,
        )
    }
    let app = Router::new()
        .route("/v1/messages", post(ok_json))
        .route("/v1/fail", post(fail))
        .route("/v1/stream", post(sse_ok))
        .route("/v1/slow", post(sse_slow))
        .route("/v1/models", get(models));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    port
}

fn closed_local_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    port
}

fn gateway_request(token: &str, path: &str, body: Option<&'static str>) -> Request<Body> {
    let builder = Request::builder()
        .uri(path)
        .method(if body.is_some() { "POST" } else { "GET" })
        .header("authorization", format!("Bearer {token}"));
    match body {
        Some(body) => builder
            .header("content-type", "application/json")
            .body(Body::from(body))
            .unwrap(),
        None => builder.body(Body::empty()).unwrap(),
    }
}

#[tokio::test]
async fn gateway_requests_are_attributed_once_in_request_logs() {
    let port = start_attribution_upstream().await;
    let (db, path) = open_temp_db();
    let provider = create_provider_at(&db, &format!("http://127.0.0.1:{port}"));
    let key = create_gateway_key(&db, &provider.id, "sk-real");

    // A closed explicit HTTP proxy makes the transport fail deterministically,
    // without relying on an unused upstream port (a system proxy could answer
    // that port with its own 502 response).
    let broken_proxy_port = closed_local_port();
    let broken_provider = db
        .provider_create(&CreateProviderInput {
            request_headers: None,
            wallet_balance_script: None,
            name: "broken-provider".to_string(),
            base_url: format!("http://127.0.0.1:{port}"),
            http_proxy: Some(format!("http://127.0.0.1:{broken_proxy_port}")),
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
        .expect("create broken provider");
    let broken_key = create_gateway_key(&db, &broken_provider.id, "sk-broken");

    // Two gateway outlets share one key but keep separate local tokens.
    let first = gateway_create_inner(&db, "first", &provider.id, &key.id, None).unwrap();
    let second = gateway_create_inner(&db, "second", &provider.id, &key.id, None).unwrap();
    let broken =
        gateway_create_inner(&db, "broken", &broken_provider.id, &broken_key.id, None).unwrap();

    let state = build_proxy_state(db);

    // 1. HTTP success with measured usage.
    let response = proxy_handler(
        AxumState(state.clone()),
        gateway_request(
            &first.session_token,
            "/v1/messages",
            Some(r#"{"model":"client-model","max_tokens":8}"#),
        ),
    )
    .await
    .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    assert!(String::from_utf8_lossy(&body).contains("json-model"));

    // 2. HTTP upstream error (500) through the other outlet sharing the key.
    let response = proxy_handler(
        AxumState(state.clone()),
        gateway_request(&second.session_token, "/v1/fail", Some(r#"{"model":"m"}"#)),
    )
    .await
    .unwrap();
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);

    // 3. Transport failure (closed port) through a different provider/key.
    let response = proxy_handler(
        AxumState(state.clone()),
        gateway_request(
            &broken.session_token,
            "/v1/messages",
            Some(r#"{"model":"m"}"#),
        ),
    )
    .await;
    let response = response.expect_err("explicit closed proxy must be a transport failure");
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);

    // 4. SSE success with measured usage.
    let response = proxy_handler(
        AxumState(state.clone()),
        gateway_request(
            &first.session_token,
            "/v1/stream",
            Some(r#"{"model":"m","stream":true}"#),
        ),
    )
    .await
    .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    assert!(String::from_utf8_lossy(&body).contains("message_stop"));

    // 5. SSE cancelled after the first event: one transport_error row, no
    // duplicate when the body is dropped.
    let response = proxy_handler(
        AxumState(state.clone()),
        gateway_request(
            &first.session_token,
            "/v1/slow",
            Some(r#"{"model":"m","stream":true}"#),
        ),
    )
    .await
    .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    {
        use futures::StreamExt;
        let mut stream = response.into_body().into_data_stream();
        let first_chunk = stream.next().await.expect("first SSE chunk");
        assert!(first_chunk.is_ok());
        drop(stream);
    }

    // Give the drop-driven recorder a bounded moment, then assert.
    let mut rows = Vec::new();
    for _ in 0..50 {
        rows = state.db.lock().unwrap().request_log_list_all().unwrap();
        if rows.len() >= 5 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(rows.len(), 5, "one row per inference request: {rows:?}");

    // request_id is unique and present on every row.
    let request_ids: std::collections::HashSet<_> = rows
        .iter()
        .filter_map(|row| row.request_id.clone())
        .collect();
    assert_eq!(request_ids.len(), 5);

    let first_rows: Vec<_> = rows
        .iter()
        .filter(|row| row.session_id.as_deref() == Some(first.session_token.as_str()))
        .collect();
    let second_rows: Vec<_> = rows
        .iter()
        .filter(|row| row.session_id.as_deref() == Some(second.session_token.as_str()))
        .collect();
    let broken_rows: Vec<_> = rows
        .iter()
        .filter(|row| row.session_id.as_deref() == Some(broken.session_token.as_str()))
        .collect();
    assert_eq!(first_rows.len(), 3);
    assert_eq!(second_rows.len(), 1);
    assert_eq!(broken_rows.len(), 1);

    for row in &first_rows {
        assert_eq!(row.provider_id.as_deref(), Some(provider.id.as_str()));
        assert_eq!(row.api_key_id.as_deref(), Some(key.id.as_str()));
    }
    assert_eq!(
        second_rows[0].provider_id.as_deref(),
        Some(provider.id.as_str())
    );
    assert_eq!(second_rows[0].api_key_id.as_deref(), Some(key.id.as_str()));
    assert_eq!(
        broken_rows[0].provider_id.as_deref(),
        Some(broken_provider.id.as_str())
    );
    assert_eq!(
        broken_rows[0].api_key_id.as_deref(),
        Some(broken_key.id.as_str())
    );

    let outcome_counts = |outcome: &str| {
        rows.iter()
            .filter(|row| row.outcome.as_deref() == Some(outcome))
            .count()
    };
    assert_eq!(outcome_counts("success"), 2);
    assert_eq!(outcome_counts("upstream_error"), 1);
    assert_eq!(outcome_counts("transport_error"), 2);

    // Measured usage only: no fabricated tokens on failures; successful rows
    // carry the usage the upstream reported.
    let success_rows: Vec<_> = rows
        .iter()
        .filter(|row| row.outcome.as_deref() == Some("success"))
        .collect();
    let json_success = success_rows
        .iter()
        .find(|row| row.model.as_deref() == Some("json-model"))
        .expect("json success row");
    assert_eq!(json_success.input_tokens, 10);
    assert_eq!(json_success.output_tokens, 5);
    let stream_success = success_rows
        .iter()
        .find(|row| row.model.as_deref() == Some("stream-model"))
        .expect("stream success row");
    assert_eq!(stream_success.input_tokens, 7);
    assert_eq!(stream_success.output_tokens, 3);
    assert!(
        stream_success.first_token_ms.is_some(),
        "stream row should carry measured token timing: {stream_success:?}"
    );
    assert!(stream_success.last_token_ms.is_some());
    for row in rows
        .iter()
        .filter(|row| row.outcome.as_deref() != Some("success"))
    {
        // No fabricated output or TTFT on a failed request. A cancelled stream
        // may still carry the input tokens the upstream already reported
        // before the disconnect; nothing is invented for it.
        assert_eq!(
            row.output_tokens, 0,
            "no fabricated output on failure: {row:?}"
        );
        assert!(row.first_token_ms.is_none());
        assert!(row.last_token_ms.is_none());
        let cancelled_stream = row
            .error_message
            .as_deref()
            .is_some_and(|message| message.contains("disconnect"));
        if cancelled_stream {
            assert_eq!(row.input_tokens, 7);
        } else {
            assert_eq!(
                row.input_tokens, 0,
                "no fabricated input on failure: {row:?}"
            );
        }
    }

    // Provider/key resource statistics read the same attribution.
    let provider_stats = state
        .db
        .lock()
        .unwrap()
        .request_log_get_resource_statistics("all", Some(&provider.id), Some(&key.id))
        .unwrap();
    assert_eq!(provider_stats.summary.total_requests, 4);
    assert_eq!(provider_stats.summary.successful_requests, 2);
    assert_eq!(provider_stats.summary.failed_requests, 2);
    let broken_stats = state
        .db
        .lock()
        .unwrap()
        .request_log_get_resource_statistics("all", Some(&broken_provider.id), Some(&broken_key.id))
        .unwrap();
    assert_eq!(broken_stats.summary.total_requests, 1);
    assert_eq!(broken_stats.summary.failed_requests, 1);

    // Non-inference model discovery is not written as billed inference.
    let rows_before_models = rows.len();
    let models_response = proxy_handler(
        AxumState(state.clone()),
        gateway_request(&first.session_token, "/models", None),
    )
    .await;
    assert!(
        models_response.is_ok(),
        "/models should be answered through the gateway connection"
    );
    let rows_after_models = state.db.lock().unwrap().request_log_list_all().unwrap();
    assert_eq!(
        rows_after_models.len(),
        rows_before_models,
        "a successful /models call must not become an inference request log"
    );
    remove_temp_db(&path);
}

#[tokio::test]
async fn gateway_catalogue_pagination_continues_and_dedupes_ids() {
    let queries: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let capture = queries.clone();
    let handler = move |req: Request<Body>| {
        let capture = capture.clone();
        async move {
            let query = req.uri().query().unwrap_or("").to_string();
            capture.lock().unwrap().push(query.clone());
            if query.contains("after_id=") {
                (
                    StatusCode::OK,
                    r#"{"data":[{"id":"b"},{"id":"a"}],"has_more":false}"#,
                )
            } else {
                (
                    StatusCode::OK,
                    r#"{"data":[{"id":"a"}],"has_more":true,"last_id":"a"}"#,
                )
            }
        }
    };
    let app = Router::new().route("/v1/models", get(handler));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    tokio::time::sleep(std::time::Duration::from_millis(10)).await;

    let (db, path) = open_temp_db();
    let provider = create_provider_at(&db, &format!("http://127.0.0.1:{port}"));
    let key = create_gateway_key(&db, &provider.id, "sk-real");
    let gateway = gateway_create_inner(&db, "outlet", &provider.id, &key.id, None).unwrap();
    let state = build_proxy_state(db);
    let response = proxy_handler(
        AxumState(state),
        Request::builder()
            .uri("/models")
            .method("GET")
            .header("authorization", format!("Bearer {}", gateway.session_token))
            .body(Body::empty())
            .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let ids: Vec<_> = body["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["id"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(ids, vec!["a".to_string(), "b".to_string()]);
    assert_eq!(body["has_more"], serde_json::json!(false));

    let queries = queries.lock().unwrap().clone();
    assert_eq!(queries.len(), 2, "one page per cursor: {queries:?}");
    assert!(queries[0].contains("limit="));
    assert!(queries[1].contains("after_id=a"));
    remove_temp_db(&path);
}

#[test]
fn gateway_policy_persists_omitted_updates_keep_it_and_corrupt_data_never_opens_access() {
    use cc_use_lib::commands::gateways::{
        gateway_create_with_policy_inner, gateway_update_with_policy_inner,
    };
    use cc_use_lib::models::GatewayModelPolicy;
    let fixture = TempDb::new();
    let provider = support::create_provider(&fixture.db, "p", "custom");
    let key = support::create_api_key(&fixture.db, &provider.id, "claude_code");
    let policy = GatewayModelPolicy::Selected {
        model_ids: vec!["one".into(), "one".into()],
    };
    let gateway = gateway_create_with_policy_inner(
        &fixture.db,
        "restricted",
        &provider.id,
        &key.id,
        None,
        Some(&policy),
    )
    .unwrap();
    assert_eq!(
        gateway.model_policy,
        GatewayModelPolicy::Selected {
            model_ids: vec!["one".into()]
        }
    );
    let key2 = support::create_api_key(&fixture.db, &provider.id, "claude_code");
    let updated = gateway_update_inner(
        &fixture.db,
        &gateway.session_token,
        None,
        None,
        Some(&key2.id),
        None,
        None,
    )
    .unwrap();
    assert_eq!(updated.model_policy, gateway.model_policy);
    assert_eq!(updated.session_token, gateway.session_token);
    assert!(gateway_update_with_policy_inner(
        &fixture.db,
        &gateway.session_token,
        None,
        None,
        None,
        None,
        None,
        Some(&GatewayModelPolicy::Selected { model_ids: vec![] })
    )
    .is_err());
    assert_eq!(
        fixture
            .db
            .gateway_get(&gateway.session_token)
            .unwrap()
            .unwrap()
            .model_policy,
        gateway.model_policy
    );
    fixture
        .db
        .conn
        .execute(
            "UPDATE proxy_sessions SET gateway_model_policy=NULL WHERE session_token=?1",
            [&gateway.session_token],
        )
        .unwrap();
    assert_eq!(
        fixture
            .db
            .gateway_get(&gateway.session_token)
            .unwrap()
            .unwrap()
            .model_policy,
        GatewayModelPolicy::All
    );
    fixture
        .db
        .conn
        .execute(
            "UPDATE proxy_sessions SET gateway_model_policy=?1 WHERE session_token=?2",
            rusqlite::params![
                r#"{"mode":"selected","modelIds":[]}"#,
                gateway.session_token
            ],
        )
        .unwrap();
    assert!(fixture.db.gateway_get(&gateway.session_token).is_err());
    assert!(fixture
        .db
        .proxy_session_get(&gateway.session_token)
        .is_err());
}

#[tokio::test]
async fn selected_gateway_publishes_only_selected_models_and_blocks_unverifiable_requests_before_upstream(
) {
    use cc_use_lib::commands::gateways::gateway_create_with_policy_inner;
    use cc_use_lib::models::GatewayModelPolicy;
    let captured = Arc::new(Mutex::new(Vec::<(String, String)>::new()));
    let capture = captured.clone();
    let app = Router::new().fallback(any(move |request: Request<Body>| {
        let capture = capture.clone();
        async move {
            let path = request.uri().to_string();
            let bytes = axum::body::to_bytes(request.into_body(), 1024 * 1024)
                .await
                .unwrap();
            capture
                .lock()
                .unwrap()
                .push((path, String::from_utf8(bytes.to_vec()).unwrap()));
            (
                StatusCode::OK,
                [("content-type", "application/json")],
                r#"{"choices":[]}"#,
            )
        }
    }));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let (db, path) = open_temp_db();
    let provider = create_provider_at(&db, &format!("http://127.0.0.1:{port}"));
    let key = create_gateway_key(&db, &provider.id, "sk-test");
    let gateway = gateway_create_with_policy_inner(
        &db,
        "limited",
        &provider.id,
        &key.id,
        None,
        Some(&GatewayModelPolicy::Selected {
            model_ids: vec!["allowed".into(), "old-id".into()],
        }),
    )
    .unwrap();
    let state = build_proxy_state(db);
    for discovery in [
        "/models",
        "/v1/models",
        "/claude/v1/models",
        "/openai/v1/models",
        "/claude-desktop/v1/models",
    ] {
        let response = proxy_handler(
            AxumState(state.clone()),
            gateway_request(&gateway.session_token, discovery, None),
        )
        .await
        .unwrap();
        let body = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            value["data"]
                .as_array()
                .unwrap()
                .iter()
                .map(|m| m["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["allowed", "old-id"]
        );
    }
    assert!(
        captured.lock().unwrap().is_empty(),
        "selected discovery must not query upstream"
    );
    for body in [
        r#"{"model":"other"}"#,
        r#"{"model":"allowed","model":"other"}"#,
        r#"{"model":null}"#,
        r#"{"nested":{"model":"allowed"}}"#,
        r#"{"model":"Allowed"}"#,
        r#"{"model":"allowed","model":"allowed"}"#,
        r#"{"model":"allowed","\u006dodel":"other"}"#,
    ] {
        let request = Request::builder()
            .method("POST")
            .uri("/v1/responses")
            .header("authorization", format!("Bearer {}", gateway.session_token))
            .header("content-type", "application/json")
            .body(Body::from(body))
            .unwrap();
        let response = proxy_handler(AxumState(state.clone()), request)
            .await
            .unwrap_err();
        assert!(response.status().is_client_error(), "{body}");
    }
    for (method, path, content_type, extra) in [
        ("POST", "/v1/%72esponses", "application/json", None),
        ("POST", "/v1/responses/", "application/json", None),
        ("POST", "/v1/v1/responses", "application/json", None),
        ("POST", "/v1//responses", "application/json", None),
        ("POST", "/v1/batches", "application/json", None),
        ("POST", "/v1/responses/id", "application/json", None),
        (
            "POST",
            "/v1/responses?model=other",
            "application/json",
            None,
        ),
        (
            "POST",
            "/v1/responses?%6dodel=other",
            "application/json",
            None,
        ),
        ("DELETE", "/v1/responses", "application/json", None),
        ("POST", "/v1/responses", "multipart/form-data", None),
        (
            "POST",
            "/v1/responses",
            "application/json",
            Some(("content-encoding", "gzip")),
        ),
        (
            "GET",
            "/v1/realtime",
            "application/json",
            Some(("upgrade", "websocket")),
        ),
    ] {
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header("authorization", format!("Bearer {}", gateway.session_token))
            .header("content-type", content_type);
        if let Some((name, value)) = extra {
            request = request.header(name, value);
        }
        let response = proxy_handler(
            AxumState(state.clone()),
            request.body(Body::from(r#"{"model":"allowed"}"#)).unwrap(),
        )
        .await
        .unwrap_err();
        assert!(response.status().is_client_error(), "{path}");
    }
    assert!(
        captured.lock().unwrap().is_empty(),
        "rejected requests must have zero upstream hits"
    );
    let raw = r#"{ "model": "allowed", "messages": [], "nested": {"model":"other"} }"#;
    let response = proxy_handler(
        AxumState(state.clone()),
        gateway_request(&gateway.session_token, "/chat/completions?x=1", Some(raw)),
    )
    .await
    .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        captured.lock().unwrap()[0],
        ("/v1/chat/completions?x=1".into(), raw.into()),
        "allowed JSON stays byte-for-byte unchanged"
    );
    // Every accepted inference alias must reach exactly the classified standard
    // endpoint, not an unverified path containing a nested client prefix.
    for endpoint in [
        "chat/completions",
        "completions",
        "responses",
        "responses/compact",
        "messages",
        "messages/count_tokens",
        "embeddings",
        "rerank",
    ] {
        for prefix in ["", "/v1", "/claude/v1", "/openai/v1", "/claude-desktop/v1"] {
            let request_path = format!("{prefix}/{endpoint}?x=2");
            let response = proxy_handler(
                AxumState(state.clone()),
                gateway_request(&gateway.session_token, &request_path, Some(raw)),
            )
            .await
            .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let _ = axum::body::to_bytes(response.into_body(), 1024 * 1024)
                .await
                .unwrap();
            assert_eq!(
                captured.lock().unwrap().last().unwrap(),
                &(format!("/v1/{endpoint}?x=2"), raw.to_string()),
                "{request_path}"
            );
        }
    }
    task.abort();
    drop(state);
    remove_temp_db(&path);
}

#[tokio::test]
async fn selected_gateway_allows_approved_sse_to_finish_after_a_policy_change() {
    use cc_use_lib::commands::gateways::{
        gateway_create_with_policy_inner, gateway_update_with_policy_inner,
    };
    use cc_use_lib::models::GatewayModelPolicy;
    let captured = Arc::new(Mutex::new(None));
    let capture = captured.clone();
    let app=Router::new().route("/v1/chat/completions",post(move |request:Request<Body>| {let capture=capture.clone(); async move {
        let bytes=axum::body::to_bytes(request.into_body(),1024*1024).await.unwrap(); *capture.lock().unwrap()=Some(bytes);
        (StatusCode::OK,[("content-type","text/event-stream")],"data: {\"model\":\"allowed\",\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\ndata: [DONE]\n\n")
    }}));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let (db, path) = open_temp_db();
    let provider = create_provider_at(&db, &format!("http://127.0.0.1:{port}"));
    let key = create_gateway_key(&db, &provider.id, "sk-test");
    let gateway = gateway_create_with_policy_inner(
        &db,
        "limited-sse",
        &provider.id,
        &key.id,
        None,
        Some(&GatewayModelPolicy::Selected {
            model_ids: vec!["allowed".into()],
        }),
    )
    .unwrap();
    let state = build_proxy_state(db);
    let raw = r#"{ "model":"allowed", "stream":true, "messages":[] }"#;
    let response = proxy_handler(
        AxumState(state.clone()),
        gateway_request(&gateway.session_token, "/chat/completions", Some(raw)),
    )
    .await
    .unwrap();
    assert_eq!(response.headers()["content-type"], "text/event-stream");
    {
        let db = state.db.lock().unwrap();
        gateway_update_with_policy_inner(
            &db,
            &gateway.session_token,
            None,
            None,
            None,
            None,
            None,
            Some(&GatewayModelPolicy::Selected {
                model_ids: vec!["different".into()],
            }),
        )
        .unwrap();
    }
    let body = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    assert!(String::from_utf8_lossy(&body).contains("hello"));
    assert!(String::from_utf8_lossy(&body).contains("[DONE]"));
    assert_eq!(
        captured.lock().unwrap().as_ref().unwrap().as_ref(),
        raw.as_bytes()
    );
    let response = proxy_handler(
        AxumState(state.clone()),
        gateway_request(&gateway.session_token, "/chat/completions", Some(raw)),
    )
    .await
    .unwrap_err();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    task.abort();
    drop(state);
    remove_temp_db(&path);
}

#[test]
fn legacy_gateway_schema_gains_policy_and_provider_inventory_without_rewriting_bindings() {
    use cc_use_lib::models::GatewayModelPolicy;
    let (db, path) = open_temp_db();
    let provider = create_provider_at(&db, "https://example.test");
    let key = create_gateway_key(&db, &provider.id, "sk-test");
    let gateway = gateway_create_inner(
        &db,
        "legacy",
        &provider.id,
        &key.id,
        Some(&connection_config(
            Some("https://relay.test"),
            "x-api-key",
            Some("legacy/1"),
        )),
    )
    .unwrap();
    db.conn.execute_batch("ALTER TABLE proxy_sessions DROP COLUMN gateway_model_policy; DROP TABLE provider_model_catalogs;").unwrap();
    drop(db);
    for _ in 0..2 {
        let reopened = Database::open_at(&path).unwrap();
        let loaded = reopened
            .gateway_get(&gateway.session_token)
            .unwrap()
            .unwrap();
        assert_eq!(loaded.model_policy, GatewayModelPolicy::All);
        assert_eq!(loaded.provider_id, provider.id);
        assert_eq!(loaded.api_key_id, key.id);
        assert_eq!(loaded.connection_config, gateway.connection_config);
        assert_eq!(loaded.display_name, "legacy");
        assert_eq!(
            reopened
                .provider_model_catalog_get(&provider.id)
                .unwrap()
                .revision,
            0
        );
        assert_eq!(
            reopened.api_key_get(&key.id).unwrap().unwrap().value,
            "sk-test"
        );
    }
    remove_temp_db(&path);
}
