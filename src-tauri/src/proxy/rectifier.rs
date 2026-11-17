//! `/responses` 上游状态整流器。
//!
//! 会话历史里可能带着上游签发的原生状态：推理条目的 `rs_…` id、`encrypted_content`、
//! 消息/函数调用的条目顶层 `id`。中转把后续请求分到另一个 OpenAI / Azure 资源（或另一家
//! 兼容上游）时，对方不认这些状态，会以 400/502 拒绝整轮请求，典型原话是
//! `The requested item was created under a different Azure OpenAI resource.`。
//!
//! 识别这类「上游自证」的拒绝后，去掉资源绑定状态，对同一上游重试一次：
//! - 推理条目整条去掉（它只携带密文，或一个需要回查的 id）；
//! - 其余条目去掉顶层 `id`，`call_id`、正文、工具参数保持原样；
//! - `include` 里去掉 `reasoning.encrypted_content`。
//!
//! 只改发往上游的请求副本，不改本地会话记录；正常请求不会被改写，否则会打乱上游的
//! prompt cache 前缀。思路与 cc-switch 的 `opaque_state_rectifier` 一致（#8877、#9424）。
//!
//! 纯函数模块：不做 IO，不认识 HTTP，方便单测。

use serde_json::{Map, Value};

/// `include` 里请求推理密文的标记：整流时去掉，避免上游再签发一份带不走的密文。
const INCLUDE_REASONING_ENCRYPTED: &str = "reasoning.encrypted_content";

/// 整流结果计数，用于日志（没有任何改动时不会重试）。
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct RectifyReport {
    pub removed_reasoning: usize,
    pub removed_ids: usize,
    pub removed_encrypted: usize,
    pub removed_include: usize,
}

impl RectifyReport {
    pub fn applied(&self) -> bool {
        self.removed_reasoning + self.removed_ids + self.removed_encrypted + self.removed_include
            > 0
    }
}

/// 上游是否自证了「请求里带着我验不了/不属于我的状态」。
///
/// 只认已知措辞（含中转在前面的自由前缀），不把普通 400（模型名错、参数错）卷进重试。
pub fn is_rectifiable_rejection(status: u16, body: &str) -> bool {
    if !(matches!(status, 400..=499) || status == 502) {
        return false;
    }

    let payload = serde_json::from_str::<Value>(body).ok();

    // OpenAI 的推理密文错误码；xAI 把同一件事放在 code/error 里。
    if let Some(payload) = payload.as_ref() {
        if payload.pointer("/error/code").and_then(Value::as_str)
            == Some("invalid_encrypted_content")
        {
            return true;
        }
        if payload.get("code").and_then(Value::as_str) == Some("invalid-argument")
            && error_messages(payload)
                .iter()
                .any(|message| message.starts_with("Could not decrypt"))
        {
            return true;
        }
    }

    let mut messages: Vec<String> = payload
        .as_ref()
        .map(error_messages)
        .unwrap_or_default()
        .into_iter()
        .map(str::to_string)
        .collect();
    // 兜底：错误体可能不是 JSON，或把原文放在别的字段里。
    messages.push(body.to_string());

    messages
        .iter()
        .any(|message| is_rectifiable_message(message))
}

/// 错误体里可能放错误原文的几个位置（与 cc-switch 保持一致）。
fn error_messages(payload: &Value) -> Vec<&str> {
    let mut messages: Vec<&str> = [
        payload.pointer("/error/message"),
        payload.get("message"),
        payload.get("detail"),
    ]
    .into_iter()
    .flatten()
    .filter_map(Value::as_str)
    .collect();
    if let Some(Value::String(error)) = payload.get("error") {
        messages.push(error);
    }
    messages
}

/// 单条错误原文是否属于可整流的拒绝（供流式路径复用）。
pub fn is_rectifiable_message(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    // Azure / OpenAI 资源归属：中转在多个资源间分流时出现。
    (message.contains("created under a different") && message.contains("resource"))
        // 密文由别的身份签发，或换供应商后解不开。
        || (message.contains("encrypted content") && message.contains("could not be verified"))
        || message.contains("could not be decrypted")
        || message.contains("was not issued to this caller")
        // store:false 下按 id 回查不到推理条目。
        || (message.contains("not found") && message.contains("items are not persisted when"))
}

