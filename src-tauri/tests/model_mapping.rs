mod support;

use axum::body::Body;
use axum::extract::State as AxumState;
use axum::http::{Request, StatusCode};
use axum::response::IntoResponse;
use axum::routing::post;
use axum::Router;
use cc_use_lib::db::Database;
use cc_use_lib::models::CreateApiKeyInput;
use cc_use_lib::proxy::handler::proxy_handler;
use std::sync::{Arc, Mutex};
use support::{build_proxy_state, create_proxy_session};
use tokio::net::TcpListener;

struct MockUpstream {
    port: u16,
    received_body: Arc<Mutex<String>>,
}

async fn start_mock_upstream() -> MockUpstream {
    let received_body: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let body_clone = received_body.clone();

    let app = Router::new().route(
        "/v1/messages",
        post(move |body: String| {
            let bc = body_clone.clone();
            async move {
                *bc.lock().unwrap() = body;
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

    MockUpstream {
        port,
        received_body,
    }
}

fn setup_provider_with_mapping(
    upstream_port: u16,
    provider_type: &str,
    model_mapping: Option<&str>,
) -> (Arc<cc_use_lib::proxy::ProxyState>, String) {
    let path = std::env::temp_dir().join(format!("cc-use-model-map-{}.db", nanoid::nanoid!(8)));
    let db = Database::open_at(&path).expect("create temp database");

    let provider = db
        .provider_create(&cc_use_lib::models::CreateProviderInput {
            name: "test-provider".to_string(),
            base_url: format!("http://127.0.0.1:{}", upstream_port),
            http_proxy: None,
            provider_type: Some(provider_type.to_string()),
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
            alias: Some(format!("{}-key", provider_type)),
            value: format!("sk-{}", provider_type),
            types: None,
            priority: Some(0),
            is_active: Some(true),
            config: None,
            cost_multiplier: None,
            usage_type: None,
            usage_url: None,
            usage_path: None,
            usage_headers: None,
            model_mapping: model_mapping.map(|s| s.to_string()),
            api_format: None,
            transform_enabled: None,
            client_configs: None,
        })
        .expect("create api key");

    let session_token = format!("session-{}", nanoid::nanoid!(16));
    create_proxy_session(&db, &session_token, &provider.id, &api_key.id, None);

    let state = build_proxy_state(db);
    (state, session_token)
}

fn extract_model(body: &str) -> String {
    let json: serde_json::Value = serde_json::from_str(body).expect("valid json");
    json["model"].as_str().unwrap().to_string()
}

// ── semantic category mapping ──

#[tokio::test]
async fn sonnet_category_maps_all_sonnet_variants() {
    let mock = start_mock_upstream().await;
    let mapping = r#"{"sonnet":"anthropic.claude-sonnet-4-6"}"#;
    let (state, session_token) = setup_provider_with_mapping(mock.port, "claude", Some(mapping));

    let request = Request::builder()
        .method("POST")
        .uri("/v1/messages")
        .header("authorization", format!("Bearer {}", session_token))
        .header("content-type", "application/json")
        .body(Body::from(
            r#"{"model":"claude-sonnet-4-5-20250929","messages":[]}"#,
        ))
        .unwrap();

    let response = proxy_handler(AxumState(state), request).await;
    assert!(response.is_ok());

    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let body = mock.received_body.lock().unwrap();
    assert_eq!(extract_model(&body), "anthropic.claude-sonnet-4-6");
}

#[tokio::test]
async fn haiku_category_maps_haiku_variants() {
    let mock = start_mock_upstream().await;
    let mapping = r#"{"haiku":"anthropic.claude-haiku-4-5"}"#;
    let (state, session_token) = setup_provider_with_mapping(mock.port, "claude", Some(mapping));

    let request = Request::builder()
        .method("POST")
        .uri("/v1/messages")
        .header("authorization", format!("Bearer {}", session_token))
        .header("content-type", "application/json")
        .body(Body::from(
            r#"{"model":"claude-haiku-4-5-20251001","messages":[]}"#,
        ))
        .unwrap();

    let response = proxy_handler(AxumState(state), request).await;
    assert!(response.is_ok());

    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let body = mock.received_body.lock().unwrap();
    assert_eq!(extract_model(&body), "anthropic.claude-haiku-4-5");
}

#[tokio::test]
async fn opus_category_maps_opus_variants() {
    let mock = start_mock_upstream().await;
    let mapping = r#"{"opus":"anthropic.claude-opus-4-7"}"#;
    let (state, session_token) = setup_provider_with_mapping(mock.port, "claude", Some(mapping));

    let request = Request::builder()
        .method("POST")
        .uri("/v1/messages")
        .header("authorization", format!("Bearer {}", session_token))
        .header("content-type", "application/json")
        .body(Body::from(
            r#"{"model":"claude-opus-4-7-20250514","messages":[]}"#,
        ))
        .unwrap();

    let response = proxy_handler(AxumState(state), request).await;
    assert!(response.is_ok());

    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let body = mock.received_body.lock().unwrap();
    assert_eq!(extract_model(&body), "anthropic.claude-opus-4-7");
}

#[tokio::test]
async fn default_model_fallback_when_no_category_match() {
    let mock = start_mock_upstream().await;
    let mapping =
        r#"{"sonnet":"anthropic.claude-sonnet-4-6","default":"anthropic.claude-haiku-4-5"}"#;
    let (state, session_token) = setup_provider_with_mapping(mock.port, "claude", Some(mapping));

    let request = Request::builder()
        .method("POST")
        .uri("/v1/messages")
        .header("authorization", format!("Bearer {}", session_token))
        .header("content-type", "application/json")
        .body(Body::from(
            r#"{"model":"some-unknown-model","messages":[]}"#,
        ))
        .unwrap();

    let response = proxy_handler(AxumState(state), request).await;
    assert!(response.is_ok());

    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let body = mock.received_body.lock().unwrap();
    assert_eq!(extract_model(&body), "anthropic.claude-haiku-4-5");
}

#[tokio::test]
async fn case_insensitive_matching() {
    let mock = start_mock_upstream().await;
    let mapping = r#"{"sonnet":"anthropic.claude-sonnet-4-6"}"#;
    let (state, session_token) = setup_provider_with_mapping(mock.port, "claude", Some(mapping));

    let request = Request::builder()
        .method("POST")
        .uri("/v1/messages")
        .header("authorization", format!("Bearer {}", session_token))
        .header("content-type", "application/json")
        .body(Body::from(r#"{"model":"Claude-SONNET-4-5","messages":[]}"#))
        .unwrap();

    let response = proxy_handler(AxumState(state), request).await;
    assert!(response.is_ok());

    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let body = mock.received_body.lock().unwrap();
    assert_eq!(extract_model(&body), "anthropic.claude-sonnet-4-6");
}

#[tokio::test]
async fn model_mapping_null_no_rewrite() {
    let mock = start_mock_upstream().await;
    let (state, session_token) = setup_provider_with_mapping(mock.port, "claude", None);

    let request = Request::builder()
        .method("POST")
        .uri("/v1/messages")
        .header("authorization", format!("Bearer {}", session_token))
        .header("content-type", "application/json")
        .body(Body::from(r#"{"model":"claude-sonnet-4-6","messages":[]}"#))
        .unwrap();

    let response = proxy_handler(AxumState(state), request).await;
    assert!(response.is_ok());

    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let body = mock.received_body.lock().unwrap();
    assert_eq!(extract_model(&body), "claude-sonnet-4-6");
}

#[tokio::test]
async fn codex_provider_skips_model_mapping() {
    let mock = start_mock_upstream().await;
    let mapping = r#"{"sonnet":"should-not-apply"}"#;
    let (state, session_token) = setup_provider_with_mapping(mock.port, "codex", Some(mapping));

    let request = Request::builder()
        .method("POST")
        .uri("/v1/messages")
        .header("authorization", format!("Bearer {}", session_token))
        .header("content-type", "application/json")
        .body(Body::from(r#"{"model":"claude-sonnet-4-6","messages":[]}"#))
        .unwrap();

    let response = proxy_handler(AxumState(state), request).await;
    assert!(response.is_ok());

    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let body = mock.received_body.lock().unwrap();
    assert_eq!(extract_model(&body), "claude-sonnet-4-6");
}

// ── [1M] suffix stripping ──

#[tokio::test]
async fn strips_one_m_suffix_before_upstream() {
    let mock = start_mock_upstream().await;
    let (state, session_token) = setup_provider_with_mapping(mock.port, "claude", None);

    let request = Request::builder()
        .method("POST")
        .uri("/v1/messages")
        .header("authorization", format!("Bearer {}", session_token))
        .header("content-type", "application/json")
        .body(Body::from(
            r#"{"model":"claude-sonnet-4-6[1M]","messages":[]}"#,
        ))
        .unwrap();

    let response = proxy_handler(AxumState(state), request).await;
    assert!(response.is_ok());

    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let body = mock.received_body.lock().unwrap();
    assert_eq!(extract_model(&body), "claude-sonnet-4-6");
}

#[tokio::test]
async fn strips_one_m_suffix_after_mapping() {
    let mock = start_mock_upstream().await;
    let mapping = r#"{"sonnet":"deepseek-v4-pro [1M]"}"#;
    let (state, session_token) = setup_provider_with_mapping(mock.port, "claude", Some(mapping));

    let request = Request::builder()
        .method("POST")
        .uri("/v1/messages")
        .header("authorization", format!("Bearer {}", session_token))
        .header("content-type", "application/json")
        .body(Body::from(r#"{"model":"claude-sonnet-4-6","messages":[]}"#))
        .unwrap();

    let response = proxy_handler(AxumState(state), request).await;
    assert!(response.is_ok());

    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let body = mock.received_body.lock().unwrap();
    assert_eq!(extract_model(&body), "deepseek-v4-pro");
}

#[tokio::test]
async fn one_m_suffix_case_insensitive() {
    let mock = start_mock_upstream().await;
    let (state, session_token) = setup_provider_with_mapping(mock.port, "claude", None);

    let request = Request::builder()
        .method("POST")
        .uri("/v1/messages")
        .header("authorization", format!("Bearer {}", session_token))
        .header("content-type", "application/json")
        .body(Body::from(
            r#"{"model":"claude-sonnet-4-6[1m]","messages":[]}"#,
        ))
        .unwrap();

    let response = proxy_handler(AxumState(state), request).await;
    assert!(response.is_ok());

    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let body = mock.received_body.lock().unwrap();
    assert_eq!(extract_model(&body), "claude-sonnet-4-6");
}
