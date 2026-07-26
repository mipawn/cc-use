use serde::{Deserialize, Serialize};

/// Header keys whose values are always replaced with a placeholder in detail
/// mode. Case-insensitive match.
const SENSITIVE_HEADERS: &[&str] = &[
    "authorization",
    "x-api-key",
    "api-key",
    "proxy-authorization",
    "x-cc-use-session-token",
    "x-cc-use-management-token",
];

/// Credential-like tokens that may appear in request/response bodies and
/// should be masked.
const SENSITIVE_BODY_PATTERNS: &[&str] = &["sk-ant-", "sk-or-", "sk-"];

const TRUNCATION_LIMIT: usize = 8192;

/// Sanitise a single header value. If the header name matches a sensitive
/// key, the entire value is replaced.
pub fn desensitize_header(name: &str, _value: &str) -> String {
    let lower = name.to_lowercase();
    if SENSITIVE_HEADERS.iter().any(|h| lower == *h) {
        "<redacted>".to_string()
    } else {
        _value.to_string()
    }
}

/// Naive body sanitisation: look for known credential prefixes and mask
/// the remainder of the token-like string. Not a complete parser, but good
/// enough for the real-time console where full fidelity isn't expected.
pub fn desensitize_body(body: &str) -> String {
    let mut result = body.to_string();
    for pattern in SENSITIVE_BODY_PATTERNS {
        let mut pos = 0;
        while let Some(idx) = result[pos..].find(pattern) {
            let abs = pos + idx;
            // Skip the prefix itself, mask from after it to whitespace/quote/end
            let start = abs + pattern.len();
            let end = result[start..]
                .find(|c: char| c.is_whitespace() || c == '"' || c == '\'')
                .map(|r| start + r)
                .unwrap_or(result.len());
            if end > start {
                result.replace_range(start..end, &"*".repeat(end - start));
            }
            pos = end;
        }
    }
    result
}

fn desensitize_json_secret_fields(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(map) => {
            for (key, val) in map {
                let lower = key.to_ascii_lowercase();
                if matches!(
                    lower.as_str(),
                    "api_key"
                        | "apikey"
                        | "token"
                        | "access_token"
                        | "refresh_token"
                        | "authorization"
                        | "x-api-key"
                ) {
                    if !val.is_null() {
                        *val = serde_json::Value::String("<redacted>".to_string());
                    }
                } else {
                    desensitize_json_secret_fields(val);
                }
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                desensitize_json_secret_fields(item);
            }
        }
        _ => {}
    }
}

fn format_json_body(body: &str) -> Option<String> {
    let mut value = serde_json::from_str::<serde_json::Value>(body).ok()?;
    desensitize_json_secret_fields(&mut value);
    serde_json::to_string_pretty(&value).ok()
}

fn extract_sse_response_text(body: &str) -> Option<String> {
    let mut parts = Vec::new();
    let mut events_seen = 0usize;
    for line in body.lines() {
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(data) else {
            continue;
        };
        events_seen += 1;
        collect_response_text(&value, &mut parts);
    }

    if parts.is_empty() {
        Some(format_sse_fallback(body, events_seen))
    } else {
        Some(parts.join(""))
    }
}

fn collect_response_text(value: &serde_json::Value, parts: &mut Vec<String>) {
    match value.get("type").and_then(|v| v.as_str()) {
        Some("content_block_delta") => {
            if let Some(text) = value
                .get("delta")
                .and_then(|d| d.get("text").or_else(|| d.get("thinking")))
                .and_then(|v| v.as_str())
            {
                parts.push(text.to_string());
            }
        }
        Some("content_block_start") => {
            if let Some(text) = value
                .get("content_block")
                .and_then(|d| d.get("text").or_else(|| d.get("thinking")))
                .and_then(|v| v.as_str())
            {
                parts.push(text.to_string());
            }
        }
        Some("message") => {
            if let Some(content) = value.get("content").and_then(|v| v.as_array()) {
                for item in content {
                    collect_text_like_fields(item, parts);
                }
            }
        }
        Some("completion") => {
            if let Some(completion) = value.get("completion").and_then(|v| v.as_str()) {
                parts.push(completion.to_string());
            }
        }
        Some("response.output_text.delta") | Some("response.refusal.delta") => {
            if let Some(delta) = value.get("delta").and_then(|v| v.as_str()) {
                parts.push(delta.to_string());
            }
        }
        Some("response.completed") => {
            if let Some(output) = value
                .get("response")
                .and_then(|v| v.get("output"))
                .and_then(|v| v.as_array())
            {
                for item in output {
                    collect_response_text(item, parts);
                }
            }
        }
        _ => {
            collect_text_like_fields(value, parts);
        }
    }
}

