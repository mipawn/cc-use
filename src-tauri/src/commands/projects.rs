use crate::db::Database;
use crate::models::{CreateProjectInput, Project, UpdateProjectInput};
use std::sync::{Arc, Mutex};
use tauri::State;

#[tauri::command]
pub fn project_list(db: State<'_, Arc<Mutex<Database>>>) -> Result<Vec<Project>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.project_list().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn project_get(
    db: State<'_, Arc<Mutex<Database>>>,
    id: String,
) -> Result<Option<Project>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.project_get(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn project_get_by_path(
    db: State<'_, Arc<Mutex<Database>>>,
    path: String,
) -> Result<Option<Project>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.project_get_by_path(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn project_create(
    db: State<'_, Arc<Mutex<Database>>>,
    input: CreateProjectInput,
) -> Result<Project, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.project_create(&input).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn project_update(
    db: State<'_, Arc<Mutex<Database>>>,
    input: UpdateProjectInput,
) -> Result<Project, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.project_update(&input).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn project_delete(db: State<'_, Arc<Mutex<Database>>>, id: String) -> Result<(), String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.project_delete(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn project_open(db: State<'_, Arc<Mutex<Database>>>, id: String) -> Result<(), String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.project_update_last_opened(&id)
        .map_err(|e| e.to_string())
}
