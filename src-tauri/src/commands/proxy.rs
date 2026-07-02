use crate::daemon_client::{
    probe_tcp_port, read_daemon_status, restart_daemon, start_daemon, stop_daemon,
};
use crate::db::Database;
use crate::models::{ProxySession, ProxyStatus};
use crate::shared_runtime::new_session_token;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

/// How long to wait for the daemon's listener to come up after a
/// start/restart. `launchctl bootstrap` returns as soon as it has
/// scheduled the process, not when the port is actually reachable;
/// without this poll the first `proxy_status()` after restart always
/// reports "not running", which is how we end up with a UI stuck on
/// "已停止" after the user clicks 重启.
const PORT_READY_TIMEOUT: Duration = Duration::from_secs(3);
const PORT_READY_POLL_INTERVAL: Duration = Duration::from_millis(100);
const PORT_STOP_TIMEOUT: Duration = Duration::from_secs(3);

/// Public helper for tray module to check proxy status
pub fn is_proxy_running(db: &Arc<Mutex<Database>>) -> bool {
    proxy_status_inner(db)
        .map(|status| status.is_running)
        .unwrap_or(false)
}

/// Inner implementation callable from tray and app startup
pub async fn proxy_start_inner(db: &Arc<Mutex<Database>>) -> Result<(), String> {
    let port = read_proxy_port(db)?;
    start_daemon()?;
    wait_for_port_ready(port, PORT_READY_TIMEOUT).await
}

pub async fn proxy_stop_inner(db: &Arc<Mutex<Database>>) -> Result<(), String> {
    let port = read_proxy_port(db)?;
    stop_daemon().map_err(|e| format!("stop daemon failed: {}", e))?;
    wait_for_port_stopped(port, PORT_STOP_TIMEOUT).await
}

#[tauri::command]
pub async fn proxy_restart(
    app: AppHandle,
    db: State<'_, Arc<Mutex<Database>>>,
) -> Result<(), String> {
    let port = read_proxy_port(&*db)?;
    restart_daemon()?;
    wait_for_port_ready(port, PORT_READY_TIMEOUT).await?;
    emit_proxy_status(&app, &*db);
    Ok(())
}

/// Explicit user-driven start (daemon toggle ON). Surfaces the real failure
/// reason (e.g. port occupied) so the UI can show it rather than a generic
/// "not reachable".
#[tauri::command]
pub async fn proxy_start(
    app: AppHandle,
    db: State<'_, Arc<Mutex<Database>>>,
) -> Result<(), String> {
    proxy_start_inner(&*db).await.map_err(|e| {
        // Enrich with the EADDRINUSE / occupancy reason if that's why we failed.
        match proxy_status_inner(&*db) {
            Ok(status) => status.last_error.unwrap_or(e),
            Err(_) => e,
        }
    })?;
    emit_proxy_status(&app, &*db);
    Ok(())
}

/// Explicit user-driven stop (daemon toggle OFF).
#[tauri::command]
pub async fn proxy_stop(app: AppHandle, db: State<'_, Arc<Mutex<Database>>>) -> Result<(), String> {
    proxy_stop_inner(&*db).await?;
    emit_proxy_status(&app, &*db);
    Ok(())
}

