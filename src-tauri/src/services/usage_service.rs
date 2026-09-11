use crate::models::{ApiKey, Provider};
use serde_json::Value;

use super::query_request::{resolve_headers, stored_or, substitute, QueryVars};
use crate::shared_runtime::provider_presets::query_defaults;

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
        "custom" => fetch_custom_usage(provider, fallback_api_keys).await,
        "opencode-go" => fetch_opencode_go_usage(provider, fallback_api_keys).await,
        _ => Err("Unknown usage type".to_string()),
    }
}

pub async fn refresh_key_usage(
    key: &ApiKey,
    provider: &Provider,
) -> Result<serde_json::Value, String> {
    match key.usage_type.as_str() {
        "none" => Ok(serde_json::json!({
            "usage": null,
            "error": "Usage checking not configured",
        })),
        "newapi" => fetch_newapi_key_usage(key, provider).await,
        "custom" => fetch_custom_key_usage(key, provider).await,
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

    let vars = QueryVars::for_provider(provider, Some(token.as_str()));
    let url = substitute(
        stored_or(
            provider.usage_url.as_deref(),
            query_defaults::NEWAPI_USAGE_URL,
        ),
        &vars,
    );
    let headers = resolve_headers(
        provider.usage_headers.as_deref(),
        query_defaults::NEWAPI_USAGE_HEADERS,
        &vars,
    )?;

    let mut request = crate::services::http_client::outbound_client_for_provider(Some(provider))?
        .get(&url)
        .header("Content-Type", "application/json");
    for (name, value) in &headers {
        request = request.header(name, value);
    }

    let resp = request.send().await.map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!(
            "HTTP {}: {}",
            resp.status().as_u16(),
            resp.status()
        ));
    }

    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let data = json.get("data").unwrap_or(&json);

    let mut usage = serde_json::json!({
        "total": to_number(data.get("total_granted")).or_else(|| to_number(data.get("total"))),
        "used": to_number(data.get("total_used")).or_else(|| to_number(data.get("used"))),
        "remaining": to_number(data.get("total_available"))
            .or_else(|| to_number(data.get("remaining")))
            .or_else(|| to_number(data.get("available"))),
        // New API quota is converted with the documented per-unit rate, so the
        // unit is known here; an explicit `unit` in the response still wins.
        "unit": data
            .get("unit")
            .and_then(|v| v.as_str())
            .unwrap_or("USD"),
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

async fn fetch_custom_usage(
    provider: &Provider,
    fallback_api_keys: &[ApiKey],
) -> Result<serde_json::Value, String> {
    let Some(raw_url) = provider
        .usage_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Err("Custom usage URL not configured".to_string());
    };
    let path = provider
        .usage_path
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "Custom usage path not configured".to_string())?;

    // The dialog documents `{baseUrl}` and `{key}`; both have to resolve here,
    // which they previously did not for a provider-level query.
    let borrowed_key = super::balance_service::pick_first_available_key(fallback_api_keys);
    let vars = QueryVars::for_provider(provider, borrowed_key.as_deref());
    let url = substitute(raw_url, &vars);

    let mut req = crate::services::http_client::outbound_client_for_provider(Some(provider))?
        .get(&url)
        .header("Content-Type", "application/json");

    let headers = resolve_headers(provider.usage_headers.as_deref(), "{}", &vars)?;
    for (name, value) in &headers {
        req = req.header(name, value);
    }

    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!(
            "HTTP {}: {}",
            resp.status().as_u16(),
            resp.status()
        ));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

    let usage = resolve_custom_path(&body, path)?;

    Ok(serde_json::json!({
        "usage": usage,
        "error": null,
    }))
}