fn collect_text_like_fields(value: &serde_json::Value, parts: &mut Vec<String>) {
    match value {
        serde_json::Value::Object(map) => {
            for (key, val) in map {
                if matches!(
                    key.as_str(),
                    "text" | "thinking" | "completion" | "content" | "delta"
                ) {
                    match val {
                        serde_json::Value::String(s) if !s.is_empty() => parts.push(s.clone()),
                        serde_json::Value::Array(_) | serde_json::Value::Object(_) => {
                            collect_text_like_fields(val, parts);
                        }
                        _ => {}
                    }
                } else if matches!(
                    val,
                    serde_json::Value::Array(_) | serde_json::Value::Object(_)
                ) {
                    collect_text_like_fields(val, parts);
                }
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                collect_text_like_fields(item, parts);
            }
        }
        _ => {}
    }
}

fn format_sse_fallback(body: &str, events_seen: usize) -> String {
    let tail_limit = 4096usize;
    let mut start = body.len().saturating_sub(tail_limit);
    while start < body.len() && !body.is_char_boundary(start) {
        start += 1;
    }
    let tail = body[start..].trim();
    if tail.is_empty() {
        format!("[未解析到文本 delta；已读取 {} 个 SSE 事件]", events_seen)
    } else {
        format!(
            "[未解析到文本 delta；已读取 {} 个 SSE 事件，以下为响应尾部]\n{}",
            events_seen, tail
        )
    }
}

fn format_detail_body(body: &[u8], content_type: &str) -> String {
    let text = String::from_utf8_lossy(body);
    let formatted = if content_type.contains("text/event-stream") {
        extract_sse_response_text(&text).unwrap_or_else(|| format_sse_fallback(&text, 0))
    } else if content_type.contains("application/json") || content_type.contains("+json") {
        format_json_body(&text).unwrap_or_else(|| text.to_string())
    } else {
        text.to_string()
    };
    desensitize_body(&formatted)
}

/// Truncate a body-like string to `limit` bytes (keeping valid UTF-8),
/// appending a note when truncation happens.
pub fn truncate_body(body: &str, limit: usize) -> String {
    if body.len() <= limit {
        return body.to_string();
    }
    let mut end = limit;
    while end > 0 && !body.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…[truncated, {}B total]", &body[..end], body.len())
}

/// Everything the realtime console streams. Tagged union so the frontend
/// can branch on `category` to render request lines vs log lines with the
/// same transport. Not persisted anywhere — if no subscriber is listening
/// when we broadcast, the event is dropped and that's fine.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "category", rename_all = "snake_case")]
pub enum ConsoleEvent {
    /// A single proxy request crossing the handler.
    #[serde(rename_all = "camelCase")]
    Request {
        /// Stable id for one proxied request. Present for handler-emitted
        /// events so the renderer can update a pending row in place.
        #[serde(skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
        /// UTC timestamp `YYYY-MM-DD HH:MM:SS`.
        timestamp: String,
        /// Classification: "pending" | "ok" | "cancelled" | "upstream_error" | "rejected" | "ws".
        kind: String,
        /// HTTP method, or "WS" for websocket upgrades.
        method: String,
        /// Incoming request path + query.
        path: String,
        /// Upstream response status; null when we never dispatched.
        status: Option<u16>,
        /// Wall-clock latency, entry → emit.
        latency_ms: Option<u64>,
        /// Final upstream URL we forwarded to.
        upstream: Option<String>,
        /// Provider display name.
        provider: Option<String>,
        /// API key alias.
        key_alias: Option<String>,
        /// Optional note (error text, "streaming" hint, ...).
        message: Option<String>,
        /// — Detail-mode fields (all absent when detail mode is off) —
        /// Desensitised request headers as "name: value" lines.
        request_headers: Option<Vec<String>>,
        /// Desensitised request body, truncated to TRUNCATION_LIMIT.
        request_body: Option<String>,
        /// Desensitised response headers as "name: value" lines.
        response_headers: Option<Vec<String>>,
        /// Desensitised response body, truncated to TRUNCATION_LIMIT.
        response_body: Option<String>,
    },
    /// A log record captured from the Rust `log` facade or patched renderer
    /// console. Shares the same stream so the UI is "one pane for everything".
    #[serde(rename_all = "camelCase")]
    Log {
        timestamp: String,
        /// "error" | "warn" | "info" | "debug" | "trace".
        level: String,
        /// Where the log came from: "daemon" | "app" | "renderer".
        source: String,
        /// Module path / log target (e.g. "cc_use_lib::proxy::handler").
        target: Option<String>,
        message: String,
    },
}