/// Toggle the daemon's console detail-mode flag via its management endpoint.
#[tauri::command]
pub async fn console_detail_mode_set(
    db: State<'_, Arc<Mutex<Database>>>,
    enabled: bool,
) -> Result<(), String> {
    let (port, token) = {
        let db = db.lock().map_err(|e| e.to_string())?;
        let settings = db.settings_get().map_err(|e| e.to_string())?;
        let token = crate::shared_runtime::read_management_token(
            &crate::shared_runtime::ManagementTokenPaths::from_home(
                &dirs::home_dir().ok_or("no home dir")?,
            ),
        )
        .map_err(|e| format!("read management token: {}", e))?
        .ok_or("no management token")?;
        (settings.proxy_port, token)
    };

    let client = reqwest::Client::new();
    let resp = client
        .post(format!(
            "http://127.0.0.1:{}/_management/console/detail-mode",
            port
        ))
        .header("x-cc-use-management-token", &token)
        .json(&serde_json::json!({ "enabled": enabled }))
        .send()
        .await
        .map_err(|e| format!("detail-mode toggle failed: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("detail-mode toggle failed: HTTP {}", resp.status()));
    }
    Ok(())
}

/// Also used internally (e.g. tray refresh, health check)
pub async fn proxy_restart_inner(db: &Arc<Mutex<Database>>) -> Result<(), String> {
    let port = read_proxy_port(db)?;
    restart_daemon()?;
    wait_for_port_ready(port, PORT_READY_TIMEOUT).await
}

#[tauri::command]
pub fn proxy_status(db: State<'_, Arc<Mutex<Database>>>) -> Result<ProxyStatus, String> {
    proxy_status_inner(&*db)
}

/// Result of a single latency probe round, surfaced to the launchpad pages so
/// users can see proxy + upstream reachability before launching a CLI.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatencyReport {
    /// Round-trip ms to the local daemon port, null if unreachable.
    pub daemon_latency_ms: Option<u64>,
    pub daemon_reachable: bool,
    /// Round-trip ms to the upstream base URL, null if unreachable / not probed.
    pub upstream_latency_ms: Option<u64>,
    pub upstream_reachable: bool,
    /// Failure reason for the upstream probe (timeout / dns / etc), if any.
    pub upstream_error: Option<String>,
}

const UPSTREAM_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// Probe both the local daemon port and (optionally) an upstream base URL.
///
/// The upstream probe is intentionally credential-free and does NOT hit a real
/// inference endpoint: it issues a HEAD to the base URL purely to measure RTT
/// and reachability, so it never incurs cost or writes request_logs. Any HTTP
/// response (even 4xx/401) counts as reachable — we only care that the host
/// answered.
#[tauri::command]
pub async fn latency_probe(
    db: State<'_, Arc<Mutex<Database>>>,
    upstream_base_url: Option<String>,
    provider_id: Option<String>,
) -> Result<LatencyReport, String> {
    let (port, provider) = {
        let db = db.lock().map_err(|e| e.to_string())?;
        let settings = db.settings_get().map_err(|e| e.to_string())?;
        let provider = match provider_id.as_deref().filter(|id| !id.trim().is_empty()) {
            Some(id) => db.provider_get(id).map_err(|e| e.to_string())?,
            None => None,
        };
        (settings.proxy_port, provider)
    };

    // Daemon probe: blocking TCP connect on the blocking pool, timed.
    let daemon_start = Instant::now();
    let daemon_reachable = tokio::task::spawn_blocking(move || probe_tcp_port(port))
        .await
        .map_err(|e| format!("probe task join failed: {}", e))?;
    let daemon_latency_ms = daemon_reachable.then(|| daemon_start.elapsed().as_millis() as u64);

    let mut report = LatencyReport {
        daemon_latency_ms,
        daemon_reachable,
        upstream_latency_ms: None,
        upstream_reachable: false,
        upstream_error: None,
    };

    let upstream_url = provider
        .as_ref()
        .map(|provider| provider.base_url.clone())
        .or(upstream_base_url)
        .filter(|u| !u.trim().is_empty());

    if let Some(url) = upstream_url {
        match crate::services::http_client::outbound_client_builder_for_proxy(
            provider.as_ref().and_then(|p| p.http_proxy.as_deref()),
        ) {
            Ok(builder) => match builder.timeout(UPSTREAM_PROBE_TIMEOUT).build() {
                Ok(client) => {
                    let start = Instant::now();
                    // HEAD without auth headers — we only want connectivity + RTT.
                    match client.head(&url).send().await {
                        Ok(_) => {
                            report.upstream_latency_ms = Some(start.elapsed().as_millis() as u64);
                            report.upstream_reachable = true;
                        }
                        Err(e) => {
                            report.upstream_error = Some(e.to_string());
                        }
                    }
                }
                Err(e) => {
                    report.upstream_error = Some(e.to_string());
                }
            },
            Err(e) => {
                report.upstream_error = Some(e);
            }
        }
    }

    Ok(report)
}

