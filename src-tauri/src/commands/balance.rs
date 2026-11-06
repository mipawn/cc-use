use crate::db::Database;
use crate::services::query_script::{self, ResolvedRequests, ScriptLimits, ScriptVars};
use serde_json::Value;
use std::sync::{Arc, Mutex};
use tauri::State;

/// Check a query script without running it.
///
/// A script is text until something evaluates it, so a typo would otherwise
/// only surface the next time a balance was refreshed. This evaluates it —
/// still without sending anything, and without any credential — and reports
/// what it would ask for, so the editor can refuse a script that cannot work.
///
/// A single-request script reports the one request it always did; a
/// named-request script reports one entry per name, carrying `optional` so
/// the editor can show what is allowed to fail. No request actually leaves
/// the process on save.
#[tauri::command]
pub fn provider_script_check(script: String, base_url: String) -> Result<Value, String> {
    provider_script_check_inner(&script, &base_url)
}

fn provider_script_check_inner(script: &str, base_url: &str) -> Result<Value, String> {
    let limits = ScriptLimits::default();
    // No credentials: placeholders that need one stay visible in the result,
    // which is what the editor shows back rather than a half-resolved request.
    let vars = ScriptVars {
        base_url: base_url.trim().trim_end_matches('/').to_string(),
        ..ScriptVars::default()
    };

    let resolved = query_script::resolve_requests(script, &vars, &limits)
        .map_err(|error| error.message().to_string())?;

    match resolved {
        ResolvedRequests::Single(request) => {
            query_script::is_permitted_target(&request.url, base_url)?;
            Ok(serde_json::json!({
                "url": request.url,
                "method": request.method,
                "headers": request.headers,
            }))
        }
        ResolvedRequests::Many(named) => {
            // Every named request is checked, optional ones included: a
            // destination a credential must not reach is a save problem even
            // when failing is supposed not to be fatal.
            for named_request in named.values() {
                query_script::is_permitted_target(&named_request.request.url, base_url)?;
            }
            let requests = named
                .into_iter()
                .map(|(name, named_request)| {
                    (
                        name,
                        serde_json::json!({
                            "url": named_request.request.url,
                            "method": named_request.request.method,
                            "headers": named_request.request.headers,
                            "optional": named_request.optional,
                        }),
                    )
                })
                .collect::<serde_json::Map<String, Value>>();
            Ok(serde_json::json!({ "requests": Value::Object(requests) }))
        }
    }
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
        if answer.get("error").is_some_and(|value| !value.is_null())
            || answer.get("isValid").and_then(Value::as_bool) == Some(false)
        {
            return result;
        }
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
        db.conn.execute(
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
        ).map_err(|error| error.to_string())?;
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
        if res.get("error").is_some_and(|value| !value.is_null())
            || res.get("isValid").and_then(Value::as_bool) == Some(false)
        {
            return result;
        }
        if let Some(usage) = res.get("usage").filter(|usage| !usage.is_null()) {
            let db = db.lock().map_err(|e| e.to_string())?;
            let now = chrono::Utc::now().to_rfc3339();
            let usage_str = serde_json::to_string(usage).unwrap_or_default();
            db.conn.execute(
                "UPDATE api_keys SET cached_usage = ?1, last_usage_checked_at = ?2 WHERE id = ?3",
                rusqlite::params![usage_str, now, key_id],
            ).map_err(|error| error.to_string())?;
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared_runtime::account_scripts::command_code_script;

    #[test]
    fn a_single_script_reports_its_request_the_way_it_always_did() {
        let report = provider_script_check_inner(
            "({request:{url:'{{baseUrl}}/api/user/self',method:'GET',headers:{Authorization:'Bearer {{apiKey}}'}},extractor:()=>({})})",
            "https://newapi.example.com",
        )
        .expect("check passes");

        assert_eq!(report["url"], "https://newapi.example.com/api/user/self");
        assert_eq!(report["method"], "GET");
        // No credential was available to substitute; the placeholder shows.
        assert_eq!(report["headers"]["Authorization"], "Bearer {{apiKey}}");
        assert!(report.get("requests").is_none());
    }

    #[test]
    fn a_named_script_reports_every_request_with_its_optionality() {
        let report = provider_script_check_inner(
            command_code_script(),
            "https://api.commandcode.ai/provider",
        )
        .expect("check passes");

        let credit = &report["requests"]["credit"];
        assert_eq!(
            credit["url"],
            "https://api.commandcode.ai/alpha/billing/credits"
        );
        assert_eq!(credit["method"], "GET");
        assert_eq!(credit["headers"]["Authorization"], "Bearer {{apiKey}}");
        assert_eq!(credit["optional"], false);
        assert_eq!(report["requests"]["subscription"]["optional"], true);
        assert_eq!(report["requests"]["summary"]["optional"], true);
        assert!(report.get("url").is_none());
    }

    #[test]
    fn the_check_still_refuses_a_foreign_destination() {
        // Single form, as before.
        let error = provider_script_check_inner(
            "({request:{url:'https://evil.example.com/collect'},extractor:()=>({})})",
            "https://relay.example.com",
        )
        .unwrap_err();
        assert!(error.contains("the provider's own origin"));

        // Named form: every entry is checked, optional ones included.
        let error = provider_script_check_inner(
            "({requests:{first:{url:'https://relay.example.com/ok'},leak:{url:'http://relay.example.com/clear'}},extractor:()=>({})})",
            "https://relay.example.com",
        )
        .unwrap_err();
        assert_eq!(error, "the query URL must use https");
    }

    #[test]
    fn both_forms_in_one_script_fail_the_check_with_the_reported_cause() {
        let error = provider_script_check_inner(
            "({request:{url:'https://x.example.com/a'},requests:{first:{url:'https://x.example.com/b'}},extractor:()=>({})})",
            "https://x.example.com",
        )
        .unwrap_err();

        assert_eq!(error, "request 与 requests 二选一，不要同时写");
    }
}
