//! The provider's account query.
//!
//! One question — how much of this account is left — answered by one script the
//! provider carries. The script was filled in by a preset or written by hand;
//! either way this module only runs it, and the reading of the answer lives in
//! the script rather than in a branch here.

use crate::models::{ApiKey, Provider};
use crate::services::query_script::{self, AccountUsage, ScriptLimits, ScriptRequest, ScriptVars};
use serde_json::Value;

/// Run the provider's account query.
///
/// The envelope keeps the field names the card and the tray already read, and
/// carries the metered periods alongside them, so a balance and a metering
/// service arrive through the same door.
pub async fn refresh_balance(
    provider: &Provider,
    fallback_api_keys: &[ApiKey],
) -> Result<Value, String> {
    let Some(script) = provider
        .wallet_balance_script
        .as_deref()
        .map(str::trim)
        .filter(|script| !script.is_empty())
    else {
        return Ok(not_configured());
    };

    let vars = vars_for(provider, fallback_api_keys);
    let usage = run(provider, script, &vars).await?;
    Ok(envelope(usage))
}

/// Run a script against a provider, end to end.
pub(super) async fn run(
    provider: &Provider,
    script: &str,
    vars: &ScriptVars,
) -> Result<AccountUsage, String> {
    let limits = ScriptLimits::default();
    let request = query_script::resolve_request(script, vars, &limits)
        .map_err(|error| error.message().to_string())?;
    ensure_query_credentials(&request)?;
    query_script::is_permitted_target(&request.url, &provider.base_url)?;

    let response = send(provider, &request).await?;
    query_script::run_extractor(script, vars, &response, &limits)
        .map_err(|error| error.message().to_string())
}

fn ensure_query_credentials(request: &ScriptRequest) -> Result<(), String> {
    for (placeholder, message) in [
        ("{{apiKey}}", "添加并启用 API 密钥后可查询额度"),
        ("{{accessToken}}", "请先配置账户访问令牌"),
        ("{{userId}}", "请先配置账户用户 ID"),
    ] {
        if request.url.contains(placeholder)
            || request
                .headers
                .values()
                .any(|value| value.contains(placeholder))
        {
            return Err(message.to_string());
        }
    }
    Ok(())
}

async fn send(provider: &Provider, request: &ScriptRequest) -> Result<Value, String> {
    let mut outgoing = crate::services::http_client::outbound_client_for_provider(Some(provider))?
        .get(&request.url)
        .header("Content-Type", "application/json");
    for (name, value) in &request.headers {
        outgoing = outgoing.header(name, value);
    }

    let response = outgoing.send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }

    response.json().await.map_err(|e| e.to_string())
}

/// The values a script may reference.
pub(super) fn vars_for(provider: &Provider, fallback_api_keys: &[ApiKey]) -> ScriptVars {
    ScriptVars {
        base_url: provider.base_url.trim_end_matches('/').to_string(),
        // The inference credential, borrowed so a query can authenticate as the
        // account it is asking about.
        api_key: pick_first_available_key(fallback_api_keys)
            .or_else(|| non_empty(provider.token.clone())),
        access_token: non_empty(provider.token.clone()),
        user_id: non_empty(provider.wallet_balance_user_id.clone()),
    }
}

fn envelope(usage: AccountUsage) -> Value {
    serde_json::json!({
        "balance": usage.remaining,
        "total": usage.total,
        "used": usage.used,
        "unlimited": usage.is_unlimited.unwrap_or(false),
        "currency": usage.unit,
        "windows": usage.windows,
        "isValid": usage.is_valid.unwrap_or(true),
        "invalidMessage": usage.invalid_message,
        "error": Value::Null,
    })
}

pub(super) fn not_configured() -> Value {
    serde_json::json!({
        "balance": Value::Null,
        "total": Value::Null,
        "used": Value::Null,
        "unlimited": false,
        "currency": Value::Null,
        "windows": Vec::<Value>::new(),
        "isValid": true,
        "invalidMessage": Value::Null,
        "error": "尚未配置账户查询",
    })
}

