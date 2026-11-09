//! The per-key quota query.
//!
//! A key can carry its own query, asking what *that key* has left rather than
//! what the account has. It is the same mechanism as the provider's account
//! query — the same script shape, the same sandbox — differing only in which
//! credential `{{apiKey}}` resolves to.
//!
//! Two boundaries live here rather than in the script text, because they are
//! about the question being asked, not the wording:
//! - the credential set: the key scope resolves `{{apiKey}}` with the key's
//!   own value and borrows nothing from the provider, so an account token or
//!   user id cannot flow into a per-key answer;
//! - the target: a request pointing at an account endpoint is the account
//!   question even when written in an editor under a key, and it is refused
//!   with a repair message instead of being reported as the key's quota.

use crate::models::{ApiKey, Provider};
use crate::services::query_script::ScriptLimits;
use crate::services::{balance_service, query_script};
use crate::shared_runtime::query_schemes;
use serde_json::Value;

/// Run a key's own quota query.
pub async fn refresh_key_usage(key: &ApiKey, provider: &Provider) -> Result<Value, String> {
    let Some(script) = key
        .usage_script
        .as_deref()
        .map(str::trim)
        .filter(|script| !script.is_empty())
    else {
        // A row saved before a switch existed without a script had none: the
        // same answer as a freshly created key, nothing configured yet.
        return Ok(not_configured());
    };

    let config = query_schemes::effective_query_config(
        key.query_config.as_ref(),
        key.usage_script.as_deref(),
    );
    if let Some(config) = config {
        if !config.enabled {
            // The scheme and the script stay remembered; the switch says off.
            return Ok(disabled());
        }
    }

    let vars = vars_for(key, provider);
    let limits = ScriptLimits::default();
    let resolved = balance_service::resolve(script, &vars, &limits)?;

    // The target tells the truth about which question is being asked. Whether
    // it came from a migrated old script or from a user pointing a per-key
    // editor at a balance endpoint, it cannot run as this key's quota.
    guard_key_scope_targets(provider, &resolved)?;
    guard_key_scope_credentials(&resolved)?;

    let usage = balance_service::execute(
        &provider.base_url,
        script,
        &vars,
        &limits,
        resolved,
        |request| async move { balance_service::send(provider, &request).await },
    )
    .await?;

    // The key scope reports the key's own quota. Windows and groups belong to
    // the account question; whatever an extractor returned for them, they are
    // dropped rather than dressed up as a key-level answer, and a script that
    // only answered the account-style windows has said nothing at all.
    let usage = strip_to_key_usage(usage)?;

    Ok(serde_json::json!({
        "usage": {
            "total": usage.total,
            "used": usage.used,
            "remaining": usage.remaining,
            "unit": usage.unit,
            "isUnlimited": usage.is_unlimited.unwrap_or(false),
            "expireAt": usage.expire_at,
            // Key quota has no metering windows; the field stays an empty
            // list so the envelope shape is stable for the renderer.
            "windows": [],
            "groups": [],
        },
        "isValid": usage.is_valid.unwrap_or(true),
        "invalidMessage": usage.invalid_message,
        "error": Value::Null,
    }))
}

/// The key being asked about is the credential the query authenticates with,
/// and nothing else: the provider's account token and user id stay out of the
/// variable set entirely.
fn vars_for(key: &ApiKey, provider: &Provider) -> query_script::ScriptVars {
    query_script::ScriptVars {
        base_url: provider.base_url.trim_end_matches('/').to_string(),
        api_key: non_empty(Some(key.value.as_str())),
        access_token: None,
        user_id: None,
    }
}

/// Refuse key-scope scripts whose request targets are account endpoints.
///
/// The evidence is the resolved URL, compared against the concrete targets
/// the account schemes read for this provider — strong enough to catch the
/// migrated templates and the well-known balance routes, loose enough to
/// leave a genuinely custom per-key script alone.
pub(super) fn guard_key_scope_targets(
    provider: &Provider,
    resolved: &query_script::ResolvedRequests,
) -> Result<(), String> {
    let blocked = query_schemes::account_target_urls(&provider.base_url);
    let statements: Vec<&str> = match resolved {
        query_script::ResolvedRequests::Single(request) => vec![&request.url],
        query_script::ResolvedRequests::Many(named) => named
            .values()
            .map(|named| named.request.url.as_str())
            .collect(),
    };
    if statements
        .iter()
        .any(|url| blocked.iter().any(|target| target == *url))
    {
        return Err(query_schemes::KEY_QUERY_ACCOUNT_TARGET_MESSAGE.to_string());
    }
    Ok(())
}

