//! OpenAI Chat Completions API → Anthropic Messages API 响应转换
//!
//! 场景：上游返回 OpenAI Chat Completions 格式，需要转换为 Anthropic Messages 格式
//!
//! ## 响应格式对比（流式）
//!
//! ### OpenAI Chat Completions SSE
//! ```text
//! data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}
//! data: {"id":"chatcmpl-xxx","choices":[{"delta":{"content":"Hello"}}]}
//! data: {"id":"chatcmpl-xxx","choices":[{"delta":{},"finish_reason":"stop"}]}
//! data: [DONE]
//! ```
//!
//! ### Anthropic Messages SSE
//! ```text
//! event: message_start
//! data: {"type":"message_start","message":{"id":"chatcmpl-xxx","type":"message","role":"assistant","content":[],"model":"gpt-4","usage":{"input_tokens":0,"output_tokens":0}}}
//!
//! event: content_block_start
//! data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}
//!
//! event: content_block_delta
//! data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}
//!
//! event: content_block_stop
//! data: {"type":"content_block_stop","index":0}
//!
//! event: message_delta
//! data: {"type":"message_delta","delta":{"stop_reason":"end_turn","usage":{"output_tokens":5}}}
//!
//! event: message_stop
//! data: {"type":"message_stop"}
//! ```

use crate::proxy::transform::sse_parser::{serialize_sse_event, SseParser};
use serde_json::json;

/// 流式响应转换状态
pub struct StreamTransformer {
    parser: SseParser,
    message_id: Option<String>,
    model: Option<String>,
    has_sent_message_start: bool,
    has_sent_content_block_start: bool,
    has_sent_content_block_stop: bool,
}

impl StreamTransformer {
    pub fn new() -> Self {
        Self {
            parser: SseParser::new(),
            message_id: None,
            model: None,
            has_sent_message_start: false,
            has_sent_content_block_start: false,
            has_sent_content_block_stop: false,
        }
    }

