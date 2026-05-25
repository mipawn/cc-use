mod support;

use axum::body::Body;
use axum::extract::State as AxumState;
use axum::http::{Request, StatusCode};
use axum::response::IntoResponse;
use axum::routing::post;
use axum::Router;
use cc_use_lib::db::Database;
use cc_use_lib::proxy::handler::proxy_handler;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use support::{build_proxy_state, create_api_key, create_proxy_session};
use tokio::net::TcpListener;

struct MockUpstream {
    port: u16,
    received_headers: Arc<Mutex<HashMap<String, String>>>,
}

async fn start_mock_upstream() -> MockUpstream {
    let received_headers: Arc<Mutex<HashMap<String, String>>> = Arc::new(Mutex::new(HashMap::new()));
    let headers_clone = received_headers.clone();

    let app = Router::new()
        .route(
            "/v1/messages",
            post(move |req: Request<Body>| {
                let hc = headers_clone.clone();
                async move {
                    let mut map = hc.lock().unwrap();
                    for (name, value) in req.headers() {
                        if let Ok(v) = value.to_str() {
                            map.insert(name.as_str().to_string(), v.to_string());
                        }
                    }
                    (StatusCode::OK, r#"{"type":"message","content":[]}"#).into_response()
                }
            }),
        );

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    // Give the server a moment to start accepting connections
    tokio::time::sleep(std::time::Duration::from_millis(10)).await;

    MockUpstream {
        port,
        received_headers,
    }
}

fn setup_session_with_type(
    provider_type: &str,
    upstream_port: u16,
) -> (Arc<cc_use_lib::proxy::ProxyState>, String) {
    let path = std::env::temp_dir().join(format!("cc-use-proxy-auth-type-{}.db", nanoid::nanoid!(8)));
    let db = Database::open_at(&path).expect("create temp database");

    let provider = db
        .provider_create(&cc_use_lib::models::CreateProviderInput {
            name: format!("{}-provider", provider_type),
            base_url: format!("http://127.0.0.1:{}", upstream_port),
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
        })
        .expect("create provider");

    let api_key = create_api_key(&db, &provider.id, provider_type);
    let session_token = format!("session-{}", nanoid::nanoid!(16));
    create_proxy_session(&db, &session_token, &provider.id, &api_key.id, None);

    let state = build_proxy_state(db);
    (state, session_token)
}

#[tokio::test]
async fn claude_provider_only_sends_x_api_key() {
    let mock = start_mock_upstream().await;
    let (state, session_token) = setup_session_with_type("claude", mock.port);

    let request = Request::builder()
        .method("POST")
        .uri("/v1/messages")
        .header("authorization", format!("Bearer {}", session_token))
        .header("content-type", "application/json")
        .body(Body::from(r#"{"model":"claude-sonnet-4-6","messages":[]}"#))
        .unwrap();

    let response = proxy_handler(AxumState(state), request).await;
    assert!(response.is_ok(), "proxy should forward successfully");

    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let headers = mock.received_headers.lock().unwrap();
    assert_eq!(headers.get("x-api-key").map(|s| s.as_str()), Some("sk-claude"));
    assert!(!headers.contains_key("authorization"), "authorization header should be removed for claude provider");
}

#[tokio::test]
async fn codex_provider_only_sends_authorization_bearer() {
    let mock = start_mock_upstream().await;
    let (state, session_token) = setup_session_with_type("codex", mock.port);

    let request = Request::builder()
        .method("POST")
        .uri("/v1/messages")
        .header("authorization", format!("Bearer {}", session_token))
        .header("content-type", "application/json")
        .body(Body::from(r#"{"model":"gpt-4","messages":[]}"#))
        .unwrap();

    let response = proxy_handler(AxumState(state), request).await;
    assert!(response.is_ok(), "proxy should forward successfully");

    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let headers = mock.received_headers.lock().unwrap();
    assert_eq!(headers.get("authorization").map(|s| s.as_str()), Some("Bearer sk-codex"));
    assert!(!headers.contains_key("x-api-key"), "x-api-key header should be removed for codex provider");
}

#[tokio::test]
async fn provider_type_none_defaults_to_x_api_key() {
    let mock = start_mock_upstream().await;

    let path = std::env::temp_dir().join(format!("cc-use-proxy-auth-none-{}.db", nanoid::nanoid!(8)));
    let db = Database::open_at(&path).expect("create temp database");

    let provider = db
        .provider_create(&cc_use_lib::models::CreateProviderInput {
            name: "no-type-provider".to_string(),
            base_url: format!("http://127.0.0.1:{}", mock.port),
            provider_type: None,
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
        })
        .expect("create provider");

    let api_key = create_api_key(&db, &provider.id, "claude");
    let session_token = format!("session-{}", nanoid::nanoid!(16));
    create_proxy_session(&db, &session_token, &provider.id, &api_key.id, None);

    let state = build_proxy_state(db);

    let request = Request::builder()
        .method("POST")
        .uri("/v1/messages")
        .header("authorization", format!("Bearer {}", session_token))
        .header("content-type", "application/json")
        .body(Body::from(r#"{"model":"claude-sonnet-4-6","messages":[]}"#))
        .unwrap();

    let response = proxy_handler(AxumState(state), request).await;
    assert!(response.is_ok(), "proxy should forward successfully");

    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let headers = mock.received_headers.lock().unwrap();
    assert_eq!(headers.get("x-api-key").map(|s| s.as_str()), Some("sk-claude"));
    assert!(!headers.contains_key("authorization"), "authorization header should be removed when provider_type is None");
}