async fn fetch_newapi_key_usage(
    key: &ApiKey,
    provider: &Provider,
) -> Result<serde_json::Value, String> {
    let vars = QueryVars::for_key(key, provider);
    let url = substitute(
        stored_or(
            key.usage_url.as_deref(),
            query_defaults::NEWAPI_KEY_USAGE_URL,
        ),
        &vars,
    );
    let headers = resolve_headers(
        key.usage_headers.as_deref(),
        query_defaults::NEWAPI_USAGE_HEADERS,
        &vars,
    )?;

    let mut request = crate::services::http_client::outbound_client_for_provider(Some(provider))?
        .get(&url)
        .header("Content-Type", "application/json");
    for (name, value) in &headers {
        request = request.header(name, value);
    }

    let resp = request.send().await.map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!(
            "HTTP {}: {}",
            resp.status().as_u16(),
            resp.status()
        ));
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
    provider: &Provider,
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

    let vars = QueryVars::for_key(key, provider);
    let resolved_url = substitute(usage_url, &vars);

    let mut req = crate::services::http_client::outbound_client_for_provider(Some(provider))?
        .get(&resolved_url)
        .header("Content-Type", "application/json");

    let headers = resolve_headers(key.usage_headers.as_deref(), "{}", &vars)?;
    for (name, value) in &headers {
        req = req.header(name, value);
    }

    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!(
            "HTTP {}: {}",
            resp.status().as_u16(),
            resp.status()
        ));
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
        // A user-supplied endpoint gives no unit; the mapping table can name
        // one, and until it does the UI shows the number without a currency.
        let mut usage = serde_json::json!({
            "unit": null,
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
    let value =
        extract_json_path(body, path).ok_or_else(|| format!("No value found at path: {}", path))?;

    // If the extracted value is an object, try to read structured fields from it
    if let Some(obj) = value.as_object() {
        let mut usage = serde_json::json!({
            "total": to_number(obj.get("total")).or_else(|| to_number(obj.get("total_granted"))),
            "used": to_number(obj.get("used")).or_else(|| to_number(obj.get("total_used"))),
            "remaining": to_number(obj.get("remaining"))
                .or_else(|| to_number(obj.get("total_available")))
                .or_else(|| to_number(obj.get("available"))),
            // Reported unit only; absent means the UI must not claim one.
            "unit": obj.get("unit").and_then(|v| v.as_str()),
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
        // No unit was reported, so none is asserted.
        "unit": null,
    }))
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

/// Fetch the metering periods OpenCode Go reports for the account.
///
/// The endpoint is derived from the provider's saved address, so a relay is
/// queried at the relay rather than at the vendor.
async fn fetch_opencode_go_usage(
    provider: &Provider,
    fallback_api_keys: &[ApiKey],
) -> Result<Value, String> {
    let api_key = super::balance_service::pick_first_available_key(fallback_api_keys)
        .ok_or_else(|| "No available API keys for the quota check".to_string())?;

    // The request is the provider's own when it has written one, and the
    // documented one otherwise — same rule as every other account query.
    let vars = QueryVars::for_provider(provider, Some(api_key.as_str()));
    let url = substitute(
        stored_or(
            provider.usage_url.as_deref(),
            query_defaults::OPENCODE_GO_USAGE_URL,
        ),
        &vars,
    );
    let headers = resolve_headers(
        provider.usage_headers.as_deref(),
        query_defaults::OPENCODE_GO_USAGE_HEADERS,
        &vars,
    )?;

    let mut request = crate::services::http_client::outbound_client_for_provider(Some(provider))?
        .get(&url)
        .header("Content-Type", "application/json");
    for (name, value) in &headers {
        request = request.header(name, value);
    }

    let resp = request.send().await.map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }

    let body: Value = resp.json().await.map_err(|e| e.to_string())?;
    parse_opencode_go_usage(&body)
}

/// Display labels for the periods this build knows. Anything else keeps its
/// raw id, so a period added upstream shows up rather than disappearing.
const WINDOW_LABELS: &[(&str, &str)] = &[
    ("rolling", "5h"),
    ("weekly", "Weekly"),
    ("monthly", "Monthly"),
];

fn window_label(id: &str) -> String {
    WINDOW_LABELS
        .iter()
        .find(|(key, _)| *key == id)
        .map(|(_, label)| (*label).to_string())
        .unwrap_or_else(|| id.to_string())
}

/// OpenCode Go reports metering periods rather than a balance.
///
/// The live response is `{ "usage": { "rolling": { "status", "percent",
/// "resetsAt" }, ... } }`. Periods are read by name and kept in the order the
/// provider sent them; nothing is summed into a single figure the provider
/// never stated, and a missing `percent` stays missing.
pub fn parse_opencode_go_usage(body: &Value) -> Result<Value, String> {
    let usage = body
        .get("usage")
        .ok_or_else(|| "Response had no 'usage' object".to_string())?;

    let periods = usage
        .as_object()
        .ok_or_else(|| "'usage' was not an object of periods".to_string())?;
    if periods.is_empty() {
        return Err("'usage' contained no periods".to_string());
    }

    let mut windows = Vec::new();
    for (id, value) in periods {
        // A period that is not an object is a shape this build cannot read;
        // saying so beats rendering a blank window.
        let Some(entry) = value.as_object() else {
            return Err(format!("Usage period '{}' was not an object", id));
        };
        windows.push(serde_json::json!({
            "id": id,
            "label": window_label(id),
            "usedPercent": entry.get("percent").and_then(Value::as_f64),
            "resetsAt": entry.get("resetsAt").and_then(Value::as_str),
            "status": entry.get("status").and_then(Value::as_str),
        }));
    }

    Ok(serde_json::json!({
        "usage": {
            "total": null,
            "used": null,
            "remaining": null,
            // A percentage is not a currency; claiming one would be a lie.
            "unit": null,
            "isUnlimited": null,
            "expireAt": null,
            "windows": windows,
            "groups": [],
        },
        "error": null,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Captured verbatim from `GET https://opencode.ai/zen/go/v1/usage` on
    /// 2026-09-11, so the parser is tested against the real shape rather than a
    /// guessed one.
    fn live_response() -> Value {
        json!({
            "usage": {
                "rolling": { "status": "ok", "percent": 0, "resetsAt": "2026-09-10T22:06:37.010Z" },
                "weekly": { "status": "ok", "percent": 0, "resetsAt": "2026-09-14T00:00:00.010Z" },
                "monthly": { "status": "ok", "percent": 0, "resetsAt": "2026-10-10T14:01:24.010Z" }
            }
        })
    }

    #[test]
    fn go_usage_reports_every_period_the_provider_sent() {
        let parsed = parse_opencode_go_usage(&live_response()).expect("parsed");
        let windows = parsed["usage"]["windows"].as_array().expect("windows");

        assert_eq!(windows.len(), 3);
        // All three are returned at once; the UI never has to pick one.
        let ids: Vec<&str> = windows.iter().filter_map(|w| w["id"].as_str()).collect();
        for expected in ["rolling", "weekly", "monthly"] {
            assert!(
                ids.contains(&expected),
                "{} missing from {:?}",
                expected,
                ids
            );
        }
        let rolling = windows.iter().find(|w| w["id"] == "rolling").unwrap();
        assert_eq!(rolling["label"], "5h");
        assert_eq!(rolling["resetsAt"], "2026-09-10T22:06:37.010Z");
        assert_eq!(rolling["status"], "ok");
    }

    #[test]
    fn a_missing_percent_stays_missing_rather_than_becoming_zero() {
        let body = json!({
            "usage": { "rolling": { "status": "ok", "resetsAt": "2026-01-01T00:00:00Z" } }
        });

        let parsed = parse_opencode_go_usage(&body).expect("parsed");
        let window = &parsed["usage"]["windows"][0];

        assert!(window["usedPercent"].is_null());
        // A percentage is not money, so no unit is claimed either.
        assert!(parsed["usage"]["unit"].is_null());
    }

    #[test]
    fn a_period_this_build_does_not_name_keeps_its_raw_id() {
        let body = json!({
            "usage": { "daily": { "status": "ok", "percent": 12.5, "resetsAt": "2026-01-02T00:00:00Z" } }
        });

        let parsed = parse_opencode_go_usage(&body).expect("parsed");
        let window = &parsed["usage"]["windows"][0];

        assert_eq!(window["id"], "daily");
        assert_eq!(window["label"], "daily");
        assert_eq!(window["usedPercent"], 12.5);
    }

    #[test]
    fn a_shape_this_build_cannot_read_is_reported() {
        assert!(parse_opencode_go_usage(&json!({})).is_err());
        assert!(parse_opencode_go_usage(&json!({ "usage": {} })).is_err());
        assert!(parse_opencode_go_usage(&json!({ "usage": { "rolling": 3 } })).is_err());
    }
}
