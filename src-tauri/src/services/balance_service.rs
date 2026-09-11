use crate::models::{ApiKey, Provider};
use serde_json::Value;

use super::query_request::{has_stored, resolve_headers, stored_or, substitute, QueryVars};
use crate::shared_runtime::provider_presets::query_defaults;

const QUOTA_PER_UNIT: f64 = 500000.0;
const UNLIMITED_THRESHOLD: f64 = 99_999_999.0;

pub async fn refresh_balance(
    provider: &Provider,
    fallback_api_keys: &[ApiKey],
) -> Result<serde_json::Value, String> {
    match provider.wallet_balance_type.as_str() {
        "none" => Ok(serde_json::json!({
            "balance": null,
            "total": null,
            "used": null,
            "unlimited": false,
            "currency": null,
            "error": "Balance checking not configured",
        })),
        "newapi" => fetch_newapi_balance(provider, fallback_api_keys).await,
        "custom" => fetch_custom_balance(provider, fallback_api_keys).await,
        "deepseek" => fetch_deepseek_balance(provider, fallback_api_keys).await,
        _ => Err("Unknown balance type".to_string()),
    }
}

async fn fetch_newapi_balance(
    provider: &Provider,
    fallback_api_keys: &[ApiKey],
) -> Result<serde_json::Value, String> {
    let borrowed_key = pick_first_available_key(fallback_api_keys);
    let vars = QueryVars::for_provider(provider, borrowed_key.as_deref());
    let client = crate::services::http_client::outbound_client_for_provider(Some(provider))?;
    let own_url = provider.wallet_balance_url.as_deref();

    // The account endpoint reads a named account, so it needs a user id. With
    // none, the key-scoped billing routes are the only thing left to ask.
    if vars.user_id.is_some() {
        let url = substitute(
            stored_or(own_url, query_defaults::NEWAPI_ACCOUNT_URL),
            &vars,
        );
        let headers = resolve_headers(
            provider.wallet_balance_headers.as_deref(),
            query_defaults::NEWAPI_ACCOUNT_HEADERS,
            &vars,
        )?;

        if let Some(result) = fetch_newapi_balance_via_user_api(&client, &url, &headers).await? {
            return Ok(result);
        }

        // A hand-written address is the user's own answer. Falling back to the
        // vendor's billing routes would query an endpoint they never named.
        if has_stored(own_url) {
            return Err(format!(
                "Account balance endpoint returned no usable data: {}",
                url
            ));
        }
    }

    let key_token = borrowed_key
        .or_else(|| provider.token.as_deref().map(str::to_string))
        .ok_or_else(|| "No available API keys".to_string())?;

    fetch_newapi_balance_via_billing_api(&client, &vars.base_url, &key_token).await
}

async fn fetch_newapi_balance_via_user_api(
    client: &reqwest::Client,
    url: &str,
    headers: &[(String, String)],
) -> Result<Option<serde_json::Value>, String> {
    let mut request = client.get(url).header("Content-Type", "application/json");
    for (name, value) in headers {
        request = request.header(name, value);
    }

    let resp = request.send().await.map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Ok(None);
    }

    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let data = match body.get("data") {
        Some(d) => d,
        None => return Ok(None),
    };

    let remain_quota = to_number(data.get("quota")).unwrap_or(0.0);
    let used_quota = to_number(data.get("used_quota")).unwrap_or(0.0);
    let total_quota = remain_quota + used_quota;

    let balance = remain_quota / QUOTA_PER_UNIT;
    let used = used_quota / QUOTA_PER_UNIT;
    let total = total_quota / QUOTA_PER_UNIT;

    Ok(Some(serde_json::json!({
        "balance": round2(balance),
        "total": round2(total),
        "used": round2(used),
        "unlimited": false,
        // New API quotes quota in dollars; QUOTA_PER_UNIT is the conversion
        // this branch applies, so the unit is known here rather than assumed
        // by the renderer.
        "currency": "USD",
        "error": null,
    })))
}

