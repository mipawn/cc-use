//! Claude Code permission classifier detection, opt-in model adaptation, and
//! validated response compatibility.
use axum::body::Bytes;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::{Duration, Instant};

const CLASSIFIER_PREFIX: &str = "You are a security monitor for autonomous AI coding agents.";
const MAX_SESSIONS: usize = 1024;
const SESSION_TTL: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Default)]
pub(super) struct AutoModeState {
    models: HashMap<(String, String), (String, Instant)>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Mapping {
    auto_mode: Option<Config>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    #[serde(default)]
    enabled: bool,
    model: Option<String>,
    thinking: Option<String>,
}

/// Claude Code sends `metadata.user_id` as a JSON *string*, with the
/// conversation id inside it. Shared so the Go adapter and the Auto mode cache
/// agree on what a native conversation id is.
pub(super) fn claude_session_id(body: &Value) -> Option<String> {
    let metadata = body["metadata"]["user_id"]
        .as_str()
        .and_then(|value| serde_json::from_str::<Value>(value).ok())?;
    metadata["session_id"]
        .as_str()
        .map(str::trim)
        .filter(|session| !session.is_empty())
        .map(str::to_string)
}

fn text_blocks(value: &Value) -> Vec<&str> {
    if let Some(text) = value.as_str() {
        return vec![text];
    }
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|block| {
            (block["type"] == "text")
                .then(|| block["text"].as_str())
                .flatten()
        })
        .collect()
}

pub(super) fn is_classifier(body: &Value) -> bool {
    // Match the system role and the final transcript envelope, never words in
    // arbitrary user/tool content. Verified against Claude Code 2.1.220.
    let system_matches = text_blocks(&body["system"])
        .iter()
        .any(|text| text.trim_start().starts_with(CLASSIFIER_PREFIX));
    let last = body["messages"]
        .as_array()
        .and_then(|messages| messages.last());
    system_matches
        && last.is_some_and(|message| {
            if message["role"] != "user" {
                return false;
            }
            let blocks = text_blocks(&message["content"]);
            blocks
                .first()
                .is_some_and(|text| text.trim_start().starts_with("<transcript>"))
                && blocks.iter().any(|text| text.contains("</transcript>"))
        })
        && body["tools"].as_array().is_none_or(Vec::is_empty)
}

/// Some gateways label non-streaming Messages JSON as text/plain. The Anthropic
/// SDK then returns a string and Claude Code crashes when accessing its usage.
/// Validate the message envelope before correcting the MIME type; never change
/// the classifier's verdict, compressed bytes, or an upstream error response.
pub(super) fn is_message_response(bytes: &[u8]) -> bool {
    let Ok(body) = serde_json::from_slice::<Value>(bytes) else {
        return false;
    };
    body["type"] == "message"
        && body["role"] == "assistant"
        && body["content"].is_array()
        && body["usage"]["input_tokens"].as_u64().is_some()
        && body["usage"]["output_tokens"].as_u64().is_some()
}

