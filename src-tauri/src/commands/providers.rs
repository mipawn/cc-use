use crate::db::Database;
use crate::models::{ApiKey, CreateProviderInput, Provider, UpdateProviderInput};
use std::sync::{Arc, Mutex};
use tauri::State;

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
    fetch_provider_model_ids(&provider, &api_key, client_kind, user_agent.as_deref()).await
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalogResult {
    models: Vec<crate::shared_runtime::model_mapping::ClientModel>,
    from_cache: bool,
    fetched_at: String,
    error: Option<String>,
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
    Ok(catalog_result(snapshot))
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
    Ok(catalog_result(snapshot))
}

fn catalog_result(snapshot: crate::services::model_catalog::CatalogSnapshot) -> ModelCatalogResult {
    let models = snapshot.catalog["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let id = entry["id"].as_str()?.to_string();
            let display_name = entry["display_name"].as_str().unwrap_or(&id).to_string();
            Some(crate::shared_runtime::model_mapping::ClientModel {
                id,
                display_name,
                supports1m: entry["supports1m"].as_bool().unwrap_or(false),
            })
        })
        .collect();
    ModelCatalogResult {
        models,
        from_cache: snapshot.from_cache,
        fetched_at: snapshot.fetched_at,
        error: snapshot.error,
    }
}

/// The shared model-list dialog has no client selector. For a multi-client key,
/// prefer an OpenAI-compatible route because Anthropic-compatible base URLs do
/// not generally expose `GET /models`.
fn preferred_model_list_client_kind(api_key: &ApiKey) -> Option<&str> {
    ["codex", "grok"]
        .into_iter()
        .find(|kind| api_key.types.iter().any(|value| value == kind))
}

/// What this app calls itself when no User-Agent was chosen.
const DEFAULT_MODEL_LIST_USER_AGENT: &str = "cc-use/3.x";

