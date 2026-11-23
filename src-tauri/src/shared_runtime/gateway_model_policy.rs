//! Shared model-ID validation, strict gateway catalog enforcement, and
//! dynamic session header bridging for OpenCode Go upstreams.
use crate::models::Provider;
use axum::http::header::{HeaderMap, HeaderName, HeaderValue};
use axum::http::{Method, StatusCode};
use serde::de::{self, MapAccess, Visitor};
use serde::Deserialize;

pub const OPENCODE_SESSION_HEADER: &str = "x-opencode-session";
const MAX_SESSION_ID_LEN: usize = 256;

/// Inbound client headers carrying a per-conversation dynamic session ID,
/// checked in priority order when bridging to `x-opencode-session`.
const DYNAMIC_SESSION_HEADERS: &[&str] = &[
    "x-session-id",
    "x-dsh-session",
    "session_id",
    "session-id",
    "x-client-request-id",
];

pub fn valid_model_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 512
        && !id.chars().any(|c| c.is_whitespace() || c.is_control())
        && !id.contains("://")
}

pub fn is_discovery_path(path: &str) -> bool {
    matches!(
        path,
        "/models"
            | "/v1/models"
            | "/claude/v1/models"
            | "/openai/v1/models"
            | "/claude-desktop/v1/models"
    )
}

/// Recognized client path aliases resolve to the very same standard endpoint
/// that the strict gateway classifier authorizes. Unknown/encoded paths have no alias.
pub fn canonical_inference_path(path: &str) -> Option<&str> {
    if path.contains("//") || path.contains('%') || path.contains('\\') {
        return None;
    }
    let canonical = ["/claude-desktop", "/claude", "/openai"]
        .into_iter()
        .find_map(|prefix| {
            path.strip_prefix(prefix)
                .filter(|suffix| suffix.starts_with("/v1/"))
        })
        .unwrap_or(path);
    let endpoint = canonical
        .strip_prefix("/v1/")
        .or_else(|| canonical.strip_prefix('/'))?;
    matches!(
        endpoint,
        "chat/completions"
            | "completions"
            | "responses"
            | "responses/compact"
            | "messages"
            | "messages/count_tokens"
            | "embeddings"
            | "rerank"
    )
    .then_some(canonical)
}

pub type PolicyError = (StatusCode, &'static str);

/// Validate a gateway request envelope against the bound provider's saved model
/// catalog before any upstream connection is opened.
pub fn validate_gateway_envelope(
    method: &Method,
    path_query: &str,
    headers: &HeaderMap,
    allowed_model_ids: &[String],
) -> Result<(), PolicyError> {
    if *method == Method::CONNECT {
        return Err((
            StatusCode::FORBIDDEN,
            "Gateway does not support CONNECT tunneling",
        ));
    }
    let (path, query) = path_query
        .split_once('?')
        .map_or((path_query, None), |(p, q)| (p, Some(q)));

    // WebSocket upgrades (e.g. Realtime / Responses WS): validate any `model*`
    // query parameter upfront; per-frame JSON `model` fields are checked in ws_relay.
    if headers.contains_key("upgrade") {
        if let Some(query) = query {
            for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
                if key.to_ascii_lowercase().starts_with("model")
                    && !allowed_model_ids.iter().any(|id| id == value.as_ref())
                {
                    return Err((
                        StatusCode::FORBIDDEN,
                        "Model is not in the provider model catalog",
                    ));
                }
            }
        }
        return Ok(());
    }

    if *method == Method::GET && is_discovery_path(path) {
        return Ok(());
    }
    if query.is_some_and(|query| {
        url::form_urlencoded::parse(query.as_bytes())
            .any(|(key, _)| key.to_ascii_lowercase().starts_with("model"))
    }) {
        return Err((
            StatusCode::BAD_REQUEST,
            "Gateway model must be specified only in the JSON body",
        ));
    }
    if *method != Method::POST || canonical_inference_path(path).is_none() {
        return Err((
            StatusCode::FORBIDDEN,
            "Endpoint cannot be verified against the provider model catalog",
        ));
    }
    if headers.contains_key("content-encoding")
        || headers.get_all("content-type").iter().count() != 1
        || !headers
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| {
                v.split(';')
                    .next()
                    .is_some_and(|v| v.trim().eq_ignore_ascii_case("application/json"))
            })
    {
        return Err((
            StatusCode::BAD_REQUEST,
            "Gateway inference requests require an uncompressed application/json body",
        ));
    }
    Ok(())
}

