//! Codex Responses API → OpenAI Chat Completions API 请求转换
//!
//! 场景：用户使用 Codex CLI，但 Provider 只提供 OpenAI Chat Completions API
//! （如 DeepSeek、MiniMax）
//!
//! ## 请求格式对比
//!
//! ### Codex Responses 请求
//! ```json
//! POST /responses
//! {
//!   "model": "gpt-4o",
//!   "messages": [
//!     {"role": "user", "content": "hello"}
//!   ],
//!   "stream": true,
//!   "max_tokens": 4096
//! }
//! ```
//!
//! ### OpenAI Chat Completions 请求
//! ```json
//! POST /v1/chat/completions
//! {
//!   "model": "deepseek-chat",
//!   "messages": [
//!     {"role": "user", "content": "hello"}
//!   ],
//!   "stream": true,
//!   "max_tokens": 4096
//! }
//! ```
//!
//! ## 转换逻辑
//!
//! 1. 路径：`/responses` → `/v1/chat/completions`
//! 2. 请求体：基本一致，只需处理少量字段映射
//! 3. model 映射：可选（如 gpt-4o → deepseek-chat）

use crate::proxy::transform::{ApiFormat, TransformedRequest};
use serde_json::{json, Value};

/// 将 Codex Responses 请求转换为 OpenAI Chat Completions 请求
///
/// # 参数
/// - `body`: Codex 请求体 JSON
/// - `target_model`: 目标模型名（可选，如果为 None 则保持原模型名）
///
/// # 返回
/// 转换后的请求
pub fn transform_request(body: Value, target_model: Option<&str>) -> TransformedRequest {
    let mut req = body.clone();

    // 替换 model（如果指定）
    if let Some(model) = target_model {
        req["model"] = json!(model);
    }

    // Codex Responses 和 OpenAI Chat Completions 的请求体基本一致
    // 只需确保以下字段存在且格式正确：
    // - model (required)
    // - messages (required)
    // - stream (optional, default false)
    // - max_tokens (optional)
    // - temperature (optional)
    // - top_p (optional)

    TransformedRequest {
        body: req,
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
        let codex_req = json!({
            "model": "gpt-4o",
            "messages": [
                {"role": "user", "content": "hello"}
            ],
            "stream": true,
            "max_tokens": 4096
        });

        let result = transform_request(codex_req.clone(), None);

        assert_eq!(result.path, Some("/v1/chat/completions".to_string()));
        assert_eq!(result.body["model"], "gpt-4o");
        assert_eq!(result.body["messages"], codex_req["messages"]);
    }

    #[test]
    fn test_model_mapping() {
        let codex_req = json!({
            "model": "gpt-4o",
            "messages": [{"role": "user", "content": "hello"}],
            "stream": true
        });

        let result = transform_request(codex_req, Some("deepseek-chat"));

        assert_eq!(result.body["model"], "deepseek-chat");
    }
}
