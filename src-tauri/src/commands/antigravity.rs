//! Tauri-facing owner of the Antigravity usage reconciler.
//!
//! `services::antigravity_watcher` intentionally knows nothing about `tauri`
//! (see `backend/architecture.md`). Everything that needs an `AppHandle` — the
//! tray badge, the renderer event, the managed state and the IPC command — lives
//! here.

use crate::db::Database;
use crate::models::AntigravitySyncSummary;
use crate::services::antigravity_watcher::{AntigravitySyncManager, SyncObserver};
use crate::tray;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};

/// Emitted after a pass that changed the index, so open views can reload.
pub const ANTIGRAVITY_UPDATED_EVENT: &str = "usage:antigravityUpdated";

struct TrayAndRendererObserver {
    app: AppHandle,
}

impl SyncObserver for TrayAndRendererObserver {
    fn index_updated(&self, summary: &AntigravitySyncSummary) {
        // The badge and the open views both read the index this pass just wrote.
        tray::refresh_tray_badge(&self.app);
        let _ = self.app.emit(ANTIGRAVITY_UPDATED_EVENT, summary);
    }
}

/// Builds and starts the reconciler, registering it as application state.
/// Returns after the threads are up; the cold-start import runs in the worker.
pub fn start(app: &AppHandle, db: Arc<Mutex<Database>>) -> AntigravitySyncManager {
    let observer: Arc<dyn SyncObserver> = Arc::new(TrayAndRendererObserver { app: app.clone() });
    AntigravitySyncManager::start(db, observer)
}

/// Catch-up reconciliation of the local Antigravity usage indexes. Runs on the
/// managed worker so startup, page-open and manual refresh never overlap and
/// never block the UI thread.
#[tauri::command]
pub async fn antigravity_usage_sync(app: AppHandle) -> Result<AntigravitySyncSummary, String> {
    app.state::<AntigravitySyncManager>()
        .request_full_sync()
        .await
}
