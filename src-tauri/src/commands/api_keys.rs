use crate::db::Database;
use crate::models::{ApiKey, CreateApiKeyInput, UpdateApiKeyInput};
use std::sync::{Arc, Mutex};
use tauri::State;

#[tauri::command]
pub fn api_key_list(
    db: State<'_, Arc<Mutex<Database>>>,
    provider_id: String,
) -> Result<Vec<ApiKey>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.api_key_list(&provider_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn api_key_create(
    db: State<'_, Arc<Mutex<Database>>>,
    input: CreateApiKeyInput,
) -> Result<ApiKey, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.api_key_create(&input).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn api_key_update(
    db: State<'_, Arc<Mutex<Database>>>,
    input: UpdateApiKeyInput,
) -> Result<ApiKey, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    let key = db.api_key_update(&input).map_err(|e| e.to_string())?;
    // The taken-over Desktop profile embeds the catalog's role slots, so a
    // saved key has to keep it in step. Other keys leave the profile alone.
    if let Err(error) = crate::commands::claude_desktop_config::refresh_taken_over_profile(&db) {
        log::warn!("failed to refresh Claude Desktop profile after key save: {error}");
    }
    Ok(key)
}

#[tauri::command]
pub fn api_key_delete(db: State<'_, Arc<Mutex<Database>>>, id: String) -> Result<(), String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.api_key_delete(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn api_key_reorder(
    db: State<'_, Arc<Mutex<Database>>>,
    provider_id: String,
    key_ids: Vec<String>,
) -> Result<Vec<ApiKey>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.api_key_reorder(&provider_id, &key_ids)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn api_key_retired_mapping_report(
    db: State<'_, Arc<Mutex<Database>>>,
) -> Result<Vec<String>, String> {
    let db = db.lock().map_err(|error| error.to_string())?;
    let raw = db
        .settings_get_value("model-mapping-retired-api-key-ids")
        .map_err(|error| error.to_string())?;
    Ok(raw
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default())
}
