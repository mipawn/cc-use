mod support;

use axum::body::Body;
use axum::extract::State as AxumState;
use axum::http::{Request, StatusCode};
use axum::response::IntoResponse;
use axum::routing::post;
use axum::Router;
use cc_use_lib::db::Database;
use cc_use_lib::models::{CreateApiKeyInput, CreateProviderInput};
use cc_use_lib::proxy::console::ConsoleEvent;
use cc_use_lib::proxy::handler::proxy_handler;
use std::time::Duration;
use support::{build_proxy_state, create_proxy_session};
use tokio::net::TcpListener;

fn create_provider_at(db: &Database, base_url: &str) -> cc_use_lib::models::Provider {
    db.provider_create(&CreateProviderInput {
        request_headers: None,
        wallet_balance_script: None,
        name: "console-provider".to_string(),
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

fn create_key(db: &Database, provider_id: &str) -> cc_use_lib::models::ApiKey {
    db.api_key_create(&CreateApiKeyInput {
        usage_script: None,
        provider_id: provider_id.to_string(),
        alias: Some("console-key".to_string()),
        value: "sk-real".to_string(),
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

async fn start_unauthorized_upstream() -> u16 {
    let app = Router::new().route(
        "/v1/messages",
        post(|| async {
            (
                StatusCode::UNAUTHORIZED,
                r#"{"error":{"message":"invalid upstream key"}}"#,
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
    port
}

async fn next_terminal_event(
    rx: &mut tokio::sync::broadcast::Receiver<ConsoleEvent>,
) -> (String, Option<u16>, Option<String>) {
    for _ in 0..4 {
        let event = tokio::time::timeout(Duration::from_millis(500), rx.recv())
            .await
            .expect("console event expected")
            .expect("channel delivered");
        if let ConsoleEvent::Request {
            kind,
            status,
            message,
            ..
        } = event
        {
            if kind != "pending" {
                return (kind, status, message);
            }
        }
    }
    panic!("no terminal console event was emitted");
}

#[tokio::test]
async fn upstream_401_is_emitted_as_an_error_with_status_and_reason() {
    let port = start_unauthorized_upstream().await;
    let path = std::env::temp_dir().join(format!("cc-use-console-neg-{}.db", nanoid::nanoid!(8)));
    let db = Database::open_at(&path).expect("create temp database");
    let provider = create_provider_at(&db, &format!("http://127.0.0.1:{port}"));
    let key = create_key(&db, &provider.id);
    create_proxy_session(&db, "session-console-neg", &provider.id, &key.id, None);

    let state = build_proxy_state(db);
    let mut rx = state.console_tx.subscribe();
    let request = Request::builder()
        .method("POST")
        .uri("/v1/messages")
        .header("authorization", "Bearer session-console-neg")
        .header("content-type", "application/json")
        .body(Body::from(r#"{"model":"claude-sonnet-4","max_tokens":8}"#))
        .unwrap();

    let response = proxy_handler(AxumState(state), request)
        .await
        .expect("upstream 401 is forwarded as a response");
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    let (kind, status, message) = next_terminal_event(&mut rx).await;
    assert_eq!(kind, "upstream_error");
    assert_eq!(status, Some(401));
    assert!(
        message
            .as_deref()
            .unwrap_or_default()
            .contains("invalid upstream key"),
        "error reason should survive, got {message:?}"
    );

    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(path.with_extension("db-wal"));
    let _ = std::fs::remove_file(path.with_extension("db-shm"));
}

async fn start_truncated_stream_upstream() -> u16 {
    let app = Router::new().route(
        "/v1/messages",
        post(|| async {
            let chunks = futures::stream::iter([Ok::<_, std::convert::Infallible>(
                axum::body::Bytes::from_static(
                    b"data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":10}}}\n\n",
                ),
            )]);
            axum::http::Response::builder()
                .status(StatusCode::OK)
                .header("content-type", "text/event-stream")
                .body(Body::from_stream(chunks))
                .unwrap()
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    port
}

#[tokio::test]
async fn truncated_200_stream_is_recorded_and_shown_as_a_failure() {
    let port = start_truncated_stream_upstream().await;
    let path = std::env::temp_dir().join(format!("cc-use-console-cut-{}.db", nanoid::nanoid!(8)));
    let db = Database::open_at(&path).expect("create temp database");
    let provider = create_provider_at(&db, &format!("http://127.0.0.1:{port}"));
    let key = create_key(&db, &provider.id);
    create_proxy_session(&db, "session-console-cut", &provider.id, &key.id, None);

    let state = build_proxy_state(db);
    let mut rx = state.console_tx.subscribe();
    let request = Request::builder()
        .method("POST")
        .uri("/v1/messages")
        .header("authorization", "Bearer session-console-cut")
        .header("content-type", "application/json")
        .body(Body::from(
            r#"{"model":"claude-sonnet-4","max_tokens":8,"stream":true}"#,
        ))
        .unwrap();

    let response = proxy_handler(AxumState(state.clone()), request)
        .await
        .expect("streaming response is returned");
    assert_eq!(response.status(), StatusCode::OK);
    let _ = axum::body::to_bytes(response.into_body(), 64 * 1024 * 1024)
        .await
        .expect("consume the truncated stream");

    let (kind, status, message) = next_terminal_event(&mut rx).await;
    assert_eq!(kind, "upstream_error");
    assert_eq!(status, Some(200));
    assert!(
        message
            .as_deref()
            .unwrap_or_default()
            .contains("before completion"),
        "truncated stream should name the failure, got {message:?}"
    );

    let outcome: String = state
        .db
        .lock()
        .unwrap()
        .conn
        .query_row(
            "SELECT outcome FROM request_logs ORDER BY created_at DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(outcome, "transport_error");

    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(path.with_extension("db-wal"));
    let _ = std::fs::remove_file(path.with_extension("db-shm"));
}
