use crate::db::Database;
use crate::models::{Provider, CreateProviderInput, UpdateProviderInput};
use std::sync::{Arc, Mutex};
use tauri::State;

#[tauri::command]
pub fn provider_list(db: State<'_, Arc<Mutex<Database>>>) -> Result<Vec<Provider>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.provider_list().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn provider_get(db: State<'_, Arc<Mutex<Database>>>, id: String) -> Result<Option<Provider>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.provider_get(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn provider_create(db: State<'_, Arc<Mutex<Database>>>, input: CreateProviderInput) -> Result<Provider, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.provider_create(&input).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn provider_update(db: State<'_, Arc<Mutex<Database>>>, input: UpdateProviderInput) -> Result<Provider, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.provider_update(&input).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn provider_delete(db: State<'_, Arc<Mutex<Database>>>, id: String) -> Result<(), String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.provider_delete(&id).map_err(|e| e.to_string())
}
