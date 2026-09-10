//! Structured records of what Auto mode asked the safety classifier to review.
//!
//! A record answers "what was reviewed, by which model, and what came back" for
//! one classifier request. It deliberately keeps three facts apart that are
//! easy to conflate: the transport succeeded, the model returned a verdict, and
//! the client actually ran the tool. The proxy only ever observes the first two.
//!
//! Nothing here stores a transcript, a request body or a model's private
//! reasoning. Parsing reads the classifier's *final visible text* only.

use serde_json::Value;

/// Bounds on what is persisted, so one record cannot grow without limit.
pub const ACTION_SUMMARY_LIMIT: usize = 512;
pub const VERDICT_REASON_LIMIT: usize = 512;

/// What the classifier said about the action under review.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// The classifier blocked the action.
    Block,
    /// The classifier let the action through its own check. This is not the
    /// same as the client having executed the tool.
    NoBlock,
    /// Nothing parseable was found. Never rendered as "allowed".
    Unknown,
}

impl Verdict {
    pub fn as_str(self) -> &'static str {
        match self {
            Verdict::Block => "block",
            Verdict::NoBlock => "no_block",
            Verdict::Unknown => "unknown",
        }
    }
}

/// The classifier's answer, read from its final visible text.
///
/// Claude Code writes the decision as `<block>yes</block>` / `<block>no</block>`
/// and may stop *at* `</block>`, so an unterminated trailing `<block>X` is the
/// same answer as a closed one. Only `text` blocks are read: a `<block>` string
/// inside a `thinking` block is the model reasoning about the word, not a
/// verdict, and the request body is never consulted.
///
/// Returns the verdict, the text it was read from, and whether that reading is
/// trustworthy. A missing or unparseable answer is `Unknown`, never `NoBlock`.
pub fn parse_verdict(response: &Value) -> (Verdict, Option<String>, bool) {
    let Some(text) = final_visible_text(response) else {
        return (Verdict::Unknown, None, false);
    };

    let verdict = match last_block_tag(&text) {
        Some("yes") => Verdict::Block,
        Some("no") => Verdict::NoBlock,
        _ => Verdict::Unknown,
    };
    let parse_ok = verdict != Verdict::Unknown;
    (verdict, Some(text), parse_ok)
}

/// The last `<block>…` marker in the text, handling the stop-sequence form
/// where the closing tag never arrives.
fn last_block_tag(text: &str) -> Option<&str> {
    let mut cursor = text;
    let mut found: Option<&str> = None;
    while let Some(index) = cursor.find("<block>") {
        let after = &cursor[index + "<block>".len()..];
        let value = after.split("</block>").next().unwrap_or(after).trim();
        found = Some(value);
        cursor = after;
    }
    // `<block>no` may carry a trailing partial stop sequence; the answer is the
    // first token.
    found.map(|value| value.split_whitespace().next().unwrap_or(value))
}

