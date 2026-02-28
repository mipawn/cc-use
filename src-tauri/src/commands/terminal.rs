use crate::db::Database;
use std::sync::Mutex;
use tauri::State;

#[tauri::command]
pub fn terminal_launch(
    db: State<'_, Mutex<Database>>,
    project_id: String,
    options: Option<serde_json::Value>,
) -> Result<(), String> {
    let db = db.lock().map_err(|e| e.to_string())?;

    let override_provider_id = options.as_ref()
        .and_then(|o| o.get("providerId"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let override_api_key_id = options.as_ref()
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
    db: State<'_, Mutex<Database>>,
    path: String,
) -> Result<(), String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    let settings = db.settings_get().map_err(|e| e.to_string())?;

    let strategy = crate::terminal::get_strategy(&settings.default_terminal_type)
        .or_else(|| crate::terminal::get_first_available())
        .ok_or("No terminal available")?;

    strategy.launch(&path, &crate::terminal::EnvObject::new(), "claude")
}
