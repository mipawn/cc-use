//! Codex Responses API → OpenAI Chat Completions API 请求转换
//!
//! 场景：用户用 Codex CLI（发 Responses 请求），但 Provider 只提供 OpenAI
//! Chat Completions API（如 DeepSeek、Kimi、MiniMax）。
//!
//! Responses 与 Chat 的请求体**并不一致**，需要字段级映射（对照 cc-switch
//! `responses_to_chat_completions`，见 docs/v3.2.0/04 §4）：
//!
//! - `instructions` → 首条 `system` 消息
//! - `input`（string 或 items 数组）→ `messages`
//!   - message item：`content` parts 的 text 拼接为字符串
//!   - function_call → assistant `tool_calls`
//!   - function_call_output → `tool` 消息
//! - `max_output_tokens` → `max_tokens`（reasoning 模型用 `max_completion_tokens`）
//! - `tools`：Responses 扁平 function → Chat 嵌套 `function`，工具名拍平 ≤64 字符
//! - 流式注入 `stream_options.include_usage`（否则第三方流式 token/费用漏记）
//! - 多条 system 合并到首条（MiniMax 约束）
//!
//! 注：响应方向（Chat → Responses，含 SSE 重建）见 `chat_to_codex`。

use crate::proxy::transform::TransformedRequest;
use serde_json::{json, Map, Value};

