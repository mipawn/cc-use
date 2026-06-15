//! SSE (Server-Sent Events) 流式响应解析器
//!
//! 用于解析和重组 SSE 格式的流式响应。支持：
//! - OpenAI Chat Completions SSE
//! - Anthropic Messages SSE
//! - Codex Responses SSE
//!
//! ## SSE 格式差异
//!
//! ### OpenAI Chat Completions
//! ```text
//! data: {"id":"chatcmpl-xxx","choices":[{"delta":{"content":"Hello"}}]}
//! data: {"id":"chatcmpl-xxx","choices":[{"delta":{"content":" world"}}]}
//! data: [DONE]
//! ```
//!
//! ### Anthropic Messages
//! ```text
//! event: message_start
//! data: {"type":"message_start","message":{"id":"msg_xxx"}}
//!
//! event: content_block_delta
//! data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}
//!
//! event: message_stop
//! data: {"type":"message_stop"}
//! ```
//!
//! ### Codex Responses
//! ```text
//! data: {"type":"session","session_id":"xxx"}
//! data: {"type":"content","content":"Hello"}
//! data: {"type":"done"}
//! ```

use serde_json::Value;
use std::str;

/// SSE 事件
#[derive(Debug, Clone)]
pub struct SseEvent {
    /// 事件类型（如 message_start, content_block_delta）
    pub event: Option<String>,
    /// 事件数据（JSON）
    pub data: Option<Value>,
    /// 原始数据（用于无法解析 JSON 的情况）
    pub raw_data: Option<String>,
}

/// SSE 解析器
pub struct SseParser {
    buffer: Vec<u8>,
}

impl SseParser {
    pub fn new() -> Self {
        Self { buffer: Vec::new() }
    }

    /// 添加新的字节流数据
    pub fn push(&mut self, chunk: &[u8]) {
        self.buffer.extend_from_slice(chunk);
    }

    /// 解析并提取完整的 SSE 事件
    ///
    /// 返回 (事件列表, 剩余未解析的字节数)
    pub fn parse(&mut self) -> Vec<SseEvent> {
        let mut events = Vec::new();
        let buffer_str = match str::from_utf8(&self.buffer) {
            Ok(s) => s,
            Err(_) => return events,
        };

        let mut current_event: Option<String> = None;
        let mut current_data_lines: Vec<String> = Vec::new();
        let mut consumed = 0;

        for line in buffer_str.lines() {
            consumed += line.len() + 1; // +1 for \n

            if line.is_empty() {
                // 空行表示一个事件结束
                if !current_data_lines.is_empty() {
                    let data_str = current_data_lines.join("\n");
                    events.push(SseEvent {
                        event: current_event.clone(),
                        data: serde_json::from_str(&data_str).ok(),
                        raw_data: Some(data_str),
                    });
                    current_event = None;
                    current_data_lines.clear();
                }
            } else if let Some(event_type) = line.strip_prefix("event: ") {
                current_event = Some(event_type.to_string());
            } else if let Some(data) = line.strip_prefix("data: ") {
                current_data_lines.push(data.to_string());
            }
        }

        // 移除已解析的部分
        self.buffer.drain(..consumed.min(self.buffer.len()));

        events
    }

    /// 清空缓冲区
    pub fn clear(&mut self) {
        self.buffer.clear();
    }
}

/// 将 SSE 事件序列化为字节流
pub fn serialize_sse_event(event: Option<&str>, data: &str) -> Vec<u8> {
    let mut result = Vec::new();

    if let Some(event_type) = event {
        result.extend_from_slice(b"event: ");
        result.extend_from_slice(event_type.as_bytes());
        result.extend_from_slice(b"\n");
    }

    result.extend_from_slice(b"data: ");
    result.extend_from_slice(data.as_bytes());
    result.extend_from_slice(b"\n\n");

    result
}

/// 判断是否是流式响应结束标记
pub fn is_done_event(event: &SseEvent) -> bool {
    if let Some(ref raw) = event.raw_data {
        // OpenAI 的 [DONE] 标记
        if raw.trim() == "[DONE]" {
            return true;
        }
    }

    if let Some(ref data) = event.data {
        // Anthropic 的 message_stop
        if data.get("type").and_then(|t| t.as_str()) == Some("message_stop") {
            return true;
        }
        // Codex 的 done
        if data.get("type").and_then(|t| t.as_str()) == Some("done") {
            return true;
        }
    }

    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_openai_sse() {
        let mut parser = SseParser::new();
        parser.push(b"data: {\"id\":\"chatcmpl-xxx\",\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n\n");
        parser.push(b"data: [DONE]\n\n");

        let events = parser.parse();
        assert_eq!(events.len(), 2);

        // 第一个事件
        assert!(events[0].data.is_some());
        assert_eq!(
            events[0].data.as_ref().unwrap()["id"].as_str(),
            Some("chatcmpl-xxx")
        );

        // 第二个事件（DONE）
        assert_eq!(events[1].raw_data.as_deref(), Some("[DONE]"));
        assert!(is_done_event(&events[1]));
    }

    #[test]
    fn test_parse_anthropic_sse() {
        let mut parser = SseParser::new();
        parser.push(b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_xxx\"}}\n\n");
        parser.push(b"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"Hello\"}}\n\n");

        let events = parser.parse();
        assert_eq!(events.len(), 2);

        // 第一个事件
        assert_eq!(events[0].event.as_deref(), Some("message_start"));
        assert_eq!(
            events[0].data.as_ref().unwrap()["type"].as_str(),
            Some("message_start")
        );

        // 第二个事件
        assert_eq!(events[1].event.as_deref(), Some("content_block_delta"));
    }

    #[test]
    fn test_serialize_sse_event() {
        let result = serialize_sse_event(Some("test"), "{\"key\":\"value\"}");
        assert_eq!(
            String::from_utf8(result).unwrap(),
            "event: test\ndata: {\"key\":\"value\"}\n\n"
        );

        let result = serialize_sse_event(None, "[DONE]");
        assert_eq!(String::from_utf8(result).unwrap(), "data: [DONE]\n\n");
    }

    #[test]
    fn test_partial_sse_parsing() {
        let mut parser = SseParser::new();

        // 推送部分数据（不完整的 JSON）
        parser.push(b"data: {\"id\":\"chatcmpl");

        // 此时应该解析不出完整事件（因为缺少换行符）
        let events = parser.parse();
        assert_eq!(events.len(), 0);

        // 推送剩余数据（注意需要包含完整的 \n\n 结束符）
        parser.push(b"-xxx\"}\n\n");

        // 现在应该能解析出完整事件
        let events = parser.parse();
        assert_eq!(events.len(), 1);
        assert!(events[0].data.is_some());
        assert_eq!(
            events[0].data.as_ref().unwrap()["id"].as_str(),
            Some("chatcmpl-xxx")
        );
    }
}