/// Fetch the real model ids exposed by a provider. Passing a client kind makes
/// sure multi-client keys use that client's base URL and auth settings instead
/// of whichever type happens to be first in the stored array.
///
/// `user_agent` arrives already validated; it replaces the default rather than
/// joining it, because a gateway that answers only known clients is matching
/// the whole value.
pub(crate) async fn fetch_provider_model_catalog(
    provider: &Provider,
    api_key: &ApiKey,
    client_kind: Option<&str>,
    user_agent: Option<&str>,
    request_headers: Option<&std::collections::BTreeMap<String, String>>,
) -> Result<serde_json::Value, String> {
    let (base_url, auth_scheme) = model_list_upstream_settings(provider, api_key, client_kind);
    let endpoint = build_model_list_endpoint(&base_url)?;

    let client = crate::services::http_client::outbound_client_builder_for_proxy(
        provider.http_proxy.as_deref(),
    )?
    .timeout(std::time::Duration::from_secs(15))
    .build()
    .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let mut entries = Vec::new();
    let mut cursor: Option<String> = None;
    let mut cursors = std::collections::HashSet::new();
    for _ in 0..10 {
        let mut request = client.get(&endpoint).query(&[("limit", "1000")]).header(
            "User-Agent",
            user_agent.unwrap_or(DEFAULT_MODEL_LIST_USER_AGENT),
        );
        if let Some(cursor) = &cursor {
            request = request.query(&[("after_id", cursor)]);
        }
        let mut extra_headers = request_headers.cloned().unwrap_or_default();
        for (name, value) in
            crate::shared_runtime::request_headers::parse(provider.request_headers.as_deref())
        {
            if !matches!(
                name.to_ascii_lowercase().as_str(),
                "authorization" | "x-api-key" | "user-agent" | "host" | "content-length"
            ) {
                extra_headers
                    .entry(name.to_ascii_lowercase())
                    .or_insert_with(|| {
                        crate::shared_runtime::request_headers::resolve(&value, &base_url)
                    });
            }
        }
        let kind = client_kind.or_else(|| api_key.types.first().map(String::as_str));
        if matches!(kind, Some("claude" | "claude_code" | "claude_desktop")) {
            extra_headers
                .entry("anthropic-version".into())
                .or_insert_with(|| "2023-06-01".into());
        }
        for (name, value) in extra_headers {
            request = request.header(name, value);
        }
        request = match auth_scheme.as_str() {
            "bearer" => request.header("Authorization", format!("Bearer {}", api_key.value)),
            "x-api-key" => request.header("x-api-key", &api_key.value),
            "none" => request,
            _ => return Err("Unsupported authentication scheme".to_string()),
        };
        let mut response = request
            .send()
            .await
            .map_err(|error| format!("Failed to fetch models: {error}"))?;
        if !response.status().is_success() {
            return Err(format!("Model discovery returned {}", response.status()));
        }
        const MAX_CATALOG_BYTES: usize = 8 * 1024 * 1024;
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| format!("Failed to read model catalog: {error}"))?
        {
            if bytes.len().saturating_add(chunk.len()) > MAX_CATALOG_BYTES {
                return Err("供应商模型目录超出大小限制".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        let body: serde_json::Value = serde_json::from_slice(&bytes)
            .map_err(|error| format!("Failed to parse model catalog: {error}"))?;
        let models = body["data"]
            .as_array()
            .ok_or("供应商模型目录缺少 data 数组")?;
        if entries.len().saturating_add(models.len()) > 10_000 {
            return Err("供应商模型目录超出模型数量限制".into());
        }
        entries.extend(
            models
                .iter()
                .filter(|model| model["id"].as_str().is_some_and(|id| !id.trim().is_empty()))
                .cloned(),
        );
        if body["has_more"].as_bool() != Some(true) {
            let mut result = body;
            result["data"] = serde_json::Value::Array(entries);
            result["has_more"] = serde_json::json!(false);
            if !result["data"]
                .as_array()
                .is_some_and(|models| !models.is_empty())
            {
                return Err("供应商未返回有效模型目录".to_string());
            }
            return Ok(result);
        }
        let next = body["last_id"]
            .as_str()
            .or_else(|| models.last().and_then(|model| model["id"].as_str()))
            .filter(|id| !id.is_empty())
            .ok_or("供应商分页模型目录缺少游标")?
            .to_string();
        if !cursors.insert(next.clone()) {
            return Err("供应商模型目录分页重复".to_string());
        }
        cursor = Some(next);
    }
    Err("供应商模型目录超出分页读取限制".to_string())
}

pub(crate) async fn fetch_provider_model_ids(
    provider: &Provider,
    api_key: &ApiKey,
    client_kind: Option<&str>,
    user_agent: Option<&str>,
) -> Result<Vec<String>, String> {
    let catalog =
        fetch_provider_model_catalog(provider, api_key, client_kind, user_agent, None).await?;
    let mut ids = catalog["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| entry["id"].as_str().map(str::to_string))
        .collect::<Vec<_>>();
    ids.sort();
    ids.dedup();
    Ok(ids)
}

pub(crate) fn model_list_upstream_settings(
    provider: &Provider,
    api_key: &ApiKey,
    requested_client_kind: Option<&str>,
) -> (String, String) {
    let client_kind = requested_client_kind.unwrap_or_else(|| {
        api_key
            .types
            .first()
            .map(String::as_str)
            .unwrap_or("claude_code")
    });
    let client_config = api_key
        .client_configs
        .as_ref()
        .and_then(|configs| configs.get(client_kind));
    let base_url = client_config
        .and_then(|config| config.get("baseUrl"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&provider.base_url)
        .to_string();
    let auth_scheme = client_config
        .and_then(|config| config.get("authScheme"))
        .and_then(|value| value.as_str())
        .filter(|value| matches!(*value, "bearer" | "x-api-key" | "none"))
        .unwrap_or_else(|| match client_kind {
            "codex" | "grok" => "bearer",
            _ => "x-api-key",
        })
        .to_string();

    (base_url, auth_scheme)
}

fn build_model_list_endpoint(base_url: &str) -> Result<String, String> {
    let base_url = base_url.trim().trim_end_matches('/');
    let parsed = url::Url::parse(base_url).map_err(|_| "Invalid provider base URL".to_string())?;
    if parsed.host_str().is_none() {
        return Err("Invalid provider base URL".to_string());
    }

    if parsed.path().ends_with("/v1") {
        Ok(format!("{}/models", base_url))
    } else {
        Ok(format!("{}/v1/models", base_url))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_provider() -> Provider {
        Provider {
            request_headers: None,
            wallet_balance_script: None,
            id: "provider-1".to_string(),
            name: "Provider".to_string(),
            base_url: "https://provider.example.com/v1".to_string(),
            http_proxy: None,
            website: None,
            remark: None,
            token: None,
            icon: None,
            wallet_balance_type: "none".to_string(),
            wallet_balance_url: None,
            wallet_balance_path: None,
            wallet_balance_headers: None,
            wallet_balance_user_id: None,
            cached_wallet_balance: None,
            cached_wallet_balance_currency: None,
            last_balance_checked_at: None,
            usage_type: "none".to_string(),
            usage_url: None,
            usage_path: None,
            usage_headers: None,
            cached_usage: None,
            last_usage_checked_at: None,
            is_active: true,
            sort_order: 0,
            preset_id: "custom".to_string(),
            default_key_config: None,
            request_adapter: "none".to_string(),
        }
    }

    fn test_key(client_kind: &str, client_configs: Option<serde_json::Value>) -> ApiKey {
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
            client_configs,
        }
    }

    #[test]
    fn model_list_uses_selected_keys_upstream_settings() {
        let provider = test_provider();
        let key = test_key(
            "claude_code",
            Some(serde_json::json!({
                "claude_code": {
                    "baseUrl": "https://key.example.com/api/v1",
                    "authScheme": "bearer"
                }
            })),
        );

        assert_eq!(
            model_list_upstream_settings(&provider, &key, None),
            (
                "https://key.example.com/api/v1".to_string(),
                "bearer".to_string()
            )
        );
    }

    #[test]
    fn model_list_uses_clients_default_auth_when_key_has_no_override() {
        let provider = test_provider();

        assert_eq!(
            model_list_upstream_settings(&provider, &test_key("claude_code", None), None).1,
            "x-api-key"
        );
        assert_eq!(
            model_list_upstream_settings(&provider, &test_key("codex", None), None).1,
            "bearer"
        );
    }

    #[test]
    fn requested_client_kind_wins_for_multi_client_keys() {
        let provider = test_provider();
        let mut key = test_key("claude_code", None);
        key.types.push("codex".to_string());
        key.client_configs = Some(serde_json::json!({
            "claude_code": {
                "baseUrl": "https://anthropic.example.com",
                "authScheme": "x-api-key"
            },
            "codex": {
                "baseUrl": "https://responses.example.com/v1",
                "authScheme": "bearer"
            }
        }));

        assert_eq!(
            model_list_upstream_settings(&provider, &key, Some("codex")),
            (
                "https://responses.example.com/v1".to_string(),
                "bearer".to_string()
            )
        );
    }

    #[test]
    fn shared_model_list_prefers_codex_for_multi_client_keys() {
        let mut key = test_key("claude_code", None);
        key.types.push("codex".to_string());

        assert_eq!(preferred_model_list_client_kind(&key), Some("codex"));
    }

    #[test]
    fn shared_model_list_keeps_claude_only_keys_on_their_default_route() {
        let key = test_key("claude_code", None);

        assert_eq!(preferred_model_list_client_kind(&key), None);
    }

    #[test]
    fn model_list_endpoint_does_not_duplicate_v1() {
        assert_eq!(
            build_model_list_endpoint("https://example.com").unwrap(),
            "https://example.com/v1/models"
        );
        assert_eq!(
            build_model_list_endpoint("https://example.com/v1").unwrap(),
            "https://example.com/v1/models"
        );
        assert_eq!(
            build_model_list_endpoint("https://example.com/api/v1/").unwrap(),
            "https://example.com/api/v1/models"
        );
    }
}