    /// 处理上游返回的字节流，转换为 Anthropic 格式的 SSE 事件
    pub fn transform_chunk(&mut self, chunk: &[u8]) -> Vec<u8> {
        self.parser.push(chunk);
        let events = self.parser.parse();

        let mut output = Vec::new();

        for event in events {
            if let Some(data) = event.data {
                // 提取 message_id 和 model
                if self.message_id.is_none() {
                    if let Some(id) = data.get("id").and_then(|v| v.as_str()) {
                        self.message_id = Some(id.to_string());
                    }
                }
                if self.model.is_none() {
                    if let Some(model) = data.get("model").and_then(|v| v.as_str()) {
                        self.model = Some(model.to_string());
                    }
                }

                // 发送 message_start（只发送一次）
                if !self.has_sent_message_start {
                    if let (Some(ref id), Some(ref model)) = (&self.message_id, &self.model) {
                        let message_start = json!({
                            "type": "message_start",
                            "message": {
                                "id": id,
                                "type": "message",
                                "role": "assistant",
                                "content": [],
                                "model": model,
                                "usage": {
                                    "input_tokens": 0,
                                    "output_tokens": 0
                                }
                            }
                        });
                        output.extend(serialize_sse_event(
                            Some("message_start"),
                            &message_start.to_string(),
                        ));
                        self.has_sent_message_start = true;
                    }
                }

                // 处理 choices
                if let Some(choices) = data.get("choices").and_then(|v| v.as_array()) {
                    for choice in choices {
                        if let Some(delta) = choice.get("delta") {
                            // 第一次收到内容时发送 content_block_start
                            if !self.has_sent_content_block_start && delta.get("content").is_some() {
                                let content_block_start = json!({
                                    "type": "content_block_start",
                                    "index": 0,
                                    "content_block": {
                                        "type": "text",
                                        "text": ""
                                    }
                                });
                                output.extend(serialize_sse_event(
                                    Some("content_block_start"),
                                    &content_block_start.to_string(),
                                ));
                                self.has_sent_content_block_start = true;
                            }

                            // 内容 delta
                            if let Some(content) = delta.get("content").and_then(|v| v.as_str()) {
                                if !content.is_empty() {
                                    let content_delta = json!({
                                        "type": "content_block_delta",
                                        "index": 0,
                                        "delta": {
                                            "type": "text_delta",
                                            "text": content
                                        }
                                    });
                                    output.extend(serialize_sse_event(
                                        Some("content_block_delta"),
                                        &content_delta.to_string(),
                                    ));
                                }
                            }
                        }

                        // finish_reason
                        if let Some(finish_reason) =
                            choice.get("finish_reason").and_then(|v| v.as_str())
                        {
                            if finish_reason != "null" && !finish_reason.is_empty() {
                                // content_block_stop
                                if !self.has_sent_content_block_stop {
                                    let content_block_stop = json!({
                                        "type": "content_block_stop",
                                        "index": 0
                                    });
                                    output.extend(serialize_sse_event(
                                        Some("content_block_stop"),
                                        &content_block_stop.to_string(),
                                    ));
                                    self.has_sent_content_block_stop = true;
                                }

                                // message_delta
                                let stop_reason = match finish_reason {
                                    "stop" => "end_turn",
                                    "length" => "max_tokens",
                                    _ => "end_turn",
                                };
                                let message_delta = json!({
                                    "type": "message_delta",
                                    "delta": {
                                        "stop_reason": stop_reason,
                                        "usage": {
                                            "output_tokens": 0
                                        }
                                    }
                                });
                                output.extend(serialize_sse_event(
                                    Some("message_delta"),
                                    &message_delta.to_string(),
                                ));

                                // message_stop
                                let message_stop = json!({"type": "message_stop"});
                                output.extend(serialize_sse_event(
                                    Some("message_stop"),
                                    &message_stop.to_string(),
                                ));
                            }
                        }
                    }
                }
            } else if let Some(ref raw) = event.raw_data {
                // [DONE] 标记
                if raw.trim() == "[DONE]" {
                    // 确保 content_block_stop 已发送
                    if self.has_sent_content_block_start && !self.has_sent_content_block_stop {
                        let content_block_stop = json!({
                            "type": "content_block_stop",
                            "index": 0
                        });
                        output.extend(serialize_sse_event(
                            Some("content_block_stop"),
                            &content_block_stop.to_string(),
                        ));
                    }

                    // message_delta + message_stop
                    let message_delta = json!({
                        "type": "message_delta",
                        "delta": {
                            "stop_reason": "end_turn",
                            "usage": {"output_tokens": 0}
                        }
                    });
                    output.extend(serialize_sse_event(
                        Some("message_delta"),
                        &message_delta.to_string(),
                    ));

                    let message_stop = json!({"type": "message_stop"});
                    output.extend(serialize_sse_event(
                        Some("message_stop"),
                        &message_stop.to_string(),
                    ));
                }
            }
        }

        output
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_stream_transform() {
        let mut transformer = StreamTransformer::new();

        // 第一个 chunk：带 id 和 model
        let chunk1 = b"data: {\"id\":\"chatcmpl-xxx\",\"model\":\"gpt-4\",\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"\"}}]}\n\n";
        let output1 = transformer.transform_chunk(chunk1);
        let output1_str = String::from_utf8(output1).unwrap();

        // 应该包含 message_start
        assert!(output1_str.contains("message_start"));
        assert!(output1_str.contains("chatcmpl-xxx"));

        // 第二个 chunk：内容
        let chunk2 = b"data: {\"id\":\"chatcmpl-xxx\",\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n\n";
        let output2 = transformer.transform_chunk(chunk2);
        let output2_str = String::from_utf8(output2).unwrap();

        // 应该包含 content_block_start 和 content_block_delta
        assert!(output2_str.contains("content_block_start"));
        assert!(output2_str.contains("content_block_delta"));
        assert!(output2_str.contains("Hello"));

        // 第三个 chunk：finish
        let chunk3 =
            b"data: {\"id\":\"chatcmpl-xxx\",\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n";
        let output3 = transformer.transform_chunk(chunk3);
        let output3_str = String::from_utf8(output3).unwrap();

        // 应该包含 content_block_stop, message_delta, message_stop
        assert!(output3_str.contains("content_block_stop"));
        assert!(output3_str.contains("message_delta"));
        assert!(output3_str.contains("message_stop"));
    }
}
