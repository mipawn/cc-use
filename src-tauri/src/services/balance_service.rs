use crate::models::{ApiKey, Provider};
use serde_json::Value;

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
            "error": "Balance checking not configured",
        })),
        "newapi" => fetch_newapi_balance(provider, fallback_api_keys).await,
        "custom" => fetch_custom_balance(provider).await,
        _ => Err("Unknown balance type".to_string()),
    }
}

async fn fetch_newapi_balance(
    provider: &Provider,
    fallback_api_keys: &[ApiKey],
) -> Result<serde_json::Value, String> {
    let base_url = provider.base_url.trim_end_matches('/');
    let client = reqwest::Client::new();

    if let (Some(token), Some(user_id)) = (
        provider.token.as_deref().filter(|s| !s.trim().is_empty()),
        provider
            .wallet_balance_user_id
            .as_deref()
            .filter(|s| !s.trim().is_empty()),
    ) {
        if let Some(result) = fetch_newapi_balance_via_user_api(&client, base_url, token, user_id).await?
        {
            return Ok(result);
        }
    }

    let key_token = pick_first_available_key(fallback_api_keys)
        .or_else(|| provider.token.as_deref().map(str::to_string))
        .ok_or_else(|| "No available API keys".to_string())?;

    fetch_newapi_balance_via_billing_api(&client, base_url, &key_token).await
}

async fn fetch_newapi_balance_via_user_api(
    client: &reqwest::Client,
    base_url: &str,
    access_token: &str,
    user_id: &str,
) -> Result<Option<serde_json::Value>, String> {
    let url = format!("{}/api/user/self", base_url);
    let resp = client
        .get(&url)
        .header("Authorization", access_token)
        .header("New-Api-User", user_id)
        .header("Content-Type", "application/json")
        .send()
        .await
        .map_err(|e| e.to_string())?;

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
        "error": null,
    }))
}

async fn fetch_custom_balance(provider: &Provider) -> Result<serde_json::Value, String> {
    let url = provider
        .wallet_balance_url
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "Custom balance URL not configured".to_string())?;
    let path = provider
        .wallet_balance_path
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "Custom balance path not configured".to_string())?;

    let client = reqwest::Client::new();
    let mut req = client.get(url).header("Content-Type", "application/json");

    if let Some(headers_str) = provider.wallet_balance_headers.as_deref() {
        for (k, v) in parse_headers(headers_str)? {
            req = req.header(k, v);
        }
    }

    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }

    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let raw = extract_json_path(&body, path)
        .ok_or_else(|| format!("Invalid balance value at path: {}", path))?;
    let balance = to_number(Some(raw))
        .ok_or_else(|| format!("Invalid balance value at path: {}", path))?;

    Ok(serde_json::json!({
        "balance": balance,
        "total": null,
        "used": null,
        "unlimited": false,
        "error": null,
    }))
}

fn parse_headers(raw: &str) -> Result<Vec<(String, String)>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    let value: serde_json::Value = serde_json::from_str(trimmed)
        .map_err(|_| "Invalid headers JSON format".to_string())?;
    let obj = value
        .as_object()
        .ok_or_else(|| "Invalid headers JSON format".to_string())?;

    Ok(obj
        .iter()
        .filter_map(|(k, v)| v.as_str().map(|vv| (k.clone(), vv.to_string())))
        .collect())
}

fn pick_first_available_key(api_keys: &[ApiKey]) -> Option<String> {
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
