use crate::daemon_client::{probe_tcp_port, read_daemon_status, restart_daemon, start_daemon, stop_daemon};
use crate::db::Database;
use crate::models::{ProxySession, ProxyStatus};
use crate::shared_runtime::new_session_token;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::State;

/// How long to wait for the daemon's listener to come up after a
/// start/restart. `launchctl bootstrap` returns as soon as it has
/// scheduled the process, not when the port is actually reachable;
/// without this poll the first `proxy_status()` after restart always
/// reports "not running", which is how we end up with a UI stuck on
/// "已停止" after the user clicks 重启.
const PORT_READY_TIMEOUT: Duration = Duration::from_secs(3);
const PORT_READY_POLL_INTERVAL: Duration = Duration::from_millis(100);

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
    let _ = proxy_status_inner(db)?;
    stop_daemon()
}

#[tauri::command]
pub async fn proxy_restart(db: State<'_, Arc<Mutex<Database>>>) -> Result<(), String> {
    let port = read_proxy_port(&*db)?;
    restart_daemon()?;
    wait_for_port_ready(port, PORT_READY_TIMEOUT).await
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

pub fn proxy_status_inner(db: &Arc<Mutex<Database>>) -> Result<ProxyStatus, String> {
    let settings = {
        let db = db.lock().map_err(|e| e.to_string())?;
        db.settings_get().map_err(|e| e.to_string())?
    };
    read_daemon_status(settings.proxy_port)
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
