use axum::extract::ws::{CloseFrame, Message, WebSocketUpgrade};
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use axum::routing::any;
use axum::Router;
use cc_use_lib::db::Database;
use cc_use_lib::models::{CreateApiKeyInput, CreateProviderInput, ProxySession};
use cc_use_lib::proxy::{build_proxy_router, build_proxy_state};
use futures::{SinkExt, StreamExt};
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio_tungstenite::tungstenite;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

#[derive(Clone)]
struct UpstreamState {
    headers: Arc<Mutex<Option<HeaderMap>>>,
    close_tx: Arc<Mutex<Option<oneshot::Sender<CloseFrame>>>>,
}

async fn upstream_websocket(
    State(state): State<UpstreamState>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    *state.headers.lock().unwrap() = Some(headers);
    ws.protocols(["realtime"])
        .on_upgrade(move |mut socket| async move {
            if let Some(Ok(Message::Text(text))) = socket.recv().await {
                let _ = socket.send(Message::Text(text)).await;
            }
            while let Some(message) = socket.recv().await {
                match message {
                    Ok(Message::Close(Some(frame))) => {
                        if let Some(tx) = state.close_tx.lock().unwrap().take() {
                            let _ = tx.send(frame);
                        }
                        break;
                    }
                    Ok(Message::Close(None)) | Err(_) => break,
                    _ => {}
                }
            }
        })
}

