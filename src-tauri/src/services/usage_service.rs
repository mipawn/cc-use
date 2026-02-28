use crate::models::{ApiKey, Provider};
use serde_json::Value;

pub async fn refresh_usage(
    provider: &Provider,
    fallback_api_keys: &[ApiKey],
) -> Result<serde_json::Value, String> {
    match provider.usage_type.as_str() {
        "none" => Ok(serde_json::json!({
            "usage": null,
            "error": "Usage checking not configured",
        })),
        "newapi" => fetch_newapi_usage(provider, fallback_api_keys).await,
        "custom" => fetch_custom_usage(provider).await,
        _ => Err("Unknown usage type".to_string()),
    }
}

pub async fn refresh_key_usage(
    key: &ApiKey,
    provider_base_url: &str,
) -> Result<serde_json::Value, String> {
    match key.usage_type.as_str() {
        "none" => Ok(serde_json::json!({
            "usage": null,
            "error": "Usage checking not configured",
        })),
        "newapi" => fetch_newapi_key_usage(provider_base_url, &key.value).await,
        "custom" => fetch_custom_key_usage(key, provider_base_url).await,
        _ => Err("Unknown usage type".to_string()),
    }
}

async fn fetch_newapi_usage(
    provider: &Provider,
    fallback_api_keys: &[ApiKey],
) -> Result<serde_json::Value, String> {
    let token = provider
        .token
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string)
        .or_else(|| pick_first_available_key(fallback_api_keys))
        .ok_or_else(|| "No available token for usage query".to_string())?;

    let url = format!("{}/api/usage/token", provider.base_url.trim_end_matches('/'));
    let resp = reqwest::Client::new()
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}: {}", resp.status().as_u16(), resp.status()));
    }

    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let data = json.get("data").unwrap_or(&json);

    let mut usage = serde_json::json!({
        "total": to_number(data.get("total_granted")).or_else(|| to_number(data.get("total"))),
        "used": to_number(data.get("total_used")).or_else(|| to_number(data.get("used"))),
        "remaining": to_number(data.get("total_available"))
            .or_else(|| to_number(data.get("remaining")))
            .or_else(|| to_number(data.get("available"))),
        "unit": data.get("unit").and_then(|v| v.as_str()).unwrap_or("USD"),
        "isUnlimited": data.get("is_unlimited").and_then(|v| v.as_bool())
            .or_else(|| data.get("isUnlimited").and_then(|v| v.as_bool()))
            .unwrap_or(false),
        "expireAt": null,
    });

    if let Some(ts) = to_i64(data.get("expire_time")) {
        usage["expireAt"] = Value::String(epoch_to_iso(ts));
    } else if let Some(expire_at) = data.get("expireAt").and_then(|v| v.as_str()) {
        usage["expireAt"] = Value::String(expire_at.to_string());
    }

    Ok(serde_json::json!({
        "usage": usage,
        "error": null,
    }))
}

async fn fetch_custom_usage(provider: &Provider) -> Result<serde_json::Value, String> {
    let url = provider
        .usage_url
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "Custom usage URL not configured".to_string())?;
    let path = provider
        .usage_path
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "Custom usage path not configured".to_string())?;

    let mut req = reqwest::Client::new()
        .get(url)
        .header("Content-Type", "application/json");

    if let Some(headers_str) = provider.usage_headers.as_deref() {
        for (k, v) in parse_headers(headers_str)? {
            req = req.header(k, v);
        }
    }

    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}: {}", resp.status().as_u16(), resp.status()));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

    let usage_value = extract_json_path(&body, path)
        .ok_or_else(|| format!("Invalid usage data at path: {}", path))?;
    let usage_obj = usage_value
        .as_object()
        .ok_or_else(|| format!("Invalid usage data at path: {}", path))?;

    let mut usage = serde_json::json!({
        "total": to_number(usage_obj.get("total")).or_else(|| to_number(usage_obj.get("total_granted"))),
        "used": to_number(usage_obj.get("used")).or_else(|| to_number(usage_obj.get("total_used"))),
        "remaining": to_number(usage_obj.get("remaining"))
            .or_else(|| to_number(usage_obj.get("total_available")))
            .or_else(|| to_number(usage_obj.get("available"))),
        "unit": usage_obj.get("unit").and_then(|v| v.as_str()).unwrap_or("USD"),
        "isUnlimited": usage_obj.get("is_unlimited").and_then(|v| v.as_bool())
            .or_else(|| usage_obj.get("isUnlimited").and_then(|v| v.as_bool()))
            .unwrap_or(false),
        "expireAt": null,
    });

    if let Some(ts) = to_i64(usage_obj.get("expire_time")) {
        usage["expireAt"] = Value::String(epoch_to_iso(ts));
    } else if let Some(expire_at) = usage_obj
        .get("expireAt")
        .and_then(|v| v.as_str())
        .or_else(|| usage_obj.get("expire_at").and_then(|v| v.as_str()))
    {
        usage["expireAt"] = Value::String(expire_at.to_string());
    }

    Ok(serde_json::json!({
        "usage": usage,
        "error": null,
    }))
}

