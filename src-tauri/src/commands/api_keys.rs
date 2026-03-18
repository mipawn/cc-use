use crate::db::Database;
use crate::models::{ApiKey, CreateApiKeyInput, UpdateApiKeyInput};
use std::sync::{Arc, Mutex};
use tauri::State;

#[tauri::command]
pub fn api_key_list(db: State<'_, Arc<Mutex<Database>>>, provider_id: String) -> Result<Vec<ApiKey>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.api_key_list(&provider_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn api_key_create(db: State<'_, Arc<Mutex<Database>>>, input: CreateApiKeyInput) -> Result<ApiKey, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.api_key_create(&input).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn api_key_update(db: State<'_, Arc<Mutex<Database>>>, input: UpdateApiKeyInput) -> Result<ApiKey, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.api_key_update(&input).map_err(|e| e.to_string())
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
    db.api_key_reorder(&provider_id, &key_ids).map_err(|e| e.to_string())
}
