//! Fail-closed gateway model exposure, shared by the app and daemon.
use crate::models::GatewayModelPolicy;
use axum::http::{HeaderMap, Method, StatusCode};
use serde::de::{self, MapAccess, Visitor};
use serde::Deserialize;
use std::collections::HashSet;

pub fn valid_model_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 512
        && !id.chars().any(|c| c.is_whitespace() || c.is_control())
        && !id.contains("://")
}

pub fn normalize(policy: &GatewayModelPolicy) -> Result<GatewayModelPolicy, String> {
    match policy {
        GatewayModelPolicy::All => Ok(GatewayModelPolicy::All),
        GatewayModelPolicy::Selected { model_ids } => {
            if model_ids.is_empty() || model_ids.len() > 10_000 {
                return Err("Select between 1 and 10000 gateway models".into());
            }
            let mut seen = HashSet::new();
            let mut ids = Vec::new();
            for id in model_ids {
                if !valid_model_id(id) {
                    return Err("Gateway model ID is invalid".into());
                }
                if seen.insert(id.clone()) {
                    ids.push(id.clone());
                }
            }
            Ok(GatewayModelPolicy::Selected { model_ids: ids })
        }
    }
}

pub fn from_json(raw: Option<&str>) -> Result<GatewayModelPolicy, String> {
    let policy = match raw {
        None => GatewayModelPolicy::All,
        Some(raw) => {
            serde_json::from_str(raw).map_err(|_| "Stored gateway model policy is invalid")?
        }
    };
    normalize(&policy)
}

pub fn to_json(policy: &GatewayModelPolicy) -> Result<String, String> {
    serde_json::to_string(&normalize(policy)?)
        .map_err(|_| "Cannot encode gateway model policy".into())
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
/// that the strict classifier authorizes. Unknown/encoded paths have no alias.
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

/// Validate the envelope before any upstream connection or discovery request.
pub fn validate_envelope(
    policy: &GatewayModelPolicy,
    method: &Method,
    path_query: &str,
    headers: &HeaderMap,
) -> Result<(), PolicyError> {
    if matches!(policy, GatewayModelPolicy::All) {
        return Ok(());
    }
    if headers.contains_key("upgrade") || *method == Method::CONNECT {
        return Err((
            StatusCode::FORBIDDEN,
            "Selected-model gateways do not support upgrades or unverifiable protocols",
        ));
    }
    let (path, query) = path_query
        .split_once('?')
        .map_or((path_query, None), |(p, q)| (p, Some(q)));
    if query.is_some_and(|query| {
        url::form_urlencoded::parse(query.as_bytes())
            .any(|(key, _)| key.to_ascii_lowercase().starts_with("model"))
    }) {
        return Err((
            StatusCode::BAD_REQUEST,
            "Gateway model must be specified only in the JSON body",
        ));
    }
    if *method == Method::GET && is_discovery_path(path) {
        return Ok(());
    }
    if *method != Method::POST || canonical_inference_path(path).is_none() {
        return Err((
            StatusCode::FORBIDDEN,
            "Endpoint cannot be verified under the gateway model policy",
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
            "Selected-model gateways require an uncompressed application/json body",
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

pub fn validate_body(policy: &GatewayModelPolicy, body: &[u8]) -> Result<(), PolicyError> {
    if let GatewayModelPolicy::Selected { model_ids } = policy {
        let model = serde_json::from_slice::<UniqueModel>(body).map_err(|_| {
            (
                StatusCode::BAD_REQUEST,
                "Gateway request requires a unique, valid JSON model string",
            )
        })?;
        if !model_ids.contains(&model.0) {
            return Err((
                StatusCode::FORBIDDEN,
                "Model is not exposed by this gateway",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn selected() -> GatewayModelPolicy {
        GatewayModelPolicy::Selected {
            model_ids: vec!["allowed".into()],
        }
    }
    #[test]
    fn policy_defaults_and_invalid_storage_fail_closed() {
        assert_eq!(from_json(None).unwrap(), GatewayModelPolicy::All);
        for raw in [
            "null",
            "{}",
            r#"{"mode":"selected","modelIds":[]}"#,
            r#"{"mode":"unknown"}"#,
            r#"{"mode":"all","modelIds":[]}"#,
        ] {
            assert!(from_json(Some(raw)).is_err(), "{raw}");
        }
    }
    #[test]
    fn exact_model_and_unique_field_required() {
        assert!(validate_body(&selected(), br#"{"model":"allowed","messages":[]}"#).is_ok());
        for body in [
            r#"{"model":"other"}"#,
            r#"{"model":"Allowed"}"#,
            r#"{"model":"allowed","model":"other"}"#,
            r#"{"model":null}"#,
            r#"{"model":""}"#,
            "{}",
            "[]",
            r#"{"model":3}"#,
            r#"{"model":"allowed"} garbage"#,
        ] {
            assert!(
                validate_body(&selected(), body.as_bytes()).is_err(),
                "{body}"
            );
        }
    }
    #[test]
    fn closed_endpoint_set_and_envelope() {
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
                validate_envelope(&selected(), &Method::POST, path, &headers).is_ok(),
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
                validate_envelope(&selected(), &Method::POST, path, &headers).is_err(),
                "{path}"
            );
        }
        headers.insert("content-encoding", "gzip".parse().unwrap());
        assert!(validate_envelope(&selected(), &Method::POST, "/responses", &headers).is_err());
        assert!(validate_envelope(
            &GatewayModelPolicy::All,
            &Method::POST,
            "/anything",
            &headers
        )
        .is_ok());
    }
}
