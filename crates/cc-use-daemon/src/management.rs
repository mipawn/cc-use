use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use cc_use_lib::db::Database;
use cc_use_lib::shared_runtime::{
    ensure_management_token, read_management_token, validate_management_token, ManagementTokenPaths,
};
use serde::{Deserialize, Serialize};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub struct DaemonState {
    pub db: Arc<Mutex<Database>>,
    pub proxy_state: Arc<cc_use_lib::proxy::ProxyState>,
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
        .route(
            "/_management/console/detail-mode",
            post(management_console_detail_mode),
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