pub fn proxy_status_inner(db: &Arc<Mutex<Database>>) -> Result<ProxyStatus, String> {
    let settings = {
        let db = db.lock().map_err(|e| e.to_string())?;
        db.settings_get().map_err(|e| e.to_string())?
    };
    read_daemon_status(settings.proxy_port)
}

pub fn emit_proxy_status(app: &AppHandle, db: &Arc<Mutex<Database>>) {
    let status = proxy_status_inner(db).unwrap_or(ProxyStatus {
        is_running: false,
        port: read_proxy_port(db).unwrap_or(12345),
        request_count: 0,
        last_error: None,
    });
    let _ = app.emit("proxy:statusChanged", &status);
    crate::tray::refresh_tray_menu(app);
}

fn read_proxy_port(db: &Arc<Mutex<Database>>) -> Result<i32, String> {
    let settings = {
        let db = db.lock().map_err(|e| e.to_string())?;
        db.settings_get().map_err(|e| e.to_string())?
    };
    Ok(settings.proxy_port)
}

/// Poll until a TCP connection to 127.0.0.1:port succeeds or the timeout
/// elapses. probe_tcp_port is blocking, so we push each attempt onto the
/// blocking pool to avoid stalling the tokio reactor while launchd is
/// bringing the daemon up.
async fn wait_for_port_ready(port: i32, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        let reachable = tokio::task::spawn_blocking(move || probe_tcp_port(port))
            .await
            .map_err(|e| format!("probe task join failed: {}", e))?;
        if reachable {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "Daemon did not start listening on port {} within {:?}",
                port, timeout
            ));
        }
        tokio::time::sleep(PORT_READY_POLL_INTERVAL).await;
    }
}

async fn wait_for_port_stopped(port: i32, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        let reachable = tokio::task::spawn_blocking(move || probe_tcp_port(port))
            .await
            .map_err(|e| format!("probe task join failed: {}", e))?;
        if !reachable {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "Daemon stop command returned, but port {} is still reachable after {:?}",
                port, timeout
            ));
        }
        tokio::time::sleep(PORT_READY_POLL_INTERVAL).await;
    }
}

#[tauri::command]
pub fn session_create(
    db: State<'_, Arc<Mutex<Database>>>,
    provider_id: String,
    api_key_id: String,
) -> Result<ProxySession, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    let session = ProxySession {
        session_token: new_session_token(),
        provider_id,
        api_key_id,
        project_id: None,
        created_at: chrono::Utc::now().to_rfc3339(),
        cli_type: None,
    };
    db.proxy_session_create(&session)
        .map_err(|e| e.to_string())?;
    Ok(session)
}

#[tauri::command]
pub fn session_get(
    db: State<'_, Arc<Mutex<Database>>>,
    session_token: String,
) -> Result<Option<ProxySession>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.proxy_session_get(&session_token)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn session_update_key(
    db: State<'_, Arc<Mutex<Database>>>,
    session_token: String,
    api_key_id: String,
) -> Result<bool, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.proxy_session_update_key(&session_token, &api_key_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn session_update_by_project(
    db: State<'_, Arc<Mutex<Database>>>,
    project_id: String,
    provider_id: String,
    api_key_id: String,
) -> Result<(), String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.proxy_session_update_by_project(&project_id, &provider_id, &api_key_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn session_delete(
    db: State<'_, Arc<Mutex<Database>>>,
    session_token: String,
) -> Result<bool, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.proxy_session_delete(&session_token)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn session_list(db: State<'_, Arc<Mutex<Database>>>) -> Result<Vec<ProxySession>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.proxy_session_list().map_err(|e| e.to_string())
}