/// 请求里是否带着上游签发的状态（推理条目、条目 id、加密内容、密文 include）。
///
/// 网关用它决定要不要为整流做任何额外工作：没有这些状态的请求（首轮、纯工具调用、
/// 非 Responses 客户端）原样直通，不缓冲、不探测、不多等一毫秒。
pub fn carries_resource_bound_state(body: &[u8]) -> bool {
    let Ok(payload) = serde_json::from_slice::<Value>(body) else {
        return false;
    };
    if payload
        .get("include")
        .and_then(Value::as_array)
        .is_some_and(|include| {
            include
                .iter()
                .any(|entry| entry.as_str() == Some(INCLUDE_REASONING_ENCRYPTED))
        })
    {
        return true;
    }
    payload
        .get("input")
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items.iter().any(|item| {
                item.get("type").and_then(Value::as_str) == Some("reasoning")
                    || item.get("encrypted_content").is_some()
                    || item
                        .as_object()
                        .is_some_and(|object| object.contains_key("id") && has_payload(object))
            })
        })
}

/// 去掉请求里资源绑定的状态；没有可去掉的内容时返回 `None`（不重试）。
///
/// 返回的是重新序列化后的请求体：内容不变、顺序保留，只删字段。
pub fn sanitize_responses_request(body: &[u8]) -> Option<(Vec<u8>, RectifyReport)> {
    let mut payload: Value = serde_json::from_slice(body).ok()?;
    let mut report = RectifyReport::default();

    if let Some(items) = payload.get_mut("input").and_then(Value::as_array_mut) {
        items.retain(|item| {
            if item.get("type").and_then(Value::as_str) == Some("reasoning") {
                report.removed_reasoning += 1;
                return false;
            }
            true
        });

        for item in items.iter_mut() {
            let Some(object) = item.as_object_mut() else {
                continue;
            };
            strip_item_state(object, &mut report);
        }
    }

    if let Some(include) = payload.get_mut("include").and_then(Value::as_array_mut) {
        let before = include.len();
        include.retain(|entry| entry.as_str() != Some(INCLUDE_REASONING_ENCRYPTED));
        report.removed_include += before - include.len();
    }

    if !report.applied() {
        return None;
    }

    serde_json::to_vec(&payload).ok().map(|body| (body, report))
}

/// 单个条目：去掉顶层 `id` 与条目里的加密片段。
///
/// `item_reference` 只靠 id 指向服务端条目，去掉就成了空引用，保留；
/// 只有 `id` 没有载荷的条目同理（删掉 id 会让上游认为这是一个空消息）。
fn strip_item_state(object: &mut Map<String, Value>, report: &mut RectifyReport) {
    let item_type = object
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();

    if item_type != "item_reference" && has_payload(object) && object.remove("id").is_some() {
        report.removed_ids += 1;
    }

    if object.remove("encrypted_content").is_some() {
        report.removed_encrypted += 1;
    }

    if let Some(parts) = object.get_mut("content").and_then(Value::as_array_mut) {
        for part in parts.iter_mut() {
            if let Some(part) = part.as_object_mut() {
                if part.remove("encrypted_content").is_some() {
                    report.removed_encrypted += 1;
                }
            }
        }
    }

    if let Some(parts) = object.get_mut("output").and_then(Value::as_array_mut) {
        for part in parts.iter_mut() {
            if let Some(part) = part.as_object_mut() {
                if part.remove("encrypted_content").is_some() {
                    report.removed_encrypted += 1;
                }
            }
        }
    }
}

