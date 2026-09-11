//! The per-key quota query.
//!
//! A key can carry its own query, asking what *that key* has left rather than
//! what the account has. It is the same mechanism as the provider's account
//! query — the same script shape, the same sandbox — differing only in which
//! credential `{{apiKey}}` resolves to.

use crate::models::{ApiKey, Provider};
use crate::services::query_script::ScriptVars;
use serde_json::Value;

/// Run a key's own quota query.
pub async fn refresh_key_usage(key: &ApiKey, provider: &Provider) -> Result<Value, String> {
    let Some(script) = key
        .usage_script
        .as_deref()
        .map(str::trim)
        .filter(|script| !script.is_empty())
    else {
        return Ok(not_configured());
    };

    let vars = vars_for(key, provider);
    let usage = super::balance_service::run(provider, script, &vars).await?;

    Ok(serde_json::json!({
        "usage": {
            "total": usage.total,
            "used": usage.used,
            "remaining": usage.remaining,
            "unit": usage.unit,
            "isUnlimited": usage.is_unlimited.unwrap_or(false),
            "expireAt": usage.expire_at,
            "windows": usage.windows,
        },
        "isValid": usage.is_valid.unwrap_or(true),
        "invalidMessage": usage.invalid_message,
        "error": Value::Null,
    }))
}

/// The key being asked about is the credential the query authenticates with,
/// which is the whole difference from the provider-level query.
fn vars_for(key: &ApiKey, provider: &Provider) -> ScriptVars {
    let mut vars = super::balance_service::vars_for(provider, &[]);
    if !key.value.trim().is_empty() {
        vars.api_key = Some(key.value.clone());
    }
    vars
}

fn not_configured() -> Value {
    serde_json::json!({
        "usage": Value::Null,
        "isValid": true,
        "invalidMessage": Value::Null,
        "error": "尚未配置额度查询",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider() -> Provider {
        serde_json::from_value(serde_json::json!({
            "id": "p1",
            "name": "relay",
            "baseUrl": "https://relay.example.com/",
            "token": "tok-1",
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

    #[test]
    fn a_key_without_a_script_says_so_instead_of_failing() {
        let envelope = not_configured();

        assert_eq!(envelope["error"], "尚未配置额度查询");
        assert!(envelope["usage"].is_null());
    }
}