impl AutoModeState {
    pub(super) fn adapt(&mut self, bytes: Bytes, mapping: &str, route_scope: &str) -> Bytes {
        let Some(config) = serde_json::from_str::<Mapping>(mapping)
            .ok()
            .and_then(|mapping| mapping.auto_mode)
            .filter(|config| config.enabled)
        else {
            return bytes;
        };
        let Ok(mut body) = serde_json::from_slice::<Value>(&bytes) else {
            return bytes;
        };
        let Some(model) = body["model"]
            .as_str()
            .filter(|model| !model.trim().is_empty())
        else {
            return bytes;
        };
        // A proxy token can serve multiple Claude conversations. Use Claude's
        // own session ID as well; never reuse another conversation's model.
        let session_id = claude_session_id(&body);
        let session_id = session_id.as_deref();
        let scope = session_id.map(|session| (route_scope.to_string(), session.to_string()));
        self.models
            .retain(|_, (_, seen)| seen.elapsed() < SESSION_TTL);

        if !is_classifier(&body) {
            // Side queries (titles, compaction, classifier calls) have no tools.
            // Only remember the model used for the session's agent requests.
            if body["tools"]
                .as_array()
                .is_some_and(|tools| !tools.is_empty())
            {
                if let Some(scope) = scope {
                    if self.models.len() >= MAX_SESSIONS && !self.models.contains_key(&scope) {
                        if let Some(oldest) = self
                            .models
                            .iter()
                            .min_by_key(|(_, (_, seen))| *seen)
                            .map(|(key, _)| key.clone())
                        {
                            self.models.remove(&oldest);
                        }
                    }
                    self.models
                        .insert(scope, (model.to_string(), Instant::now()));
                }
            }
            return bytes;
        }

        let target = config
            .model
            .as_deref()
            .map(str::trim)
            .filter(|model| !model.is_empty())
            .or_else(|| {
                scope
                    .as_ref()
                    .and_then(|scope| self.models.get(scope))
                    .map(|(model, _)| model.as_str())
            });
        if let Some(target) = target {
            body["model"] = json!(target.trim_end_matches("[1m]").trim());
        }
        match config.thinking.as_deref().unwrap_or("low") {
            "low" => {
                // Keep enough visible output after the thinking budget for the
                // classifier's XML verdict, including its short first stage.
                body["thinking"] = json!({"type": "enabled", "budget_tokens": 1024});
                let max_tokens = body["max_tokens"].as_u64().unwrap_or(0).max(4096);
                body["max_tokens"] = json!(max_tokens);
                if body.get("output_config").is_none_or(Value::is_null) {
                    body["output_config"] = json!({});
                }
                if let Some(output) = body["output_config"].as_object_mut() {
                    output.insert("effort".to_string(), json!("low"));
                }
                body.as_object_mut().unwrap().remove("temperature");
                body.as_object_mut().unwrap().remove("top_p");
                body.as_object_mut().unwrap().remove("top_k");
            }
            "disabled" => {
                body["thinking"] = json!({"type": "disabled"});
                if let Some(output) = body["output_config"].as_object_mut() {
                    output.remove("effort");
                }
            }
            _ => {} // Unknown/future settings preserve the request's thinking.
        }
        serde_json::to_vec(&body).map(Bytes::from).unwrap_or(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn string_prompts_follow_only_the_same_route_and_identified_session() {
        let mut state = AutoModeState::default();
        let mapping = r#"{"autoMode":{"enabled":true,"thinking":"preserve"}}"#;
        let main = json!({"model":"glm-5", "tools":[{"name":"Bash"}],
            "metadata":{"user_id":"{\"session_id\":\"same-session\"}"}});
        state.adapt(Bytes::from(main.to_string()), mapping, "route-a");
        let classifier = json!({"model":"original", "system":CLASSIFIER_PREFIX,
            "messages":[{"role":"user","content":"<transcript>test</transcript>"}],
            "metadata":main["metadata"]});
        let adapt = |state: &mut AutoModeState, body: &Value, route| {
            serde_json::from_slice::<Value>(&state.adapt(
                Bytes::from(body.to_string()),
                mapping,
                route,
            ))
            .unwrap()
        };
        assert_eq!(adapt(&mut state, &classifier, "route-a")["model"], "glm-5");
        assert_eq!(
            adapt(&mut state, &classifier, "route-b")["model"],
            "original"
        );
        let mut anonymous = classifier.clone();
        anonymous.as_object_mut().unwrap().remove("metadata");
        assert_eq!(
            adapt(&mut state, &anonymous, "route-a")["model"],
            "original"
        );
    }

    #[test]
    fn unknown_or_malformed_requests_and_configuration_pass_through() {
        let mut state = AutoModeState::default();
        let mapping = r#"{"autoMode":{"enabled":true}}"#;
        for input in ["not json", "null", "[]", r#"{"model":null}"#] {
            let body = Bytes::from(input);
            assert_eq!(state.adapt(body.clone(), mapping, "route"), body);
        }
        let body = Bytes::from(r#"{"model":"original"}"#);
        for invalid_mapping in ["{", "null", r#"{"autoMode":true}"#] {
            assert_eq!(state.adapt(body.clone(), invalid_mapping, "route"), body);
        }
    }
}
