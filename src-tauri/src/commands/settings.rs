use crate::db::Database;
use crate::models::GlobalSettings;
use std::sync::Mutex;
use tauri::State;

#[tauri::command]
pub fn settings_get(db: State<'_, Mutex<Database>>) -> Result<GlobalSettings, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.settings_get().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn settings_update(
    db: State<'_, Mutex<Database>>,
    updates: serde_json::Value,
) -> Result<GlobalSettings, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.settings_update(&updates).map_err(|e| e.to_string())
}
