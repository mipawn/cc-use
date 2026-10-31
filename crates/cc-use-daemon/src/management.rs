use axum::{
    extract::{ConnectInfo, Request, State},
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use cc_use_lib::db::Database;
use cc_use_lib::shared_runtime::{
    ensure_management_token, read_management_token, validate_management_token, ManagementTokenPaths,
};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub struct DaemonState {
    pub db: Arc<Mutex<Database>>,
    pub proxy_state: Arc<cc_use_lib::proxy::ProxyState>,
    /// This process's console history. Only the owning process may delete it,
    /// so the GUI asks the daemon to clear its own files instead of removing
    /// a file that is still being written to.
    pub console_log: Arc<cc_use_lib::services::console_log_store::ConsoleLogHandle>,
    pub management_token: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ManagementHealthResponse {
    pub ok: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagementInstanceHeartbeatInput {
    pub instance_id: String,
    pub shell_pid: Option<i32>,
    pub process_pid: Option<i32>,
    pub phase: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagementInstanceStopInput {
    pub instance_id: String,
    pub shell_pid: Option<i32>,
    pub process_pid: Option<i32>,
    pub stop_reason: Option<String>,
    pub exit_code: Option<i32>,
}

pub fn management_routes() -> Router<DaemonState> {
    Router::new()
        .route("/_management/health", get(management_health))
        // Read and write share the path: the GUI must be able to show the
        // daemon's real state after a reload rather than assuming it is off.
        .route(
            "/_management/console/detail-mode",
            get(management_console_detail_mode_get).post(management_console_detail_mode),
        )
        .route(
            "/_management/instances/heartbeat",
            post(management_instance_heartbeat),
        )
        .route(
            "/_management/instances/stop",
            post(management_instance_stop),
        )
        .route(
            "/_management/console/stream",
            get(crate::console_stream::console_stream),
        )
        .route("/_management/console/clear", post(management_console_clear))
        .route(
            "/_management/console/log-status",
            get(management_console_log_status),
        )
        // The management plane is loopback-only no matter what the proxy
        // listen scope is (R8). Without this layer, binding the proxy to
        // `0.0.0.0` would also publish the management token, console clear and
        // the SSE admin stream to every peer on the LAN.
        .route_layer(middleware::from_fn(require_loopback_peer))
}

/// Reject management requests whose TCP peer is not loopback.
///
/// The peer address comes from `ConnectInfo`, which the only production
/// listener installs via `into_make_service_with_connect_info`
/// (`runtime::run_foreground`). A missing extension can therefore only mean an
/// in-process router test or a direct `Router` call, where no peer address
/// exists at all; those are treated as trusted so tests can drive the handlers.
/// The real listener always provides the extension, so a LAN client cannot
/// reach `/_management/*` even when the proxy binds `0.0.0.0`.
///
/// This check runs before authentication on purpose: a non-loopback peer gets
/// the same 403 whether or not it presents the right management token, so the
/// route's existence and its token can never be probed from the network.
async fn require_loopback_peer(request: Request, next: Next) -> Response {
    let peer = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|connect_info| connect_info.0);
    if let Some(peer) = peer {
        if !peer.ip().is_loopback() {
            return error_response(
                StatusCode::FORBIDDEN,
                "Management API is only reachable over loopback",
            );
        }
    }
    next.run(request).await
}

/// Drop the daemon's own console history. The GUI clears its files itself and
/// calls this so both sides move to the same generation.
///
/// The clear is queued behind whatever is already being written, and the
/// response is only sent after the writer finished removing the files: the app
/// treats a `200` as a real per-owner acknowledgement, not an "accepted"
/// placeholder. The generation is returned so a caller can prove the clear
/// moved the cursor even when the directory was read immediately afterwards.
async fn management_console_clear(
    State(state): State<DaemonState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, Response> {
    require_management_token(&state, &headers)?;
    let console_log = Arc::clone(&state.console_log);
    let result = tokio::task::spawn_blocking(move || {
        console_log.clear_and_wait(std::time::Duration::from_secs(5))
    })
    .await
    .map_err(|_| {
        error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Console clear task failed",
        )
    })?;
    match result {
        Ok(()) => Ok(Json(serde_json::json!({
            "ok": true,
            "generation": state.console_log.generation(),
        }))),
        Err(message) => Err(error_response(StatusCode::INTERNAL_SERVER_ERROR, &message)),
    }
}

/// Per-owner writer state, for the console's write-status line. The daemon is
/// by definition available when it answers; the app reports `available: false`
/// for an unreachable daemon instead of treating the zeros as healthy.
async fn management_console_log_status(
    State(state): State<DaemonState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, Response> {
    require_management_token(&state, &headers)?;
    let status = state.console_log.status();
    Ok(Json(serde_json::json!({
        "available": status.available,
        "dropped": status.dropped,
        "writeFailed": status.write_failed,
        "trimmed": status.trimmed,
        "capacityEvicted": status.capacity_evicted,
    })))
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagementConsoleDetailModeInput {
    enabled: bool,
}

async fn management_console_detail_mode(
    State(state): State<DaemonState>,
    headers: HeaderMap,
    Json(input): Json<ManagementConsoleDetailModeInput>,
) -> Result<Json<ManagementHealthResponse>, Response> {
    require_management_token(&state, &headers)?;
    state
        .proxy_state
        .detail_mode
        .store(input.enabled, Ordering::Relaxed);
    Ok(Json(ManagementHealthResponse { ok: true }))
}

/// Whether the daemon is currently capturing request/response detail. The flag
/// lives in the daemon, so a reloaded renderer has to ask rather than guess.
async fn management_console_detail_mode_get(
    State(state): State<DaemonState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, Response> {
    require_management_token(&state, &headers)?;
    Ok(Json(serde_json::json!({
        "enabled": state.proxy_state.detail_mode.load(Ordering::Relaxed),
    })))
}

pub fn resolve_management_token() -> Result<String, String> {
    let home_dir =
        dirs::home_dir().ok_or_else(|| "Failed to resolve home directory".to_string())?;
    let paths = ManagementTokenPaths::from_home(&home_dir);
    ensure_management_token(&paths)
}

pub fn read_existing_management_token() -> Result<Option<String>, String> {
    let home_dir =
        dirs::home_dir().ok_or_else(|| "Failed to resolve home directory".to_string())?;
    let paths = ManagementTokenPaths::from_home(&home_dir);
    read_management_token(&paths)
}

async fn management_health(
    State(state): State<DaemonState>,
    headers: HeaderMap,
) -> Result<Json<ManagementHealthResponse>, Response> {
    require_management_token(&state, &headers)?;
    Ok(Json(ManagementHealthResponse { ok: true }))
}

async fn management_instance_heartbeat(
    State(state): State<DaemonState>,
    headers: HeaderMap,
    Json(input): Json<ManagementInstanceHeartbeatInput>,
) -> Result<Json<ManagementHealthResponse>, Response> {
    require_management_token(&state, &headers)?;

    let db = state
        .db
        .lock()
        .map_err(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "Database lock failed"))?;
    let phase = input.phase.as_deref().unwrap_or("running");
    if !matches!(phase, "launching" | "running") {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Invalid managed instance heartbeat phase",
        ));
    }
    let updated = db
        .managed_instance_touch_heartbeat(
            &input.instance_id,
            input.shell_pid,
            input.process_pid,
            phase,
            &chrono::Utc::now().to_rfc3339(),
        )
        .map_err(|e| error_response(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;

    if !updated {
        return Err(error_response(
            StatusCode::CONFLICT,
            "Managed instance is no longer active",
        ));
    }

    Ok(Json(ManagementHealthResponse { ok: true }))
}

async fn management_instance_stop(
    State(state): State<DaemonState>,
    headers: HeaderMap,
    Json(input): Json<ManagementInstanceStopInput>,
) -> Result<Json<ManagementHealthResponse>, Response> {
    require_management_token(&state, &headers)?;

    let status = match input.stop_reason.as_deref() {
        Some("launch_failed" | "prelaunch_failed") => "failed",
        _ => "stopped",
    };

    let db = state
        .db
        .lock()
        .map_err(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "Database lock failed"))?;
    let instance = db
        .managed_instance_get(&input.instance_id)
        .map_err(|e| error_response(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Managed instance not found"))?;
    let session_token = instance.session_token;
    let now = chrono::Utc::now().to_rfc3339();
    if matches!(instance.status.as_str(), "stopped" | "failed") {
        db.proxy_session_revoke(&session_token, &instance.status, &now)
            .map_err(|e| error_response(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
        return Ok(Json(ManagementHealthResponse { ok: true }));
    }
    let updated = db
        .managed_instance_mark_stopped(
            &input.instance_id,
            input.shell_pid,
            input.process_pid,
            status,
            input.stop_reason.as_deref(),
            input.exit_code,
            &now,
        )
        .map_err(|e| error_response(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;

    if !updated {
        return Err(error_response(
            StatusCode::CONFLICT,
            "Managed instance is no longer active",
        ));
    }

    db.proxy_session_revoke(&session_token, status, &now)
        .map_err(|e| error_response(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;

    Ok(Json(ManagementHealthResponse { ok: true }))
}

fn require_management_token(state: &DaemonState, headers: &HeaderMap) -> Result<(), Response> {
    let provided = headers
        .get("x-cc-use-management-token")
        .and_then(|value| value.to_str().ok());

    if validate_management_token(&state.management_token, provided) {
        Ok(())
    } else {
        Err(error_response(
            StatusCode::UNAUTHORIZED,
            "Invalid management token",
        ))
    }
}

fn error_response(status: StatusCode, message: &str) -> Response {
    (status, Json(serde_json::json!({ "error": message }))).into_response()
}