struct UniqueModel(String);
impl<'de> Deserialize<'de> for UniqueModel {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ModelVisitor;
        impl<'de> Visitor<'de> for ModelVisitor {
            type Value = UniqueModel;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a JSON object containing one model string")
            }
            fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Self::Value, M::Error> {
                let mut model = None;
                while let Some(key) = map.next_key::<String>()? {
                    if key == "model" {
                        if model.is_some() {
                            return Err(de::Error::custom("duplicate model"));
                        }
                        model = Some(map.next_value::<String>()?);
                    } else {
                        map.next_value::<de::IgnoredAny>()?;
                    }
                }
                let model = model.ok_or_else(|| de::Error::custom("missing model"))?;
                if !valid_model_id(&model) {
                    return Err(de::Error::custom("invalid model"));
                }
                Ok(UniqueModel(model))
            }
        }
        deserializer.deserialize_map(ModelVisitor)
    }
}

/// Strictly verify that a gateway JSON inference body names a unique top-level
/// `"model"` string present in the bound provider's saved model catalog.
pub fn validate_gateway_body(allowed_model_ids: &[String], body: &[u8]) -> Result<(), PolicyError> {
    let model = serde_json::from_slice::<UniqueModel>(body).map_err(|_| {
        (
            StatusCode::BAD_REQUEST,
            "Gateway request requires a unique, valid JSON model string",
        )
    })?;
    if !allowed_model_ids.iter().any(|id| id == &model.0) {
        return Err((
            StatusCode::FORBIDDEN,
            "Model is not in the provider model catalog",
        ));
    }
    Ok(())
}

/// Inspect a WebSocket text frame relayed through a gateway. Non-JSON frames or
/// JSON frames without a top-level `"model"` key pass through; frames declaring
/// a `"model"` must match the bound provider's saved model catalog.
pub fn validate_gateway_ws_text_frame(
    allowed_model_ids: &[String],
    text: &str,
) -> Result<(), PolicyError> {
    let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(text) else {
        return Ok(());
    };
    if !map.contains_key("model") {
        return Ok(());
    }
    validate_gateway_body(allowed_model_ids, text.as_bytes())
}

/// Returns true when the outbound request targets OpenCode Go (either via the
/// provider preset or directly via `opencode.ai/{zen,inference}/go`).
pub fn is_opencode_go_upstream(provider: Option<&Provider>, upstream_url: &str) -> bool {
    if provider.is_some_and(|p| p.preset_id == "opencode-go") {
        return true;
    }
    let Ok(parsed) = url::Url::parse(upstream_url) else {
        return false;
    };
    let is_host = parsed
        .host_str()
        .is_some_and(|host| host.eq_ignore_ascii_case("opencode.ai"));
    if !is_host {
        return false;
    }
    let path = parsed.path();
    path == "/zen/go"
        || path.starts_with("/zen/go/")
        || path == "/inference/go"
        || path.starts_with("/inference/go/")
}

fn first_dynamic_session_header(headers: &HeaderMap) -> Option<HeaderValue> {
    for name in DYNAMIC_SESSION_HEADERS {
        let Some(raw) = headers.get(*name).and_then(|value| value.to_str().ok()) else {
            continue;
        };
        let trimmed = raw.trim();
        if trimmed.is_empty()
            || trimmed.len() > MAX_SESSION_ID_LEN
            || trimmed.chars().any(|c| c.is_control())
        {
            continue;
        }
        if let Ok(value) = HeaderValue::from_str(trimmed) {
            return Some(value);
        }
    }
    None
}

