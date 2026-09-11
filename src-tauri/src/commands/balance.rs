use crate::db::Database;
use crate::services::query_script::{self, ScriptLimits, ScriptVars};
use serde_json::Value;
use std::sync::{Arc, Mutex};
use tauri::State;

/// Check a query script without running it.
///
/// A script is text until something evaluates it, so a typo would otherwise
/// only surface the next time a balance was refreshed. This evaluates it —
/// still without sending anything, and without any credential — and reports
/// what it would ask for, so the editor can refuse a script that cannot work.
#[tauri::command]
pub fn provider_script_check(script: String, base_url: String) -> Result<Value, String> {
    let limits = ScriptLimits::default();
    // No credentials: placeholders that need one stay visible in the result,
    // which is what the editor shows back rather than a half-resolved request.
    let vars = ScriptVars {
        base_url: base_url.trim().trim_end_matches('/').to_string(),
        ..ScriptVars::default()
    };

    let request = query_script::resolve_request(&script, &vars, &limits)
        .map_err(|error| error.message().to_string())?;
    query_script::is_permitted_target(&request.url, &base_url)?;

    Ok(serde_json::json!({
        "url": request.url,
        "method": request.method,
        "headers": request.headers,
    }))
}

/// Run a provider's account query and cache what it answered.
///
/// One command, because a provider has one account query: the script decides
/// whether the answer is a balance, a set of metering periods, or both, and the
/// card reads whichever arrived.
#[tauri::command]
pub async fn balance_refresh(
    db: State<'_, Arc<Mutex<Database>>>,
    provider_id: String,
) -> Result<Value, String> {
    let (provider, api_keys) = {
        let db = db.lock().map_err(|e| e.to_string())?;
        let provider = db
            .provider_get(&provider_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Provider not found".to_string())?;
        let api_keys = db.api_key_list(&provider_id).unwrap_or_default();
        (provider, api_keys)
    };

    let result = crate::services::balance_service::refresh_balance(&provider, &api_keys).await;

    // Only a successful query updates the cache. A failure leaves the last
    // known answer standing rather than blanking it.
    if let Ok(ref answer) = result {
        let cached_usage = serde_json::json!({
            "total": answer.get("total").cloned().unwrap_or(Value::Null),
            "used": answer.get("used").cloned().unwrap_or(Value::Null),
            "remaining": answer.get("balance").cloned().unwrap_or(Value::Null),
            "unit": answer.get("currency").cloned().unwrap_or(Value::Null),
            "isUnlimited": answer.get("unlimited").cloned().unwrap_or(Value::Bool(false)),
            "windows": answer.get("windows").cloned().unwrap_or(Value::Array(Vec::new())),
        });

        let now = chrono::Utc::now().to_rfc3339();
        // The currency is cached with the amount so the card renders a CNY
        // balance as CNY instead of defaulting to a dollar sign.
        let balance = answer.get("balance").and_then(Value::as_f64);
        let currency = answer.get("currency").and_then(Value::as_str);

        let db = db.lock().map_err(|e| e.to_string())?;
        let _ = db.conn.execute(
            "UPDATE providers SET cached_wallet_balance = ?1, cached_wallet_balance_currency = ?2,
                cached_usage = ?3, last_balance_checked_at = ?4, last_usage_checked_at = ?4
             WHERE id = ?5",
            rusqlite::params![
                balance,
                currency,
                serde_json::to_string(&cached_usage).unwrap_or_default(),
                now,
                provider_id
            ],
        );
    }

    result
}

/// Run a key's own quota query and cache what it answered.
#[tauri::command]
pub async fn key_usage_refresh(
    db: State<'_, Arc<Mutex<Database>>>,
    key_id: String,
) -> Result<Value, String> {
    let (key, provider) = {
        let db = db.lock().map_err(|e| e.to_string())?;
        let key = db
            .api_key_get(&key_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "API key not found".to_string())?;
        let provider = db
            .provider_get(&key.provider_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Provider not found".to_string())?;
        (key, provider)
    };

    let result = crate::services::usage_service::refresh_key_usage(&key, &provider).await;

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
