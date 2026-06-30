use crate::db::Database;
use crate::models::GlobalSettings;
use crate::services::console_bridge::ConsoleBridgeHandle;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, State};

#[tauri::command]
pub fn settings_get(db: State<'_, Arc<Mutex<Database>>>) -> Result<GlobalSettings, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.settings_get().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn settings_update(
    app: AppHandle,
    db: State<'_, Arc<Mutex<Database>>>,
    bridge: State<'_, ConsoleBridgeHandle>,
    updates: serde_json::Value,
) -> Result<GlobalSettings, String> {
    // Snapshot the old port before writing so we can detect a change.
    // Held scope ends before proxy_restart_inner's own lock to avoid
    // deadlocking on the DB mutex.
    let (old_port, old_daemon_enabled, new_settings) = {
        let db = db.lock().map_err(|e| e.to_string())?;
        let old = db.settings_get().map_err(|e| e.to_string())?;
        let new_settings = db.settings_update(&updates).map_err(|e| e.to_string())?;
        (old.proxy_port, old.daemon_enabled, new_settings)
    };

    // Daemon on/off toggle changed.
    if new_settings.daemon_enabled != old_daemon_enabled {
        let toggle_result = if new_settings.daemon_enabled {
            crate::commands::proxy::proxy_start_inner(&*db).await
        } else {
            crate::commands::proxy::proxy_stop_inner(&*db).await
        };
        if let Err(e) = toggle_result {
            log::warn!("daemon toggle failed: {}", e);
            if let Ok(db) = db.lock() {
                let _ = db.settings_update(&serde_json::json!({
                    "daemonEnabled": old_daemon_enabled
                }));
            }
            crate::commands::proxy::emit_proxy_status(&app, &*db);
            return Err(e);
        }
        crate::commands::proxy::emit_proxy_status(&app, &*db);
        bridge.restart();
    }

    // Port change means the running daemon is now bound to the wrong
    // port. Trigger a restart so the new port takes effect immediately
    // without the user having to click "restart" themselves. Failure
    // here is logged but not surfaced — the settings write itself
    // succeeded, and the UI's status polling will reflect the real
    // daemon state a moment later.
    // Respect the toggle: only auto-restart when the daemon is enabled.
    if new_settings.proxy_port != old_port {
        if new_settings.daemon_enabled {
            if let Err(e) = crate::commands::proxy::proxy_restart_inner(&*db).await {
                log::warn!(
                    "proxy_port changed {} -> {} but daemon restart failed: {}",
                    old_port,
                    new_settings.proxy_port,
                    e
                );
            }
        }
        // Kick the console bridge so it drops its stale connection to the
        // old-port daemon and picks up the new port on reconnect. Without
        // this the Console page stays dark for up to BACKOFF_MAX seconds.
        bridge.restart();
        crate::commands::proxy::emit_proxy_status(&app, &*db);
    }

    Ok(new_settings)
}

#[tauri::command]
pub fn get_setting(
    db: State<'_, Arc<Mutex<Database>>>,
    key: String,
) -> Result<Option<String>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.settings_get_value(&key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_setting(
    db: State<'_, Arc<Mutex<Database>>>,
    key: String,
    value: String,
) -> Result<(), String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.settings_set_value(&key, &value)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_setting(db: State<'_, Arc<Mutex<Database>>>, key: String) -> Result<(), String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.settings_delete_value(&key).map_err(|e| e.to_string())
}