async fn fetch_newapi_balance_via_billing_api(
    client: &reqwest::Client,
    base_url: &str,
    api_key: &str,
) -> Result<serde_json::Value, String> {
    let subscription_url = format!("{}/dashboard/billing/subscription", base_url);
    let subscription_resp = client
        .get(&subscription_url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !subscription_resp.status().is_success() {
        return Err(format!(
            "Subscription HTTP {}",
            subscription_resp.status().as_u16()
        ));
    }

    let subscription_data: serde_json::Value =
        subscription_resp.json().await.map_err(|e| e.to_string())?;
    let hard_limit = to_number(subscription_data.get("hard_limit_usd"))
        .or_else(|| to_number(subscription_data.get("system_hard_limit_usd")))
        .unwrap_or(0.0);

    let usage_url = format!("{}/dashboard/billing/usage", base_url);
    let usage_resp = client
        .get(&usage_url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !usage_resp.status().is_success() {
        return Err(format!("Usage HTTP {}", usage_resp.status().as_u16()));
    }

    let usage_data: serde_json::Value = usage_resp.json().await.map_err(|e| e.to_string())?;
    let raw_usage = to_number(usage_data.get("total_usage")).unwrap_or(0.0);
    let total_usage =
        if hard_limit > 0.0 && hard_limit < UNLIMITED_THRESHOLD && raw_usage > hard_limit * 2.0 {
            raw_usage / 100.0
        } else {
            raw_usage
        };

    let unlimited = hard_limit >= UNLIMITED_THRESHOLD;
    let (balance, total) = if unlimited {
        (total_usage, None)
    } else {
        (hard_limit - total_usage, Some(hard_limit))
    };

    if !balance.is_finite() {
        return Err("Invalid balance response format".to_string());
    }

    Ok(serde_json::json!({
        "balance": round2(balance),
        "total": total.map(round2),
        "used": round2(total_usage),
        "unlimited": unlimited,
        // Same dollar-based quota as the account endpoints above.
        "currency": "USD",
        "error": null,
    }))
}

async fn fetch_custom_balance(
    provider: &Provider,
    fallback_api_keys: &[ApiKey],
) -> Result<serde_json::Value, String> {
    let Some(raw_url) = provider
        .wallet_balance_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Err("Custom balance URL not configured".to_string());
    };
    let path = provider
        .wallet_balance_path
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "Custom balance path not configured".to_string())?;

    // The balance dialog documents `{key}`, so it has to resolve here too; the
    // key it names is the same one the other branches borrow.
    let borrowed_key = pick_first_available_key(fallback_api_keys);
    let vars = QueryVars::for_provider(provider, borrowed_key.as_deref());
    let url = substitute(raw_url, &vars);

    let client = crate::services::http_client::outbound_client_for_provider(Some(provider))?;
    let mut req = client.get(&url).header("Content-Type", "application/json");

    let headers = resolve_headers(provider.wallet_balance_headers.as_deref(), "{}", &vars)?;
    for (name, value) in &headers {
        req = req.header(name, value);
    }

    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }

    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let raw = extract_json_path(&body, path)
        .ok_or_else(|| format!("Invalid balance value at path: {}", path))?;
    let balance =
        to_number(Some(raw)).ok_or_else(|| format!("Invalid balance value at path: {}", path))?;

    Ok(serde_json::json!({
        "balance": balance,
        "total": null,
        "used": null,
        "unlimited": false,
        // A user-supplied endpoint gives no unit, so the UI shows the number
        // without claiming one.
        "currency": null,
        "error": null,
    }))
}

async fn fetch_deepseek_balance(
    provider: &Provider,
    fallback_api_keys: &[ApiKey],
) -> Result<serde_json::Value, String> {
    let api_key = pick_first_available_key(fallback_api_keys)
        .ok_or_else(|| "No available API keys for DeepSeek balance check".to_string())?;

    let client = crate::services::http_client::outbound_client_for_provider(Some(provider))?;
    let vars = QueryVars::for_provider(provider, Some(api_key.as_str()));
    // The saved request wins. It is visible and editable in the provider's
    // settings, so a provider pointed at a relay never has its key sent back to
    // the vendor endpoint; an empty value means "use the documented official
    // one". `{key}` is the key being borrowed for this check.
    let url = substitute(
        stored_or(
            provider.wallet_balance_url.as_deref(),
            query_defaults::DEEPSEEK_BALANCE_URL,
        ),
        &vars,
    );
    let headers = resolve_headers(
        provider.wallet_balance_headers.as_deref(),
        query_defaults::DEEPSEEK_BALANCE_HEADERS,
        &vars,
    )?;

    let mut request = client.get(&url).header("Content-Type", "application/json");
    for (name, value) in &headers {
        request = request.header(name, value);
    }
    let resp = request.send().await.map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }

    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    parse_deepseek_balance_response(&body)
}

