use crate::db::Database;
use crate::models::GlobalSettings;
use crate::services::console_bridge::ConsoleBridgeHandle;
use std::sync::{Arc, Mutex};
use tauri::State;

#[tauri::command]
pub fn settings_get(db: State<'_, Arc<Mutex<Database>>>) -> Result<GlobalSettings, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.settings_get().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn settings_update(
    db: State<'_, Arc<Mutex<Database>>>,
    bridge: State<'_, ConsoleBridgeHandle>,
    updates: serde_json::Value,
) -> Result<GlobalSettings, String> {
    // Snapshot the old port before writing so we can detect a change.
    // Held scope ends before proxy_restart_inner's own lock to avoid
    // deadlocking on the DB mutex.
    let (old_port, new_settings) = {
        let db = db.lock().map_err(|e| e.to_string())?;
        let old = db.settings_get().map_err(|e| e.to_string())?;
        let new_settings = db.settings_update(&updates).map_err(|e| e.to_string())?;
        (old.proxy_port, new_settings)
    };

    // Port change means the running daemon is now bound to the wrong
    // port. Trigger a restart so the new port takes effect immediately
    // without the user having to click "restart" themselves. Failure
    // here is logged but not surfaced — the settings write itself
    // succeeded, and the UI's status polling will reflect the real
    // daemon state a moment later.
    if new_settings.proxy_port != old_port {
        if let Err(e) = crate::commands::proxy::proxy_restart_inner(&*db).await {
            log::warn!(
                "proxy_port changed {} -> {} but daemon restart failed: {}",
                old_port,
                new_settings.proxy_port,
                e
            );
        }
        // Kick the console bridge so it drops its stale connection to the
        // old-port daemon and picks up the new port on reconnect. Without
        // this the Console page stays dark for up to BACKOFF_MAX seconds.
        bridge.restart();
    }

    Ok(new_settings)
}
