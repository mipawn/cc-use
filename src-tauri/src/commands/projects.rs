use crate::db::Database;
use crate::models::{Project, CreateProjectInput, UpdateProjectInput};
use std::sync::Mutex;
use tauri::State;

#[tauri::command]
pub fn project_list(db: State<'_, Mutex<Database>>) -> Result<Vec<Project>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.project_list().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn project_get(db: State<'_, Mutex<Database>>, id: String) -> Result<Option<Project>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.project_get(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn project_get_by_path(db: State<'_, Mutex<Database>>, path: String) -> Result<Option<Project>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.project_get_by_path(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn project_create(db: State<'_, Mutex<Database>>, input: CreateProjectInput) -> Result<Project, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.project_create(&input).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn project_update(db: State<'_, Mutex<Database>>, input: UpdateProjectInput) -> Result<Project, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    let updated = db.project_update(&input).map_err(|e| e.to_string())?;

    // Keep existing sessions hot-switched when project binding changes.
    if (input.provider_id.is_some() || input.api_key_id.is_some())
        && updated.provider_id.is_some()
        && updated.api_key_id.is_some()
    {
        let _ = db.proxy_session_update_by_project(
            &updated.id,
            updated.provider_id.as_deref().unwrap_or_default(),
            updated.api_key_id.as_deref().unwrap_or_default(),
        );
    }

    Ok(updated)
}

#[tauri::command]
pub fn project_delete(db: State<'_, Mutex<Database>>, id: String) -> Result<(), String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.project_delete(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn project_open(db: State<'_, Mutex<Database>>, id: String) -> Result<(), String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.project_update_last_opened(&id).map_err(|e| e.to_string())
}
