//! User-entered User-Agents saved locally for reuse. No traffic is collected.
use crate::db::Database;
use std::sync::{Arc, Mutex};
use tauri::State;

#[tauri::command]
pub fn user_agent_custom_list(db: State<'_, Arc<Mutex<Database>>>) -> Result<Vec<String>, String> {
    db.lock()
        .map_err(|error| error.to_string())?
        .user_agent_custom_list()
}

#[tauri::command]
pub fn user_agent_custom_save(
    db: State<'_, Arc<Mutex<Database>>>,
    value: String,
) -> Result<Vec<String>, String> {
    db.lock()
        .map_err(|error| error.to_string())?
        .user_agent_custom_save(&value)
}

#[tauri::command]
pub fn user_agent_custom_delete(
    db: State<'_, Arc<Mutex<Database>>>,
    value: String,
) -> Result<Vec<String>, String> {
    db.lock()
        .map_err(|error| error.to_string())?
        .user_agent_custom_delete(&value)
}
