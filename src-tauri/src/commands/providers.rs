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
    let db = db.lock().map_err(|e| e.to_string())?;
    db.provider_create(&input).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn provider_update(
    db: State<'_, Arc<Mutex<Database>>>,
    input: UpdateProviderInput,
) -> Result<Provider, String> {
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

#[tauri::command]
pub async fn provider_model_list(
    db: State<'_, Arc<Mutex<Database>>>,
    provider_id: String,
    api_key_id: String,
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

    let client_kind = preferred_model_list_client_kind(&api_key);
    fetch_provider_model_ids(&provider, &api_key, client_kind).await
}

/// The shared model-list dialog has no client selector. For a multi-client key,
/// prefer an OpenAI-compatible route because Anthropic-compatible base URLs do
/// not generally expose `GET /models`.
fn preferred_model_list_client_kind(api_key: &ApiKey) -> Option<&str> {
    ["codex", "grok"]
        .into_iter()
        .find(|kind| api_key.types.iter().any(|value| value == kind))
}

/// Fetch the real model ids exposed by a provider. Passing a client kind makes
/// sure multi-client keys use that client's base URL and auth settings instead
/// of whichever type happens to be first in the stored array.
pub(crate) async fn fetch_provider_model_ids(
    provider: &Provider,
    api_key: &ApiKey,
    client_kind: Option<&str>,
) -> Result<Vec<String>, String> {
    let (base_url, auth_scheme) = model_list_upstream_settings(provider, api_key, client_kind);
    let endpoint = build_model_list_endpoint(&base_url)?;

    let client = crate::services::http_client::outbound_client_builder_for_proxy(
        provider.http_proxy.as_deref(),
    )?
    .timeout(std::time::Duration::from_secs(15))
    .build()
    .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let mut request = client.get(endpoint).header("User-Agent", "cc-use/3.x");
    request = match auth_scheme.as_str() {
        "bearer" => request.header("Authorization", format!("Bearer {}", api_key.value)),
        "x-api-key" => request.header("x-api-key", &api_key.value),
        "none" => request,
        _ => return Err("Unsupported authentication scheme".to_string()),
    };

    let resp = request
        .send()
        .await
        .map_err(|e| format!("Failed to fetch models: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("API returned {}: {}", status, body));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    let models = body["data"]
        .as_array()
        .ok_or_else(|| "Unexpected response format: missing 'data' array".to_string())?;

    let mut model_ids: Vec<String> = models
        .iter()
        .filter_map(|m| m["id"].as_str().map(|s| s.to_string()))
        .collect();
    model_ids.sort();
    model_ids.dedup();

    if model_ids.is_empty() {
        return Err("No models found".to_string());
    }

    Ok(model_ids)
}

fn model_list_upstream_settings(
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
            last_balance_checked_at: None,
            usage_type: "none".to_string(),
            usage_url: None,
            usage_path: None,
            usage_headers: None,
            cached_usage: None,
            last_usage_checked_at: None,
            is_active: true,
            sort_order: 0,
        }
    }

    fn test_key(client_kind: &str, client_configs: Option<serde_json::Value>) -> ApiKey {
        ApiKey {
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
