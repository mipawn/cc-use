use crate::db::Database;
use crate::models::{ManagedInstance, UpdateManagedInstanceAssignmentInput};
use std::sync::{Arc, Mutex};
use tauri::State;

fn normalize_cli_type(value: &str) -> &str {
    if value == "claude" {
        "claude_code"
    } else {
        value
    }
}

pub fn managed_instance_list_inner(
    db: &Database,
    cli_type: Option<&str>,
) -> Result<Vec<ManagedInstance>, String> {
    match cli_type {
        Some(cli_type) => db
            .managed_instance_list_recent_for_cli_type(cli_type, 100)
            .map_err(|e| e.to_string()),
        None => db.managed_instance_list_active().map_err(|e| e.to_string()),
    }
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
    if !matches!(instance.status.as_str(), "launching" | "running" | "stale") {
        return Err("Managed instance is no longer active".to_string());
    }
    let provider = db
        .provider_get(&input.provider_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Provider not found".to_string())?;
    if !provider.is_active {
        return Err("Provider is disabled".to_string());
    }
    let api_key = db
        .api_key_get(&input.api_key_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "API key not found".to_string())?;
    if api_key.provider_id != input.provider_id {
        return Err("API key does not belong to the selected provider".to_string());
    }
    if !api_key.is_active {
        return Err("API key is disabled".to_string());
    }
    if api_key.is_exhausted {
        return Err("API key is exhausted".to_string());
    }
    let instance_cli_type = normalize_cli_type(&instance.cli_type);
    if !api_key
        .types
        .iter()
        .any(|value| normalize_cli_type(value) == instance_cli_type)
    {
        return Err(format!(
            "API key is not compatible with {} instances",
            instance_cli_type
        ));
    }

    let changed = db
        .managed_instance_update_assignment_and_session(
            &input.id,
            &instance.session_token,
            &input.provider_id,
            &input.api_key_id,
            input.assignment_source.as_deref(),
        )
        .map_err(|e| e.to_string())?;

    if !changed {
        return Err("Managed instance or proxy session is no longer active".to_string());
    }

    db.managed_instance_get(&input.id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Managed instance not found".to_string())
}

pub fn managed_instance_cleanup_inner(db: &Database, cli_type: &str) -> Result<usize, String> {
    db.managed_instance_cleanup_inactive_for_cli_type(cli_type)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn managed_instance_list(
    db: State<'_, Arc<Mutex<Database>>>,
    cli_type: Option<String>,
) -> Result<Vec<ManagedInstance>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    managed_instance_list_inner(&db, cli_type.as_deref())
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
pub fn managed_instance_cleanup(
    db: State<'_, Arc<Mutex<Database>>>,
    cli_type: String,
) -> Result<usize, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    managed_instance_cleanup_inner(&db, &cli_type)
}