/// 条目除了 `id` / `type` 之外还有内容，删掉 id 不会变成空条目。
fn has_payload(object: &Map<String, Value>) -> bool {
    object.keys().any(|key| key != "id" && key != "type")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn recognises_azure_resource_mismatch_with_relay_prefix() {
        let body = r#"{"error":{"message":"OpenAI Responses bad request: The requested item was created under a different Azure OpenAI resource. Use the same resource that created the item to access it. [trace_id=x]","type":"invalid_request_error","code":null}}"#;
        assert!(is_rectifiable_rejection(400, body));
    }

    #[test]
    fn recognises_encrypted_content_rejections() {
        assert!(is_rectifiable_rejection(
            400,
            r#"{"error":{"message":"The encrypted content gAAA was could not be verified. Reason: Encrypted content could not be decrypted or parsed.","code":"invalid_encrypted_content"}}"#
        ));
        assert!(is_rectifiable_rejection(
            502,
            r#"{"error":{"message":"Encrypted function output content could not be decrypted or decoded."}}"#
        ));
    }

    #[test]
    fn ignores_unrelated_bad_requests() {
        assert!(!is_rectifiable_rejection(
            400,
            r#"{"error":{"message":"Invalid value for 'model': gpt-nope"}}"#
        ));
        assert!(!is_rectifiable_rejection(
            400,
            r#"{"error":{"message":"The requested item was not found in this conversation"}}"#
        ));
        assert!(!is_rectifiable_rejection(500, "upstream exploded"));
    }

    #[test]
    fn strips_reasoning_ids_and_encrypted_content() {
        let body = json!({
            "model": "gpt-6.1-sol",
            "store": false,
            "include": ["reasoning.encrypted_content", "other"],
            "input": [
                {"role": "user", "content": "hi"},
                {"type": "reasoning", "id": "rs_123", "encrypted_content": "gAAA", "summary": []},
                {"type": "message", "id": "msg_123", "role": "assistant", "content": [{"type": "output_text", "text": "ok"}]},
                {"type": "function_call", "id": "fc_123", "call_id": "call_1", "name": "bash", "arguments": "{}"},
                {"type": "function_call_output", "id": "fco_1", "call_id": "call_1", "output": "done"},
                {"type": "item_reference", "id": "msg_ref"}
            ]
        });

        let (sanitized, report) =
            sanitize_responses_request(&serde_json::to_vec(&body).unwrap()).unwrap();
        let value: Value = serde_json::from_slice(&sanitized).unwrap();
        let items = value["input"].as_array().unwrap();

        assert_eq!(report.removed_reasoning, 1);
        assert_eq!(report.removed_ids, 3);
        assert_eq!(report.removed_include, 1);
        assert_eq!(items.len(), 5);
        assert_eq!(items[1]["type"], "message");
        assert!(items[1].get("id").is_none());
        assert_eq!(items[1]["role"], "assistant");
        assert_eq!(items[4]["type"], "item_reference");
        assert_eq!(items[4]["id"], "msg_ref");
        assert_eq!(value["include"], json!(["other"]));
        // 工具调用与结果的配对字段不能动
        assert_eq!(items[2]["call_id"], "call_1");
        assert_eq!(items[3]["call_id"], "call_1");
        assert_eq!(items[2]["name"], "bash");
        assert_eq!(items[3]["output"], "done");
    }

    #[test]
    fn returns_none_when_nothing_to_strip() {
        let body = json!({
            "input": [
                {"role": "user", "content": "hi"},
                {"type": "function_call", "call_id": "call_1", "name": "bash", "arguments": "{}"}
            ]
        });
        assert!(sanitize_responses_request(&serde_json::to_vec(&body).unwrap()).is_none());
    }

    #[test]
    fn detects_only_requests_that_carry_resource_bound_state() {
        let plain = json!({"input": [{"role": "user", "content": "hi"}]});
        assert!(!carries_resource_bound_state(
            &serde_json::to_vec(&plain).unwrap()
        ));

        let reasoning = json!({"input": [{"type": "reasoning", "id": "rs_1", "encrypted_content": "gAAA"}]});
        assert!(carries_resource_bound_state(
            &serde_json::to_vec(&reasoning).unwrap()
        ));

        let item_id = json!({"input": [{"type": "message", "id": "msg_1", "role": "assistant", "content": []}]});
        assert!(carries_resource_bound_state(
            &serde_json::to_vec(&item_id).unwrap()
        ));

        let include = json!({"include": ["reasoning.encrypted_content"], "input": []});
        assert!(carries_resource_bound_state(
            &serde_json::to_vec(&include).unwrap()
        ));

        assert!(!carries_resource_bound_state(b"not json"));
    }

    #[test]
    fn sanitize_is_idempotent() {
        let body = json!({
            "include": ["reasoning.encrypted_content"],
            "input": [
                {"type": "reasoning", "id": "rs_1", "encrypted_content": "gAAA"},
                {"type": "message", "id": "msg_1", "role": "assistant", "content": []}
            ]
        });
        let (once, _) = sanitize_responses_request(&serde_json::to_vec(&body).unwrap()).unwrap();
        assert!(sanitize_responses_request(&once).is_none());
    }
}
