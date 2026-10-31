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
    // Snapshot the old port and listen scope before writing so we can detect a
    // change. Held scope ends before proxy_restart_inner's own lock to avoid
    // deadlocking on the DB mutex.
    let (old_port, old_listen_scope, old_daemon_enabled, new_settings) = {
        let db = db.lock().map_err(|e| e.to_string())?;
        let old = db.settings_get().map_err(|e| e.to_string())?;
        let new_settings = db.settings_update(&updates).map_err(|e| e.to_string())?;
        (
            old.proxy_port,
            old.proxy_listen_scope,
            old.daemon_enabled,
            new_settings,
        )
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

    // Port or listen-scope change means the running daemon is now bound to the
    // wrong address/port. Trigger a restart so the new binding takes effect
    // immediately without the user having to click "restart" themselves.
    // Failure here is logged with both old and new values plus the daemon
    // error, and the real status is re-emitted, so an inconsistent binding is
    // visible instead of silently looking saved. The settings value itself is
    // deliberately not rolled back: the user asked for this scope and the next
    // successful start will honour it.
    // Respect the toggle: only auto-restart when the daemon is enabled.
    if listen_settings_require_restart(
        old_port,
        new_settings.proxy_port,
        &old_listen_scope,
        &new_settings.proxy_listen_scope,
    ) {
        if new_settings.daemon_enabled {
            if let Err(e) = crate::commands::proxy::proxy_restart_inner(&*db).await {
                log::warn!(
                    "proxy listen settings changed (port {} -> {}, scope {} -> {}) but daemon restart failed: {}",
                    old_port,
                    new_settings.proxy_port,
                    old_listen_scope,
                    new_settings.proxy_listen_scope,
                    e
                );
            }
        }
        // Kick the console bridge so it drops its stale connection to the
        // old-port daemon and picks up the new port on reconnect. Without
        // this the Console page stays dark for up to BACKOFF_MAX seconds.
        // A scope-only change keeps the same port but still restarts the
        // daemon, so the bridge is restarted for both cases.
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

/// Whether a settings write changed the listener binding enough to require the
/// running daemon to restart. Scope-only and port-only changes both count; a
/// no-op write must not bounce the proxy. Pure so the decision is unit-tested:
/// the actual restart call needs a Tauri `AppHandle`, which is why the branch
/// itself is only exercised by the running app and the LAN E2E script.
fn listen_settings_require_restart(
    old_port: i32,
    new_port: i32,
    old_scope: &str,
    new_scope: &str,
) -> bool {
    old_port != new_port || old_scope != new_scope
}

#[cfg(test)]
mod tests {
    use super::listen_settings_require_restart;

    #[test]
    fn a_no_op_write_does_not_restart_the_daemon() {
        assert!(!listen_settings_require_restart(
            12345, 12345, "loopback", "loopback"
        ));
    }

    #[test]
    fn a_port_change_restarts_the_daemon() {
        assert!(listen_settings_require_restart(
            12345, 23000, "loopback", "loopback"
        ));
    }

    #[test]
    fn a_scope_only_change_restarts_the_daemon() {
        assert!(listen_settings_require_restart(
            12345, 12345, "loopback", "lan"
        ));
        assert!(listen_settings_require_restart(
            12345, 12345, "lan", "loopback"
        ));
    }
}
