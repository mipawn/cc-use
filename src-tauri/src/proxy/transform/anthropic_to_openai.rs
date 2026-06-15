//! Anthropic Messages API → OpenAI Chat Completions API 请求转换
//!
//! 场景：用户使用 Claude Code CLI，但 Provider 只提供 OpenAI Chat Completions API
//!
//! ## 请求格式对比
//!
//! ### Anthropic Messages 请求
//! ```json
//! POST /v1/messages
//! {
//!   "model": "claude-3-5-sonnet-20241022",
//!   "max_tokens": 4096,
//!   "system": "You are a helpful assistant.",
//!   "messages": [
//!     {"role": "user", "content": "hello"}
//!   ],
//!   "stream": true
//! }
//! ```
//!
//! ### OpenAI Chat Completions 请求
//! ```json
//! POST /v1/chat/completions
//! {
//!   "model": "gpt-4",
//!   "messages": [
//!     {"role": "system", "content": "You are a helpful assistant."},
//!     {"role": "user", "content": "hello"}
//!   ],
//!   "stream": true,
//!   "max_tokens": 4096
//! }
//! ```
//!
//! ## 关键差异
//!
//! 1. **system 参数位置**：
//!    - Anthropic: 顶层字段 `"system": "..."`
//!    - OpenAI: messages 数组第一条 `{"role": "system", "content": "..."}`
//!
//! 2. **max_tokens**：
//!    - Anthropic: 必填
//!    - OpenAI: 可选
//!
//! 3. **模型名称映射**：
//!    - claude-3-5-sonnet-20241022 → gpt-4
//!    - claude-3-5-haiku-20241022 → gpt-4o-mini

use crate::proxy::transform::TransformedRequest;
use serde_json::{json, Value};

/// 将 Anthropic Messages 请求转换为 OpenAI Chat Completions 请求
///
/// # 参数
/// - `body`: Anthropic 请求体 JSON
/// - `target_model`: 目标模型名（可选）
///
/// # 返回
/// 转换后的请求
pub fn transform_request(body: Value, target_model: Option<&str>) -> TransformedRequest {
    let mut openai_req = json!({});

    // 模型名
    if let Some(model) = target_model {
        openai_req["model"] = json!(model);
    } else if let Some(model) = body.get("model") {
        // 简单映射：claude-* → gpt-4
        openai_req["model"] = if model.as_str().unwrap_or("").starts_with("claude") {
            json!("gpt-4")
        } else {
            model.clone()
        };
    }

    // 构建 messages 数组
    let mut messages = Vec::new();

    // system 消息（如果有）
    if let Some(system) = body.get("system").and_then(|v| v.as_str()) {
        messages.push(json!({
            "role": "system",
            "content": system
        }));
    }

    // 用户/助手消息
    if let Some(orig_messages) = body.get("messages").and_then(|v| v.as_array()) {
        for msg in orig_messages {
            messages.push(msg.clone());
        }
    }

    openai_req["messages"] = json!(messages);

    // 其他可选参数
    if let Some(stream) = body.get("stream") {
        openai_req["stream"] = stream.clone();
    }
    if let Some(max_tokens) = body.get("max_tokens") {
        openai_req["max_tokens"] = max_tokens.clone();
    }
    if let Some(temperature) = body.get("temperature") {
        openai_req["temperature"] = temperature.clone();
    }
    if let Some(top_p) = body.get("top_p") {
        openai_req["top_p"] = top_p.clone();
    }

    TransformedRequest {
        body: openai_req,
        path: Some("/v1/chat/completions".to_string()),
        content_type: Some("application/json".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_basic_transform() {
        let anthropic_req = json!({
            "model": "claude-3-5-sonnet-20241022",
            "max_tokens": 4096,
            "system": "You are a helpful assistant.",
            "messages": [
                {"role": "user", "content": "hello"}
            ],
            "stream": true
        });

        let result = transform_request(anthropic_req, None);

        assert_eq!(result.path, Some("/v1/chat/completions".to_string()));
        assert_eq!(result.body["model"], "gpt-4");
        assert_eq!(result.body["max_tokens"], 4096);

        // system 应该被移到 messages 数组第一条
        let messages = result.body["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["role"], "system");
        assert_eq!(messages[0]["content"], "You are a helpful assistant.");
        assert_eq!(messages[1]["role"], "user");
        assert_eq!(messages[1]["content"], "hello");
    }

    #[test]
    fn test_model_mapping() {
        let anthropic_req = json!({
            "model": "claude-3-5-sonnet-20241022",
            "max_tokens": 4096,
            "messages": [{"role": "user", "content": "hello"}]
        });

        let result = transform_request(anthropic_req, Some("gpt-4o"));

        assert_eq!(result.body["model"], "gpt-4o");
    }

    #[test]
    fn test_no_system() {
        let anthropic_req = json!({
            "model": "claude-3-5-sonnet-20241022",
            "max_tokens": 4096,
            "messages": [{"role": "user", "content": "hello"}]
        });

        let result = transform_request(anthropic_req, None);

        let messages = result.body["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["role"], "user");
    }
}
