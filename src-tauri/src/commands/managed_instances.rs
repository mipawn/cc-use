use crate::db::Database;
use crate::models::{ManagedInstance, UpdateManagedInstanceAssignmentInput};
use std::sync::{Arc, Mutex};
use tauri::State;

pub fn managed_instance_list_inner(db: &Database) -> Result<Vec<ManagedInstance>, String> {
    db.managed_instance_list_active().map_err(|e| e.to_string())
}

pub fn managed_instance_get_inner(
    db: &Database,
    id: &str,
) -> Result<Option<ManagedInstance>, String> {
    db.managed_instance_get(id).map_err(|e| e.to_string())
}

pub fn managed_instance_update_assignment_inner(
    db: &Database,
    input: &UpdateManagedInstanceAssignmentInput,
) -> Result<ManagedInstance, String> {
    let instance = db
        .managed_instance_get(&input.id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Managed instance not found".to_string())?;

    let changed = db
        .managed_instance_update_assignment(
            &input.id,
            &input.provider_id,
            &input.api_key_id,
            input.assignment_source.as_deref(),
        )
        .map_err(|e| e.to_string())?;

    if !changed {
        return Err("Managed instance not found".to_string());
    }

    let session_changed = db
        .proxy_session_update_provider_key(
            &instance.session_token,
            &input.provider_id,
            &input.api_key_id,
        )
        .map_err(|e| e.to_string())?;

    if !session_changed {
        return Err("Proxy session not found for managed instance".to_string());
    }

    db.managed_instance_get(&input.id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Managed instance not found".to_string())
}

pub fn managed_instance_cleanup_inner(db: &Database) -> Result<usize, String> {
    db.managed_instance_cleanup_inactive()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn managed_instance_list(
    db: State<'_, Arc<Mutex<Database>>>,
) -> Result<Vec<ManagedInstance>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    managed_instance_list_inner(&db)
}

#[tauri::command]
pub fn managed_instance_get(
    db: State<'_, Arc<Mutex<Database>>>,
    id: String,
) -> Result<Option<ManagedInstance>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    managed_instance_get_inner(&db, &id)
}

#[tauri::command]
pub fn managed_instance_update_assignment(
    db: State<'_, Arc<Mutex<Database>>>,
    input: UpdateManagedInstanceAssignmentInput,
) -> Result<ManagedInstance, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    managed_instance_update_assignment_inner(&db, &input)
}

#[tauri::command]
pub fn managed_instance_cleanup(db: State<'_, Arc<Mutex<Database>>>) -> Result<usize, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    managed_instance_cleanup_inner(&db)
}
