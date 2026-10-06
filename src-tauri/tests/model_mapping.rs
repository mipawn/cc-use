mod support;

use axum::body::Body;
use axum::extract::State as AxumState;
use axum::http::{Request, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::Router;
use cc_use_lib::db::Database;
use cc_use_lib::models::{CreateApiKeyInput, ProxySession};
use cc_use_lib::proxy::handler::proxy_handler;
use std::sync::{Arc, Mutex};
use support::build_proxy_state;
use tokio::net::TcpListener;

struct MockUpstream {
    port: u16,
    received_body: Arc<Mutex<String>>,
}

async fn start_mock_upstream() -> MockUpstream {
    let received_body: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let messages_body = received_body.clone();
    let responses_body = received_body.clone();

    let app = Router::new()
        .route(
            "/v1/messages",
            post(move |body: String| {
                let received_body = messages_body.clone();
                async move {
                    *received_body.lock().unwrap() = body;
                    (StatusCode::OK, r#"{"type":"message","content":[]}"#).into_response()
                }
            }),
        )
        .route(
            "/v1/responses",
            post(move |body: String| {
                let received_body = responses_body.clone();
                async move {
                    *received_body.lock().unwrap() = body;
                    (StatusCode::OK, r#"{"object":"response","output":[]}"#).into_response()
                }
            }),
        )
        .route(
            "/v1/models",
            get(|| async {
                (
                    StatusCode::OK,
                    r#"{"data":[{"id":"company-opus-4-6","type":"model"}],"has_more":false}"#,
                )
                    .into_response()
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
            request_headers: None,
            wallet_balance_script: None,
            name: "test-provider".to_string(),
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
            preset_id: None,
            default_key_config: None,
            request_adapter: None,
        })
        .expect("create provider");

    let api_key = db
        .api_key_create(&CreateApiKeyInput {
            usage_script: None,
            provider_id: provider.id.clone(),
            alias: Some(format!("{}-key", provider_type)),
            value: format!("sk-{}", provider_type),
            types: Some(vec![match provider_type {
                "codex" => "codex".to_string(),
                "claude" => "claude_code".to_string(),
                other => other.to_string(),
            }]),
            priority: Some(0),
            is_active: Some(true),
            config: None,
            usage_type: None,
            usage_url: None,
            usage_path: None,
            usage_headers: None,
            model_mapping: model_mapping.map(|s| s.to_string()),
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
        session_kind: "manual".to_string(),
        last_seen_at: chrono::Utc::now().to_rfc3339(),
        expires_at: None,
        revoked_at: None,
        revoked_reason: None,
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
async fn legacy_default_is_ignored_and_unknown_model_passes_through() {
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
    assert_eq!(extract_model(&body), "some-unknown-model");
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
async fn claude_desktop_model_list_is_forwarded_from_current_provider() {
    let mock = start_mock_upstream().await;
    let (state, session_token) = setup_provider_with_mapping(mock.port, "claude_desktop", None);

    let request = Request::builder()
        .method("GET")
        .uri("/claude-desktop/v1/models")
        .header("authorization", format!("Bearer {}", session_token))
        .body(Body::empty())
        .unwrap();

    let response = proxy_handler(AxumState(state), request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["data"][0]["id"], "company-opus-4-6");
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

#[tokio::test]
async fn codex_model_mapping_only_renames_responses_model() {
    let mock = start_mock_upstream().await;
    let mapping = r#"{"codex":"deepseek-v4-pro"}"#;
    let (state, session_token) = setup_provider_with_mapping(mock.port, "codex", Some(mapping));

    let request = Request::builder()
        .method("POST")
        .uri("/v1/responses")
        .header("authorization", format!("Bearer {}", session_token))
        .header("content-type", "application/json")
        .body(Body::from(r#"{"model":"gpt-5.4","input":[]}"#))
        .unwrap();

    let response = proxy_handler(AxumState(state), request).await;
    assert!(response.is_ok());

    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let body = mock.received_body.lock().unwrap();
    assert_eq!(extract_model(&body), "deepseek-v4-pro");
}

#[tokio::test]
async fn codex_without_mapping_keeps_original_model() {
    let mock = start_mock_upstream().await;
    let (state, session_token) = setup_provider_with_mapping(mock.port, "codex", None);

    let request = Request::builder()
        .method("POST")
        .uri("/v1/responses")
        .header("authorization", format!("Bearer {}", session_token))
        .header("content-type", "application/json")
        .body(Body::from(r#"{"model":"gpt-5.4","input":[]}"#))
        .unwrap();

    let response = proxy_handler(AxumState(state), request).await;
    assert!(response.is_ok());

    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let body = mock.received_body.lock().unwrap();
    assert_eq!(extract_model(&body), "gpt-5.4");
}

#[tokio::test]
async fn codex_ignores_legacy_claude_default_mapping() {
    let mock = start_mock_upstream().await;
    let mapping = r#"{"default":"claude-sonnet-upstream"}"#;
    let (state, session_token) = setup_provider_with_mapping(mock.port, "codex", Some(mapping));

    let request = Request::builder()
        .method("POST")
        .uri("/v1/responses")
        .header("authorization", format!("Bearer {}", session_token))
        .header("content-type", "application/json")
        .body(Body::from(r#"{"model":"gpt-5.4","input":[]}"#))
        .unwrap();

    let response = proxy_handler(AxumState(state), request).await;
    assert!(response.is_ok());

    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let body = mock.received_body.lock().unwrap();
    assert_eq!(extract_model(&body), "gpt-5.4");
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

// Claude Code 2.1.220 classifier wire shape, with a short synthetic transcript.
fn auto_mode_request(session: &str) -> serde_json::Value {
    serde_json::json!({
        "model": "claude-sonnet-5",
        "system": [{"type": "text", "text": "You are a security monitor for autonomous AI coding agents.\n\n## Context"}],
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": "<transcript>\n"},
            {"type": "text", "text": "User: inspect the repository\nTool: Bash git status"},
            {"type": "text", "text": "</transcript>\n"}
        ]}],
        "metadata": {"user_id": serde_json::json!({"session_id": session}).to_string()},
        "max_tokens": 64,
        "thinking": {"type": "disabled"},
        "temperature": 0,
        "stop_sequences": ["</block>"],
        "output_config": {"format": {"type": "json_schema", "schema": {"type": "object"}}}
    })
}

async fn forward_auto_mode_body(
    state: &Arc<cc_use_lib::proxy::ProxyState>,
    token: &str,
    mock: &MockUpstream,
    body: &serde_json::Value,
) -> serde_json::Value {
    let response = proxy_handler(
        AxumState(state.clone()),
        Request::builder()
            .method("POST")
            .uri("/v1/messages?beta=true")
            .header("authorization", format!("Bearer {}", token))
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    serde_json::from_str(&mock.received_body.lock().unwrap()).unwrap()
}

#[tokio::test]
async fn auto_mode_custom_model_and_low_thinking_preserve_classifier_contract() {
    let mock = start_mock_upstream().await;
    let (state, token) = setup_provider_with_mapping(
        mock.port,
        "claude",
        Some(
            r#"{"sonnet":"chat-model","autoMode":{"enabled":true,"model":" deepseek-v4-flash ","thinking":"low"}}"#,
        ),
    );
    let original = auto_mode_request("session-a");
    let result = forward_auto_mode_body(&state, &token, &mock, &original).await;
    assert_eq!(result["model"], "deepseek-v4-flash");
    assert_eq!(
        result["thinking"],
        serde_json::json!({"type":"enabled","budget_tokens":1024})
    );
    assert_eq!(result["output_config"]["effort"], "low");
    assert_eq!(result["max_tokens"], 4096);
    assert!(result.get("temperature").is_none());
    for field in ["system", "messages", "stop_sequences", "metadata"] {
        assert_eq!(result[field], original[field], "changed {field}");
    }
    assert_eq!(
        result["output_config"]["format"],
        original["output_config"]["format"]
    );
}

#[tokio::test]
async fn auto_mode_follows_session_model_without_cross_session_or_side_query_leaks() {
    let mock = start_mock_upstream().await;
    let (state, token) = setup_provider_with_mapping(
        mock.port,
        "claude",
        Some(r#"{"opus":"deepseek-v4-pro","sonnet":"fallback","autoMode":{"enabled":true}}"#),
    );
    let mut main = serde_json::json!({"model":"claude-opus-4-7","messages":[],
        "tools":[{"name":"Bash","input_schema":{"type":"object"}}],
        "metadata":{"user_id":"{\"session_id\":\"session-a\"}"}});
    forward_auto_mode_body(&state, &token, &mock, &main).await;
    let mut side_query = main.clone();
    side_query.as_object_mut().unwrap().remove("tools");
    side_query["model"] = serde_json::json!("title-model");
    forward_auto_mode_body(&state, &token, &mock, &side_query).await;
    let result =
        forward_auto_mode_body(&state, &token, &mock, &auto_mode_request("session-a")).await;
    assert_eq!(result["model"], "deepseek-v4-pro");
    let other =
        forward_auto_mode_body(&state, &token, &mock, &auto_mode_request("session-b")).await;
    assert_eq!(other["model"], "fallback");
    main["model"] = serde_json::json!("glm-5");
    forward_auto_mode_body(&state, &token, &mock, &main).await;
    let switched =
        forward_auto_mode_body(&state, &token, &mock, &auto_mode_request("session-a")).await;
    assert_eq!(switched["model"], "glm-5");
}

#[tokio::test]
async fn auto_mode_does_not_rewrite_user_mentions_or_normal_agent_requests() {
    let mock = start_mock_upstream().await;
    let (state, token) = setup_provider_with_mapping(
        mock.port,
        "claude",
        Some(r#"{"autoMode":{"enabled":true,"model":"classifier"}}"#),
    );
    let mut request = auto_mode_request("session-a");
    request["system"] = serde_json::json!("You are a coding assistant.");
    let result = forward_auto_mode_body(&state, &token, &mock, &request).await;
    assert_eq!(result, request);
    let mut request = auto_mode_request("session-a");
    request["tools"] = serde_json::json!([{"name":"Bash","input_schema":{"type":"object"}}]);
    let result = forward_auto_mode_body(&state, &token, &mock, &request).await;
    assert_eq!(result, request);
}

#[tokio::test]
async fn auto_mode_supports_disabled_and_preserved_thinking_and_opt_out() {
    let mock = start_mock_upstream().await;
    for (config, expected) in [
        (
            r#"{"enabled":true,"model":"glm-5","thinking":"disabled"}"#,
            "disabled",
        ),
        (
            r#"{"enabled":true,"model":"glm-5","thinking":"preserve"}"#,
            "preserve",
        ),
        (r#"{"enabled":false,"model":"glm-5"}"#, "off"),
    ] {
        let mapping = format!("{{\"autoMode\":{config}}}");
        let (state, token) = setup_provider_with_mapping(mock.port, "claude", Some(&mapping));
        let mut request = auto_mode_request("session-a");
        request["thinking"] = serde_json::json!({"type":"adaptive"});
        request["output_config"]["effort"] = serde_json::json!("high");
        let result = forward_auto_mode_body(&state, &token, &mock, &request).await;
        match expected {
            "disabled" => {
                assert_eq!(result["thinking"], serde_json::json!({"type":"disabled"}));
                assert!(result["output_config"].get("effort").is_none());
                assert_eq!(result["model"], "glm-5");
            }
            "preserve" => {
                assert_eq!(result["thinking"], request["thinking"]);
                assert_eq!(result["output_config"], request["output_config"]);
                assert_eq!(result["model"], "glm-5");
            }
            _ => assert_eq!(result, request),
        }
    }
}

// Real gateway regression: Claude's SDK treats text/plain as a string, even
// when the response body is a valid Messages object with usage and a verdict.
#[tokio::test]
async fn auto_mode_json_mime_and_usage_survive_plain_missing_and_gzip_headers() {
    use std::io::Write;
    let body = br#"{"id":"msg-test","type":"message","role":"assistant","model":"deepseek-v4-flash","content":[{"type":"text","text":"<block>no"}],"stop_reason":"stop_sequence","stop_sequence":"</block>","usage":{"input_tokens":123,"output_tokens":7}}"#;
    for mime in [
        Some("text/plain; charset=utf-8"),
        None,
        Some("application/json"),
    ] {
        for compressed in [false, true] {
            let bytes = if compressed {
                let mut encoder =
                    flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
                encoder.write_all(body).unwrap();
                encoder.finish().unwrap()
            } else {
                body.to_vec()
            };
            let expected = bytes.clone();
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let app = Router::new().route(
                "/v1/messages",
                post(move || {
                    let bytes = bytes.clone();
                    async move {
                        let mut response = axum::http::Response::builder().status(200);
                        if let Some(mime) = mime {
                            response = response.header("content-type", mime);
                        }
                        if compressed {
                            response = response.header("content-encoding", "gzip");
                        }
                        response.body(Body::from(bytes)).unwrap()
                    }
                }),
            );
            let server = tokio::spawn(async move {
                axum::serve(listener, app).await.unwrap();
            });
            // Detection and transport repair also work when model adaptation is off.
            let (state, token) = setup_provider_with_mapping(port, "claude", None);
            let response = proxy_handler(
                AxumState(state.clone()),
                Request::builder()
                    .method("POST")
                    .uri("/v1/messages")
                    .header("authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(Body::from(auto_mode_request("session").to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
            assert_eq!(response.headers()["content-type"], "application/json");
            assert_eq!(
                response.headers().contains_key("content-encoding"),
                compressed
            );
            let actual = axum::body::to_bytes(response.into_body(), 4096)
                .await
                .unwrap();
            assert_eq!(
                actual.as_ref(),
                expected,
                "must not rewrite the verdict or encoded bytes"
            );
            let db = state.db.lock().unwrap();
            let logs = db.request_log_list_all().unwrap();
            assert_eq!(logs.len(), 1);
            assert_eq!(logs[0].request_kind.as_deref(), Some("auto_mode"));
            assert_eq!((logs[0].input_tokens, logs[0].output_tokens), (123, 7));
            assert_eq!(
                db.request_log_get_recent_paginated("all", 1, 10)
                    .unwrap()
                    .items[0]
                    .request_kind
                    .as_deref(),
                Some("auto_mode")
            );
            server.abort();
        }
    }
}

#[tokio::test]
async fn auto_mode_does_not_relabel_errors_invalid_envelopes_or_regular_requests() {
    let valid = r#"{"type":"message","role":"assistant","content":[],"usage":{"input_tokens":1,"output_tokens":1}}"#;
    for (status, body, classifier) in [
        (200, "<html>maintenance</html>", true),
        (200, r#"{"type":"message","content":[]}"#, true),
        (503, valid, true),
        (200, valid, false),
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let app = Router::new().route(
            "/v1/messages",
            post(move || async move { (StatusCode::from_u16(status).unwrap(), body) }),
        );
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let (state, token) = setup_provider_with_mapping(port, "claude", None);
        let mut request = auto_mode_request("session");
        if !classifier {
            request["system"] = serde_json::json!("You are a coding assistant.");
        }
        let response = proxy_handler(
            AxumState(state.clone()),
            Request::builder()
                .method("POST")
                .uri("/v1/messages")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::from(request.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(response.status().as_u16(), status);
        assert_eq!(
            response.headers()["content-type"],
            "text/plain; charset=utf-8"
        );
        assert_eq!(
            axum::body::to_bytes(response.into_body(), 4096)
                .await
                .unwrap()
                .as_ref(),
            body.as_bytes()
        );
        let logs = state.db.lock().unwrap().request_log_list_all().unwrap();
        if status == 503 {
            assert_eq!(logs[0].request_kind.as_deref(), Some("auto_mode"));
            assert_eq!(logs[0].outcome.as_deref(), Some("upstream_error"));
        } else {
            assert!(logs
                .iter()
                .all(|log| log.request_kind.is_none() || classifier));
        }
        server.abort();
    }
}

#[tokio::test]
async fn v2_claude_clients_rewrite_independently_and_empty_scope_clears_legacy() {
    let mock = start_mock_upstream().await;
    let mapping = serde_json::json!({
        "version": 2, "opus": "legacy-must-not-apply",
        "clients": {
            "claude_code": {"upstream": {"opus": "code-target"}},
            "claude_desktop": {"upstream": {"mode":"fixed", "model": "desktop-target"}},
        }
    })
    .to_string();
    for (kind, path, expected) in [
        ("claude_code", "/v1/messages", "code-target"),
        (
            "claude_desktop",
            "/claude-desktop/v1/messages",
            "desktop-target",
        ),
    ] {
        let (state, token) = setup_provider_with_mapping(mock.port, kind, Some(&mapping));
        let request = Request::builder()
            .method("POST")
            .uri(path)
            .header("authorization", format!("Bearer {token}"))
            .body(Body::from(r#"{"model":"claude-opus-4-6","messages":[]}"#))
            .unwrap();
        proxy_handler(AxumState(state), request).await.unwrap();
        assert_eq!(extract_model(&mock.received_body.lock().unwrap()), expected);
    }
    let empty_desktop = serde_json::json!({"version":2,"opus":"legacy", "clients":{"claude_code":{"upstream":{"opus":"code"}}, "claude_desktop":{"upstream":{}}}}).to_string();
    let (state, token) =
        setup_provider_with_mapping(mock.port, "claude_desktop", Some(&empty_desktop));
    let request = Request::builder()
        .method("POST")
        .uri("/claude-desktop/v1/messages")
        .header("authorization", format!("Bearer {token}"))
        .body(Body::from(r#"{"model":"claude-opus-4-6","messages":[]}"#))
        .unwrap();
    proxy_handler(AxumState(state), request).await.unwrap();
    assert_eq!(
        extract_model(&mock.received_body.lock().unwrap()),
        "claude-opus-4-6"
    );
}

#[tokio::test]
async fn catalog_override_does_not_require_upstream_and_still_requires_session_auth() {
    let mapping = r#"{"version":2,"clients":{"claude_desktop":{"models":[{"id":"local","displayName":"Local"}],"upstream":{}}}}"#;
    let (state, token) = setup_provider_with_mapping(0, "claude_desktop", Some(mapping));
    let request = Request::builder()
        .uri("/claude-desktop/v1/models")
        .header("authorization", format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        proxy_handler(AxumState(state.clone()), request)
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let request = Request::builder()
        .uri("/claude-desktop/v1/models")
        .header("authorization", "Bearer session-invalid")
        .body(Body::empty())
        .unwrap();
    assert!(proxy_handler(AxumState(state), request).await.is_err());
}

#[tokio::test]
async fn v2_codex_catalog_does_not_apply_its_upstream_alias_to_list_ids() {
    let mock = start_mock_upstream().await;
    let mapping = r#"{"version":2,"clients":{"codex":{"models":[{"id":"visible-codex","displayName":"My Codex"}],"upstream":{"model":"actual-codex"}}}}"#;
    let (state, token) = setup_provider_with_mapping(mock.port, "codex", Some(mapping));
    let request = Request::builder()
        .uri("/v1/models")
        .header("authorization", format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap();
    let response = proxy_handler(AxumState(state.clone()), request)
        .await
        .unwrap();
    let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    let catalog: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(catalog["object"], "list");
    assert_eq!(catalog["data"][0]["id"], "visible-codex");
    let request = Request::builder()
        .method("POST")
        .uri("/v1/responses")
        .header("authorization", format!("Bearer {token}"))
        .body(Body::from(r#"{"model":"visible-codex","input":[]}"#))
        .unwrap();
    proxy_handler(AxumState(state), request).await.unwrap();
    assert_eq!(
        extract_model(&mock.received_body.lock().unwrap()),
        "actual-codex"
    );
}

// ── gateway namespacing: the served catalog is Claude-shaped, the provider
// still receives its own ids ──

#[tokio::test]
async fn claude_discovery_namespaces_ids_and_requests_decode_back() {
    let mock = start_mock_upstream().await;
    let (state, token) = setup_provider_with_mapping(mock.port, "claude", None);

    let request = Request::builder()
        .uri("/v1/models")
        .header("authorization", format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap();
    let response = proxy_handler(AxumState(state.clone()), request)
        .await
        .unwrap();
    let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    let catalog: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(catalog["data"][0]["id"], "claude-company-opus-4-6");

    let request = Request::builder()
        .method("POST")
        .uri("/v1/messages")
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(Body::from(
            r#"{"model":"claude-company-opus-4-6","messages":[]}"#,
        ))
        .unwrap();
    proxy_handler(AxumState(state), request).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert_eq!(
        extract_model(&mock.received_body.lock().unwrap()),
        "company-opus-4-6"
    );
}

#[tokio::test]
async fn custom_catalog_exposes_a_1m_entry_only_and_decodes_it() {
    let mock = start_mock_upstream().await;
    let mapping = r#"{"version":2,"clients":{"claude_code":{"catalog":{"mode":"custom","models":[{"id":"deepseek-v4.1-flash","displayName":"V4 Flash","supports1m":true}]},"upstream":{"mode":"follow"}}}}"#;
    let (state, token) = setup_provider_with_mapping(mock.port, "claude", Some(mapping));

    let request = Request::builder()
        .uri("/v1/models")
        .header("authorization", format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap();
    let response = proxy_handler(AxumState(state.clone()), request)
        .await
        .unwrap();
    let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    let catalog: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let ids = catalog["data"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|entry| entry["id"].as_str().map(str::to_string))
        .collect::<Vec<_>>();
    // A 1M model is offered as the 1M entry only.
    assert_eq!(ids, vec!["claude-deepseek-v4.1-flash[1m]".to_string()]);

    let request = Request::builder()
        .method("POST")
        .uri("/v1/messages")
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(Body::from(
            r#"{"model":"claude-deepseek-v4.1-flash[1m]","messages":[]}"#,
        ))
        .unwrap();
    proxy_handler(AxumState(state), request).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert_eq!(
        extract_model(&mock.received_body.lock().unwrap()),
        "deepseek-v4.1-flash"
    );
}

#[tokio::test]
async fn catalog_ids_win_over_family_forwarding() {
    let mock = start_mock_upstream().await;
    let mapping = r#"{"version":2,"clients":{"claude_code":{"catalog":{"mode":"custom","models":[{"id":"claude-sonnet-4-5","displayName":"Relay Sonnet"}]},"upstream":{"mode":"family","sonnet":"claude-sonnet-4-6"}}}}"#;
    let (state, token) = setup_provider_with_mapping(mock.port, "claude", Some(mapping));

    let request = Request::builder()
        .uri("/v1/models")
        .header("authorization", format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap();
    proxy_handler(AxumState(state.clone()), request)
        .await
        .unwrap();

    let request = Request::builder()
        .method("POST")
        .uri("/v1/messages")
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(Body::from(r#"{"model":"claude-sonnet-4-5","messages":[]}"#))
        .unwrap();
    proxy_handler(AxumState(state), request).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert_eq!(
        extract_model(&mock.received_body.lock().unwrap()),
        "claude-sonnet-4-5"
    );
}

#[tokio::test]
async fn role_slots_are_served_without_the_provider_model_list() {
    // Nothing listens on this port: the role-slot menu must not depend on the
    // provider's model-list endpoint, which is exactly the endpoint that
    // rejects credentials on some relays.
    let dead_port = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    };
    let mapping = r#"{"version":2,"clients":{"claude_desktop":{"catalog":{"mode":"custom","models":[{"id":"deepseek-v4.1-flash","displayName":"V4 Flash","supports1m":true},{"id":"glm-5.2","displayName":"GLM 5.2"}],"roles":{"opus":"glm-5.2","sonnet":"deepseek-v4.1-flash"}},"upstream":{"mode":"follow"}}}}"#;
    let (state, token) = setup_provider_with_mapping(dead_port, "claude_desktop", Some(mapping));

    let request = Request::builder()
        .uri("/claude-desktop/v1/models")
        .header("authorization", format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap();
    let response = proxy_handler(AxumState(state), request).await.unwrap();
    let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    let catalog: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let served = catalog["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| {
            (
                entry["id"].as_str().unwrap().to_string(),
                entry["display_name"].as_str().unwrap().to_string(),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        served,
        vec![
            (
                "claude-sonnet-5[1m]".to_string(),
                "V4 Flash · 1M".to_string()
            ),
            ("claude-opus-5".to_string(), "GLM 5.2".to_string()),
        ]
    );
}

#[tokio::test]
async fn role_route_ids_decode_to_the_assigned_models() {
    let mock = start_mock_upstream().await;
    let mapping = r#"{"version":2,"clients":{"claude_desktop":{"catalog":{"mode":"custom","models":[{"id":"glm-5.2","displayName":"GLM 5.2"}],"roles":{"opus":"glm-5.2"}},"upstream":{"mode":"follow"}}}}"#;
    let (state, token) = setup_provider_with_mapping(mock.port, "claude_desktop", Some(mapping));

    let request = Request::builder()
        .uri("/claude-desktop/v1/models")
        .header("authorization", format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap();
    proxy_handler(AxumState(state.clone()), request)
        .await
        .unwrap();

    let request = Request::builder()
        .method("POST")
        .uri("/claude-desktop/v1/messages")
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(Body::from(r#"{"model":"claude-opus-5","messages":[]}"#))
        .unwrap();
    proxy_handler(AxumState(state), request).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert_eq!(
        extract_model(&mock.received_body.lock().unwrap()),
        "glm-5.2"
    );
}

#[tokio::test]
async fn roles_pointing_at_one_model_are_listed_once_but_all_routes_resolve() {
    let mock = start_mock_upstream().await;
    let mapping = r#"{"version":2,"clients":{"claude_desktop":{"catalog":{"mode":"custom","models":[{"id":"glm-5.2","displayName":"GLM 5.2"}],"roles":{"sonnet":"glm-5.2","opus":"glm-5.2"}},"upstream":{"mode":"follow"}}}}"#;
    let (state, token) = setup_provider_with_mapping(mock.port, "claude_desktop", Some(mapping));

    let request = Request::builder()
        .uri("/claude-desktop/v1/models")
        .header("authorization", format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap();
    let response = proxy_handler(AxumState(state.clone()), request)
        .await
        .unwrap();
    let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    let catalog: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let ids = catalog["data"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|entry| entry["id"].as_str().map(str::to_string))
        .collect::<Vec<_>>();
    assert_eq!(ids, vec!["claude-sonnet-5".to_string()]);

    // The opus route is not in the menu, but a request naming it still
    // reaches the model behind it.
    let request = Request::builder()
        .method("POST")
        .uri("/claude-desktop/v1/messages")
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(Body::from(r#"{"model":"claude-opus-5","messages":[]}"#))
        .unwrap();
    proxy_handler(AxumState(state), request).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert_eq!(
        extract_model(&mock.received_body.lock().unwrap()),
        "glm-5.2"
    );
}

#[tokio::test]
async fn count_tokens_is_answered_locally_when_the_upstream_lacks_the_route() {
    let mock = start_mock_upstream().await;
    let (state, token) = setup_provider_with_mapping(mock.port, "claude", None);

    let request = Request::builder()
        .method("POST")
        .uri("/v1/messages/count_tokens")
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(Body::from(
            r#"{"model":"count-me","messages":[{"role":"user","content":"hello world"}]}"#,
        ))
        .unwrap();
    let response = proxy_handler(AxumState(state), request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get("x-cc-use-count-tokens")
            .and_then(|value| value.to_str().ok()),
        Some("estimated")
    );
    let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert!(body["input_tokens"].as_u64().unwrap_or(0) > 0);
}
