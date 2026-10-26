//! Claude Code auto mode request identification and response compatibility.
//!
//! Auto mode itself runs inside Claude Code. The proxy only labels classifier
//! traffic for the console/statistics and repairs a non-streaming Messages
//! response whose MIME type an upstream mislabelled.
use serde_json::Value;

const CLASSIFIER_PREFIX: &str = "You are a security monitor for autonomous AI coding agents.";

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
    // arbitrary user/tool content. Server-side review does not use this shape;
    // it arrives on ordinary requests with `safeguards` instead.
    let system_matches = text_blocks(&body["system"])
        .iter()
        .any(|text| text.contains(CLASSIFIER_PREFIX));
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn classifier_body() -> Value {
        json!({
            "model": "original",
            "system": CLASSIFIER_PREFIX,
            "messages": [{"role": "user", "content": "<transcript>x</transcript>"}]
        })
    }

    #[test]
    fn recognises_the_classifier_envelope() {
        assert!(is_classifier(&classifier_body()));
        let mut body = classifier_body();
        body["system"] = json!([{"type": "text", "text": format!("prefix {CLASSIFIER_PREFIX}")}]);
        assert!(is_classifier(&body));
    }

    #[test]
    fn rejects_requests_that_carry_tools_or_lack_the_transcript() {
        let mut with_tools = classifier_body();
        with_tools["tools"] = json!([{"name": "Bash"}]);
        assert!(!is_classifier(&with_tools));

        let mut without_transcript = classifier_body();
        without_transcript["messages"] = json!([{"role": "user", "content": "hello"}]);
        assert!(!is_classifier(&without_transcript));

        let mut wrong_role = classifier_body();
        wrong_role["messages"] =
            json!([{"role": "assistant", "content": "<transcript>x</transcript>"}]);
        assert!(!is_classifier(&wrong_role));
    }

    #[test]
    fn ignores_the_prefix_outside_the_system_role() {
        let body = json!({
            "messages": [{"role": "user", "content": CLASSIFIER_PREFIX}]
        });
        assert!(!is_classifier(&body));
    }

    #[test]
    fn validates_only_complete_message_envelopes() {
        let valid = br#"{"type":"message","role":"assistant","content":[],"usage":{"input_tokens":1,"output_tokens":2}}"#;
        assert!(is_message_response(valid));
        assert!(!is_message_response(
            br#"{"type":"message","role":"assistant","content":[]}"#
        ));
        assert!(!is_message_response(
            br#"{"type":"error","error":{"type":"api_error"}}"#
        ));
        assert!(!is_message_response(b"event: message_start\ndata: {}\n\n"));
    }
}
