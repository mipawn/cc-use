mod support;

use axum::body::Body;
use axum::extract::State as AxumState;
use axum::http::{Request, StatusCode};
use axum::response::IntoResponse;
use axum::routing::post;
use axum::Router;
use cc_use_lib::db::Database;
use cc_use_lib::models::{CreateApiKeyInput, ProxySession};
use cc_use_lib::proxy::handler::proxy_handler;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use support::{build_proxy_state, create_api_key, create_proxy_session};
use tokio::net::TcpListener;

struct MockUpstream {
    port: u16,
    received_headers: Arc<Mutex<HashMap<String, String>>>,
}

struct CodexMockUpstream {
    port: u16,
    received_headers: Arc<Mutex<HashMap<String, String>>>,
    received_body: Arc<Mutex<Option<serde_json::Value>>>,
}

async fn start_mock_upstream() -> MockUpstream {
    let received_headers: Arc<Mutex<HashMap<String, String>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let headers_clone = received_headers.clone();

    let app = Router::new().route(
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

async fn start_codex_mock_upstream() -> CodexMockUpstream {
    let received_headers: Arc<Mutex<HashMap<String, String>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let received_body: Arc<Mutex<Option<serde_json::Value>>> = Arc::new(Mutex::new(None));
    let chat_headers = received_headers.clone();
    let chat_body = received_body.clone();
    let responses_headers = received_headers.clone();
    let responses_body = received_body.clone();

    let app = Router::new()
        .route(
            "/v1/chat/completions",
            post(move |req: Request<Body>| {
                let hc = chat_headers.clone();
                let bc = chat_body.clone();
                async move {
                    {
                        let mut map = hc.lock().unwrap();
                        for (name, value) in req.headers() {
                            if let Ok(v) = value.to_str() {
                                map.insert(name.as_str().to_string(), v.to_string());
                            }
                        }
                    }
                    let body = axum::body::to_bytes(req.into_body(), 1024 * 1024)
                        .await
                        .unwrap();
                    *bc.lock().unwrap() = serde_json::from_slice(&body).ok();
                    (
                        StatusCode::OK,
                        r#"{"id":"chatcmpl-test","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}"#,
                    )
                        .into_response()
                }
            }),
        )
        .route(
            "/v1/responses",
            post(move |req: Request<Body>| {
                let hc = responses_headers.clone();
                let bc = responses_body.clone();
                async move {
                    {
                        let mut map = hc.lock().unwrap();
                        for (name, value) in req.headers() {
                            if let Ok(v) = value.to_str() {
                                map.insert(name.as_str().to_string(), v.to_string());
                            }
                        }
                    }
                    let body = axum::body::to_bytes(req.into_body(), 1024 * 1024)
                        .await
                        .unwrap();
                    *bc.lock().unwrap() = serde_json::from_slice(&body).ok();
                    (
                        StatusCode::OK,
                        r#"{"id":"resp-test","object":"response","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}"#,
                    )
                        .into_response()
                }
            }),
        );

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    tokio::time::sleep(std::time::Duration::from_millis(10)).await;

    CodexMockUpstream {
        port,
        received_headers,
        received_body,
    }
}

fn setup_session_with_type(
    provider_type: &str,
    upstream_port: u16,
) -> (Arc<cc_use_lib::proxy::ProxyState>, String) {
    let path =
        std::env::temp_dir().join(format!("cc-use-proxy-auth-type-{}.db", nanoid::nanoid!(8)));
    let db = Database::open_at(&path).expect("create temp database");

    let provider = db
        .provider_create(&cc_use_lib::models::CreateProviderInput {
            name: format!("{}-provider", provider_type),
            base_url: format!("http://127.0.0.1:{}", upstream_port),
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
        })
        .expect("create provider");

    let api_key = create_api_key(&db, &provider.id, provider_type);
    let session_token = format!("session-{}", nanoid::nanoid!(16));
    db.proxy_session_create(&ProxySession {
        session_token: session_token.clone(),
        provider_id: provider.id.clone(),
        api_key_id: api_key.id.clone(),
        project_id: None,
        created_at: chrono::Utc::now().to_rfc3339(),
        cli_type: Some(match provider_type {
            "codex" => "codex-app".to_string(),
            "claude" => "claude_code".to_string(),
            other => other.to_string(),
        }),
    })
    .expect("create proxy session");

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
    assert_eq!(
        headers.get("x-api-key").map(|s| s.as_str()),
        Some("sk-claude")
    );
    assert!(
        !headers.contains_key("authorization"),
        "authorization header should be removed for claude provider"
    );
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
    assert_eq!(
        headers.get("authorization").map(|s| s.as_str()),
        Some("Bearer sk-codex")
    );
    assert!(
        !headers.contains_key("x-api-key"),
        "x-api-key header should be removed for codex provider"
    );
}

#[tokio::test]
async fn provider_type_none_defaults_to_x_api_key() {
    let mock = start_mock_upstream().await;

    let path =
        std::env::temp_dir().join(format!("cc-use-proxy-auth-none-{}.db", nanoid::nanoid!(8)));
    let db = Database::open_at(&path).expect("create temp database");

    let provider = db
        .provider_create(&cc_use_lib::models::CreateProviderInput {
            name: "no-type-provider".to_string(),
            base_url: format!("http://127.0.0.1:{}", mock.port),
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
    assert_eq!(
        headers.get("x-api-key").map(|s| s.as_str()),
        Some("sk-claude")
    );
    assert!(
        !headers.contains_key("authorization"),
        "authorization header should be removed when provider_type is None"
    );
}

#[tokio::test]
async fn codex_app_responses_request_uses_session_and_passes_responses_through() {
    let mock = start_codex_mock_upstream().await;
    let path = std::env::temp_dir().join(format!(
        "cc-use-codex-app-responses-{}.db",
        nanoid::nanoid!(8)
    ));
    let db = Database::open_at(&path).expect("create temp database");

    let provider = db
        .provider_create(&cc_use_lib::models::CreateProviderInput {
            name: "openai-provider".to_string(),
            base_url: format!("http://127.0.0.1:{}/v1", mock.port),
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
        })
        .expect("create provider");

    let api_key = create_api_key(&db, &provider.id, "codex");
    let session_token = format!("session-{}", nanoid::nanoid!(16));
    db.proxy_session_create(&ProxySession {
        session_token: session_token.clone(),
        provider_id: provider.id.clone(),
        api_key_id: api_key.id.clone(),
        project_id: None,
        created_at: chrono::Utc::now().to_rfc3339(),
        cli_type: Some("codex-app".to_string()),
    })
    .expect("create proxy session");

    let state = build_proxy_state(db);
    let request = Request::builder()
        .method("POST")
        .uri("/v1/responses")
        .header("authorization", format!("Bearer {}", session_token))
        .header("content-type", "application/json")
        .body(Body::from(
            r#"{"model":"gpt-5.5","input":"hello","stream":false}"#,
        ))
        .unwrap();

    let response = proxy_handler(AxumState(state), request).await;
    assert!(response.is_ok(), "proxy should forward successfully");

    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let headers = mock.received_headers.lock().unwrap();
    assert_eq!(
        headers.get("authorization").map(|s| s.as_str()),
        Some("Bearer sk-codex")
    );
    assert!(
        !headers.contains_key("x-api-key"),
        "x-api-key header should be removed for OpenAI-style upstreams"
    );

    let body = mock.received_body.lock().unwrap();
    let body = body
        .as_ref()
        .expect("mock upstream should receive JSON body");
    assert_eq!(body["input"], "hello");
    assert!(body.get("messages").is_none());
}

#[tokio::test]
async fn codex_responses_request_with_legacy_session_type_passes_responses_through() {
    let mock = start_codex_mock_upstream().await;
    let path = std::env::temp_dir().join(format!("cc-use-codex-legacy-{}.db", nanoid::nanoid!(8)));
    let db = Database::open_at(&path).expect("create temp database");

    let provider = db
        .provider_create(&cc_use_lib::models::CreateProviderInput {
            name: "DeepSeek".to_string(),
            base_url: format!("http://127.0.0.1:{}", mock.port),
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
        })
        .expect("create provider");

    let api_key = create_api_key(&db, &provider.id, "codex");
    let session_token = format!("session-{}", nanoid::nanoid!(16));
    db.proxy_session_create(&ProxySession {
        session_token: session_token.clone(),
        provider_id: provider.id.clone(),
        api_key_id: api_key.id.clone(),
        project_id: None,
        created_at: chrono::Utc::now().to_rfc3339(),
        cli_type: None,
    })
    .expect("create legacy proxy session");

    let state = build_proxy_state(db);
    let request = Request::builder()
        .method("POST")
        .uri("/v1/responses")
        .header("authorization", format!("Bearer {}", session_token))
        .header("content-type", "application/json")
        .body(Body::from(
            r#"{"model":"gpt-5.5","input":"hello","stream":false}"#,
        ))
        .unwrap();

    let response = proxy_handler(AxumState(state), request)
        .await
        .expect("proxy should return upstream response");
    assert_eq!(response.status(), StatusCode::OK);

    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let body = mock.received_body.lock().unwrap();
    let body = body
        .as_ref()
        .expect("legacy Codex session should still reach the upstream");
    assert_eq!(body["input"], "hello");
    assert!(body.get("messages").is_none());
}

#[tokio::test]
async fn codex_responses_request_with_non_session_auth_uses_takeover_session() {
    let mock = start_codex_mock_upstream().await;
    let path = std::env::temp_dir().join(format!(
        "cc-use-codex-auth-fallback-{}.db",
        nanoid::nanoid!(8)
    ));
    let db = Database::open_at(&path).expect("create temp database");

    let provider = db
        .provider_create(&cc_use_lib::models::CreateProviderInput {
            name: "DeepSeek".to_string(),
            base_url: format!("http://127.0.0.1:{}", mock.port),
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
        })
        .expect("create provider");

    let api_key = create_api_key(&db, &provider.id, "codex");
    let session_token = format!("session-{}", nanoid::nanoid!(16));
    db.settings_set_value(
        cc_use_lib::shared_runtime::CODEX_SESSION_TOKEN_SETTING_KEY,
        &session_token,
    )
    .expect("save takeover session token");
    db.proxy_session_create(&ProxySession {
        session_token: session_token.clone(),
        provider_id: provider.id.clone(),
        api_key_id: api_key.id.clone(),
        project_id: None,
        created_at: chrono::Utc::now().to_rfc3339(),
        cli_type: Some("codex-app".to_string()),
    })
    .expect("create takeover proxy session");

    let state = build_proxy_state(db);
    let request = Request::builder()
        .method("POST")
        .uri("/v1/responses")
        .header("authorization", "Bearer real-openai-or-oauth-token")
        .header("content-type", "application/json")
        .body(Body::from(
            r#"{"model":"gpt-5.5","input":"hello","stream":false}"#,
        ))
        .unwrap();

    let response = proxy_handler(AxumState(state), request)
        .await
        .expect("proxy should use takeover session");
    assert_eq!(response.status(), StatusCode::OK);

    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let headers = mock.received_headers.lock().unwrap();
    assert_eq!(
        headers.get("authorization").map(|s| s.as_str()),
        Some("Bearer sk-codex")
    );
    let body = mock.received_body.lock().unwrap();
    assert_eq!(
        body.as_ref().and_then(|json| json["input"].as_str()),
        Some("hello")
    );
    assert!(body
        .as_ref()
        .and_then(|json| json.get("messages"))
        .is_none());
}

#[tokio::test]
async fn codex_app_ignores_legacy_format_fields_and_passes_responses_through() {
    let mock = start_codex_mock_upstream().await;
    let path =
        std::env::temp_dir().join(format!("cc-use-codex-deepseek-{}.db", nanoid::nanoid!(8)));
    let db = Database::open_at(&path).expect("create temp database");

    let provider = db
        .provider_create(&cc_use_lib::models::CreateProviderInput {
            name: "DeepSeek".to_string(),
            base_url: format!("http://127.0.0.1:{}", mock.port),
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
        })
        .expect("create provider");

    let api_key = db
        .api_key_create(&CreateApiKeyInput {
            provider_id: provider.id.clone(),
            alias: Some("deepseek-key".to_string()),
            value: "sk-deepseek".to_string(),
            types: Some(vec!["codex".to_string()]),
            priority: Some(0),
            is_active: Some(true),
            config: None,
            cost_multiplier: None,
            usage_type: None,
            usage_url: None,
            usage_path: None,
            usage_headers: None,
            model_mapping: None,
            client_configs: None,
        })
        .expect("create api key");

    let session_token = format!("session-{}", nanoid::nanoid!(16));
    db.proxy_session_create(&ProxySession {
        session_token: session_token.clone(),
        provider_id: provider.id.clone(),
        api_key_id: api_key.id.clone(),
        project_id: None,
        created_at: chrono::Utc::now().to_rfc3339(),
        cli_type: Some("codex-app".to_string()),
    })
    .expect("create proxy session");

    let state = build_proxy_state(db);
    let request = Request::builder()
        .method("POST")
        .uri("/v1/responses")
        .header("authorization", format!("Bearer {}", session_token))
        .header("content-type", "application/json")
        .body(Body::from(
            r#"{"model":"gpt-5.5","input":"hello","stream":false}"#,
        ))
        .unwrap();

    let response = proxy_handler(AxumState(state), request)
        .await
        .expect("proxy should return upstream response");
    assert_eq!(response.status(), StatusCode::OK);

    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let headers = mock.received_headers.lock().unwrap();
    assert_eq!(
        headers.get("authorization").map(|s| s.as_str()),
        Some("Bearer sk-deepseek")
    );

    let body = mock.received_body.lock().unwrap();
    let body = body
        .as_ref()
        .expect("upstream should receive the original Responses JSON");
    assert_eq!(body["input"], "hello");
    assert!(body.get("messages").is_none());
}

#[tokio::test]
async fn codex_app_legacy_transform_off_field_still_passes_responses_through() {
    let mock = start_codex_mock_upstream().await;
    let path = std::env::temp_dir().join(format!("cc-use-codex-off-{}.db", nanoid::nanoid!(8)));
    let db = Database::open_at(&path).expect("create temp database");

    let provider = db
        .provider_create(&cc_use_lib::models::CreateProviderInput {
            name: "DeepSeek".to_string(),
            base_url: format!("http://127.0.0.1:{}", mock.port),
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
        })
        .expect("create provider");

    let api_key = db
        .api_key_create(&CreateApiKeyInput {
            provider_id: provider.id.clone(),
            alias: Some("deepseek-off-key".to_string()),
            value: "sk-deepseek".to_string(),
            types: Some(vec!["codex".to_string()]),
            priority: Some(0),
            is_active: Some(true),
            config: None,
            cost_multiplier: None,
            usage_type: None,
            usage_url: None,
            usage_path: None,
            usage_headers: None,
            model_mapping: None,
            client_configs: None,
        })
        .expect("create api key");

    let session_token = format!("session-{}", nanoid::nanoid!(16));
    db.proxy_session_create(&ProxySession {
        session_token: session_token.clone(),
        provider_id: provider.id.clone(),
        api_key_id: api_key.id.clone(),
        project_id: None,
        created_at: chrono::Utc::now().to_rfc3339(),
        cli_type: Some("codex-app".to_string()),
    })
    .expect("create proxy session");

    let state = build_proxy_state(db);
    let request = Request::builder()
        .method("POST")
        .uri("/v1/responses")
        .header("authorization", format!("Bearer {}", session_token))
        .header("content-type", "application/json")
        .body(Body::from(
            r#"{"model":"gpt-5.5","input":"hello","stream":false}"#,
        ))
        .unwrap();

    let response = proxy_handler(AxumState(state), request)
        .await
        .expect("proxy should return upstream response");
    assert_eq!(response.status(), StatusCode::OK);
    let body = mock.received_body.lock().unwrap();
    let body = body
        .as_ref()
        .expect("upstream should receive the original Responses JSON");
    assert_eq!(body["input"], "hello");
    assert!(body.get("messages").is_none());
}
