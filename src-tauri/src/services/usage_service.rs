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
        "isUnlimited": to_bool(data.get("unlimited_quota"))
            .or(to_bool(data.get("is_unlimited")))
            .or(to_bool(data.get("isUnlimited")))
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

    let usage = resolve_custom_path(&body, path)?;

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
        "total": to_number(data.get("total_granted")).or_else(|| to_number(data.get("total"))),
        "used": to_number(data.get("total_used")).or_else(|| to_number(data.get("used"))),
        "remaining": to_number(data.get("total_available"))
            .or_else(|| to_number(data.get("remaining")))
            .or_else(|| to_number(data.get("available"))),
        "unit": "USD",
        "isUnlimited": to_bool(data.get("unlimited_quota"))
            .or(to_bool(data.get("is_unlimited")))
            .or(to_bool(data.get("isUnlimited")))
            .unwrap_or(false),
        "expireAt": null,
    });

    if let Some(ts) = to_i64(data.get("expires_at")).or_else(|| to_i64(data.get("expire_time"))) {
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

    let usage = resolve_custom_path(&body, usage_path)?;

    Ok(serde_json::json!({
        "usage": usage,
        "error": null,
    }))
}

/// Resolve custom usage path — supports two formats:
/// 1. Single path string (legacy): `"data.total_available"` → extracts as `remaining`
/// 2. JSON path map: `{"remaining": "data.total_available", "total": "data.total_granted", ...}`
///    Supported keys: remaining, total, used, unit, isUnlimited, expireAt
fn resolve_custom_path(body: &Value, path: &str) -> Result<Value, String> {
    // Try parsing as JSON map first
    if let Ok(map) = serde_json::from_str::<std::collections::HashMap<String, String>>(path) {
        let mut usage = serde_json::json!({
            "unit": "USD",
            "isUnlimited": false,
            "expireAt": null,
        });

        for (key, json_path) in &map {
            let val = extract_json_path(body, json_path);
            match key.as_str() {
                "remaining" => {
                    if let Some(n) = to_number(val) {
                        usage["remaining"] = serde_json::json!(n);
                    }
                }
                "total" => {
                    if let Some(n) = to_number(val) {
                        usage["total"] = serde_json::json!(n);
                    }
                }
                "used" => {
                    if let Some(n) = to_number(val) {
                        usage["used"] = serde_json::json!(n);
                    }
                }
                "unit" => {
                    if let Some(s) = val.and_then(|v| v.as_str()) {
                        usage["unit"] = Value::String(s.to_string());
                    }
                }
                "isUnlimited" => {
                    if let Some(b) = to_bool(val) {
                        usage["isUnlimited"] = serde_json::json!(b);
                    }
                }
                "expireAt" => {
                    if let Some(ts) = val.and_then(|v| v.as_i64()) {
                        usage["expireAt"] = Value::String(epoch_to_iso(ts));
                    } else if let Some(s) = val.and_then(|v| v.as_str()) {
                        usage["expireAt"] = Value::String(s.to_string());
                    }
                }
                _ => {} // ignore unknown keys
            }
        }

        return Ok(usage);
    }

    // Legacy single-path mode: extract a single numeric value as remaining
    let value = extract_json_path(body, path)
        .ok_or_else(|| format!("No value found at path: {}", path))?;

    // If the extracted value is an object, try to read structured fields from it
    if let Some(obj) = value.as_object() {
        let mut usage = serde_json::json!({
            "total": to_number(obj.get("total")).or_else(|| to_number(obj.get("total_granted"))),
            "used": to_number(obj.get("used")).or_else(|| to_number(obj.get("total_used"))),
            "remaining": to_number(obj.get("remaining"))
                .or_else(|| to_number(obj.get("total_available")))
                .or_else(|| to_number(obj.get("available"))),
            "unit": obj.get("unit").and_then(|v| v.as_str()).unwrap_or("USD"),
            "isUnlimited": to_bool(obj.get("unlimited_quota"))
                .or(to_bool(obj.get("is_unlimited")))
                .or(to_bool(obj.get("isUnlimited")))
                .unwrap_or(false),
            "expireAt": null,
        });

        if let Some(ts) = to_i64(obj.get("expire_time")) {
            usage["expireAt"] = Value::String(epoch_to_iso(ts));
        } else if let Some(expire_at) = obj
            .get("expireAt")
            .and_then(|v| v.as_str())
            .or_else(|| obj.get("expire_at").and_then(|v| v.as_str()))
        {
            usage["expireAt"] = Value::String(expire_at.to_string());
        }

        return Ok(usage);
    }

    // Scalar value — treat as remaining
    let remaining = to_number(Some(value))
        .ok_or_else(|| format!("No numeric value found at path: {}", path))?;

    Ok(serde_json::json!({
        "remaining": remaining,
        "unit": "USD",
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

/// Parse a JSON value as bool, handling bool / number (1=true) / string ("true")
fn to_bool(v: Option<&Value>) -> Option<bool> {
    match v {
        Some(Value::Bool(b)) => Some(*b),
        Some(Value::Number(n)) => n.as_i64().map(|i| i != 0),
        Some(Value::String(s)) => match s.trim().to_lowercase().as_str() {
            "true" | "1" => Some(true),
            "false" | "0" => Some(false),
            _ => None,
        },
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
