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

fn preference_key(provider_id: &str, client_kind: &str) -> Result<String, String> {
    if !matches!(
        client_kind,
        "claude_code" | "claude_desktop" | "codex" | "grok"
    ) {
        return Err("Unsupported launchpad".into());
    }
    if provider_id.is_empty() || provider_id.len() > 256 {
        return Err("Invalid provider ID".into());
    }
    Ok(format!(
        "model-catalog-user-agent.{provider_id}.{client_kind}"
    ))
}

/// Query preferences are separate from the key's forwarding configuration.
#[tauri::command]
pub fn user_agent_query_preference_get(
    db: State<'_, Arc<Mutex<Database>>>,
    provider_id: String,
    client_kind: String,
) -> Result<Option<String>, String> {
    let key = preference_key(&provider_id, &client_kind)?;
    db.lock()
        .map_err(|error| error.to_string())?
        .settings_get_value(&key)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn user_agent_query_preference_save(
    db: State<'_, Arc<Mutex<Database>>>,
    provider_id: String,
    client_kind: String,
    value: String,
) -> Result<(), String> {
    let key = preference_key(&provider_id, &client_kind)?;
    let value = crate::shared_runtime::user_agent::validate(Some(&value))?.unwrap_or_default();
    db.lock()
        .map_err(|error| error.to_string())?
        .settings_set_value(&key, &value)
        .map_err(|error| error.to_string())
}
