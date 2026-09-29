mod support;

use axum::body::Body;
use axum::extract::State as AxumState;
use axum::http::{Request, StatusCode};
use axum::response::IntoResponse;
use axum::routing::post;
use axum::Router;
use cc_use_lib::db::Database;
use cc_use_lib::models::{CreateProviderInput, ProxySession};
use cc_use_lib::proxy::handler::proxy_handler;
use cc_use_lib::proxy::ProxyState;
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;

const REAL_CLAUDE_UA: &str = "claude-cli/2.1.161 (external, cli)";
const CHOSEN_UA: &str = "claude-cli/9.9.9 (external, cli)";

#[derive(Clone)]
struct Received {
    /// Every `user-agent` value, in order — a second one would be a bug the
    /// upstream would have to resolve on its own.
    user_agents: Vec<String>,
}

async fn start_mock_upstream() -> (u16, Arc<Mutex<Vec<Received>>>) {
    let received: Arc<Mutex<Vec<Received>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = received.clone();

    let app = Router::new().route(
        "/v1/messages",
        post(move |req: Request<Body>| {
            let sink = sink.clone();
            async move {
                let user_agents = req
                    .headers()
                    .get_all("user-agent")
                    .iter()
                    .filter_map(|value| value.to_str().ok().map(str::to_string))
                    .collect();
                sink.lock().unwrap().push(Received { user_agents });
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

/// A provider, key and session pointed at the mock upstream.
struct Fixture {
    state: Arc<ProxyState>,
    session_token: String,
}

fn setup(upstream_port: u16, cli_type: Option<&str>, proxy_user_agent: Option<&str>) -> Fixture {
    let path = std::env::temp_dir().join(format!("cc-use-ua-{}.db", nanoid::nanoid!(8)));
    let db = Arc::new(Mutex::new(
        Database::open_at(&path).expect("create temp database"),
    ));

    let (provider_id, api_key_id) = {
        let guard = db.lock().unwrap();
        let provider = guard
            .provider_create(&CreateProviderInput {
                request_headers: None,
                wallet_balance_script: None,
                name: "ua-provider".to_string(),
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

        let api_key = support::create_api_key(&guard, &provider.id, "claude");
        guard
            .conn
            .execute(
                "UPDATE api_keys SET types = '[\"claude_code\"]' WHERE id = ?1",
                [&api_key.id],
            )
            .expect("normalize key type");

        if let Some(user_agent) = proxy_user_agent {
            let configs = serde_json::json!({
                "claude_code": { "proxyUserAgent": user_agent }
            });
            guard
                .conn
                .execute(
                    "UPDATE api_keys SET client_configs = ?1 WHERE id = ?2",
                    rusqlite::params![configs.to_string(), api_key.id],
                )
                .expect("persist client config");
        }

        (provider.id, api_key.id)
    };

    let session_token = format!("session-{}", nanoid::nanoid!(16));
    {
        let guard = db.lock().unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        guard
            .proxy_session_create(&ProxySession {
                session_token: session_token.clone(),
                provider_id,
                api_key_id,
                project_id: None,
                created_at: now.clone(),
                session_kind: "manual".to_string(),
                last_seen_at: now,
                expires_at: None,
                revoked_at: None,
                revoked_reason: None,
                cli_type: cli_type.map(str::to_string),
            })
            .expect("create proxy session");
    }

    let state = cc_use_lib::proxy::build_proxy_state(Arc::clone(&db)).expect("build proxy state");
    Fixture {
        state,
        session_token,
    }
}

impl Fixture {
    async fn send(&self, user_agent: &str) -> Result<(), String> {
        let request = Request::builder()
            .method("POST")
            .uri("/v1/messages")
            .header("authorization", format!("Bearer {}", self.session_token))
            .header("content-type", "application/json")
            .header("user-agent", user_agent)
            .body(Body::from(r#"{"model":"claude-sonnet-4-6","messages":[]}"#))
            .unwrap();

        proxy_handler(AxumState(Arc::clone(&self.state)), request)
            .await
            .map(|_| ())
            .map_err(|response| format!("forward rejected with {}", response.status()))
    }
}

async fn forwarded_user_agents(received: &Arc<Mutex<Vec<Received>>>) -> Vec<String> {
    // The mock handler runs off the request path; give it a moment to record.
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let received = received.lock().unwrap();
    assert_eq!(received.len(), 1, "expected exactly one forwarded request");
    received[0].user_agents.clone()
}

#[tokio::test]
async fn an_unchosen_user_agent_crosses_untouched() {
    let (port, received) = start_mock_upstream().await;
    let fixture = setup(port, Some("claude_code"), None);

    fixture.send(REAL_CLAUDE_UA).await.expect("forward");

    assert_eq!(
        forwarded_user_agents(&received).await,
        vec![REAL_CLAUDE_UA.to_string()]
    );
}

#[tokio::test]
async fn a_chosen_user_agent_replaces_a_real_clients_own() {
    let (port, received) = start_mock_upstream().await;
    let fixture = setup(port, Some("claude_code"), Some(CHOSEN_UA));

    // The caller is the real client, and its value still loses: naming a UA is
    // a decision about what the upstream sees, not a default.
    fixture.send(REAL_CLAUDE_UA).await.expect("forward");

    assert_eq!(
        forwarded_user_agents(&received).await,
        vec![CHOSEN_UA.to_string()]
    );
}

#[tokio::test]
async fn exactly_one_user_agent_reaches_the_upstream() {
    let (port, received) = start_mock_upstream().await;
    let fixture = setup(port, Some("claude_code"), Some(CHOSEN_UA));

    fixture.send(REAL_CLAUDE_UA).await.expect("forward");

    // Two values would leave the upstream to pick, which is the situation a
    // chosen UA exists to avoid.
    assert_eq!(forwarded_user_agents(&received).await.len(), 1);
}

#[tokio::test]
async fn clearing_the_choice_restores_the_clients_own_value() {
    let (port, received) = start_mock_upstream().await;
    let fixture = setup(port, Some("claude_code"), None);

    fixture.send("curl/8.0").await.expect("forward");

    assert_eq!(
        forwarded_user_agents(&received).await,
        vec!["curl/8.0".to_string()]
    );
}

#[tokio::test]
async fn a_stored_value_that_cannot_travel_does_not_break_the_request() {
    let (port, received) = start_mock_upstream().await;
    let fixture = setup(port, Some("claude_code"), Some("bad\nvalue"));

    // It was stored before validation existed. Skipping it is the outcome that
    // keeps the request alive; failing it would punish the caller for a value
    // they did not send.
    fixture.send(REAL_CLAUDE_UA).await.expect("forward");

    assert_eq!(
        forwarded_user_agents(&received).await,
        vec![REAL_CLAUDE_UA.to_string()]
    );
}
