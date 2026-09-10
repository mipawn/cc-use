//! Console history commands.
//!
//! The renderer keeps a small live buffer; these read the bounded on-disk
//! history back after a reload or restart. Reading is cheap and never touches
//! the network or the daemon's proxy path.

use crate::db::Database;
use crate::services::console_log_store::{
    read_recent, ConsoleLogHandle, ConsoleLogPage, ConsoleLogSource, SOURCES,
};
use std::sync::{Arc, Mutex};
use tauri::State;

/// Sources to include. Unknown names are rejected rather than silently ignored,
/// so a typo cannot quietly hide half the history.
fn resolve_sources(sources: &[String]) -> Result<Vec<ConsoleLogSource>, String> {
    if sources.is_empty() {
        return Ok(SOURCES.to_vec());
    }
    sources
        .iter()
        .map(|name| {
            ConsoleLogSource::parse(name)
                .ok_or_else(|| format!("Unknown console log source: {}", name))
        })
        .collect()
}

/// Most recent records, oldest first. `truncated` says older history was
/// already evicted by the size budget, so the caller does not claim it is
/// showing everything.
#[tauri::command]
pub fn console_log_read_recent(
    sources: Vec<String>,
    limit: Option<usize>,
) -> Result<ConsoleLogPage, String> {
    let dir = crate::services::console_log_store::console_log_dir()
        .ok_or_else(|| "Cannot locate the console log directory".to_string())?;
    let sources = resolve_sources(&sources)?;
    // Reading is a plain directory scan; nothing else is running here, so a
    // short lock is enough to see a consistent file listing.
    let _guard = READ_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    Ok(read_recent(
        &dir,
        &sources,
        limit.unwrap_or(500).clamp(1, 5_000),
    ))
}

/// Records this process could not persist (queue overflow or a write failure).
/// Surfaced so a full disk is visible instead of silently losing history.
#[tauri::command]
pub fn console_log_status(state: State<'_, Arc<ConsoleLogHandle>>) -> serde_json::Value {
    serde_json::json!({ "dropped": state.dropped() })
}

/// Drop the console history of both processes and wait until it is gone.
///
/// The app owns its files; the daemon owns its own, so it is asked over the
/// management API rather than having its files deleted from under it. Statistics
/// and Auto mode audit rows live in the database and are untouched.
#[tauri::command]
pub async fn console_log_clear(
    db: State<'_, Arc<Mutex<Database>>>,
    state: State<'_, Arc<ConsoleLogHandle>>,
) -> Result<(), String> {
    let app_cleared = state.clear_and_wait(std::time::Duration::from_secs(5));
    let daemon_cleared = request_daemon_clear(&db).await;
    if app_cleared || daemon_cleared {
        Ok(())
    } else {
        Err("Console history could not be cleared".to_string())
    }
}

/// Serialises reads against a concurrent clear so a read never returns a mix of
/// pre-clear and post-clear files.
static READ_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Ask the daemon to drop its own files. It owns them; deleting a file another
/// process is still appending to would corrupt its writer.
async fn request_daemon_clear(db: &State<'_, Arc<Mutex<Database>>>) -> bool {
    let target = {
        let Ok(db) = db.lock() else { return false };
        let Ok(settings) = db.settings_get() else {
            return false;
        };
        let Ok(Some(token)) = crate::shared_runtime::read_management_token(
            &crate::shared_runtime::ManagementTokenPaths::from_home(&match dirs::home_dir() {
                Some(home) => home,
                None => return false,
            }),
        ) else {
            return false;
        };
        (settings.proxy_port, token)
    };

    reqwest::Client::new()
        .post(format!(
            "http://127.0.0.1:{}/_management/console/clear",
            target.0
        ))
        .header("x-cc-use-management-token", &target.1)
        .send()
        .await
        .map(|response| response.status().is_success())
        .unwrap_or(false)
}
