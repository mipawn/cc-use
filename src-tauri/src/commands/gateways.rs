use crate::db::Database;
use crate::models::{
    ApiKey, Gateway, GatewayConnectionConfig, GatewayModelPolicy, Provider, ProxySession,
};
use crate::shared_runtime::gateway_connection;
use crate::shared_runtime::new_session_token;
use std::sync::{Arc, Mutex};
use tauri::State;

/// A gateway outlet binds exactly one provider key. Validate the pair before
/// writing so a stale UI cannot create a permanently failing outlet.
fn validate_binding(
    db: &Database,
    provider_id: &str,
    api_key_id: &str,
) -> Result<(Provider, ApiKey), String> {
    let provider = db
        .provider_get(provider_id)
        .map_err(|e| e.to_string())?
        .ok_or("Provider not found")?;
    let api_key = db
        .api_key_get(api_key_id)
        .map_err(|e| e.to_string())?
        .ok_or("API key not found")?;
    if api_key.provider_id != provider.id {
        return Err("API key does not belong to the selected provider".to_string());
    }
    if !api_key.is_active {
        return Err("API key is disabled".to_string());
    }
    if api_key.is_exhausted {
        return Err("API key is marked exhausted".to_string());
    }
    Ok((provider, api_key))
}

pub fn gateway_list_inner(db: &Database) -> Result<Vec<Gateway>, String> {
    db.gateway_list().map_err(|e| e.to_string())
}

pub fn gateway_create_inner(
    db: &Database,
    name: &str,
    provider_id: &str,
    api_key_id: &str,
    connection_config: Option<&GatewayConnectionConfig>,
) -> Result<Gateway, String> {
    gateway_create_with_policy_inner(db, name, provider_id, api_key_id, connection_config, None)
}

pub fn gateway_create_with_policy_inner(
    db: &Database,
    name: &str,
    provider_id: &str,
    api_key_id: &str,
    connection_config: Option<&GatewayConnectionConfig>,
    model_policy: Option<&GatewayModelPolicy>,
) -> Result<Gateway, String> {
    let model_policy = crate::shared_runtime::gateway_model_policy::normalize(
        model_policy.unwrap_or(&GatewayModelPolicy::All),
    )?;
    let name = name.trim();
    if name.is_empty() {
        return Err("Gateway name is required".to_string());
    }
    validate_binding(db, provider_id, api_key_id)?;
    // Omitted means the creation default: Bearer, provider address, no UA.
    let connection_config = gateway_connection::normalize_config(connection_config)?;

    let now = chrono::Utc::now().to_rfc3339();
    let session = ProxySession {
        session_token: new_session_token(),
        provider_id: provider_id.to_string(),
        api_key_id: api_key_id.to_string(),
        project_id: None,
        created_at: now.clone(),
        session_kind: "gateway".to_string(),
        last_seen_at: now,
        expires_at: None,
        revoked_at: None,
        revoked_reason: None,
        cli_type: None,
        display_name: Some(name.to_string()),
        is_active: true,
        connection_config: Some(connection_config),
        model_policy: Some(model_policy),
    };
    db.proxy_session_create(&session)
        .map_err(|e| e.to_string())?;
    db.gateway_get(&session.session_token)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Failed to read the created gateway".to_string())
}

/// Update one outlet. `None` for a field keeps its stored value; a supplied
/// `connection_config` replaces the whole stored override object.
pub fn gateway_update_inner(
    db: &Database,
    session_token: &str,
    name: Option<&str>,
    provider_id: Option<&str>,
    api_key_id: Option<&str>,
    is_active: Option<bool>,
    connection_config: Option<&GatewayConnectionConfig>,
) -> Result<Gateway, String> {
    gateway_update_with_policy_inner(
        db,
        session_token,
        name,
        provider_id,
        api_key_id,
        is_active,
        connection_config,
        None,
    )
}

// Preserve the established flat optional-update contract across IPC and helpers.
#[allow(clippy::too_many_arguments)]
pub fn gateway_update_with_policy_inner(
    db: &Database,
    session_token: &str,
    name: Option<&str>,
    provider_id: Option<&str>,
    api_key_id: Option<&str>,
    is_active: Option<bool>,
    connection_config: Option<&GatewayConnectionConfig>,
    model_policy: Option<&GatewayModelPolicy>,
) -> Result<Gateway, String> {
    let next_policy_json = model_policy
        .map(crate::shared_runtime::gateway_model_policy::to_json)
        .transpose()?;
    let current = db
        .gateway_get(session_token)
        .map_err(|e| e.to_string())?
        .ok_or("Gateway not found")?;

    let next_provider = provider_id.unwrap_or(&current.provider_id);
    let next_key = api_key_id.unwrap_or(&current.api_key_id);
    validate_binding(db, next_provider, next_key)?;

    let next_name = match name {
        Some(name) => {
            let trimmed = name.trim();
            if trimmed.is_empty() {
                return Err("Gateway name is required".to_string());
            }
            Some(trimmed)
        }
        None => None,
    };

    let next_connection_json = match connection_config {
        Some(config) => {
            let normalized = gateway_connection::normalize_config(Some(config))?;
            Some(gateway_connection::config_to_json(&normalized)?)
        }
        None => None,
    };

    db.gateway_update_with_policy(
        session_token,
        next_name,
        provider_id,
        api_key_id,
        is_active,
        next_connection_json.as_deref(),
        next_policy_json.as_deref(),
    )
    .map_err(|e| e.to_string())?;

    db.gateway_get(session_token)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Gateway not found after update".to_string())
}

pub fn gateway_delete_inner(db: &Database, session_token: &str) -> Result<bool, String> {
    db.gateway_delete(session_token).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn gateway_list(db: State<'_, Arc<Mutex<Database>>>) -> Result<Vec<Gateway>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    gateway_list_inner(&db)
}

#[tauri::command]
pub fn gateway_create(
    db: State<'_, Arc<Mutex<Database>>>,
    name: String,
    provider_id: String,
    api_key_id: String,
    connection_config: Option<GatewayConnectionConfig>,
    model_policy: Option<GatewayModelPolicy>,
) -> Result<Gateway, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    gateway_create_with_policy_inner(
        &db,
        &name,
        &provider_id,
        &api_key_id,
        connection_config.as_ref(),
        model_policy.as_ref(),
    )
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn gateway_update(
    db: State<'_, Arc<Mutex<Database>>>,
    session_token: String,
    name: Option<String>,
    provider_id: Option<String>,
    api_key_id: Option<String>,
    is_active: Option<bool>,
    connection_config: Option<GatewayConnectionConfig>,
    model_policy: Option<GatewayModelPolicy>,
) -> Result<Gateway, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    gateway_update_with_policy_inner(
        &db,
        &session_token,
        name.as_deref(),
        provider_id.as_deref(),
        api_key_id.as_deref(),
        is_active,
        connection_config.as_ref(),
        model_policy.as_ref(),
    )
}

#[tauri::command]
pub fn gateway_delete(
    db: State<'_, Arc<Mutex<Database>>>,
    session_token: String,
) -> Result<bool, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    gateway_delete_inner(&db, &session_token)
}