fn setup_proxy(
    upstream_port: u16,
    http_proxy: Option<String>,
) -> (Arc<cc_use_lib::proxy::ProxyState>, String) {
    let path =
        std::env::temp_dir().join(format!("cc-use-websocket-test-{}.db", nanoid::nanoid!(8)));
    let db = Database::open_at(&path).expect("create test database");
    let provider = db
        .provider_create(&CreateProviderInput {
            name: "websocket-provider".to_string(),
            base_url: format!("http://127.0.0.1:{}", upstream_port),
            http_proxy,
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
        .unwrap();
    let key = db
        .api_key_create(&CreateApiKeyInput {
            provider_id: provider.id.clone(),
            alias: Some("websocket-key".to_string()),
            value: "sk-upstream-websocket".to_string(),
            types: Some(vec!["codex".to_string()]),
            priority: None,
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
        .unwrap();
    let session_token = format!("session-{}", nanoid::nanoid!(16));
    let now = chrono::Utc::now().to_rfc3339();
    db.proxy_session_create(&ProxySession {
        session_token: session_token.clone(),
        provider_id: provider.id,
        api_key_id: key.id,
        project_id: None,
        created_at: now.clone(),
        session_kind: "manual".to_string(),
        last_seen_at: now,
        expires_at: None,
        revoked_at: None,
        revoked_reason: None,
        cli_type: Some("codex-app".to_string()),
    })
    .unwrap();

    (
        build_proxy_state(Arc::new(Mutex::new(db))).unwrap(),
        session_token,
    )
}

async fn start_connect_proxy(
    target_port: u16,
) -> (u16, oneshot::Receiver<String>, tokio::task::JoinHandle<()>) {
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (request_tx, request_rx) = oneshot::channel();
    let task = tokio::spawn(async move {
        let (mut client, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut chunk = [0u8; 1024];
        while !request.windows(4).any(|window| window == b"\r\n\r\n") {
            let read = client.read(&mut chunk).await.unwrap();
            assert!(read > 0);
            request.extend_from_slice(&chunk[..read]);
        }
        request_tx
            .send(String::from_utf8_lossy(&request).to_string())
            .unwrap();

        let mut upstream = tokio::net::TcpStream::connect(("127.0.0.1", target_port))
            .await
            .unwrap();
        client
            .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            .await
            .unwrap();
        let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
    });
    (port, request_rx, task)
}

#[tokio::test]
async fn websocket_waits_for_upstream_and_preserves_handshake_and_close_semantics() {
    let headers = Arc::new(Mutex::new(None));
    let (close_tx, close_rx) = oneshot::channel();
    let upstream_state = UpstreamState {
        headers: headers.clone(),
        close_tx: Arc::new(Mutex::new(Some(close_tx))),
    };
    let upstream_app = Router::new()
        .route("/v1/realtime", any(upstream_websocket))
        .with_state(upstream_state);
    let upstream_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_port = upstream_listener.local_addr().unwrap().port();
    let upstream_task =
        tokio::spawn(async move { axum::serve(upstream_listener, upstream_app).await.unwrap() });

    let (connect_proxy_port, connect_request_rx, connect_proxy_task) =
        start_connect_proxy(upstream_port).await;
    let (proxy_state, session_token) = setup_proxy(
        upstream_port,
        Some(format!(
            "http://proxy-user:proxy-pass@127.0.0.1:{}",
            connect_proxy_port
        )),
    );
    let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_port = proxy_listener.local_addr().unwrap().port();
    let proxy_task = tokio::spawn(async move {
        axum::serve(proxy_listener, build_proxy_router(proxy_state))
            .await
            .unwrap()
    });

    let mut request = format!("ws://127.0.0.1:{}/v1/realtime", proxy_port)
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        "authorization",
        format!("Bearer {}", session_token).parse().unwrap(),
    );
    request
        .headers_mut()
        .insert("user-agent", "codex-cli/websocket-test".parse().unwrap());
    request
        .headers_mut()
        .insert("origin", "https://desktop.local".parse().unwrap());
    request.headers_mut().insert(
        "sec-websocket-protocol",
        "realtime, fallback".parse().unwrap(),
    );
    request
        .headers_mut()
        .insert("openai-beta", "realtime=v1".parse().unwrap());

    let (mut client, response) = tokio_tungstenite::connect_async(request).await.unwrap();
    assert_eq!(
        response.headers()["sec-websocket-protocol"],
        "realtime",
        "proxy should return the protocol selected by upstream"
    );

    client
        .send(tungstenite::Message::Text("hello".into()))
        .await
        .unwrap();
    assert_eq!(
        client.next().await.unwrap().unwrap(),
        tungstenite::Message::Text("hello".into())
    );
    client
        .send(tungstenite::Message::Close(Some(
            tungstenite::protocol::CloseFrame {
                code: tungstenite::protocol::frame::coding::CloseCode::Away,
                reason: "client finished".into(),
            },
        )))
        .await
        .unwrap();

    let upstream_close = tokio::time::timeout(std::time::Duration::from_secs(1), close_rx)
        .await
        .expect("upstream should receive a close frame")
        .expect("close frame sender should remain available");
    assert_eq!(upstream_close.code, 1001);
    assert_eq!(upstream_close.reason.as_str(), "client finished");

    let upstream_headers = headers.lock().unwrap().clone().unwrap();
    assert_eq!(
        upstream_headers["authorization"],
        "Bearer sk-upstream-websocket"
    );
    assert_eq!(upstream_headers["user-agent"], "codex-cli/websocket-test");
    assert_eq!(upstream_headers["origin"], "https://desktop.local");
    assert_eq!(upstream_headers["openai-beta"], "realtime=v1");
    assert_eq!(
        upstream_headers["sec-websocket-protocol"],
        "realtime, fallback"
    );
    let connect_request = connect_request_rx.await.unwrap();
    assert!(
        connect_request.starts_with(&format!("CONNECT 127.0.0.1:{} HTTP/1.1\r\n", upstream_port))
    );
    assert!(connect_request.contains("Proxy-Authorization: Basic cHJveHktdXNlcjpwcm94eS1wYXNz\r\n"));

    proxy_task.abort();
    connect_proxy_task.abort();
    upstream_task.abort();
}

#[tokio::test]
async fn websocket_returns_bad_gateway_before_client_upgrade_when_upstream_is_unavailable() {
    let unused_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let unavailable_port = unused_listener.local_addr().unwrap().port();
    drop(unused_listener);

    let (proxy_state, session_token) = setup_proxy(unavailable_port, None);
    let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_port = proxy_listener.local_addr().unwrap().port();
    let proxy_task = tokio::spawn(async move {
        axum::serve(proxy_listener, build_proxy_router(proxy_state))
            .await
            .unwrap()
    });

    let mut request = format!("ws://127.0.0.1:{}/v1/realtime", proxy_port)
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        "authorization",
        format!("Bearer {}", session_token).parse().unwrap(),
    );

    let error = tokio_tungstenite::connect_async(request)
        .await
        .expect_err("unavailable upstream must not produce a client 101 response");
    match error {
        tungstenite::Error::Http(response) => {
            assert_eq!(response.status(), axum::http::StatusCode::BAD_GATEWAY);
        }
        other => panic!("expected HTTP 502 handshake response, got {other}"),
    }

    proxy_task.abort();
}