impl ConsoleEvent {
    /// Request has entered the proxy and is about to contact upstream.
    pub fn pending(
        request_id: impl Into<String>,
        method: &str,
        path: &str,
        upstream: &str,
        provider: Option<&str>,
        key_alias: Option<&str>,
        is_streaming: bool,
    ) -> Self {
        Self::Request {
            request_id: Some(request_id.into()),
            timestamp: now_timestamp(),
            kind: "pending".to_string(),
            method: method.to_string(),
            path: path.to_string(),
            status: None,
            latency_ms: None,
            upstream: Some(upstream.to_string()),
            provider: provider.map(String::from),
            key_alias: key_alias.map(String::from),
            message: if is_streaming {
                Some("streaming".to_string())
            } else {
                Some("pending".to_string())
            },
            request_headers: None,
            request_body: None,
            response_headers: None,
            response_body: None,
        }
    }

    /// Successful non-streaming or streaming response.
    pub fn ok(
        request_id: impl Into<String>,
        method: &str,
        path: &str,
        status: u16,
        latency_ms: u64,
        upstream: &str,
        provider: Option<&str>,
        key_alias: Option<&str>,
        is_streaming: bool,
    ) -> Self {
        Self::Request {
            request_id: Some(request_id.into()),
            timestamp: now_timestamp(),
            kind: "ok".to_string(),
            method: method.to_string(),
            path: path.to_string(),
            status: Some(status),
            latency_ms: Some(latency_ms),
            upstream: Some(upstream.to_string()),
            provider: provider.map(String::from),
            key_alias: key_alias.map(String::from),
            message: if is_streaming {
                Some("streaming".to_string())
            } else {
                None
            },
            request_headers: None,
            request_body: None,
            response_headers: None,
            response_body: None,
        }
    }

    /// Upstream contact failed or response could not be read.
    pub fn upstream_error(
        request_id: impl Into<String>,
        method: &str,
        path: &str,
        latency_ms: u64,
        upstream: &str,
        provider: Option<&str>,
        key_alias: Option<&str>,
        error: &str,
    ) -> Self {
        Self::Request {
            request_id: Some(request_id.into()),
            timestamp: now_timestamp(),
            kind: "upstream_error".to_string(),
            method: method.to_string(),
            path: path.to_string(),
            status: None,
            latency_ms: Some(latency_ms),
            upstream: Some(upstream.to_string()),
            provider: provider.map(String::from),
            key_alias: key_alias.map(String::from),
            message: Some(error.to_string()),
            request_headers: None,
            request_body: None,
            response_headers: None,
            response_body: None,
        }
    }

    /// Client disconnected while waiting for upstream or before a stream completed.
    pub fn cancelled(
        request_id: impl Into<String>,
        method: &str,
        path: &str,
        status: Option<u16>,
        latency_ms: u64,
        upstream: &str,
        provider: Option<&str>,
        key_alias: Option<&str>,
    ) -> Self {
        Self::Request {
            request_id: Some(request_id.into()),
            timestamp: now_timestamp(),
            kind: "cancelled".to_string(),
            method: method.to_string(),
            path: path.to_string(),
            status,
            latency_ms: Some(latency_ms),
            upstream: Some(upstream.to_string()),
            provider: provider.map(String::from),
            key_alias: key_alias.map(String::from),
            message: Some("client disconnected".to_string()),
            request_headers: None,
            request_body: None,
            response_headers: None,
            response_body: None,
        }
    }

    /// Rejection before we could dispatch (auth missing, unknown path, ...).
    pub fn rejected(
        request_id: impl Into<String>,
        method: &str,
        path: &str,
        latency_ms: u64,
        reason: &str,
    ) -> Self {
        Self::Request {
            request_id: Some(request_id.into()),
            timestamp: now_timestamp(),
            kind: "rejected".to_string(),
            method: method.to_string(),
            path: path.to_string(),
            status: None,
            latency_ms: Some(latency_ms),
            upstream: None,
            provider: None,
            key_alias: None,
            message: Some(reason.to_string()),
            request_headers: None,
            request_body: None,
            response_headers: None,
            response_body: None,
        }
    }

