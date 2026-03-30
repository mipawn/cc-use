use crate::db::Database;
use std::sync::{Arc, Mutex};
use tauri::State;

#[tauri::command]
pub fn terminal_launch(
    db: State<'_, Arc<Mutex<Database>>>,
    project_id: String,
    options: Option<serde_json::Value>,
) -> Result<(), String> {
    let db = db.lock().map_err(|e| e.to_string())?;

    let override_provider_id = options
        .as_ref()
        .and_then(|o| o.get("providerId"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let override_api_key_id = options
        .as_ref()
        .and_then(|o| o.get("apiKeyId"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    crate::terminal::launch_terminal(
        &db,
        &project_id,
        override_provider_id.as_deref(),
        override_api_key_id.as_deref(),
    )
}

#[tauri::command]
pub fn terminal_launch_with_path(
    db: State<'_, Arc<Mutex<Database>>>,
    path: String,
) -> Result<(), String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    let settings = db.settings_get().map_err(|e| e.to_string())?;
    crate::terminal::launch_terminal_path_only(&settings.default_terminal_type, &path)
}

#[tauri::command]
pub fn terminal_get_launch_preview(
    db: State<'_, Arc<Mutex<Database>>>,
    project_id: Option<String>,
    provider_id: Option<String>,
    api_key_id: Option<String>,
    cli_type: String,
) -> Result<crate::models::TerminalLaunchPreview, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    crate::terminal::get_launch_preview(
        &db,
        project_id.as_deref(),
        provider_id.as_deref(),
        api_key_id.as_deref(),
        &cli_type,
    )
}
