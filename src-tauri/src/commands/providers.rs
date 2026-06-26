use crate::db::Database;
use crate::models::{CreateProviderInput, Provider, UpdateProviderInput};
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
) -> Result<Vec<String>, String> {
    let (provider, api_keys) = {
        let db = db.lock().map_err(|e| e.to_string())?;
        let provider = db
            .provider_get(&provider_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Provider not found".to_string())?;
        let keys = db.api_key_list(&provider_id).unwrap_or_default();
        (provider, keys)
    };

    let base_url = provider.base_url.trim_end_matches('/');

    // Determine auth token: use provider.token first, then first active API key
    let token = provider
        .token
        .as_deref()
        .filter(|s| !s.is_empty())
        .or_else(|| {
            api_keys
                .iter()
                .find(|k| k.is_active && !k.is_exhausted)
                .map(|k| k.value.as_str())
        })
        .ok_or_else(|| "No available token or API key for this provider".to_string())?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let resp = client
        .get(format!("{}/v1/models", base_url))
        .header("Authorization", format!("Bearer {}", token))
        .header("User-Agent", "cc-use/3.x")
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

    let model_ids: Vec<String> = models
        .iter()
        .filter_map(|m| m["id"].as_str().map(|s| s.to_string()))
        .collect();

    if model_ids.is_empty() {
        return Err("No models found".to_string());
    }

    Ok(model_ids)
}