pub fn parse_deepseek_balance_response(
    body: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let is_available = body
        .get("is_available")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if !is_available {
        // "Not available" is not the same fact as "zero": reporting 0 would
        // claim the account is empty.
        return Err("DeepSeek reports the account balance is not available".to_string());
    }

    let balance_infos = body.get("balance_infos").and_then(|v| v.as_array());

    let balance_obj = balance_infos.and_then(|arr| {
        arr.iter()
            .find(|v| v.get("currency").and_then(|c| c.as_str()) == Some("CNY"))
            .or_else(|| arr.first())
    });

    let Some(entry) = balance_obj else {
        return Err("DeepSeek response did not include any balance entry".to_string());
    };

    let total_balance = to_number(entry.get("total_balance"));
    let Some(balance) = total_balance else {
        return Err("DeepSeek balance entry had no total_balance".to_string());
    };

    Ok(serde_json::json!({
        "balance": round2(balance),
        // DeepSeek bills in CNY; the response states the currency and the UI
        // renders that rather than assuming dollars.
        "currency": entry.get("currency").and_then(|c| c.as_str()),
        "total": null,
        "used": null,
        "unlimited": false,
        "error": null,
    }))
}

pub(super) fn pick_first_available_key(api_keys: &[ApiKey]) -> Option<String> {
    api_keys
        .iter()
        .filter(|k| k.is_active && !k.is_exhausted && !k.value.trim().is_empty())
        .min_by_key(|k| k.priority)
        .map(|k| k.value.clone())
}

fn to_number(v: Option<&Value>) -> Option<f64> {
    match v {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => s.trim().parse::<f64>().ok(),
        _ => None,
    }
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

#[derive(Debug)]
enum PathToken {
    Key(String),
    Index(usize),
}

fn extract_json_path<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    let tokens = parse_path(path);
    if tokens.is_empty() {
        return Some(value);
    }

    let mut current = value;
    for token in tokens {
        match token {
            PathToken::Key(k) => current = current.get(&k)?,
            PathToken::Index(i) => current = current.get(i)?,
        }
    }
    Some(current)
}

fn parse_path(path: &str) -> Vec<PathToken> {
    let mut src = path.trim();
    if let Some(rest) = src.strip_prefix('$') {
        src = rest;
    }
    if let Some(rest) = src.strip_prefix('.') {
        src = rest;
    }
    if src.is_empty() {
        return Vec::new();
    }

    let mut out = Vec::new();
    let chars: Vec<char> = src.chars().collect();
    let mut i = 0usize;
    let mut key_buf = String::new();

    while i < chars.len() {
        match chars[i] {
            '.' => {
                if !key_buf.is_empty() {
                    out.push(PathToken::Key(std::mem::take(&mut key_buf)));
                }
                i += 1;
            }
            '[' => {
                if !key_buf.is_empty() {
                    out.push(PathToken::Key(std::mem::take(&mut key_buf)));
                }
                i += 1;
                let mut inner = String::new();
                while i < chars.len() && chars[i] != ']' {
                    inner.push(chars[i]);
                    i += 1;
                }
                if i < chars.len() && chars[i] == ']' {
                    i += 1;
                }
                let inner = inner.trim().trim_matches('"').trim_matches('\'');
                if let Ok(idx) = inner.parse::<usize>() {
                    out.push(PathToken::Index(idx));
                } else if !inner.is_empty() {
                    out.push(PathToken::Key(inner.to_string()));
                }
            }
            c => {
                key_buf.push(c);
                i += 1;
            }
        }
    }
    if !key_buf.is_empty() {
        out.push(PathToken::Key(key_buf));
    }
    out
}
