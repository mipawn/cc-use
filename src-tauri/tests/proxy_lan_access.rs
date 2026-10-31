//! R8/T25: LAN access policy for the proxy plane.
//!
//! When the daemon is explicitly bound to the LAN, a non-loopback peer may only
//! use the local gateway/session tokens. Provider-credential pass-through is
//! rejected (403) so the desktop app cannot become an open relay for real
//! provider keys. Loopback peers, and in-process tests without `ConnectInfo`,
//! keep every existing behaviour.

mod support;

use axum::body::Body;
use axum::extract::{ConnectInfo, State as AxumState};
use axum::http::{Request, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::Router;
use cc_use_lib::commands::gateways::gateway_create_inner;
use cc_use_lib::db::Database;
use cc_use_lib::models::{CreateProviderInput, ProxySession};
use cc_use_lib::proxy::console::ConsoleEvent;
use cc_use_lib::proxy::handler::proxy_handler;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use support::{build_proxy_state, create_api_key};
use tokio::net::TcpListener;

const LAN_PEER_IP: [u8; 4] = [192, 168, 1, 23];

struct MockUpstream {
    port: u16,
    message_hits: Arc<Mutex<u32>>,
    model_hits: Arc<Mutex<u32>>,
    responses_hits: Arc<Mutex<u32>>,
}

async fn start_mock_upstream() -> MockUpstream {
    let message_hits = Arc::new(Mutex::new(0));
    let model_hits = Arc::new(Mutex::new(0));
    let responses_hits = Arc::new(Mutex::new(0));
    let messages = Arc::clone(&message_hits);
    let models = Arc::clone(&model_hits);
    let responses = Arc::clone(&responses_hits);

    let app = Router::new()
        .route(
            "/v1/messages",
            post(move || {
                let messages = Arc::clone(&messages);
                async move {
                    *messages.lock().unwrap() += 1;
                    (StatusCode::OK, r#"{"type":"message","content":[]}"#).into_response()
                }
            }),
        )
        .route(
            "/v1/models",
            get(move || {
                let models = Arc::clone(&models);
                async move {
                    *models.lock().unwrap() += 1;
                    (
                        StatusCode::OK,
                        r#"{"object":"list","data":[{"id":"lan-mock-model","object":"model"}]}"#,
                    )
                        .into_response()
                }
            }),
        )
        .route(
            "/v1/responses",
            post(move || {
                let responses = Arc::clone(&responses);
                async move {
                    *responses.lock().unwrap() += 1;
                    (StatusCode::OK, r#"{"id":"resp-lan","object":"response"}"#).into_response()
                }
            }),
        );

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    tokio::time::sleep(Duration::from_millis(10)).await;

    MockUpstream {
        port,
        message_hits,
        model_hits,
        responses_hits,
    }
}

fn open_temp_db() -> (Database, PathBuf) {
    let path = std::env::temp_dir().join(format!("cc-use-lan-access-{}.db", nanoid::nanoid!(8)));
    let db = Database::open_at(&path).expect("create temp database");
    (db, path)
}

fn remove_temp_db(path: &Path) {
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(path.with_extension("db-wal"));
    let _ = std::fs::remove_file(path.with_extension("db-shm"));
}

fn create_provider_at(db: &Database, base_url: &str) -> cc_use_lib::models::Provider {
    db.provider_create(&CreateProviderInput {
        request_headers: None,
        wallet_balance_script: None,
        name: "lan-provider".to_string(),
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

fn create_manual_session(db: &Database, provider_id: &str, api_key_id: &str) -> String {
    let session_token = format!("session-{}", nanoid::nanoid!(16));
    db.proxy_session_create(&ProxySession {
        session_token: session_token.clone(),
        provider_id: provider_id.to_string(),
        api_key_id: api_key_id.to_string(),
        project_id: None,
        created_at: chrono::Utc::now().to_rfc3339(),
        session_kind: "manual".to_string(),
        last_seen_at: chrono::Utc::now().to_rfc3339(),
        expires_at: None,
        revoked_at: None,
        revoked_reason: None,
        cli_type: None,
        display_name: None,
        is_active: true,
        connection_config: None,
        model_policy: None,
    })
    .expect("create proxy session");
    session_token
}

fn peer(ip: [u8; 4]) -> ConnectInfo<SocketAddr> {
    ConnectInfo(SocketAddr::from((ip, 50123)))
}

fn lan_peer() -> ConnectInfo<SocketAddr> {
    peer(LAN_PEER_IP)
}

fn loopback_peer() -> ConnectInfo<SocketAddr> {
    peer([127, 0, 0, 1])
}

fn with_peer(request: Request<Body>, peer: ConnectInfo<SocketAddr>) -> Request<Body> {
    let mut request = request;
    request.extensions_mut().insert(peer);
    request
}

fn provider_credential_request() -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/v1/messages")
        .header("authorization", "Bearer sk-live-provider-credential")
        .header("content-type", "application/json")
        .body(Body::from(r#"{"model":"claude-sonnet-4-6","messages":[]}"#))
        .unwrap()
}

fn session_request(session_token: &str) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/v1/messages")
        .header("authorization", format!("Bearer {}", session_token))
        .header("content-type", "application/json")
        .body(Body::from(r#"{"model":"claude-sonnet-4-6","messages":[]}"#))
        .unwrap()
}

/// A LAN peer must not be able to use a provider credential: the proxy would
/// forward it with this machine's real upstream keys. The rejection must be a
/// bare 403 that does not echo the credential, and it must show up in the
/// console as a rejected request.
#[tokio::test]
async fn lan_peer_provider_credential_is_rejected_and_emits_a_reject_event() {
    let (db, path) = open_temp_db();
    let state = build_proxy_state(db);
    let mut events = state.console_tx.subscribe();

    let response = proxy_handler(
        AxumState(Arc::clone(&state)),
        with_peer(provider_credential_request(), lan_peer()),
    )
    .await
    .expect_err("provider credential from a LAN peer must be rejected");

    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let body = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    let text = String::from_utf8_lossy(&body);
    assert!(
        !text.contains("sk-live-provider-credential"),
        "the rejection body must not echo the credential, got {:?}",
        text
    );
    assert!(
        !text.to_ascii_lowercase().contains("management"),
        "the rejection body must not mention management internals, got {:?}",
        text
    );
    assert!(
        text.contains("non-loopback"),
        "the rejection should explain the LAN restriction, got {:?}",
        text
    );

    let event = tokio::time::timeout(Duration::from_millis(200), events.recv())
        .await
        .expect("reject event should be broadcast")
        .expect("console channel should deliver the event");
    match event {
        ConsoleEvent::Request {
            kind,
            method,
            path,
            status,
            message,
            ..
        } => {
            assert_eq!(kind, "rejected");
            assert_eq!(method, "POST");
            assert_eq!(path, "/v1/messages");
            assert!(status.is_none(), "nothing was dispatched upstream");
            assert!(
                message.as_deref().unwrap_or("").contains("non-loopback"),
                "console reject should name the LAN cause, got {:?}",
                message
            );
        }
        other => panic!("expected a Request console event, got {:?}", other),
    }

    remove_temp_db(&path);
}

/// Loopback peers keep the historical pass-through routing. `/v1/messages` has
/// no official-upstream mapping, so a provider credential still ends in the
/// existing "Unsupported proxy path" 404 — not the LAN 403.
#[tokio::test]
async fn loopback_peer_provider_credential_keeps_passthrough_routing() {
    let (db, path) = open_temp_db();
    let state = build_proxy_state(db);

    let response = proxy_handler(
        AxumState(state),
        with_peer(provider_credential_request(), loopback_peer()),
    )
    .await
    .expect_err("unsupported pass-through path still rejects");

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    remove_temp_db(&path);
}

/// The in-process/direct-router case has no peer address at all; it must keep
/// the old behaviour (the production listener always installs ConnectInfo).
#[tokio::test]
async fn missing_connect_info_keeps_the_trusted_in_process_behaviour() {
    let (db, path) = open_temp_db();
    let state = build_proxy_state(db);

    let response = proxy_handler(AxumState(state), provider_credential_request())
        .await
        .expect_err("unsupported pass-through path still rejects");

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    remove_temp_db(&path);
}

/// A session (local Key) token from a LAN peer is the supported path: it is
/// forwarded exactly like a loopback request.
#[tokio::test]
async fn lan_peer_session_token_is_forwarded() {
    let mock = start_mock_upstream().await;
    let (db, path) = open_temp_db();
    let provider = create_provider_at(&db, &format!("http://127.0.0.1:{}", mock.port));
    let api_key = create_api_key(&db, &provider.id, "claude_code");
    let session_token = create_manual_session(&db, &provider.id, &api_key.id);
    let state = build_proxy_state(db);

    let response = proxy_handler(
        AxumState(state),
        with_peer(session_request(&session_token), lan_peer()),
    )
    .await
    .expect("a LAN peer may use a session token");

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        *mock.message_hits.lock().unwrap(),
        1,
        "the LAN session request reached the upstream"
    );
    remove_temp_db(&path);
}

/// Loopback session requests are unchanged by the guard.
#[tokio::test]
async fn loopback_peer_session_token_is_forwarded() {
    let mock = start_mock_upstream().await;
    let (db, path) = open_temp_db();
    let provider = create_provider_at(&db, &format!("http://127.0.0.1:{}", mock.port));
    let api_key = create_api_key(&db, &provider.id, "claude_code");
    let session_token = create_manual_session(&db, &provider.id, &api_key.id);
    let state = build_proxy_state(db);

    let response = proxy_handler(
        AxumState(state),
        with_peer(session_request(&session_token), loopback_peer()),
    )
    .await
    .expect("loopback session token still forwards");

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(*mock.message_hits.lock().unwrap(), 1);
    remove_temp_db(&path);
}

/// Gateway outlets are session rows too, so their tokens keep working from the
/// LAN — otherwise the feature would be useless.
#[tokio::test]
async fn lan_peer_gateway_token_is_forwarded() {
    let mock = start_mock_upstream().await;
    let (db, path) = open_temp_db();
    let provider = create_provider_at(&db, &format!("http://127.0.0.1:{}", mock.port));
    let api_key = create_api_key(&db, &provider.id, "claude_code");
    let gateway = gateway_create_inner(&db, "lan-outlet", &provider.id, &api_key.id, None)
        .expect("create gateway");
    let state = build_proxy_state(db);

    let response = proxy_handler(
        AxumState(state),
        with_peer(session_request(&gateway.session_token), lan_peer()),
    )
    .await
    .expect("a LAN peer may use a gateway token");

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(*mock.message_hits.lock().unwrap(), 1);
    remove_temp_db(&path);
}

/// Model discovery for a gateway also works from the LAN (A19: `/models` works
/// for LAN clients using the gateway token).
#[tokio::test]
async fn lan_peer_gateway_token_can_read_models() {
    let mock = start_mock_upstream().await;
    let (db, path) = open_temp_db();
    let provider = create_provider_at(&db, &format!("http://127.0.0.1:{}", mock.port));
    let api_key = create_api_key(&db, &provider.id, "claude_code");
    let gateway = gateway_create_inner(&db, "lan-outlet", &provider.id, &api_key.id, None)
        .expect("create gateway");
    let state = build_proxy_state(db);

    let request = Request::builder()
        .method("GET")
        .uri("/v1/models")
        .header("authorization", format!("Bearer {}", gateway.session_token))
        .body(Body::empty())
        .unwrap();

    let response = proxy_handler(AxumState(state), with_peer(request, lan_peer()))
        .await
        .expect("LAN gateway model discovery should reach the provider");

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    assert!(
        String::from_utf8_lossy(&body).contains("lan-mock-model"),
        "the LAN client receives the provider catalogue"
    );
    assert_eq!(*mock.model_hits.lock().unwrap(), 1);
    remove_temp_db(&path);
}

/// The Codex Desktop takeover path also starts from a provider credential. It
/// must not become a LAN bypass: even with a valid takeover session stored, a
/// non-loopback provider credential is still rejected on the auth class alone.
#[tokio::test]
async fn lan_peer_provider_credential_cannot_use_the_codex_takeover_session() {
    let mock = start_mock_upstream().await;
    let (db, path) = open_temp_db();
    let provider = create_provider_at(&db, &format!("http://127.0.0.1:{}", mock.port));
    let api_key = create_api_key(&db, &provider.id, "codex");
    let session_token = format!("session-{}", nanoid::nanoid!(16));
    db.settings_set_value(
        cc_use_lib::shared_runtime::CODEX_SESSION_TOKEN_SETTING_KEY,
        &session_token,
    )
    .expect("save takeover session token");
    db.proxy_session_create(&ProxySession {
        session_token,
        provider_id: provider.id.clone(),
        api_key_id: api_key.id.clone(),
        project_id: None,
        created_at: chrono::Utc::now().to_rfc3339(),
        session_kind: "desktop".to_string(),
        last_seen_at: chrono::Utc::now().to_rfc3339(),
        expires_at: None,
        revoked_at: None,
        revoked_reason: None,
        cli_type: Some("codex-app".to_string()),
        display_name: None,
        is_active: true,
        connection_config: None,
        model_policy: None,
    })
    .expect("create takeover proxy session");
    let state = build_proxy_state(db);

    let request = Request::builder()
        .method("POST")
        .uri("/v1/responses")
        .header("authorization", "Bearer real-openai-provider-credential")
        .header("content-type", "application/json")
        .body(Body::from(r#"{"model":"gpt-5.5","input":"hello"}"#))
        .unwrap();

    let response = proxy_handler(AxumState(state), with_peer(request, lan_peer()))
        .await
        .expect_err("LAN provider credential must be rejected before the takeover fallback");

    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        *mock.responses_hits.lock().unwrap(),
        0,
        "nothing may be forwarded upstream"
    );
    remove_temp_db(&path);
}
