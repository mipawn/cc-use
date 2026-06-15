//! API 格式转换模块
//!
//! 支持在不同 API 格式之间转换请求和响应，让任意 CLI 都能调用任意 Provider。
//!
//! ## 支持的转换路径
//!
//! - **Codex Responses ↔ OpenAI Chat Completions**
//!   - 场景：DeepSeek/MiniMax key + Codex CLI
//!   - 模块：`codex_to_chat` + `chat_to_codex`
//!
//! - **Anthropic Messages ↔ OpenAI Chat Completions**
//!   - 场景：OpenAI key + Claude Code CLI
//!   - 模块：`anthropic_to_openai` + `openai_to_anthropic`
//!
//! ## 架构
//!
//! ```text
//! CLI Request → handler.rs
//!   → check provider.transform_enabled
//!   → if enabled:
//!       → transform_request(cli_type, api_format, req)
//!       → forward_to_upstream(transformed_req)
//!       → transform_response(cli_type, api_format, resp)
//!   → else:
//!       → forward_to_upstream(req)
//! ```

pub mod codex_to_chat;
pub mod chat_to_codex;
pub mod anthropic_to_openai;
pub mod openai_to_anthropic;
pub mod sse_parser;
pub mod reasoning;
pub mod tools;

use serde_json::Value;

/// CLI 类型，决定请求/响应的格式
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CliType {
    ClaudeCode,
    CodexCli,
    CodexApp,
}

/// Provider API 格式
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApiFormat {
    /// 自动检测（根据 provider type 推断）
    Auto,
    /// Anthropic Messages API
    AnthropicMessages,
    /// OpenAI Chat Completions API
    OpenAIChat,
    /// Codex Responses API
    CodexResponses,
}

impl ApiFormat {
    pub fn from_str(s: &str) -> Self {
        match s {
            "anthropic_messages" => ApiFormat::AnthropicMessages,
            "openai_chat" => ApiFormat::OpenAIChat,
            "codex_responses" => ApiFormat::CodexResponses,
            _ => ApiFormat::Auto,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            ApiFormat::Auto => "auto",
            ApiFormat::AnthropicMessages => "anthropic_messages",
            ApiFormat::OpenAIChat => "openai_chat",
            ApiFormat::CodexResponses => "codex_responses",
        }
    }
}

/// 请求转换结果
#[derive(Debug)]
pub struct TransformedRequest {
    /// 转换后的请求体
    pub body: Value,
    /// 转换后的路径（如果需要修改）
    pub path: Option<String>,
    /// 转换后的 Content-Type（如果需要修改）
    pub content_type: Option<String>,
}

/// 响应转换结果
#[derive(Debug)]
pub struct TransformedResponse {
    /// 转换后的响应体（非流式）或 SSE 事件流（流式）
    pub body: Vec<u8>,
    /// 转换后的 Content-Type
    pub content_type: String,
}

/// 根据 CLI 类型和 API 格式决定转换路径
pub fn should_transform(cli_type: CliType, api_format: ApiFormat) -> Option<TransformPath> {
    match (cli_type, api_format) {
        // Codex CLI/App + OpenAI Chat API → 需要转换
        (CliType::CodexCli | CliType::CodexApp, ApiFormat::OpenAIChat) => {
            Some(TransformPath::CodexToChat)
        }
        // Claude Code + OpenAI Chat API → 需要转换
        (CliType::ClaudeCode, ApiFormat::OpenAIChat) => Some(TransformPath::AnthropicToOpenAI),
        // 其他情况不需要转换（直接透传）
        _ => None,
    }
}

/// 转换路径
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransformPath {
    CodexToChat,
    AnthropicToOpenAI,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_should_transform() {
        // Codex CLI + OpenAI Chat → 需要转换
        assert_eq!(
            should_transform(CliType::CodexCli, ApiFormat::OpenAIChat),
            Some(TransformPath::CodexToChat)
        );

        // Codex CLI + Codex Responses → 不需要转换
        assert_eq!(
            should_transform(CliType::CodexCli, ApiFormat::CodexResponses),
            None
        );

        // Claude Code + Anthropic Messages → 不需要转换
        assert_eq!(
            should_transform(CliType::ClaudeCode, ApiFormat::AnthropicMessages),
            None
        );

        // Claude Code + OpenAI Chat → 需要转换
        assert_eq!(
            should_transform(CliType::ClaudeCode, ApiFormat::OpenAIChat),
            Some(TransformPath::AnthropicToOpenAI)
        );
    }

    #[test]
    fn test_api_format_from_str() {
        assert_eq!(
            ApiFormat::from_str("openai_chat"),
            ApiFormat::OpenAIChat
        );
        assert_eq!(
            ApiFormat::from_str("anthropic_messages"),
            ApiFormat::AnthropicMessages
        );
        assert_eq!(ApiFormat::from_str("unknown"), ApiFormat::Auto);
    }
}
