use crate::db::Database;
use std::sync::{Arc, Mutex};
use tauri::State;

#[tauri::command]
pub async fn balance_refresh(
    db: State<'_, Arc<Mutex<Database>>>,
    provider_id: String,
) -> Result<serde_json::Value, String> {
    let (provider, api_keys) = {
        let db = db.lock().map_err(|e| e.to_string())?;
        let provider = db.provider_get(&provider_id).map_err(|e| e.to_string())?
            .ok_or_else(|| "Provider not found".to_string())?;
        let api_keys = db.api_key_list(&provider_id).unwrap_or_default();
        (provider, api_keys)
    };

    let result = crate::services::balance_service::refresh_balance(&provider, &api_keys).await;

    // Update cached balance in DB
    if let Ok(ref res) = result {
        if let Some(balance) = res.get("balance").and_then(|v| v.as_f64()) {
            let db = db.lock().map_err(|e| e.to_string())?;
            let now = chrono::Utc::now().to_rfc3339();
            let _ = db.conn.execute(
                "UPDATE providers SET cached_wallet_balance = ?1, last_balance_checked_at = ?2 WHERE id = ?3",
                rusqlite::params![balance, now, provider_id],
            );
        }
    }

    result
}

#[tauri::command]
pub async fn usage_refresh(
    db: State<'_, Arc<Mutex<Database>>>,
    provider_id: String,
) -> Result<serde_json::Value, String> {
    let (provider, api_keys) = {
        let db = db.lock().map_err(|e| e.to_string())?;
        let provider = db.provider_get(&provider_id).map_err(|e| e.to_string())?
            .ok_or_else(|| "Provider not found".to_string())?;
        let api_keys = db.api_key_list(&provider_id).unwrap_or_default();
        (provider, api_keys)
    };

    let result = crate::services::usage_service::refresh_usage(&provider, &api_keys).await;

    // Update cached usage in DB
    if let Ok(ref res) = result {
        if let Some(usage) = res.get("usage") {
            let db = db.lock().map_err(|e| e.to_string())?;
            let now = chrono::Utc::now().to_rfc3339();
            let usage_str = serde_json::to_string(usage).unwrap_or_default();
            let _ = db.conn.execute(
                "UPDATE providers SET cached_usage = ?1, last_usage_checked_at = ?2 WHERE id = ?3",
                rusqlite::params![usage_str, now, provider_id],
            );
        }
    }

    result
}

#[tauri::command]
pub async fn key_usage_refresh(
    db: State<'_, Arc<Mutex<Database>>>,
    key_id: String,
) -> Result<serde_json::Value, String> {
    let (key, provider_base_url) = {
        let db = db.lock().map_err(|e| e.to_string())?;
        let key = db.api_key_get(&key_id).map_err(|e| e.to_string())?
            .ok_or_else(|| "API key not found".to_string())?;
        let provider = db.provider_get(&key.provider_id).map_err(|e| e.to_string())?
            .ok_or_else(|| "Provider not found".to_string())?;
        (key, provider.base_url)
    };

    let result = crate::services::usage_service::refresh_key_usage(&key, &provider_base_url).await;

    // Update cached usage in DB
    if let Ok(ref res) = result {
        if let Some(usage) = res.get("usage") {
            let db = db.lock().map_err(|e| e.to_string())?;
            let now = chrono::Utc::now().to_rfc3339();
            let usage_str = serde_json::to_string(usage).unwrap_or_default();
            let _ = db.conn.execute(
                "UPDATE api_keys SET cached_usage = ?1, last_usage_checked_at = ?2 WHERE id = ?3",
                rusqlite::params![usage_str, now, key_id],
            );
        }
    }

    result
}