    /// Websocket upgrade accepted; relay continues in a spawned task.
    pub fn ws_upgraded(
        request_id: impl Into<String>,
        path: &str,
        latency_ms: u64,
        upstream: &str,
        provider: Option<&str>,
        key_alias: Option<&str>,
    ) -> Self {
        Self::Request {
            request_id: Some(request_id.into()),
            timestamp: now_timestamp(),
            kind: "ws".to_string(),
            method: "WS".to_string(),
            path: path.to_string(),
            status: None,
            latency_ms: Some(latency_ms),
            upstream: Some(upstream.to_string()),
            provider: provider.map(String::from),
            key_alias: key_alias.map(String::from),
            message: Some("upgraded".to_string()),
            request_headers: None,
            request_body: None,
            response_headers: None,
            response_body: None,
        }
    }

    /// Generic log record from the Rust log facade or the patched renderer console.
    pub fn log(level: &str, source: &str, target: Option<&str>, message: &str) -> Self {
        Self::Log {
            timestamp: now_timestamp(),
            level: level.to_string(),
            source: source.to_string(),
            target: target.map(String::from),
            message: message.to_string(),
        }
    }

    pub fn with_request_id(mut self, request_id: impl Into<String>) -> Self {
        if let Self::Request {
            request_id: ref mut target,
            ..
        } = self
        {
            *target = Some(request_id.into());
        }
        self
    }
}

/// Build the optional detail fields from raw request/response data. Returns
/// (request_headers, request_body, response_headers, response_body). All
/// fields are desensitised and truncated. Returns all None when detail_mode
/// is false.
pub fn build_detail_fields(
    req_headers: &hyper::HeaderMap,
    req_body: &[u8],
    resp_headers: &hyper::HeaderMap,
    resp_body: &[u8],
    detail_mode: bool,
) -> (
    Option<Vec<String>>,
    Option<String>,
    Option<Vec<String>>,
    Option<String>,
) {
    build_detail_fields_with_content_type(
        req_headers,
        req_body,
        resp_headers,
        resp_body,
        "",
        "",
        detail_mode,
    )
}

pub fn build_detail_fields_with_content_type(
    req_headers: &hyper::HeaderMap,
    req_body: &[u8],
    resp_headers: &hyper::HeaderMap,
    resp_body: &[u8],
    req_content_type: &str,
    resp_content_type: &str,
    detail_mode: bool,
) -> (
    Option<Vec<String>>,
    Option<String>,
    Option<Vec<String>>,
    Option<String>,
) {
    if !detail_mode {
        return (None, None, None, None);
    }
    fn headers_to_lines(h: &hyper::HeaderMap) -> Vec<String> {
        h.iter()
            .map(|(n, v)| {
                format!(
                    "{}: {}",
                    n.as_str(),
                    desensitize_header(n.as_str(), v.to_str().unwrap_or("<binary>"))
                )
            })
            .collect()
    }
    let req_h = Some(headers_to_lines(req_headers));
    let resp_h = Some(headers_to_lines(resp_headers));
    let req_b = Some(truncate_body(
        &format_detail_body(req_body, req_content_type),
        TRUNCATION_LIMIT,
    ));
    let resp_b = Some(truncate_body(
        &format_detail_body(resp_body, resp_content_type),
        TRUNCATION_LIMIT,
    ));
    (req_h, req_b, resp_h, resp_b)
}

pub fn now_timestamp() -> String {
    chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_detail_extracts_late_text_delta_without_metadata() {
        let body = concat!(
            "event: message_start\n",
            "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":123}}}\n\n",
            "event: content_block_start\n",
            "data: {\"type\":\"content_block_start\",\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}\n\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"派大星，我是 Claude Code\"}}\n\n"
        );

        let formatted = format_detail_body(body.as_bytes(), "text/event-stream; charset=utf-8");

        assert_eq!(formatted, "派大星，我是 Claude Code");
        assert!(!formatted.contains("message_start"));
        assert!(!formatted.contains("input_token"));
    }

    #[test]
    fn sse_detail_fallback_uses_tail_when_text_is_missing() {
        let body = concat!(
            "event: message_start\n",
            "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":123}}}\n\n",
            "event: message_delta\n",
            "data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":0}}\n\n"
        );

        let formatted = format_detail_body(body.as_bytes(), "text/event-stream");

        assert!(formatted.contains("未解析到文本 delta"));
        assert!(formatted.contains("message_delta"));
        assert!(!formatted.contains("input_token*"));
    }
}
