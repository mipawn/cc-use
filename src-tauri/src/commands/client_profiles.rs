use crate::db::client_profiles::normalize_profile_client_kind;
use crate::db::Database;
use crate::models::{
    ClientProfile, ClientProfileConnectionConfig, CreateClientProfileInput,
    UpdateClientProfileInput,
};
use std::sync::{Arc, Mutex};
use tauri::State;

fn validate_connection_config(
    config: Option<&ClientProfileConnectionConfig>,
) -> Result<(), String> {
    let Some(cfg) = config else {
        return Ok(());
    };
    if let Some(url_raw) = cfg
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let parsed = url::Url::parse(url_raw).map_err(|_| {
            "Base URL must be a valid http(s) URL without credentials, query, or fragment."
                .to_string()
        })?;
        if !matches!(parsed.scheme(), "http" | "https")
            || parsed.host_str().is_none()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
        {
            return Err(
                "Base URL must be a valid http(s) URL without credentials, query, or fragment."
                    .to_string(),
            );
        }
    }
    if let Some(scheme) = cfg
        .auth_scheme
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if !matches!(scheme, "bearer" | "x-api-key" | "none" | "default") {
            return Err(format!("Unsupported auth scheme: {}", scheme));
        }
    }
    if let Some(ua) = cfg.user_agent.as_deref() {
        if ua.contains('\r') || ua.contains('\n') {
            return Err("User-Agent cannot contain line breaks.".to_string());
        }
    }
    Ok(())
}

fn validate_binding(db: &Database, provider_id: &str, api_key_id: &str) -> Result<(), String> {
    let provider = db
        .provider_get(provider_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Provider not found".to_string())?;
    let key = db
        .api_key_get(api_key_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "API key not found".to_string())?;
    if key.provider_id != provider.id {
        return Err("API key does not belong to the selected provider".to_string());
    }
    Ok(())
}

pub fn client_profile_list_inner(
    db: &Database,
    client_kind: Option<&str>,
) -> Result<Vec<ClientProfile>, String> {
    db.client_profile_list(client_kind)
        .map_err(|e| e.to_string())
}

pub fn client_profile_get_inner(db: &Database, id: &str) -> Result<Option<ClientProfile>, String> {
    db.client_profile_get(id).map_err(|e| e.to_string())
}

pub fn client_profile_create_inner(
    db: &Database,
    input: &CreateClientProfileInput,
) -> Result<ClientProfile, String> {
    if input.name.trim().is_empty() {
        return Err("Profile name is required".to_string());
    }
    if normalize_profile_client_kind(&input.client_kind).is_none() {
        return Err(format!("Unsupported client kind: {}", input.client_kind));
    }
    validate_binding(db, &input.provider_id, &input.api_key_id)?;
    validate_connection_config(input.connection_config.as_ref())?;
    db.client_profile_create(input).map_err(|e| e.to_string())
}

pub fn client_profile_update_inner(
    db: &Database,
    input: &UpdateClientProfileInput,
) -> Result<ClientProfile, String> {
    let existing = db
        .client_profile_get(&input.id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Client profile not found".to_string())?;
    if let Some(name) = input.name.as_deref() {
        if name.trim().is_empty() {
            return Err("Profile name cannot be empty".to_string());
        }
    }
    let next_provider = input
        .provider_id
        .as_deref()
        .unwrap_or(&existing.provider_id);
    let next_key = input.api_key_id.as_deref().unwrap_or(&existing.api_key_id);
    validate_binding(db, next_provider, next_key)?;
    validate_connection_config(input.connection_config.as_ref())?;

    let updated = db.client_profile_update(input).map_err(|e| e.to_string())?;

    // Sync taken-over Claude Desktop profile if this profile was edited;
    // sync failure is tracked independently and never fails the save.
    if updated.client_kind == "claude_desktop" {
        let _ =
            crate::commands::claude_desktop_config::refresh_taken_over_profile_after_key_edit(db);
    }

    Ok(updated)
}

pub fn client_profile_delete_inner(db: &Database, id: &str) -> Result<bool, String> {
    db.client_profile_delete(id).map_err(|e| e.to_string())
}

pub fn client_profile_reorder_inner(
    db: &Database,
    client_kind: &str,
    ids: &[String],
) -> Result<(), String> {
    if normalize_profile_client_kind(client_kind).is_none() {
        return Err(format!("Unsupported client kind: {}", client_kind));
    }
    db.client_profile_reorder(client_kind, ids)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn client_profile_list(
    db: State<'_, Arc<Mutex<Database>>>,
    client_kind: Option<String>,
) -> Result<Vec<ClientProfile>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    client_profile_list_inner(&db, client_kind.as_deref())
}

#[tauri::command]
pub fn client_profile_get(
    db: State<'_, Arc<Mutex<Database>>>,
    id: String,
) -> Result<Option<ClientProfile>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    client_profile_get_inner(&db, &id)
}

#[tauri::command]
pub fn client_profile_create(
    db: State<'_, Arc<Mutex<Database>>>,
    input: CreateClientProfileInput,
) -> Result<ClientProfile, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    client_profile_create_inner(&db, &input)
}

#[tauri::command]
pub fn client_profile_update(
    db: State<'_, Arc<Mutex<Database>>>,
    input: UpdateClientProfileInput,
) -> Result<ClientProfile, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    client_profile_update_inner(&db, &input)
}

#[tauri::command]
pub fn client_profile_delete(
    db: State<'_, Arc<Mutex<Database>>>,
    id: String,
) -> Result<bool, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    client_profile_delete_inner(&db, &id)
}

#[tauri::command]
pub fn client_profile_reorder(
    db: State<'_, Arc<Mutex<Database>>>,
    client_kind: String,
    ids: Vec<String>,
) -> Result<(), String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    client_profile_reorder_inner(&db, &client_kind, &ids)
}
