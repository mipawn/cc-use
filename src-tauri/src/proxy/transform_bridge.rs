//! 格式转换集成辅助模块
//!
//! 桥接 handler.rs 和 transform 模块，处理请求/响应的转换逻辑。

use crate::models::Provider;
use crate::proxy::transform::{
    self, anthropic_to_openai, chat_to_codex, codex_to_chat, openai_to_anthropic, ApiFormat,
    CliType, TransformPath,
};

/// 根据 CLI 类型和 Provider 配置决定是否需要转换，如果需要则转换请求
pub fn transform_request_if_needed(
    body_bytes: Vec<u8>,
    req_path: &str,
    provider: &Provider,
    cli_type_str: Option<&str>,
) -> Result<(Vec<u8>, String), String> {
    // 检查是否启用转换
    if !provider.transform_enabled {
        return Ok((body_bytes, req_path.to_string()));
    }

    // 解析 CLI 类型
    let cli_type = match cli_type_str {
        Some("claude") => CliType::ClaudeCode,
        Some("codex") => CliType::CodexCli,
        Some("codex-app") => CliType::CodexApp,
        _ => {
            // 未知 CLI 类型，不转换
            return Ok((body_bytes, req_path.to_string()));
        }
    };

    // 解析 API 格式
    let api_format = ApiFormat::from_str(
        provider
            .api_format
            .as_deref()
            .unwrap_or("auto")
    );

    // 决定转换路径
    let transform_path = match transform::should_transform(cli_type, api_format) {
        Some(path) => path,
        None => return Ok((body_bytes, req_path.to_string())),
    };

    // 解析请求体为 JSON
    let body_json: serde_json::Value = serde_json::from_slice(&body_bytes)
        .map_err(|e| format!("Failed to parse request body: {}", e))?;

    // 执行转换
    let transformed = match transform_path {
        TransformPath::CodexToChat => {
            // Codex → OpenAI Chat
            codex_to_chat::transform_request(body_json, None)
        }
        TransformPath::AnthropicToOpenAI => {
            // Anthropic → OpenAI Chat
            anthropic_to_openai::transform_request(body_json, None)
        }
    };

    // 序列化转换后的请求体
    let transformed_bytes = serde_json::to_vec(&transformed.body)
        .map_err(|e| format!("Failed to serialize transformed request: {}", e))?;

    // 使用转换后的路径（如果有）
    let final_path = transformed.path.unwrap_or_else(|| req_path.to_string());

    Ok((transformed_bytes, final_path))
}

/// 判断响应是否需要转换
pub fn should_transform_response(
    provider: &Provider,
    cli_type_str: Option<&str>,
) -> Option<TransformPath> {
    if !provider.transform_enabled {
        return None;
    }

    let cli_type = match cli_type_str {
        Some("claude") => CliType::ClaudeCode,
        Some("codex") => CliType::CodexCli,
        Some("codex-app") => CliType::CodexApp,
        _ => return None,
    };

    let api_format = ApiFormat::from_str(
        provider
            .api_format
            .as_deref()
            .unwrap_or("auto")
    );

    transform::should_transform(cli_type, api_format)
}

/// 创建流式响应转换器
pub fn create_stream_transformer(
    transform_path: TransformPath,
) -> Box<dyn StreamTransformer + Send> {
    match transform_path {
        TransformPath::CodexToChat => {
            // 这个方向不应该出现在响应转换中
            Box::new(chat_to_codex::StreamTransformer::new())
        }
        TransformPath::AnthropicToOpenAI => {
            Box::new(openai_to_anthropic::StreamTransformer::new())
        }
    }
}

/// 流式响应转换器 trait
pub trait StreamTransformer {
    fn transform_chunk(&mut self, chunk: &[u8]) -> Vec<u8>;
}

impl StreamTransformer for chat_to_codex::StreamTransformer {
    fn transform_chunk(&mut self, chunk: &[u8]) -> Vec<u8> {
        chat_to_codex::StreamTransformer::transform_chunk(self, chunk)
    }
}

impl StreamTransformer for openai_to_anthropic::StreamTransformer {
    fn transform_chunk(&mut self, chunk: &[u8]) -> Vec<u8> {
        openai_to_anthropic::StreamTransformer::transform_chunk(self, chunk)
    }
}