async fn fetch_newapi_key_usage(
    provider_base_url: &str,
    key_value: &str,
) -> Result<serde_json::Value, String> {
    let url = format!("{}/api/usage/token/", provider_base_url.trim_end_matches('/'));
    let resp = reqwest::Client::new()
        .get(&url)
        .header("Authorization", format!("Bearer {}", key_value))
        .header("Content-Type", "application/json")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}: {}", resp.status().as_u16(), resp.status()));
    }

    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let data = json.get("data").unwrap_or(&json);

    let mut usage = serde_json::json!({
        "total": to_number(data.get("total_granted")),
        "used": to_number(data.get("total_used")),
        "remaining": to_number(data.get("total_available")),
        "unit": "USD",
        "isUnlimited": data.get("unlimited_quota").and_then(|v| v.as_bool()).unwrap_or(false),
        "expireAt": null,
    });

    if let Some(ts) = to_i64(data.get("expires_at")) {
        usage["expireAt"] = Value::String(epoch_to_iso(ts));
    }

    Ok(serde_json::json!({
        "usage": usage,
        "error": null,
    }))
}

async fn fetch_custom_key_usage(
    key: &ApiKey,
    provider_base_url: &str,
) -> Result<serde_json::Value, String> {
    let usage_url = key
        .usage_url
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "Custom usage URL not configured".to_string())?;
    let usage_path = key
        .usage_path
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "Custom usage path not configured".to_string())?;

    let base_url = provider_base_url.trim_end_matches('/');
    let resolved_url = usage_url
        .replace("{baseUrl}", base_url)
        .replace("{key}", &key.value);

    let mut req = reqwest::Client::new()
        .get(&resolved_url)
        .header("Content-Type", "application/json");

    if let Some(headers_raw) = key.usage_headers.as_deref() {
        let resolved_headers = headers_raw
            .replace("{baseUrl}", base_url)
            .replace("{key}", &key.value);
        for (k, v) in parse_headers(&resolved_headers)? {
            req = req.header(k, v);
        }
    }

    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}: {}", resp.status().as_u16(), resp.status()));
    }

    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let value = extract_json_path(&body, usage_path)
        .ok_or_else(|| format!("No value found at path: {}", usage_path))?;
    let remaining = to_number(Some(value))
        .ok_or_else(|| format!("No value found at path: {}", usage_path))?;

    Ok(serde_json::json!({
        "usage": {
            "remaining": remaining,
            "unit": "USD",
        },
        "error": null,
    }))
}

fn pick_first_available_key(api_keys: &[ApiKey]) -> Option<String> {
    api_keys
        .iter()
        .filter(|k| k.is_active && !k.is_exhausted && !k.value.trim().is_empty())
        .min_by_key(|k| k.priority)
        .map(|k| k.value.clone())
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

fn to_number(v: Option<&Value>) -> Option<f64> {
    match v {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => s.trim().parse::<f64>().ok(),
        _ => None,
    }
}

fn to_i64(v: Option<&Value>) -> Option<i64> {
    match v {
        Some(Value::Number(n)) => n.as_i64(),
        Some(Value::String(s)) => s.trim().parse::<i64>().ok(),
        _ => None,
    }
}

fn epoch_to_iso(ts: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp(ts, 0)
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339())
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