/// 将 Codex Responses 请求转换为 OpenAI Chat Completions 请求。
///
/// - `body`: Codex Responses 请求体
/// - `target_model`: 目标模型名（None 则沿用原 model）
pub fn transform_request(body: Value, target_model: Option<&str>) -> TransformedRequest {
    let mut chat = Map::new();

    let model = target_model
        .map(str::to_string)
        .or_else(|| body.get("model").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_default();
    if !model.is_empty() {
        chat.insert("model".to_string(), json!(model));
    }

    // instructions(system) + input items → messages
    let mut messages: Vec<Value> = Vec::new();
    if let Some(instr) = body.get("instructions").and_then(Value::as_str) {
        if !instr.is_empty() {
            messages.push(json!({ "role": "system", "content": instr }));
        }
    }
    match body.get("input") {
        Some(Value::String(s)) => messages.push(json!({ "role": "user", "content": s })),
        Some(Value::Array(items)) => {
            for item in items {
                if let Some(msg) = input_item_to_message(item) {
                    messages.push(msg);
                }
            }
        }
        _ => {}
    }
    collapse_system_messages_to_head(&mut messages);
    chat.insert("messages".to_string(), json!(messages));

    // max_output_tokens → max_tokens / max_completion_tokens
    if let Some(max) = body.get("max_output_tokens").and_then(Value::as_u64) {
        let key = if is_reasoning_model(&model) {
            "max_completion_tokens"
        } else {
            "max_tokens"
        };
        chat.insert(key.to_string(), json!(max));
    } else if let Some(max) = body.get("max_tokens").and_then(Value::as_u64) {
        chat.insert("max_tokens".to_string(), json!(max));
    }

    for key in ["temperature", "top_p"] {
        if let Some(v) = body.get(key) {
            chat.insert(key.to_string(), v.clone());
        }
    }

    // 流式：注入 include_usage，确保第三方流式回传 usage（token/费用）
    if body.get("stream").and_then(Value::as_bool).unwrap_or(false) {
        chat.insert("stream".to_string(), json!(true));
        chat.insert(
            "stream_options".to_string(),
            json!({ "include_usage": true }),
        );
    }

    // tools / tool_choice
    if let Some(tools) = body.get("tools").and_then(Value::as_array) {
        let mapped: Vec<Value> = tools.iter().filter_map(tool_to_chat_tool).collect();
        if !mapped.is_empty() {
            chat.insert("tools".to_string(), json!(mapped));
        }
    }
    if let Some(tc) = body.get("tool_choice") {
        chat.insert("tool_choice".to_string(), tc.clone());
    }

    TransformedRequest {
        body: Value::Object(chat),
        path: Some("/v1/chat/completions".to_string()),
        content_type: Some("application/json".to_string()),
    }
}

/// 单个 Responses `input` item → Chat message。
fn input_item_to_message(item: &Value) -> Option<Value> {
    let item_type = item.get("type").and_then(Value::as_str).unwrap_or("message");
    match item_type {
        "message" => {
            let role = item.get("role").and_then(Value::as_str).unwrap_or("user");
            let content = extract_content_text(item.get("content"));
            Some(json!({ "role": role, "content": content }))
        }
        "function_call" => {
            let name = item.get("name").and_then(Value::as_str).unwrap_or_default();
            let arguments = item.get("arguments").and_then(Value::as_str).unwrap_or("{}");
            let call_id = item
                .get("call_id")
                .or_else(|| item.get("id"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            Some(json!({
                "role": "assistant",
                "content": Value::Null,
                "tool_calls": [{
                    "id": call_id,
                    "type": "function",
                    "function": { "name": flatten_tool_name(name), "arguments": arguments }
                }]
            }))
        }
        "function_call_output" => {
            let call_id = item.get("call_id").and_then(Value::as_str).unwrap_or_default();
            let output = item.get("output").map(value_to_text).unwrap_or_default();
            Some(json!({ "role": "tool", "tool_call_id": call_id, "content": output }))
        }
        _ => None,
    }
}

/// 提取 message content 的纯文本（content 可能是 string 或 parts 数组）。
fn extract_content_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

/// Responses function tool → Chat 嵌套 function tool。
fn tool_to_chat_tool(tool: &Value) -> Option<Value> {
    // 已是 Chat 形态（带嵌套 function）则原样保留。
    if tool.get("function").is_some() {
        return Some(tool.clone());
    }
    let name = tool.get("name").and_then(Value::as_str)?;
    let mut function = Map::new();
    function.insert("name".to_string(), json!(flatten_tool_name(name)));
    if let Some(desc) = tool.get("description") {
        function.insert("description".to_string(), desc.clone());
    }
    if let Some(params) = tool.get("parameters") {
        function.insert("parameters".to_string(), params.clone());
    }
    Some(json!({ "type": "function", "function": function }))
}

/// 命名空间工具名拍平 + 截断到 64 字符（OpenAI function name 上限）。
fn flatten_tool_name(name: &str) -> String {
    let flat: String = name
        .chars()
        .map(|c| match c {
            '.' | '/' | ' ' | ':' => '_',
            other => other,
        })
        .collect();
    if flat.chars().count() > 64 {
        flat.chars().take(64).collect()
    } else {
        flat
    }
}

/// 多条 system 合并到首条（MiniMax 等要求 system 单条置顶）。
fn collapse_system_messages_to_head(messages: &mut Vec<Value>) {
    let systems: Vec<String> = messages
        .iter()
        .filter(|m| m.get("role").and_then(Value::as_str) == Some("system"))
        .map(|m| extract_content_text(m.get("content")))
        .collect();
    if systems.len() <= 1 {
        return;
    }
    let merged = systems.join("\n\n");
    messages.retain(|m| m.get("role").and_then(Value::as_str) != Some("system"));
    messages.insert(0, json!({ "role": "system", "content": merged }));
}

fn is_reasoning_model(model: &str) -> bool {
    let m = model.to_lowercase();
    m.starts_with("o1") || m.starts_with("o3") || m.starts_with("o4") || m.starts_with("gpt-5")
}

fn value_to_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn instructions_become_system_message() {
        let req = json!({
            "model": "gpt-5",
            "instructions": "You are helpful.",
            "input": "hello"
        });
        let out = transform_request(req, None);
        let msgs = out.body["messages"].as_array().unwrap();
        assert_eq!(msgs[0]["role"], "system");
        assert_eq!(msgs[0]["content"], "You are helpful.");
        assert_eq!(msgs[1]["role"], "user");
        assert_eq!(msgs[1]["content"], "hello");
        assert_eq!(out.path.as_deref(), Some("/v1/chat/completions"));
    }

    #[test]
    fn input_message_parts_are_flattened_to_text() {
        let req = json!({
            "model": "deepseek-chat",
            "input": [
                {"type":"message","role":"user","content":[
                    {"type":"input_text","text":"hi "},
                    {"type":"input_text","text":"there"}
                ]}
            ]
        });
        let out = transform_request(req, None);
        let msgs = out.body["messages"].as_array().unwrap();
        assert_eq!(msgs[0]["role"], "user");
        assert_eq!(msgs[0]["content"], "hi there");
    }

    #[test]
    fn function_call_becomes_tool_calls() {
        let req = json!({
            "model": "deepseek-chat",
            "input": [
                {"type":"function_call","call_id":"call_1","name":"get_weather","arguments":"{\"city\":\"SF\"}"}
            ]
        });
        let out = transform_request(req, None);
        let msg = &out.body["messages"][0];
        assert_eq!(msg["role"], "assistant");
        assert_eq!(msg["tool_calls"][0]["id"], "call_1");
        assert_eq!(msg["tool_calls"][0]["function"]["name"], "get_weather");
        assert_eq!(msg["tool_calls"][0]["function"]["arguments"], "{\"city\":\"SF\"}");
    }

    #[test]
    fn function_call_output_becomes_tool_message() {
        let req = json!({
            "model": "deepseek-chat",
            "input": [
                {"type":"function_call_output","call_id":"call_1","output":"sunny"}
            ]
        });
        let out = transform_request(req, None);
        let msg = &out.body["messages"][0];
        assert_eq!(msg["role"], "tool");
        assert_eq!(msg["tool_call_id"], "call_1");
        assert_eq!(msg["content"], "sunny");
    }

    #[test]
    fn max_output_tokens_maps_to_max_tokens_for_chat_model() {
        let req = json!({"model":"deepseek-chat","input":"hi","max_output_tokens":2048});
        let out = transform_request(req, None);
        assert_eq!(out.body["max_tokens"], 2048);
        assert!(out.body.get("max_completion_tokens").is_none());
    }

    #[test]
    fn max_output_tokens_maps_to_max_completion_tokens_for_reasoning_model() {
        let req = json!({"model":"o3-mini","input":"hi","max_output_tokens":2048});
        let out = transform_request(req, None);
        assert_eq!(out.body["max_completion_tokens"], 2048);
        assert!(out.body.get("max_tokens").is_none());
    }

    #[test]
    fn stream_injects_include_usage() {
        let req = json!({"model":"deepseek-chat","input":"hi","stream":true});
        let out = transform_request(req, None);
        assert_eq!(out.body["stream"], true);
        assert_eq!(out.body["stream_options"]["include_usage"], true);
    }

    #[test]
    fn non_stream_has_no_stream_options() {
        let req = json!({"model":"deepseek-chat","input":"hi"});
        let out = transform_request(req, None);
        assert!(out.body.get("stream_options").is_none());
    }

    #[test]
    fn tools_flatten_to_nested_function() {
        let req = json!({
            "model":"deepseek-chat","input":"hi",
            "tools":[{"type":"function","name":"my.tool.name","description":"d","parameters":{"type":"object"}}]
        });
        let out = transform_request(req, None);
        let tool = &out.body["tools"][0];
        assert_eq!(tool["type"], "function");
        assert_eq!(tool["function"]["name"], "my_tool_name");
        assert_eq!(tool["function"]["description"], "d");
        assert_eq!(tool["function"]["parameters"]["type"], "object");
    }

    #[test]
    fn multiple_system_messages_collapse_to_head() {
        let req = json!({
            "model":"deepseek-chat",
            "instructions":"sys A",
            "input":[
                {"type":"message","role":"system","content":"sys B"},
                {"type":"message","role":"user","content":"hi"}
            ]
        });
        let out = transform_request(req, None);
        let msgs = out.body["messages"].as_array().unwrap();
        assert_eq!(msgs[0]["role"], "system");
        assert_eq!(msgs[0]["content"], "sys A\n\nsys B");
        let system_count = msgs.iter().filter(|m| m["role"] == "system").count();
        assert_eq!(system_count, 1);
        assert_eq!(msgs[1]["role"], "user");
    }

    #[test]
    fn target_model_overrides_original() {
        let req = json!({"model":"gpt-5","input":"hi"});
        let out = transform_request(req, Some("deepseek-chat"));
        assert_eq!(out.body["model"], "deepseek-chat");
    }
}
