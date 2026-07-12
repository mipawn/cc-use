use crate::management::{management_routes, resolve_management_token, DaemonState};
use axum::{
    body::Body,
    extract::{Request, State},
    response::Response,
    Router,
};
use cc_use_lib::{db::Database, proxy::build_proxy_state, proxy::handler::proxy_handler};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

const MANAGED_INSTANCE_STALE_AFTER_SECS: i64 = 20;
const MANAGED_INSTANCE_STOP_STALE_AFTER_SECS: i64 = 120;
const MANAGED_INSTANCE_SWEEP_INTERVAL_SECS: u64 = 10;

pub fn build_daemon_state(
    db: Arc<Mutex<Database>>,
    proxy_state: Arc<cc_use_lib::proxy::ProxyState>,
) -> Result<DaemonState, String> {
    Ok(DaemonState {
        db,
        proxy_state,
        management_token: resolve_management_token()?,
    })
}

pub fn build_daemon_router(state: DaemonState) -> Router {
    Router::new()
        .merge(management_routes())
        .fallback(daemon_proxy_handler)
        .with_state(state)
}

async fn daemon_proxy_handler(
    State(state): State<DaemonState>,
    request: Request<Body>,
) -> Result<Response<Body>, Response<Body>> {
    proxy_handler(State(state.proxy_state), request).await
}

pub async fn run_foreground() -> Result<(), String> {
    let db = Arc::new(Mutex::new(
        Database::new().map_err(|e| format!("Failed to initialize database: {}", e))?,
    ));
    let settings = {
        let db = db.lock().map_err(|e| e.to_string())?;
        db.settings_get()
            .map_err(|e| format!("Failed to load settings: {}", e))?
    };
    let proxy_state = build_proxy_state(db.clone())?;
    // Install the logger AFTER proxy_state exists so it has a live Sender
    // to broadcast into. Any `log::info!` from here on is observable by the
    // Console page once a subscriber connects.
    crate::console_logger::install(proxy_state.console_tx.clone());
    log::info!("daemon booted; binding 127.0.0.1:{}", settings.proxy_port);

    let state = build_daemon_state(db.clone(), proxy_state)?;
    spawn_managed_instance_sweeper(db);

    let app = build_daemon_router(state);
    let addr = SocketAddr::from(([127, 0, 0, 1], settings.proxy_port as u16));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| format!("Failed to bind daemon port {}: {}", settings.proxy_port, e))?;

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await
    .map_err(|e| format!("Daemon server exited with error: {}", e))
}

fn spawn_managed_instance_sweeper(db: Arc<Mutex<Database>>) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(
            MANAGED_INSTANCE_SWEEP_INTERVAL_SECS,
        ));

        loop {
            interval.tick().await;

            let stale_cutoff =
                chrono::Utc::now() - chrono::Duration::seconds(MANAGED_INSTANCE_STALE_AFTER_SECS);
            let stop_cutoff = chrono::Utc::now()
                - chrono::Duration::seconds(MANAGED_INSTANCE_STOP_STALE_AFTER_SECS);

            if let Ok(db) = db.lock() {
                let _ = db.managed_instance_mark_stale_older_than(&stale_cutoff.to_rfc3339());
                let _ = db.managed_instance_stop_stale_older_than(&stop_cutoff.to_rfc3339());
                let _ = db.proxy_session_revoke_stopped_managed(&chrono::Utc::now().to_rfc3339());
            }
        }
    });
}
