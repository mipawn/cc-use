//! Login-item (auto-launch) and global-shortcut commands.
//!
//! These are platform-integration commands that don't fit naturally in any of
//! the existing domain modules (providers / keys / projects / settings), so
//! they live here next to `system.rs` rather than polluting it.

use crate::auto_launch;
use crate::db::Database;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, Runtime, State, Wry};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// Persisted under the `launchAtLogin` settings key. Reads/writes go through
/// the existing settings table so the toggle survives restarts and shows up
/// alongside every other user-facing preference.
const SETTING_LAUNCH_AT_LOGIN: &str = "launchAtLogin";
/// Persisted under `showWindowShortcut`. Empty string means "no shortcut".
const SETTING_SHOW_SHORTCUT: &str = "showWindowShortcut";

type DbState<'a> = State<'a, Arc<Mutex<Database>>>;

// ---------------------------------------------------------------------------
// Auto-launch
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn auto_launch_is_enabled(db: DbState<'_>) -> Result<bool, String> {
    // Trust the OS as source of truth when available — if the login item got
    // removed out-of-band (user deleted it from System Settings) we want the
    // UI to reflect that immediately rather than reading a stale DB flag.
    match auto_launch::is_enabled() {
        Ok(os_state) => {
            // Keep the DB in sync so other code paths that read the setting see
            // the truth. Best-effort: a write failure shouldn't fail the read.
            if let Ok(db) = db.lock() {
                let _ = db.settings_set_value(
                    SETTING_LAUNCH_AT_LOGIN,
                    if os_state { "true" } else { "false" },
                );
            }
            Ok(os_state)
        }
        // On platforms where detection is unreliable, fall back to the stored flag.
        Err(_) => {
            if let Ok(db) = db.lock() {
                Ok(db
                    .settings_get_value(SETTING_LAUNCH_AT_LOGIN)
                    .ok()
                    .flatten()
                    .map(|v| v == "true")
                    .unwrap_or(false))
            } else {
                Ok(false)
            }
        }
    }
}

#[tauri::command]
pub fn auto_launch_set_enabled(db: DbState<'_>, enabled: bool) -> Result<bool, String> {
    if enabled {
        auto_launch::enable()?;
    } else {
        auto_launch::disable()?;
    }
    if let Ok(db) = db.lock() {
        let _ = db.settings_set_value(
            SETTING_LAUNCH_AT_LOGIN,
            if enabled { "true" } else { "false" },
        );
    }
    Ok(enabled)
}

// ---------------------------------------------------------------------------
// Global shortcut
// ---------------------------------------------------------------------------

/// Toggle the main window visibility from anywhere.
///
/// Kept as a free function so the same handler can be wired up both from the
/// initial `setup` (to restore a previously-persisted shortcut on boot) and
/// from `show_window_set_shortcut` when the user picks a new combo.
pub fn toggle_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(win) = app.get_webview_window("main") {
        if win.is_visible().unwrap_or(false) {
            #[cfg(target_os = "macos")]
            {
                let _ = app.set_dock_visibility(false);
            }
            let _ = win.hide();
        } else {
            #[cfg(target_os = "macos")]
            {
                let _ = app.set_dock_visibility(true);
            }
            let _ = win.show();
            let _ = win.set_focus();
        }
    }
}

fn register_toggle_shortcut(app: &AppHandle<Wry>, combo: &str) -> Result<(), String> {
    // Always clear first so changing combos doesn't leave the old one armed.
    app.global_shortcut()
        .unregister_all()
        .map_err(|e| e.to_string())?;
    if combo.is_empty() {
        return Ok(());
    }
    let shortcut: Shortcut = combo
        .parse()
        .map_err(|e| format!("Invalid shortcut {combo:?}: {e}"))?;
    let app_handle = app.clone();
    app.global_shortcut()
        .on_shortcut(shortcut, move |_app, _shortcut, event| {
            // The plugin fires for both pressed and released; only act on
            // press to avoid double-toggles.
            if event.state() == ShortcutState::Pressed {
                toggle_main_window(&app_handle);
            }
        })
        .map_err(|e| e.to_string())
}

/// Read the persisted shortcut (if any) and arm it. Called once during setup.
pub fn restore_shortcut(app: &AppHandle<Wry>, db: &Database) {
    if let Some(combo) = db
        .settings_get_value(SETTING_SHOW_SHORTCUT)
        .ok()
        .flatten()
        .filter(|s| !s.is_empty())
    {
        if let Err(e) = register_toggle_shortcut(app, &combo) {
            log::warn!("Failed to restore global shortcut {combo:?}: {e}");
        }
    }
}

#[tauri::command]
pub fn show_window_get_shortcut(db: DbState<'_>) -> Result<String, String> {
    if let Ok(db) = db.lock() {
        Ok(db
            .settings_get_value(SETTING_SHOW_SHORTCUT)
            .ok()
            .flatten()
            .unwrap_or_default())
    } else {
        Ok(String::new())
    }
}

#[tauri::command]
pub fn show_window_set_shortcut(
    app: AppHandle<Wry>,
    db: DbState<'_>,
    combo: String,
) -> Result<String, String> {
    register_toggle_shortcut(&app, &combo)?;
    if let Ok(db) = db.lock() {
        let _ = db.settings_set_value(SETTING_SHOW_SHORTCUT, &combo);
    }
    Ok(combo)
}