/// The key scope names its own credential or nothing. The check happens
/// before any send, with key-scope wording for every placeholder.
pub(super) fn guard_key_scope_credentials(
    resolved: &query_script::ResolvedRequests,
) -> Result<(), String> {
    match resolved {
        query_script::ResolvedRequests::Single(request) => {
            balance_service::ensure_key_query_credentials(request)
        }
        query_script::ResolvedRequests::Many(named) => {
            for named_request in named.values() {
                balance_service::ensure_key_query_credentials(&named_request.request)?;
            }
            Ok(())
        }
    }
}

/// Keep the per-key fields; drop what belongs to the account question.
pub(super) fn strip_to_key_usage(
    usage: query_script::AccountUsage,
) -> Result<query_script::AccountUsage, String> {
    let quota_reported = usage.remaining.is_some()
        || usage.total.is_some()
        || usage.used.is_some()
        || usage.is_unlimited.is_some()
        || usage.expire_at.is_some();
    if !quota_reported {
        // "The service said nothing about this key" is a failure to fix, not
        // a zero to display — the account-style window answer is not the
        // key's quota.
        return Err(key_quota_missing_message(&usage));
    }
    Ok(query_script::AccountUsage {
        remaining: usage.remaining,
        total: usage.total,
        used: usage.used,
        unit: usage.unit,
        is_unlimited: usage.is_unlimited,
        expire_at: usage.expire_at,
        windows: Vec::new(),
        is_valid: usage.is_valid,
        invalid_message: usage.invalid_message,
    })
}

fn key_quota_missing_message(usage: &query_script::AccountUsage) -> String {
    if usage.windows.is_empty() {
        "查询未返回当前密钥的额度".to_string()
    } else {
        "查询只返回了周期窗口，没有返回当前密钥的额度；请使用“密钥额度”区的独立方案".to_string()
    }
}

