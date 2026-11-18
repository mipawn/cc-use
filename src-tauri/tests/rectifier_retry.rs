mod support;

use axum::body::Body;
use axum::extract::State as AxumState;
use axum::http::{Request, StatusCode};
use axum::response::IntoResponse;
use axum::routing::post;
use axum::Router;
use cc_use_lib::db::Database;
use cc_use_lib::models::{ApiKey, CreateApiKeyInput, CreateProviderInput, ProxySession};
use cc_use_lib::proxy::handler::proxy_handler;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use support::build_proxy_state;
use tokio::net::TcpListener;

const AZURE_REJECTION: &str = r#"{"error":{"message":"OpenAI Responses bad request: The requested item was created under a different Azure OpenAI resource. Use the same resource that created the item to access it. [trace_id=test]","type":"invalid_request_error","param":"","code":null}}"#;

/// Mock Responses upstream: the first call is answered with the configured
/// rejection, every later call with a 200 and the body recorded.
struct MockUpstream {
    port: u16,
    bodies: Arc<Mutex<Vec<String>>>,
    calls: Arc<AtomicUsize>,
}

async fn start_upstream(rejection: &'static str, reject_status: StatusCode) -> MockUpstream {
    let bodies: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let calls = Arc::new(AtomicUsize::new(0));
    let state = (bodies.clone(), calls.clone());

    let endpoint = post(move |body: String| {
        let (bodies, calls) = state.clone();
        async move {
            bodies.lock().unwrap().push(body);
            let call = calls.fetch_add(1, Ordering::SeqCst);
            if call == 0 {
                (reject_status, rejection).into_response()
            } else {
                (
                    StatusCode::OK,
                    [("content-type", "application/json")],
                    r#"{"object":"response","output":[]}"#,
                )
                    .into_response()
            }
        }
    });
    let app = Router::new()
        .route("/v1/responses", endpoint.clone())
        .route("/responses", endpoint.clone())
        .route("/v1/responses/compact", endpoint.clone())
        .route("/responses/compact", endpoint.clone())
        .route("/v1/chat/completions", endpoint);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    tokio::time::sleep(std::time::Duration::from_millis(10)).await;

    MockUpstream {
        port,
        bodies,
        calls,
    }
}

/// A Codex session routed to a mock provider, exercising the real handler path.
fn setup_session(upstream_port: u16) -> (Arc<cc_use_lib::proxy::ProxyState>, String) {
    setup_session_with_rectifier(upstream_port, Some(true))
}

