use crate::daemon_client::{read_daemon_status, restart_daemon, start_daemon, stop_daemon};
use crate::db::Database;
use crate::models::{ProxySession, ProxyStatus};
use crate::shared_runtime::new_session_token;
use std::sync::{Arc, Mutex};
use tauri::State;

/// Public helper for tray module to check proxy status
pub fn is_proxy_running(db: &Arc<Mutex<Database>>) -> bool {
    proxy_status_inner(db)
        .map(|status| status.is_running)
        .unwrap_or(false)
}

/// Inner implementation callable from tray and app startup
pub async fn proxy_start_inner(db: &Arc<Mutex<Database>>) -> Result<(), String> {
    let _ = proxy_status_inner(db)?;
    start_daemon()
}

pub async fn proxy_stop_inner(db: &Arc<Mutex<Database>>) -> Result<(), String> {
    let _ = proxy_status_inner(db)?;
    stop_daemon()
}

#[tauri::command]
pub async fn proxy_restart(db: State<'_, Arc<Mutex<Database>>>) -> Result<(), String> {
    let _ = proxy_status_inner(&*db)?;
    restart_daemon()
}

/// Also used internally (e.g. tray refresh, health check)
pub async fn proxy_restart_inner(db: &Arc<Mutex<Database>>) -> Result<(), String> {
    let _ = proxy_status_inner(db)?;
    restart_daemon()
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
