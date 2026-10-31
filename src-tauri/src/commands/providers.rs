use crate::db::Database;
use crate::models::{ApiKey, CreateProviderInput, Provider, UpdateProviderInput};
use std::sync::{Arc, Mutex};
use tauri::State;

/// The catalogue IPC shape lives with the service that produces it so the
/// gateway preview command can return the same object without depending on
/// this module.
pub use crate::services::model_catalog::ModelCatalogResult;

#[tauri::command]
pub fn provider_list(db: State<'_, Arc<Mutex<Database>>>) -> Result<Vec<Provider>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.provider_list().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn provider_get(
    db: State<'_, Arc<Mutex<Database>>>,
    id: String,
) -> Result<Option<Provider>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.provider_get(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn provider_create(
    db: State<'_, Arc<Mutex<Database>>>,
    input: CreateProviderInput,
) -> Result<Provider, String> {
    if let Some(adapter) = input.request_adapter.as_deref() {
        if !crate::shared_runtime::is_supported_request_adapter(adapter) {
            return Err(format!("Unsupported request adapter: {}", adapter));
        }
    }
    let db = db.lock().map_err(|e| e.to_string())?;
    // Merge the preset template with whatever the caller supplied, so a create
    // that skipped the advanced sections still stores a complete configuration.
    let input = crate::shared_runtime::apply_preset_defaults(input);
    db.provider_create(&input).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn provider_update(
    db: State<'_, Arc<Mutex<Database>>>,
    input: UpdateProviderInput,
) -> Result<Provider, String> {
    if let Some(adapter) = input.request_adapter.as_deref() {
        if !crate::shared_runtime::is_supported_request_adapter(adapter) {
            return Err(format!("Unsupported request adapter: {}", adapter));
        }
    }
    let db = db.lock().map_err(|e| e.to_string())?;
    db.provider_update(&input).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn provider_delete(db: State<'_, Arc<Mutex<Database>>>, id: String) -> Result<(), String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.provider_delete(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn provider_reorder(
    db: State<'_, Arc<Mutex<Database>>>,
    provider_ids: Vec<String>,
) -> Result<Vec<Provider>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.provider_reorder(&provider_ids)
        .map_err(|e| e.to_string())
}

/// The preset catalogue the "add provider" flow fills from. Read-only: presets
/// are code, not user data, and are never mutated by the UI.
#[tauri::command]
pub fn provider_preset_list() -> Vec<crate::shared_runtime::ProviderPreset> {
    crate::shared_runtime::provider_presets()
}

#[tauri::command]
pub async fn provider_model_list(
    db: State<'_, Arc<Mutex<Database>>>,
    provider_id: String,
    api_key_id: String,
    user_agent: Option<String>,
    client_kind: Option<String>,
) -> Result<Vec<String>, String> {
    let (provider, api_key) = {
        let db = db.lock().map_err(|e| e.to_string())?;
        let provider = db
            .provider_get(&provider_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Provider not found".to_string())?;
        let api_key = db
            .api_key_list(&provider_id)
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|key| key.id == api_key_id)
            .ok_or_else(|| "API key does not belong to this provider".to_string())?;
        (provider, api_key)
    };

    // Refused here, where the dialog can show it, rather than turning into a
    // request that fails later for a reason that names something else.
    let user_agent = crate::shared_runtime::user_agent::validate(user_agent.as_deref())?;

    let client_kind = client_kind
        .as_deref()
        .or_else(|| preferred_model_list_client_kind(&api_key));
    crate::services::model_catalog::fetch_provider_model_ids(
        &provider,
        &api_key,
        client_kind,
        user_agent.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn provider_model_catalog(
    db: State<'_, Arc<Mutex<Database>>>,
    provider_id: String,
    api_key_id: String,
    client_kind: String,
) -> Result<ModelCatalogResult, String> {
    if !matches!(
        client_kind.as_str(),
        "claude_code" | "claude_desktop" | "codex" | "grok"
    ) {
        return Err("不支持的启动台".into());
    }
    let (provider, key) = {
        let db = db.lock().map_err(|error| error.to_string())?;
        let provider = db
            .provider_get(&provider_id)
            .map_err(|error| error.to_string())?
            .ok_or("供应商不存在")?;
        let key = db
            .api_key_get(&api_key_id)
            .map_err(|error| error.to_string())?
            .ok_or("密钥不存在")?;
        if key.provider_id != provider_id
            || !key.types.iter().any(|kind| {
                kind == &client_kind || kind == "claude" && client_kind == "claude_code"
            })
        {
            return Err("密钥不支持所选启动台".into());
        }
        (provider, key)
    };
    let snapshot = crate::services::model_catalog::provider_catalog(
        db.inner(),
        &provider,
        &key,
        &client_kind,
        false,
        None,
    )
    .await?;
    Ok(ModelCatalogResult::from_snapshot(snapshot))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalogPreviewInput {
    provider_id: String,
    api_key_id: Option<String>,
    key_value: String,
    client_kind: String,
    client_configs: Option<serde_json::Value>,
    user_agent: Option<String>,
}

#[tauri::command]
pub async fn provider_model_catalog_preview(
    db: State<'_, Arc<Mutex<Database>>>,
    input: ModelCatalogPreviewInput,
) -> Result<ModelCatalogResult, String> {
    if !matches!(
        input.client_kind.as_str(),
        "claude_code" | "claude_desktop" | "codex" | "grok"
    ) {
        return Err("Unsupported launchpad".into());
    }
    if input.key_value.trim().is_empty() {
        return Err("Enter an API key before querying models".into());
    }
    let provider = {
        let db = db.lock().map_err(|error| error.to_string())?;
        let provider = db
            .provider_get(&input.provider_id)
            .map_err(|error| error.to_string())?
            .ok_or("Provider not found")?;
        if let Some(id) = input.api_key_id.as_deref() {
            let key = db
                .api_key_get(id)
                .map_err(|error| error.to_string())?
                .ok_or("API key not found")?;
            if key.provider_id != input.provider_id {
                return Err("API key does not belong to this provider".into());
            }
        }
        provider
    };
    let mut client_configs = input.client_configs;
    if let Some(raw) = input.user_agent.as_deref() {
        let ua = crate::shared_runtime::user_agent::validate(Some(raw))?;
        let configs = client_configs.get_or_insert_with(|| serde_json::json!({}));
        let configs = configs
            .as_object_mut()
            .ok_or("Invalid client connections")?;
        let config = configs
            .entry(input.client_kind.clone())
            .or_insert_with(|| serde_json::json!({}));
        let config = config.as_object_mut().ok_or("Invalid client connection")?;
        if let Some(ua) = ua {
            config.insert("proxyUserAgent".into(), serde_json::json!(ua));
        } else {
            config.remove("proxyUserAgent");
        }
    }
    let key = ApiKey {
        id: input.api_key_id.unwrap_or_else(|| "__preview__".into()),
        provider_id: input.provider_id,
        alias: None,
        value: input.key_value,
        types: vec![input.client_kind.clone()],
        priority: 0,
        is_exhausted: false,
        is_active: true,
        config: None,
        usage_type: "none".into(),
        usage_url: None,
        usage_path: None,
        usage_headers: None,
        cached_usage: None,
        last_usage_checked_at: None,
        model_mapping: None,
        client_configs,
        usage_script: None,
    };
    let snapshot = crate::services::model_catalog::preview_catalog(
        db.inner(),
        &provider,
        &key,
        &input.client_kind,
    )
    .await?;
    Ok(ModelCatalogResult::from_snapshot(snapshot))
}

/// The shared model-list dialog has no client selector. For a multi-client key,
/// prefer an OpenAI-compatible route because Anthropic-compatible base URLs do
/// not generally expose `GET /models`.
fn preferred_model_list_client_kind(api_key: &ApiKey) -> Option<&str> {
    ["codex", "grok"]
        .into_iter()
        .find(|kind| api_key.types.iter().any(|value| value == kind))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_key(client_kind: &str) -> ApiKey {
        ApiKey {
            usage_script: None,
            id: "key-1".to_string(),
            provider_id: "provider-1".to_string(),
            alias: None,
            value: "sk-test".to_string(),
            types: vec![client_kind.to_string()],
            priority: 0,
            is_exhausted: false,
            is_active: true,
            config: None,
            usage_type: "none".to_string(),
            usage_url: None,
            usage_path: None,
            usage_headers: None,
            cached_usage: None,
            last_usage_checked_at: None,
            model_mapping: None,
            client_configs: None,
        }
    }

    #[test]
    fn shared_model_list_prefers_codex_for_multi_client_keys() {
        let mut key = test_key("claude_code");
        key.types.push("codex".to_string());

        assert_eq!(preferred_model_list_client_kind(&key), Some("codex"));
    }

    #[test]
    fn shared_model_list_keeps_claude_only_keys_on_their_default_route() {
        let key = test_key("claude_code");

        assert_eq!(preferred_model_list_client_kind(&key), None);
    }
}

#[tauri::command]
pub fn provider_model_catalog_get(
    db: State<'_, Arc<Mutex<Database>>>,
    provider_id: String,
) -> Result<crate::models::ProviderModelCatalog, String> {
    db.lock()
        .map_err(|_| "Database lock failed")?
        .provider_model_catalog_get(&provider_id)
}

#[tauri::command]
pub fn provider_model_catalog_save(
    db: State<'_, Arc<Mutex<Database>>>,
    provider_id: String,
    models: Vec<crate::shared_runtime::model_mapping::ClientModel>,
    revision: i64,
) -> Result<crate::models::ProviderModelCatalog, String> {
    db.lock()
        .map_err(|_| "Database lock failed")?
        .provider_model_catalog_save(&provider_id, &models, revision)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelCatalogQueryInput {
    pub provider_id: String,
    pub api_key_id: String,
    pub connection_config: crate::models::GatewayConnectionConfig,
}

pub async fn provider_model_catalog_query_inner(
    db: &Arc<Mutex<Database>>,
    input: ProviderModelCatalogQueryInput,
) -> Result<ModelCatalogResult, String> {
    let (provider, key) = {
        let db = db.lock().map_err(|_| "Database lock failed")?;
        let provider = db
            .provider_get(&input.provider_id)
            .map_err(|_| "Cannot read provider")?
            .ok_or("Provider not found")?;
        let key = db
            .api_key_get(&input.api_key_id)
            .map_err(|_| "Cannot read API key")?
            .ok_or("API key not found")?;
        if key.provider_id != provider.id {
            return Err("API key does not belong to this provider".into());
        }
        if !provider.is_active {
            return Err("Provider is disabled".into());
        }
        if !key.is_active {
            return Err("API key is disabled".into());
        }
        if key.is_exhausted {
            return Err("API key is exhausted".into());
        }
        (provider, key)
    };
    let connection = crate::shared_runtime::gateway_connection::resolve(
        &provider,
        &key,
        Some(&input.connection_config),
    )?;
    let snapshot =
        crate::services::model_catalog::gateway_catalog(&provider, &connection, None).await?;
    Ok(ModelCatalogResult::from_snapshot(snapshot))
}

#[tauri::command]
pub async fn provider_model_catalog_query(
    db: State<'_, Arc<Mutex<Database>>>,
    input: ProviderModelCatalogQueryInput,
) -> Result<ModelCatalogResult, String> {
    provider_model_catalog_query_inner(db.inner(), input).await
}