/// Concatenate the assistant's visible text blocks, ignoring `thinking`.
fn final_visible_text(response: &Value) -> Option<String> {
    let content = response.get("content")?.as_array()?;
    let text: String = content
        .iter()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("");
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// The action awaiting review, read from the classifier's transcript.
///
/// Claude Code encloses the conversation in `<transcript>` and describes a tool
/// call with a `<tool_use>` block. Only the **last** one is of interest: the
/// classifier is deciding about the pending action, and older calls in the same
/// transcript were already decided.
///
/// The shape is not guaranteed by a published contract, so an unrecognized
/// transcript yields `None` rather than a guess — and the caller records that
/// as unknown instead of inventing an action.
pub fn parse_pending_action(body: &Value) -> Option<PendingAction> {
    let transcript = transcript_text(body)?;
    let last = last_tool_use(transcript)?;

    let name = element_text(last, "tool_name")?;
    let tool_use_id = element_text(last, "tool_use_id");
    let parameters = element_text(last, "parameters").unwrap_or_default();
    let (summary, truncated) = summarize_action(&name, &parameters);

    Some(PendingAction {
        tool_name: name,
        tool_use_id,
        summary,
        truncated,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingAction {
    pub tool_name: String,
    pub tool_use_id: Option<String>,
    pub summary: String,
    pub truncated: bool,
}

/// The `<transcript>` body of the classifier's last user turn.
fn transcript_text(body: &Value) -> Option<&str> {
    let messages = body.get("messages")?.as_array()?;
    let content = messages.last()?.get("content")?;

    let blocks: Vec<&str> = match content {
        Value::String(text) => vec![text.as_str()],
        Value::Array(items) => items
            .iter()
            .filter_map(|item| item.get("text").and_then(Value::as_str))
            .collect(),
        _ => return None,
    };

    blocks
        .into_iter()
        .find(|text| text.trim_start().starts_with("<transcript>"))
        .and_then(|text| {
            let start = text.find("<transcript>")? + "<transcript>".len();
            let rest = &text[start..];
            Some(rest.split("</transcript>").next().unwrap_or(rest))
        })
}

/// The last `<tool_use>…</tool_use>` block in the transcript.
fn last_tool_use(transcript: &str) -> Option<&str> {
    let mut cursor = transcript;
    let mut found: Option<&str> = None;
    while let Some(index) = cursor.find("<tool_use>") {
        let start = index + "<tool_use>".len();
        let after = &cursor[start..];
        let block = after.split("</tool_use>").next().unwrap_or(after);
        found = Some(block);
        cursor = after;
    }
    found
}

fn element_text<'a>(block: &'a str, tag: &str) -> Option<String> {
    let open = format!("<{}>", tag);
    let close = format!("</{}>", tag);
    let start = block.find(&open)? + open.len();
    let rest = &block[start..];
    let value = rest.split(&close).next().unwrap_or(rest).trim();
    (!value.is_empty()).then(|| value.to_string())
}

/// `Bash · git status` — a short, redacted description of the pending action.
///
/// Only the credential-redacted, length-bounded leading portion of the
/// parameters is kept. When the parameters cannot be read safely the tool name
/// alone is recorded, which is the doc's stated fallback.
fn summarize_action(tool_name: &str, parameters: &str) -> (String, bool) {
    let redacted = crate::proxy::console::desensitize_body(parameters);
    // Collapse whitespace so a multi-line command still reads as one line.
    let compact: String = redacted.split_whitespace().collect::<Vec<_>>().join(" ");

    if compact.is_empty() {
        return (tool_name.to_string(), false);
    }

    let summary = format!("{} · {}", tool_name, compact);
    if summary.len() <= ACTION_SUMMARY_LIMIT {
        return (summary, false);
    }

    let mut truncated = String::new();
    for ch in summary.chars() {
        if truncated.len() + ch.len_utf8() > ACTION_SUMMARY_LIMIT {
            break;
        }
        truncated.push(ch);
    }
    (truncated, true)
}

/// Clamp a reason string to what the record is allowed to hold.
pub fn clamp_reason(reason: &str) -> (String, bool) {
    let redacted = crate::proxy::console::desensitize_body(reason);
    let compact: String = redacted.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.len() <= VERDICT_REASON_LIMIT {
        return (compact, false);
    }
    let mut truncated = String::new();
    for ch in compact.chars() {
        if truncated.len() + ch.len_utf8() > VERDICT_REASON_LIMIT {
            break;
        }
        truncated.push(ch);
    }
    (truncated, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn message_with(content: Value) -> Value {
        json!({ "type": "message", "role": "assistant", "content": content })
    }

    #[test]
    fn a_closed_block_tag_is_read_as_the_verdict() {
        let response = message_with(json!([{ "type": "text", "text": "<block>no</block>" }]));
        let (verdict, _, parse_ok) = parse_verdict(&response);
        assert_eq!(verdict, Verdict::NoBlock);
        assert!(parse_ok);

        let response = message_with(json!([{ "type": "text", "text": "<block>yes</block>" }]));
        assert_eq!(parse_verdict(&response).0, Verdict::Block);
    }

    /// Claude Code may stop *at* the closing tag, so the text ends mid-marker.
    #[test]
    fn an_unterminated_block_tag_is_still_the_verdict() {
        let response = message_with(json!([{ "type": "text", "text": "<block>no" }]));
        let (verdict, _, parse_ok) = parse_verdict(&response);

        assert_eq!(verdict, Verdict::NoBlock);
        assert!(parse_ok);
    }

    /// The model's private reasoning is not its answer.
    #[test]
    fn a_block_tag_inside_thinking_is_not_a_verdict() {
        let response = message_with(json!([
            { "type": "thinking", "thinking": "I could answer <block>no</block> here" },
        ]));

        let (verdict, _, parse_ok) = parse_verdict(&response);

        assert_eq!(verdict, Verdict::Unknown);
        assert!(!parse_ok);
    }

    #[test]
    fn only_the_final_answer_counts_when_the_model_considers_both() {
        let response = message_with(json!([
            { "type": "thinking", "thinking": "weighing <block>yes</block>" },
            { "type": "text", "text": "Considering it.\n<block>no</block>" },
        ]));

        assert_eq!(parse_verdict(&response).0, Verdict::NoBlock);
    }

    #[test]
    fn an_unreadable_answer_stays_unknown_rather_than_becoming_allowed() {
        for response in [
            message_with(json!([{ "type": "text", "text": "I cannot determine this." }])),
            message_with(json!([])),
            json!({ "type": "message", "role": "assistant" }),
            json!({ "error": { "type": "overloaded_error" } }),
        ] {
            let (verdict, _, parse_ok) = parse_verdict(&response);
            assert_eq!(verdict, Verdict::Unknown, "{:?}", response);
            assert!(!parse_ok);
        }
    }

    fn classifier_body(transcript: &str) -> Value {
        json!({
            "messages": [
                { "role": "user", "content": "earlier" },
                { "role": "user", "content": format!("<transcript>{}</transcript>", transcript) }
            ]
        })
    }

    #[test]
    fn the_pending_action_is_the_last_tool_call_in_the_transcript() {
        let body = classifier_body(
            r#"
            <tool_use>
            <tool_name>Read</tool_name>
            <tool_use_id>tool-1</tool_use_id>
            <parameters>{"file_path":"/tmp/a"}</parameters>
            </tool_use>
            <tool_result>ok</tool_result>
            <tool_use>
            <tool_name>Bash</tool_name>
            <tool_use_id>tool-2</tool_use_id>
            <parameters>{"command":"git status"}</parameters>
            </tool_use>
            "#,
        );

        let action = parse_pending_action(&body).expect("action");

        // The earlier Read was already decided; only the pending one matters.
        assert_eq!(action.tool_name, "Bash");
        assert_eq!(action.tool_use_id.as_deref(), Some("tool-2"));
        assert_eq!(action.summary, "Bash · {\"command\":\"git status\"}");
        assert!(!action.truncated);
    }

    #[test]
    fn a_transcript_shape_this_build_does_not_recognize_yields_nothing() {
        // Better an empty record than a fabricated action.
        assert!(parse_pending_action(&classifier_body("just prose, no tool calls")).is_none());
        assert!(parse_pending_action(&json!({ "messages": [] })).is_none());
    }

    #[test]
    fn a_credential_in_the_parameters_never_reaches_the_summary() {
        let body = classifier_body(
            r#"<tool_use><tool_name>Bash</tool_name><parameters>{"command":"curl -H 'Authorization: Bearer sk-live-abcdef123456' https://x"}</parameters></tool_use>"#,
        );

        let action = parse_pending_action(&body).expect("action");

        assert!(
            !action.summary.contains("sk-live-abcdef123456"),
            "{}",
            action.summary
        );
        assert!(action.summary.starts_with("Bash ·"));
    }

    #[test]
    fn a_very_long_action_is_clamped_and_flagged() {
        let body = classifier_body(&format!(
            r#"<tool_use><tool_name>Bash</tool_name><parameters>{}</parameters></tool_use>"#,
            "x".repeat(4_000)
        ));

        let action = parse_pending_action(&body).expect("action");

        assert!(action.truncated);
        assert!(action.summary.len() <= ACTION_SUMMARY_LIMIT);
    }

    #[test]
    fn an_action_without_parameters_still_records_the_tool() {
        let body = classifier_body(
            r#"<tool_use><tool_name>TodoWrite</tool_name><parameters></parameters></tool_use>"#,
        );

        let action = parse_pending_action(&body).expect("action");

        assert_eq!(action.summary, "TodoWrite");
    }
}