fn non_empty(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn not_configured() -> Value {
    serde_json::json!({
        "usage": Value::Null,
        "isValid": true,
        "invalidMessage": Value::Null,
        "error": "尚未配置额度查询",
    })
}

fn disabled() -> Value {
    serde_json::json!({
        "usage": Value::Null,
        "isValid": true,
        "invalidMessage": Value::Null,
        "error": "额度查询已关闭",
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared_runtime::account_scripts;

    fn provider() -> Provider {
        serde_json::from_value(serde_json::json!({
            "id": "p1",
            "name": "relay",
            "baseUrl": "https://relay.example.com/",
            "token": "tok-1",
            "walletBalanceUserId": "user-1",
            "walletBalanceType": "custom",
            "usageType": "none",
            "isActive": true,
            "sortOrder": 0
        }))
        .expect("provider fixture")
    }

    fn key(value: &str) -> ApiKey {
        serde_json::from_value(serde_json::json!({
            "id": "k1",
            "providerId": "p1",
            "value": value,
            "types": ["claude_code"],
            "priority": 0,
            "isExhausted": false,
            "isActive": true,
            "usageType": "none"
        }))
        .expect("key fixture")
    }

    /// The key's own value wins: a quota query is asking about that key.
    #[test]
    fn the_key_being_asked_about_is_the_credential_used() {
        let vars = vars_for(&key("sk-live"), &provider());

        assert_eq!(vars.api_key.as_deref(), Some("sk-live"));
        assert_eq!(vars.base_url, "https://relay.example.com");
    }

    /// The provider's account credentials are what the key scope must not
    /// borrow; they exist on the fixture precisely to prove they stay out.
    #[test]
    fn the_key_scope_borrows_no_account_credential() {
        let vars = vars_for(&key("sk-live"), &provider());

        assert_eq!(vars.access_token, None, "provider token must not leak in");
        assert_eq!(vars.user_id, None, "provider user id must not leak in");
    }

    #[test]
    fn a_key_without_a_script_says_so_instead_of_failing() {
        let envelope = not_configured();

        assert_eq!(envelope["error"], "尚未配置额度查询");
        assert!(envelope["usage"].is_null());
    }

    #[test]
    fn a_key_with_the_newapi_key_script_runs_through_the_whole_envelope() {
        let provider = provider();
        let mut key = key("sk-live");
        key.usage_script = Some(account_scripts::script_for(
            account_scripts::key_usage_for_legacy_kind("newapi").expect("shipped per-key script"),
        ));
        key.query_config = Some(query_schemes::QueryConfig {
            enabled: true,
            scheme_id: query_schemes::SCHEME_NEWAPI_KEY.to_string(),
        });

        // No network here: the resolution must accept the shipped key script.
        let vars = vars_for(&key, &provider);
        let resolved = balance_service::resolve(
            key.usage_script.as_deref().expect("script"),
            &vars,
            &ScriptLimits::default(),
        )
        .expect("the shipped key script resolves");
        guard_key_scope_targets(&provider, &resolved)
            .expect("the shipped key script targets the per-key route");
        guard_key_scope_credentials(&resolved).expect("the shipped key script uses only the key");
    }

    /// A script that targets the account endpoints cannot run as this key's
    /// quota, whatever the extractor promises — the message points at the
    /// repair, and the original script stays touched by no one.
    #[tokio::test]
    async fn a_key_script_pointing_at_account_endpoints_is_refused() {
        for script in [
            account_scripts::command_code_script().to_string(),
            account_scripts::script_for(
                account_scripts::for_legacy_kind("newapi").expect("account script"),
            ),
        ] {
            let provider = provider();
            let mut key = key("sk-live");
            key.usage_script = Some(script);
            key.query_config = Some(query_schemes::QueryConfig {
                enabled: true,
                scheme_id: query_schemes::SCHEME_CUSTOM.to_string(),
            });

            let error = refresh_key_usage(&key, &provider)
                .await
                .expect_err("account scripts are refused for keys");
            assert_eq!(error, query_schemes::KEY_QUERY_ACCOUNT_TARGET_MESSAGE);
        }
    }

    /// An explicitly disabled switch answers "closed" and sends nothing.
    #[tokio::test]
    async fn a_disabled_quota_says_so_instead_of_running() {
        let provider = provider();
        let mut key = key("sk-live");
        key.usage_script =
            Some("({request:{url:'{{baseUrl}}/x'},extractor:()=>({remaining:1})})".to_string());
        key.query_config = Some(query_schemes::QueryConfig {
            enabled: false,
            scheme_id: query_schemes::SCHEME_CUSTOM.to_string(),
        });

        let envelope = refresh_key_usage(&key, &provider)
            .await
            .expect("closed, not failed");
        assert_eq!(envelope["error"], "额度查询已关闭");
        assert!(envelope["usage"].is_null());
    }

    /// Legacy rows kept their implicit state: a script alone is enabled.
    #[tokio::test]
    async fn a_legacy_key_with_only_a_script_still_runs() {
        let _provider = provider();
        let mut key = key("sk-live");
        key.usage_script =
            Some("({request:{url:'{{baseUrl}}/x'},extractor:()=>({remaining:1})})".to_string());
        assert!(key.query_config.is_none());

        let config = query_schemes::effective_query_config(
            key.query_config.as_ref(),
            key.usage_script.as_deref(),
        )
        .expect("legacy intent");
        assert!(config.enabled);
    }

    #[test]
    fn a_window_only_answer_is_not_this_key_s_quota() {
        let usage = query_script::AccountUsage {
            windows: vec![query_script::AccountWindow {
                id: "rolling_5h".to_string(),
                label: Some("5h".to_string()),
                used_percent: Some(30.0),
                resets_at: None,
                status: None,
            }],
            ..Default::default()
        };

        let message = strip_to_key_usage(usage).expect_err("windows are not a key quota");
        assert!(message.contains("没有返回当前密钥的额度"));
    }

    #[test]
    fn a_real_quota_survives_with_windows_stripped() {
        let usage = query_script::AccountUsage {
            remaining: Some(12.5),
            unit: Some("USD".to_string()),
            ..Default::default()
        };

        let stripped = strip_to_key_usage(usage).expect("quota value kept");
        assert_eq!(stripped.remaining, Some(12.5));
        assert!(stripped.windows.is_empty());
    }
}