fn non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// The credential a query borrows when it names none of its own.
pub(super) fn pick_first_available_key(api_keys: &[ApiKey]) -> Option<String> {
    api_keys
        .iter()
        .filter(|key| key.is_active && !key.is_exhausted && !key.value.trim().is_empty())
        .min_by_key(|key| key.priority)
        .map(|key| key.value.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Provider;

    #[tokio::test]
    async fn a_query_without_its_required_key_stops_before_network_io() {
        let mut provider = provider();
        provider.token = None;
        provider.wallet_balance_script = Some(
            "({request:{url:'{{baseUrl}}/usage',headers:{Authorization:'Bearer {{apiKey}}'}},extractor:r=>({remaining:r.balance})})".into(),
        );
        let error = refresh_balance(&provider, &[]).await.unwrap_err();
        assert_eq!(error, "添加并启用 API 密钥后可查询额度");
    }

    #[test]
    fn an_account_token_query_does_not_require_an_inference_key() {
        let request = query_script::resolve_request(
            "({request:{url:'{{baseUrl}}/usage',headers:{Authorization:'{{accessToken}}'}},extractor:r=>({remaining:r.balance})})",
            &ScriptVars { base_url: "https://example.com".into(), access_token: Some("fixture".into()), ..Default::default() },
            &ScriptLimits::default(),
        ).unwrap();
        assert!(ensure_query_credentials(&request).is_ok());
    }

    fn provider() -> Provider {
        Provider {
            id: "p1".to_string(),
            name: "relay".to_string(),
            base_url: "https://relay.example.com".to_string(),
            http_proxy: None,
            website: None,
            remark: None,
            token: Some("tok-1".to_string()),
            icon: None,
            wallet_balance_type: "custom".to_string(),
            wallet_balance_url: None,
            wallet_balance_path: None,
            wallet_balance_headers: None,
            wallet_balance_user_id: Some("uid-7".to_string()),
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
            wallet_balance_script: None,
            request_headers: None,
        }
    }

    fn key(value: &str, priority: i64) -> ApiKey {
        serde_json::from_value(serde_json::json!({
            "id": format!("k-{value}"),
            "providerId": "p1",
            "value": value,
            "priority": priority,
            "types": ["claude_code"],
            "isExhausted": false,
            "isActive": true,
            "usageType": "none"
        }))
        .expect("key fixture")
    }

    #[test]
    fn a_provider_without_a_script_says_so_instead_of_failing() {
        let envelope = not_configured();

        assert_eq!(envelope["error"], "尚未配置账户查询");
        assert!(envelope["balance"].is_null());
    }

    #[test]
    fn the_variables_name_the_credential_the_query_borrows() {
        let vars = vars_for(&provider(), &[key("sk-live", 0)]);

        assert_eq!(vars.base_url, "https://relay.example.com");
        assert_eq!(vars.api_key.as_deref(), Some("sk-live"));
        assert_eq!(vars.access_token.as_deref(), Some("tok-1"));
        assert_eq!(vars.user_id.as_deref(), Some("uid-7"));
    }

    #[test]
    fn the_lowest_priority_available_key_is_the_one_borrowed() {
        let mut exhausted = key("sk-dead", 0);
        exhausted.is_exhausted = true;

        let vars = vars_for(&provider(), &[exhausted, key("sk-live", 5)]);

        assert_eq!(vars.api_key.as_deref(), Some("sk-live"));
    }

    /// The envelope keeps the names the card reads, and adds the metered
    /// periods beside them.
    #[test]
    fn the_envelope_carries_a_balance_and_its_periods_together() {
        let envelope = envelope(AccountUsage {
            remaining: Some(12.5),
            unit: Some("USD".to_string()),
            ..AccountUsage::default()
        });

        assert_eq!(envelope["balance"], 12.5);
        assert_eq!(envelope["currency"], "USD");
        assert!(envelope["error"].is_null());
    }
}