/// For OpenCode Go upstreams, bridge a client-supplied dynamic session header
/// (such as `x-session-id` from `dsh-session-header`) into `x-opencode-session`
/// without ever inventing a static fallback value or overwriting an existing
/// `x-opencode-session` header.
pub fn apply_opencode_go_session_header(
    headers: &mut HeaderMap,
    provider: Option<&Provider>,
    upstream_url: &str,
) {
    if !is_opencode_go_upstream(provider, upstream_url) {
        return;
    }
    let has_existing = headers
        .get(OPENCODE_SESSION_HEADER)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| !value.trim().is_empty());
    if has_existing {
        return;
    }
    if let Some(session_value) = first_dynamic_session_header(headers) {
        headers.insert(
            HeaderName::from_static(OPENCODE_SESSION_HEADER),
            session_value,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowed() -> Vec<String> {
        vec!["allowed".into()]
    }

    #[test]
    fn valid_model_id_rejects_empty_whitespace_control_and_urls() {
        assert!(valid_model_id("deepseek-v4.1-flash"));
        assert!(valid_model_id("hy4-flash-free"));
        assert!(!valid_model_id(""));
        assert!(!valid_model_id("model with space"));
        assert!(!valid_model_id("model\nnewline"));
        assert!(!valid_model_id("https://example.com/model"));
    }

    #[test]
    fn discovery_paths_match_known_model_endpoints() {
        for path in [
            "/models",
            "/v1/models",
            "/claude/v1/models",
            "/openai/v1/models",
            "/claude-desktop/v1/models",
        ] {
            assert!(is_discovery_path(path), "{path}");
        }
        assert!(!is_discovery_path("/v1/messages"));
        assert!(!is_discovery_path("/v1/models/gpt-5"));
    }

    #[test]
    fn exact_model_and_unique_field_required_for_gateway() {
        assert!(validate_gateway_body(&allowed(), br#"{"model":"allowed","messages":[]}"#).is_ok());
        assert!(validate_gateway_body(&[], br#"{"model":"allowed"}"#).is_err());
        for body in [
            r#"{"model":"other"}"#,
            r#"{"model":"Allowed"}"#,
            r#"{"model":"allowed","model":"other"}"#,
            r#"{"model":"allowed","\u006dodel":"other"}"#,
            r#"{"model":null}"#,
            r#"{"model":""}"#,
            "{}",
            "[]",
            r#"{"model":3}"#,
            r#"{"model":"allowed"} garbage"#,
        ] {
            assert!(
                validate_gateway_body(&allowed(), body.as_bytes()).is_err(),
                "{body}"
            );
        }
    }

    #[test]
    fn closed_endpoint_set_and_envelope_for_gateway() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "content-type",
            "application/json; charset=utf-8".parse().unwrap(),
        );
        for path in [
            "/messages",
            "/v1/messages/count_tokens",
            "/openai/v1/responses",
            "/responses/compact?x=1",
            "/claude/v1/messages",
            "/embeddings",
        ] {
            assert!(
                validate_gateway_envelope(&Method::POST, path, &headers, &allowed()).is_ok(),
                "{path}"
            );
        }
        for path in [
            "/v1/messages/",
            "/v1/v1/messages",
            "/v1/responses/id",
            "/v1/%6dessages",
            "/v1/../messages",
            "/batches",
            "/responses?model=other",
            "/responses?%6dodel=other",
            "//responses",
        ] {
            assert!(
                validate_gateway_envelope(&Method::POST, path, &headers, &allowed()).is_err(),
                "{path}"
            );
        }
        headers.insert("content-encoding", "gzip".parse().unwrap());
        assert!(
            validate_gateway_envelope(&Method::POST, "/responses", &headers, &allowed()).is_err()
        );

        let mut ws_headers = HeaderMap::new();
        ws_headers.insert("upgrade", "websocket".parse().unwrap());
        assert!(validate_gateway_envelope(
            &Method::GET,
            "/v1/realtime?model=allowed",
            &ws_headers,
            &allowed()
        )
        .is_ok());
        assert!(validate_gateway_envelope(
            &Method::GET,
            "/v1/realtime?model=other",
            &ws_headers,
            &allowed()
        )
        .is_err());
        assert!(validate_gateway_ws_text_frame(&allowed(), "ping").is_ok());
        assert!(validate_gateway_ws_text_frame(
            &allowed(),
            r#"{"type":"response.create","model":"allowed"}"#
        )
        .is_ok());
        assert!(validate_gateway_ws_text_frame(
            &allowed(),
            r#"{"type":"response.create","model":"other"}"#
        )
        .is_err());
    }

    #[test]
    fn opencode_go_bridges_dynamic_session_header_without_static_fallback() {
        let mut headers = HeaderMap::new();
        headers.insert("x-session-id", "sess-dynamic-123".parse().unwrap());
        apply_opencode_go_session_header(
            &mut headers,
            None,
            "https://opencode.ai/zen/go/v1/chat/completions",
        );
        assert_eq!(
            headers
                .get(OPENCODE_SESSION_HEADER)
                .and_then(|v| v.to_str().ok()),
            Some("sess-dynamic-123")
        );

        // Existing x-opencode-session is never overwritten.
        let mut existing = HeaderMap::new();
        existing.insert("x-opencode-session", "native-opencode-id".parse().unwrap());
        existing.insert("x-session-id", "other-session".parse().unwrap());
        apply_opencode_go_session_header(
            &mut existing,
            None,
            "https://opencode.ai/inference/go/v1/messages",
        );
        assert_eq!(
            existing
                .get(OPENCODE_SESSION_HEADER)
                .and_then(|v| v.to_str().ok()),
            Some("native-opencode-id")
        );

        // Absent dynamic header never invents a static value.
        let mut empty = HeaderMap::new();
        apply_opencode_go_session_header(
            &mut empty,
            None,
            "https://opencode.ai/zen/go/v1/chat/completions",
        );
        assert!(empty.get(OPENCODE_SESSION_HEADER).is_none());

        // Non-OpenCode-Go upstreams stay untouched.
        let mut other = HeaderMap::new();
        other.insert("x-session-id", "sess-456".parse().unwrap());
        apply_opencode_go_session_header(&mut other, None, "https://api.openai.com/v1/responses");
        assert!(other.get(OPENCODE_SESSION_HEADER).is_none());
    }
}