fn setup_session_with_rectifier(
    upstream_port: u16,
    responses_rectifier: Option<bool>,
) -> (Arc<cc_use_lib::proxy::ProxyState>, String) {
    let path = std::env::temp_dir().join(format!("cc-use-rectifier-{}.db", nanoid::nanoid!(8)));
    let db = Database::open_at(&path).expect("create temp database");

    let provider = db
        .provider_create(&CreateProviderInput {
            query_config: None,
            request_headers: None,
            wallet_balance_script: None,
            name: "rectifier-provider".to_string(),
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
            responses_rectifier,
        })
        .expect("create provider");

    let api_key: ApiKey = db
        .api_key_create(&CreateApiKeyInput {
            query_config: None,
            usage_script: None,
            provider_id: provider.id.clone(),
            alias: Some("codex-key".to_string()),
            value: "sk-test".to_string(),
            types: Some(vec!["codex".to_string()]),
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
        .expect("create api key");

    let session_token = format!("session-{}", nanoid::nanoid!(16));
    let now = chrono::Utc::now().to_rfc3339();
    db.proxy_session_create(&ProxySession {
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
        cli_type: Some("codex-app".to_string()),
        display_name: None,
        is_active: true,
        connection_config: None,
        model_policy: None,
    })
    .expect("create proxy session");

    (build_proxy_state(db), session_token)
}

fn responses_request(session_token: &str, body: &'static str) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/v1/responses")
        .header("authorization", format!("Bearer {}", session_token))
        .header("content-type", "application/json")
        .body(Body::from(body))
        .unwrap()
}

/// Mock streaming upstream: the first call answers 200 + SSE with an error
/// event and no content, later calls answer 200 + SSE with real output.
async fn start_streaming_upstream() -> MockUpstream {
    let bodies: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let calls = Arc::new(AtomicUsize::new(0));
    let state = (bodies.clone(), calls.clone());

    let app = Router::new().route(
        "/v1/responses",
        post(move |body: String| {
            let (bodies, calls) = state.clone();
            async move {
                bodies.lock().unwrap().push(body);
                let call = calls.fetch_add(1, Ordering::SeqCst);
                let payload = if call == 0 {
                    concat!(
                        "event: response.created\n",
                        "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\"}}\n\n",
                        "event: error\n",
                        "data: {\"type\":\"error\",\"error\":{\"message\":\"The requested item was created under a different Azure OpenAI resource.\"}}\n\n",
                    )
                } else {
                    concat!(
                        "event: response.output_text.delta\n",
                        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\n",
                        "event: response.completed\n",
                        "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_2\"}}\n\n",
                    )
                };
                (
                    StatusCode::OK,
                    [("content-type", "text/event-stream")],
                    payload,
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

    MockUpstream {
        port,
        bodies,
        calls,
    }
}

const RESOURCE_BOUND_INPUT: &str = r#"{
    "model": "gpt-6.1-sol",
    "store": false,
    "input": [
        {"role": "user", "content": "hi"},
        {"type": "reasoning", "id": "rs_abc", "encrypted_content": "gAAA", "summary": []},
        {"type": "message", "id": "msg_abc", "role": "assistant", "content": [{"type": "output_text", "text": "ok"}]}
    ]
}"#;

#[tokio::test]
async fn omitted_provider_flag_passes_http_rejection_through_unchanged() {
    let mock = start_upstream(AZURE_REJECTION, StatusCode::BAD_REQUEST).await;
    let (state, session_token) = setup_session_with_rectifier(mock.port, None);
    let response = proxy_handler(
        AxumState(state),
        responses_request(&session_token, RESOURCE_BOUND_INPUT),
    )
    .await
    .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert!(!response.headers().contains_key("x-cc-use-rectified"));
    let body = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    assert_eq!(body.as_ref(), AZURE_REJECTION.as_bytes());
    assert_eq!(mock.calls.load(Ordering::SeqCst), 1);
    assert_eq!(mock.bodies.lock().unwrap()[0], RESOURCE_BOUND_INPUT);
}

#[tokio::test]
async fn omitted_or_disabled_provider_flag_passes_sse_rejection_through() {
    for enabled in [None, Some(false)] {
        let mock = start_streaming_upstream().await;
        let (state, session_token) = setup_session_with_rectifier(mock.port, enabled);
        let response = proxy_handler(
            AxumState(state),
            responses_request(&session_token, RESOURCE_BOUND_INPUT),
        )
        .await
        .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(!response.headers().contains_key("x-cc-use-rectified"));
        let body = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        assert!(String::from_utf8_lossy(&body).contains("different Azure"));
        assert_eq!(mock.calls.load(Ordering::SeqCst), 1);
        assert_eq!(mock.bodies.lock().unwrap()[0], RESOURCE_BOUND_INPUT);
    }
}

#[tokio::test]
async fn gateway_opt_in_covers_responses_aliases_but_not_chat_completions() {
    for (path, should_retry) in [
        ("/v1/responses", true),
        ("/responses", true),
        ("/v1/responses/compact", true),
        ("/responses/compact", true),
        ("/v1/chat/completions", false),
    ] {
        let mock = start_upstream(AZURE_REJECTION, StatusCode::BAD_REQUEST).await;
        let (state, session_token) = setup_session(mock.port);
        state.db.lock().unwrap().conn.execute(
            "UPDATE proxy_sessions SET session_kind = 'gateway', cli_type = NULL WHERE session_token = ?1",
            [&session_token],
        ).unwrap();
        let mut request = responses_request(&session_token, RESOURCE_BOUND_INPUT);
        *request.uri_mut() = path.parse().unwrap();
        let response = proxy_handler(AxumState(state), request).await.unwrap();
        assert_eq!(
            response.status(),
            if should_retry {
                StatusCode::OK
            } else {
                StatusCode::BAD_REQUEST
            },
            "{path}"
        );
        assert_eq!(
            mock.calls.load(Ordering::SeqCst),
            if should_retry { 2 } else { 1 },
            "{path}"
        );
        assert_eq!(
            response.headers().contains_key("x-cc-use-rectified"),
            should_retry,
            "{path}"
        );
    }
}

#[tokio::test]
async fn retries_stream_that_starts_with_a_rejection() {
    let mock = start_streaming_upstream().await;
    let (state, session_token) = setup_session(mock.port);

    let response = proxy_handler(
        AxumState(state),
        responses_request(&session_token, RESOURCE_BOUND_INPUT),
    )
    .await
    .expect("handler returns a response");

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(mock.calls.load(Ordering::SeqCst), 2, "exactly one retry");

    let body = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .expect("read body");
    let body = String::from_utf8_lossy(&body);
    assert!(body.contains("\"delta\":\"hello\""), "{body}");
    assert!(!body.contains("different Azure"), "{body}");

    let bodies = mock.bodies.lock().unwrap();
    assert!(!bodies[1].contains("reasoning"), "{}", bodies[1]);
    assert!(!bodies[1].contains("rs_abc"), "{}", bodies[1]);
}

#[tokio::test]
async fn provider_switch_off_skips_rectification() {
    let mock = start_upstream(AZURE_REJECTION, StatusCode::BAD_REQUEST).await;
    let (state, session_token) = setup_session_with_rectifier(mock.port, Some(false));

    let response = proxy_handler(
        AxumState(state),
        responses_request(&session_token, RESOURCE_BOUND_INPUT),
    )
    .await
    .expect("handler returns a response");

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        mock.calls.load(Ordering::SeqCst),
        1,
        "no retry when disabled"
    );
}

#[tokio::test]
async fn retries_once_without_resource_bound_state() {
    let mock = start_upstream(AZURE_REJECTION, StatusCode::BAD_REQUEST).await;
    let (state, session_token) = setup_session(mock.port);

    let response = proxy_handler(
        AxumState(state),
        responses_request(
            &session_token,
            r#"{
                "model": "gpt-6.1-sol",
                "store": false,
                "include": ["reasoning.encrypted_content"],
                "input": [
                    {"role": "user", "content": "hi"},
                    {"type": "reasoning", "id": "rs_abc", "encrypted_content": "gAAA", "summary": []},
                    {"type": "message", "id": "msg_abc", "role": "assistant", "content": [{"type": "output_text", "text": "ok"}]},
                    {"type": "function_call", "id": "fc_abc", "call_id": "call_1", "name": "bash", "arguments": "{}"},
                    {"type": "function_call_output", "id": "fco_abc", "call_id": "call_1", "output": "done"}
                ]
            }"#,
        ),
    )
    .await
    .expect("handler returns a response");

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(mock.calls.load(Ordering::SeqCst), 2, "exactly one retry");

    let bodies = mock.bodies.lock().unwrap();
    assert_eq!(bodies.len(), 2);
    // First attempt is the client's request verbatim.
    assert!(bodies[0].contains("rs_abc"));
    // Retry drops the reasoning item, the item ids and the encrypted-content include.
    let retried = &bodies[1];
    assert!(!retried.contains("reasoning"), "{retried}");
    assert!(!retried.contains("encrypted_content"), "{retried}");
    assert!(!retried.contains("rs_abc"), "{retried}");
    assert!(!retried.contains("msg_abc"), "{retried}");
    assert!(!retried.contains("fc_abc"), "{retried}");
    // Tool call pairing and payloads survive.
    assert!(retried.contains("call_1"));
    assert!(retried.contains("\"name\":\"bash\""));
    assert!(retried.contains("done"));
    assert!(retried.contains("\"role\":\"user\""));
}

#[tokio::test]
async fn unrelated_bad_request_is_not_retried() {
    let mock = start_upstream(
        r#"{"error":{"message":"Invalid value for 'model': gpt-nope"}}"#,
        StatusCode::BAD_REQUEST,
    )
    .await;
    let (state, session_token) = setup_session(mock.port);

    let response = proxy_handler(
        AxumState(state),
        responses_request(
            &session_token,
            r#"{"model":"gpt-nope","input":[{"role":"user","content":"hi"}]}"#,
        ),
    )
    .await
    .expect("handler returns a response");

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(mock.calls.load(Ordering::SeqCst), 1, "no retry");
}

#[tokio::test]
async fn request_without_resource_bound_state_is_not_retried() {
    let mock = start_upstream(AZURE_REJECTION, StatusCode::BAD_REQUEST).await;
    let (state, session_token) = setup_session(mock.port);

    let response = proxy_handler(
        AxumState(state),
        responses_request(
            &session_token,
            r#"{"model":"gpt-6.1-sol","input":[{"role":"user","content":"hi"}]}"#,
        ),
    )
    .await
    .expect("handler returns a response");

    // Nothing to strip: the rejection is passed through instead of a pointless retry.
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(mock.calls.load(Ordering::SeqCst), 1);
}
