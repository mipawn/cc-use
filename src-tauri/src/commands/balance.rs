use crate::db::Database;
use crate::models::{QueryTestInput, QueryTestResult};
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

    // The input snapshot the answer belongs to: the effective query config,
    // the borrowed credential a refresh would send with, and the address and
    // proxy it would send through.
    let config_snapshot = crate::shared_runtime::query_schemes::effective_query_config(
        provider.query_config.as_ref(),
        provider.wallet_balance_script.as_deref(),
    );
    let borrowed_credential_snapshot =
        crate::services::balance_service::pick_first_available_key(&api_keys);

    let result = crate::services::balance_service::refresh_balance(&provider, &api_keys).await;

    // Only a successful query updates the cache. A failure leaves the last
    // known answer standing rather than blanking it.
    if let Ok(ref answer) = result {
        if answer.get("error").is_some_and(|value| !value.is_null())
            || answer.get("isValid").and_then(Value::as_bool) == Some(false)
        {
            return result;
        }

        // And only the answer of the *current* configuration updates it. The
        // update path (one transaction with the change) clears the cache the
        // moment any of these moved; storing this run anyway would resurrect
        // the old answer under the new configuration.
        {
            let (provider_now, api_keys_now) = {
                let db = db.lock().map_err(|e| e.to_string())?;
                let provider_now = db.provider_get(&provider_id).map_err(|e| e.to_string())?;
                match provider_now {
                    Some(provider_now) => {
                        let api_keys_now = db.api_key_list(&provider_id).unwrap_or_default();
                        (provider_now, api_keys_now)
                    }
                    None => return result,
                }
            };
            let config_now = crate::shared_runtime::query_schemes::effective_query_config(
                provider_now.query_config.as_ref(),
                provider_now.wallet_balance_script.as_deref(),
            );
            let borrowed_now =
                crate::services::balance_service::pick_first_available_key(&api_keys_now);
            if config_now != config_snapshot
                || borrowed_now != borrowed_credential_snapshot
                || provider_now.base_url != provider.base_url
                || provider_now.http_proxy != provider.http_proxy
                || provider_now.token != provider.token
                || provider_now.wallet_balance_user_id != provider.wallet_balance_user_id
            {
                return result;
            }
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

/// The named query schemes the catalogue ships, for one or both scopes.
///
/// A scheme is configuration, not behaviour: the UI reads the credential
/// requirements and the capability flags from here instead of guessing them
/// from preset ids or templates. The script texts stay backend-owned.
#[tauri::command]
pub fn query_schemes(scope: Option<String>) -> Result<Vec<Value>, String> {
    let infos = crate::shared_runtime::query_schemes::scheme_infos_for_scope(scope.as_deref())?;
    infos
        .iter()
        .map(serde_json::to_value)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

/// Run an unsaved draft's query once, exactly the way a refresh would.
///
/// The point of the seam: nothing is persisted, no cache is written and no
/// check time is stamped — a cancelled editor carries no residue. What the
/// test may borrow (the account scope's fallback credential) is resolved
/// with one short DB lock before any network work starts, so the lock never
/// spans an await.
#[tauri::command]
pub async fn query_test(
    db: State<'_, Arc<Mutex<Database>>>,
    input: QueryTestInput,
) -> Result<QueryTestResult, String> {
    // Only the account scope without an explicit key can borrow a saved
    // credential, and only through the provider's own id; the key scope is
    // its key, and cannot borrow anything from storage.
    let draft_has_key = input
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_some();
    let provider_id = input
        .provider_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let fallback_credential = if input.scope != "account" || draft_has_key {
        None
    } else if let Some(provider_id) = provider_id {
        let keys = {
            let db = db.lock().map_err(|e| e.to_string())?;
            db.api_key_list(provider_id).unwrap_or_default()
        };
        crate::services::balance_service::pick_first_available_key(&keys)
    } else {
        None
    };

    // The transport closes over the draft's own provider shape, so a draft
    // resolves and sends through the same proxy-aware client a saved refresh
    // would use.
    let transport_provider = crate::services::query_test::draft_provider(&input)?;
    crate::services::query_test::run_draft_query_test(&input, fallback_credential, move |request| {
        let provider = transport_provider.clone();
        async move { crate::services::balance_service::send(&provider, &request).await }
    })
    .await
}

/// Run a key's own quota query and cache what it answered.
///
/// The refresh is also where a *stale* answer is jealously refused: the key
/// and its provider are re-read after the query ran, and the answer only
/// lands when the configuration it answered against is still what is stored
/// (enabled switch, script, credential, address). Anything that moved during
/// the await makes the answer old news for the fresh configuration.
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

    // The input snapshot the answer belongs to. The provider key list snapshot
    // for the borrowed-credential check is only a function of the config; the
    // key's own value and script below decide whether the answer may land.
    let key_scope_config = crate::shared_runtime::query_schemes::effective_query_config(
        key.query_config.as_ref(),
        key.usage_script.as_deref(),
    );

    let result = crate::services::usage_service::refresh_key_usage(&key, &provider).await;

    if let Ok(ref res) = result {
        if res.get("error").is_some_and(|value| !value.is_null())
            || res.get("isValid").and_then(Value::as_bool) == Some(false)
        {
            return result;
        }
        if let Some(usage) = res.get("usage").filter(|usage| !usage.is_null()) {
            let db = db.lock().map_err(|e| e.to_string())?;

            // The answer is only current for the configuration it answered
            // against. If the key, its switch, its script, its credential or
            // the provider's address moved while the request was in flight,
            // the storage rule (same transaction as the change) has already
            // cleared the cache — and this write-back would silently
            // resurrect the old answer under the new configuration.
            let key_now = db
                .api_key_get(&key_id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "API key not found".to_string())?;
            let provider_now = db
                .provider_get(&key_now.provider_id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "Provider not found".to_string())?;
            let config_now = crate::shared_runtime::query_schemes::effective_query_config(
                key_now.query_config.as_ref(),
                key_now.usage_script.as_deref(),
            );
            let address_moved = provider_now.base_url != provider.base_url
                || provider_now.http_proxy != provider.http_proxy;
            if config_now != key_scope_config
                || key_now.value != key.value
                || key_now.usage_script != key.usage_script
                || address_moved
            {
                // The stale run is dropped and reported, not stored.
                return result;
            }

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
