//! Codex App 相关命令

use crate::db::Database;
use crate::terminal::codex_app;
use std::sync::{Arc, Mutex};
use tauri::State;

#[tauri::command]
pub fn codex_app_launch(
    db: State<'_, Arc<Mutex<Database>>>,
    settings: State<'_, Arc<Mutex<crate::models::GlobalSettings>>>,
    project_id: String,
) -> Result<String, String> {
    let proxy_port = {
        let settings = settings.lock().map_err(|e| e.to_string())?;
        settings.proxy_port
    };

    codex_app::launch_codex_app(db.inner().clone(), &project_id, proxy_port)
}

#[tauri::command]
pub fn codex_app_stop(db: State<'_, Arc<Mutex<Database>>>) -> Result<(), String> {
    codex_app::stop_codex_app(db.inner().clone())
}

#[tauri::command]
pub fn codex_app_get_active_project(
    db: State<'_, Arc<Mutex<Database>>>,
) -> Result<Option<String>, String> {
    codex_app::get_active_project(db.inner().clone())
}
