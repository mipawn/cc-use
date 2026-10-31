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
            request_headers: None,
            wallet_balance_script: None,
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
            preset_id: None,
            default_key_config: None,
            request_adapter: None,
        })
        .unwrap();
    let key = db
        .api_key_create(&CreateApiKeyInput {
            usage_script: None,
            provider_id: provider.id.clone(),
            alias: Some("websocket-key".to_string()),
            value: "sk-upstream-websocket".to_string(),
            types: Some(vec!["codex".to_string()]),
            priority: None,
            is_active: Some(true),
            config: None,
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
        display_name: None,
        is_active: true,
        connection_config: None,
        model_policy: None,
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

// ────────────────────────────────────────────────────────────────────────────
// T05/T21 boundary: gateway WebSocket handshake uses the shared connection
// policy (provider headers + gateway auth/UA) and is not billed as inference.
// ────────────────────────────────────────────────────────────────────────────

fn setup_gateway_proxy(upstream_port: u16) -> (Arc<cc_use_lib::proxy::ProxyState>, String) {
    let path = std::env::temp_dir().join(format!("cc-use-ws-gateway-{}.db", nanoid::nanoid!(8)));
    let db = Database::open_at(&path).expect("create test database");
    let provider = db
        .provider_create(&CreateProviderInput {
            request_headers: Some(r#"{"X-Relay":"cc-use-ws"}"#.to_string()),
            wallet_balance_script: None,
            name: "gateway-ws-provider".to_string(),
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
        .unwrap();
    let key = db
        .api_key_create(&CreateApiKeyInput {
            usage_script: None,
            provider_id: provider.id.clone(),
            alias: Some("gateway-ws-key".to_string()),
            value: "sk-upstream-websocket".to_string(),
            types: Some(vec!["claude_code".to_string()]),
            priority: None,
            is_active: Some(true),
            config: None,
            usage_type: None,
            usage_url: None,
            usage_path: None,
            usage_headers: None,
            model_mapping: None,
            client_configs: None,
        })
        .unwrap();
    let gateway = cc_use_lib::commands::gateways::gateway_create_inner(
        &db,
        "ws-gateway",
        &provider.id,
        &key.id,
        Some(&cc_use_lib::models::GatewayConnectionConfig {
            base_url: None,
            auth_scheme: "x-api-key".to_string(),
            user_agent: Some("gateway-ws-agent/1".to_string()),
        }),
    )
    .unwrap();
    (
        build_proxy_state(Arc::new(Mutex::new(db))).unwrap(),
        gateway.session_token,
    )
}

#[tokio::test]
async fn gateway_websocket_handshake_uses_the_shared_connection_policy() {
    let headers = Arc::new(Mutex::new(None));
    let (close_tx, _close_rx) = oneshot::channel();
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

    let (proxy_state, gateway_token) = setup_gateway_proxy(upstream_port);
    let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_port = proxy_listener.local_addr().unwrap().port();
    let router_state = proxy_state.clone();
    let proxy_task = tokio::spawn(async move {
        axum::serve(proxy_listener, build_proxy_router(router_state))
            .await
            .unwrap()
    });

    let mut request = format!("ws://127.0.0.1:{}/v1/realtime", proxy_port)
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        "authorization",
        format!("Bearer {}", gateway_token).parse().unwrap(),
    );
    request
        .headers_mut()
        .insert("user-agent", "external-client/0.2".parse().unwrap());
    request
        .headers_mut()
        .insert("x-api-key", "sk-client-claimed".parse().unwrap());

    let (mut client, response) = tokio_tungstenite::connect_async(request).await.unwrap();
    assert_eq!(
        response.status(),
        axum::http::StatusCode::SWITCHING_PROTOCOLS
    );
    client
        .send(tungstenite::Message::Text("ping".into()))
        .await
        .unwrap();
    assert_eq!(
        client.next().await.unwrap().unwrap(),
        tungstenite::Message::Text("ping".into())
    );

    let upstream_headers = headers.lock().unwrap().clone().unwrap();
    assert_eq!(
        upstream_headers["x-api-key"], "sk-upstream-websocket",
        "gateway auth scheme applies to the WebSocket handshake"
    );
    assert!(
        !upstream_headers.contains_key("authorization"),
        "the local gateway session token must never reach the upstream"
    );
    assert_eq!(upstream_headers["user-agent"], "gateway-ws-agent/1");
    assert_eq!(upstream_headers["x-relay"], "cc-use-ws");
    assert_eq!(
        upstream_headers["x-api-key"], "sk-upstream-websocket",
        "the gateway scheme replaced the client's claimed credential header"
    );
    assert_eq!(upstream_headers["upgrade"], "websocket");
    assert_eq!(upstream_headers["sec-websocket-version"], "13");
    assert!(upstream_headers.get("sec-websocket-key").is_some());

    // A handshake is a connection event, not billed inference.
    assert!(
        proxy_state
            .db
            .lock()
            .unwrap()
            .request_log_list_all()
            .unwrap()
            .is_empty(),
        "WebSocket handshake must not be written as a billed inference request"
    );

    client.close(None).await.ok();
    proxy_task.abort();
    upstream_task.abort();
}

#[tokio::test]
async fn gateway_existing_websocket_closes_before_forwarding_next_frame_when_policy_is_restricted()
{
    let frames = Arc::new(Mutex::new(Vec::new()));
    let seen = frames.clone();
    let upstream_app = Router::new().route(
        "/v1/realtime",
        any(move |ws: WebSocketUpgrade| {
            let seen = seen.clone();
            async move {
                ws.on_upgrade(move |mut socket| async move {
                    while let Some(Ok(message)) = socket.recv().await {
                        match message {
                            Message::Text(_) | Message::Binary(_) => {
                                seen.lock().unwrap().push(message.clone());
                                let _ = socket.send(message).await;
                            }
                            Message::Close(_) => break,
                            _ => {}
                        }
                    }
                })
            }
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let upstream_task =
        tokio::spawn(async move { axum::serve(listener, upstream_app).await.unwrap() });
    let (state, token) = setup_gateway_proxy(port);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_port = listener.local_addr().unwrap().port();
    let proxy_state = state.clone();
    let proxy_task = tokio::spawn(async move {
        axum::serve(listener, build_proxy_router(proxy_state))
            .await
            .unwrap()
    });
    let mut request = format!("ws://127.0.0.1:{proxy_port}/v1/realtime")
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("authorization", format!("Bearer {token}").parse().unwrap());
    let (mut client, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    client
        .send(tungstenite::Message::Text("before".into()))
        .await
        .unwrap();
    assert_eq!(
        client.next().await.unwrap().unwrap(),
        tungstenite::Message::Text("before".into())
    );
    client
        .send(tungstenite::Message::Binary(vec![1, 2, 3].into()))
        .await
        .unwrap();
    assert_eq!(
        client.next().await.unwrap().unwrap(),
        tungstenite::Message::Binary(vec![1, 2, 3].into())
    );
    {
        let db = state.db.lock().unwrap();
        cc_use_lib::commands::gateways::gateway_update_with_policy_inner(
            &db,
            &token,
            None,
            None,
            None,
            None,
            None,
            Some(&cc_use_lib::models::GatewayModelPolicy::Selected {
                model_ids: vec!["allowed".into()],
            }),
        )
        .unwrap();
    }
    client
        .send(tungstenite::Message::Binary(vec![4, 5, 6].into()))
        .await
        .unwrap();
    let next = tokio::time::timeout(std::time::Duration::from_secs(2), client.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    match next {
        tungstenite::Message::Close(Some(frame)) => assert_eq!(
            frame.code,
            tungstenite::protocol::frame::coding::CloseCode::Policy
        ),
        other => panic!("expected policy close, got {other:?}"),
    }
    assert_eq!(
        frames.lock().unwrap().len(),
        2,
        "post-policy frame must not reach upstream"
    );
    // Restricting one outlet does not restrict another outlet on the same key.
    let second = {
        let db = state.db.lock().unwrap();
        let first = db.gateway_get(&token).unwrap().unwrap();
        cc_use_lib::commands::gateways::gateway_create_inner(
            &db,
            "unaffected",
            &first.provider_id,
            &first.api_key_id,
            Some(&first.connection_config),
        )
        .unwrap()
    };
    let mut second_request = format!("ws://127.0.0.1:{proxy_port}/v1/realtime")
        .into_client_request()
        .unwrap();
    second_request.headers_mut().insert(
        "authorization",
        format!("Bearer {}", second.session_token).parse().unwrap(),
    );
    let (mut second_client, _) = tokio_tungstenite::connect_async(second_request)
        .await
        .unwrap();
    second_client
        .send(tungstenite::Message::Binary(vec![7, 8].into()))
        .await
        .unwrap();
    assert_eq!(
        second_client.next().await.unwrap().unwrap(),
        tungstenite::Message::Binary(vec![7, 8].into())
    );
    assert_eq!(frames.lock().unwrap().len(), 3);
    second_client.close(None).await.ok();

    // A new handshake is also refused before contacting the upstream.
    let mut request = format!("ws://127.0.0.1:{proxy_port}/v1/realtime")
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("authorization", format!("Bearer {token}").parse().unwrap());
    let failure = tokio_tungstenite::connect_async(request).await.unwrap_err();
    match failure {
        tungstenite::Error::Http(response) => assert_eq!(response.status().as_u16(), 403),
        other => panic!("expected local rejection: {other:?}"),
    }
    proxy_task.abort();
    upstream_task.abort();
}
