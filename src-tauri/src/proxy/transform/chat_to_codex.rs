//! OpenAI Chat Completions API → Codex Responses API 响应转换
//!
//! 场景：上游返回 OpenAI Chat Completions 格式，需要转换为 Codex Responses 格式
//!
//! ## 响应格式对比（流式）
//!
//! ### OpenAI Chat Completions SSE
//! ```text
//! data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1234567890,"model":"deepseek-chat","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}
//! data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1234567890,"model":"deepseek-chat","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}
//! data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1234567890,"model":"deepseek-chat","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}
//! data: [DONE]
//! ```
//!
//! ### Codex Responses SSE
//! ```text
//! data: {"type":"session","session_id":"chatcmpl-xxx"}
//! data: {"type":"content","content":"Hello"}
//! data: {"type":"done"}
//! ```

use crate::proxy::transform::sse_parser::{serialize_sse_event, SseEvent, SseParser};
use serde_json::{json, Value};

/// 流式响应转换状态
pub struct StreamTransformer {
    parser: SseParser,
    session_id: Option<String>,
    has_sent_session: bool,
}

impl StreamTransformer {
    pub fn new() -> Self {
        Self {
            parser: SseParser::new(),
            session_id: None,
            has_sent_session: false,
        }
    }

    /// 处理上游返回的字节流，转换为 Codex 格式的 SSE 事件
    pub fn transform_chunk(&mut self, chunk: &[u8]) -> Vec<u8> {
        self.parser.push(chunk);
        let events = self.parser.parse();

        let mut output = Vec::new();

        for event in events {
            if let Some(data) = event.data {
                // 提取 session_id（第一个事件）
                if self.session_id.is_none() {
                    if let Some(id) = data.get("id").and_then(|v| v.as_str()) {
                        self.session_id = Some(id.to_string());
                    }
                }

                // 发送 session 事件（只发送一次）
                if !self.has_sent_session {
                    if let Some(ref session_id) = self.session_id {
                        let session_event = json!({
                            "type": "session",
                            "session_id": session_id
                        });
                        output.extend(serialize_sse_event(None, &session_event.to_string()));
                        self.has_sent_session = true;
                    }
                }

                // 处理 delta 内容
                if let Some(choices) = data.get("choices").and_then(|v| v.as_array()) {
                    for choice in choices {
                        if let Some(delta) = choice.get("delta") {
                            // 普通内容
                            if let Some(content) = delta.get("content").and_then(|v| v.as_str()) {
                                if !content.is_empty() {
                                    let content_event = json!({
                                        "type": "content",
                                        "content": content
                                    });
                                    output.extend(serialize_sse_event(
                                        None,
                                        &content_event.to_string(),
                                    ));
                                }
                            }

                            // reasoning_content（DeepSeek R1）
                            if let Some(reasoning) =
                                delta.get("reasoning_content").and_then(|v| v.as_str())
                            {
                                if !reasoning.is_empty() {
                                    let reasoning_event = json!({
                                        "type": "reasoning",
                                        "reasoning": reasoning
                                    });
                                    output.extend(serialize_sse_event(
                                        None,
                                        &reasoning_event.to_string(),
                                    ));
                                }
                            }
                        }

                        // 检查 finish_reason
                        if let Some(finish_reason) =
                            choice.get("finish_reason").and_then(|v| v.as_str())
                        {
                            if finish_reason != "null" && !finish_reason.is_empty() {
                                let done_event = json!({"type": "done"});
                                output.extend(serialize_sse_event(None, &done_event.to_string()));
                            }
                        }
                    }
                }
            } else if let Some(ref raw) = event.raw_data {
                // [DONE] 标记
                if raw.trim() == "[DONE]" {
                    let done_event = json!({"type": "done"});
                    output.extend(serialize_sse_event(None, &done_event.to_string()));
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

        // 第一个 chunk：带 id
        let chunk1 = b"data: {\"id\":\"chatcmpl-xxx\",\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"\"}}]}\n\n";
        let output1 = transformer.transform_chunk(chunk1);
        let output1_str = String::from_utf8(output1).unwrap();

        // 应该包含 session 事件
        assert!(output1_str.contains("\"type\":\"session\""));
        assert!(output1_str.contains("\"session_id\":\"chatcmpl-xxx\""));

        // 第二个 chunk：内容
        let chunk2 = b"data: {\"id\":\"chatcmpl-xxx\",\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n\n";
        let output2 = transformer.transform_chunk(chunk2);
        let output2_str = String::from_utf8(output2).unwrap();

        // 应该包含 content 事件
        assert!(output2_str.contains("\"type\":\"content\""));
        assert!(output2_str.contains("\"content\":\"Hello\""));

        // 第三个 chunk：[DONE]
        let chunk3 = b"data: [DONE]\n\n";
        let output3 = transformer.transform_chunk(chunk3);
        let output3_str = String::from_utf8(output3).unwrap();

        // 应该包含 done 事件
        assert!(output3_str.contains("\"type\":\"done\""));
    }

    #[test]
    fn test_reasoning_content() {
        let mut transformer = StreamTransformer::new();

        let chunk = b"data: {\"id\":\"chatcmpl-xxx\",\"choices\":[{\"delta\":{\"reasoning_content\":\"Let me think...\"}}]}\n\n";
        let output = transformer.transform_chunk(chunk);
        let output_str = String::from_utf8(output).unwrap();

        // 应该包含 reasoning 事件
        assert!(output_str.contains("\"type\":\"reasoning\""));
        assert!(output_str.contains("\"reasoning\":\"Let me think...\""));
    }
}
