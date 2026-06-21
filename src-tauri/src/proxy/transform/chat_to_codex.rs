//! OpenAI Chat Completions API → Codex Responses API 响应转换
//!
//! 场景：上游返回 OpenAI Chat Completions 格式，需要转换为 Codex Responses 格式
//!
//! ## 完整 SSE 事件序列（对照 cc-switch streaming_codex_chat.rs）
//!
//! ```text
//! response.created → response.in_progress
//!   → response.output_item.added (reasoning)
//!   → response.output_item.delta (reasoning chunks)
//!   → response.output_item.done (reasoning)
//!   → response.output_item.added (message)
//!   → response.output_item.delta (content chunks)
//!   → response.output_item.done (message)
//!   → response.output_item.added (tool_call)
//!   → response.output_item.delta (tool_call arguments)
//!   → response.output_item.done (tool_call)
//! → response.completed (with usage)
//! 或 response.failed (错误)
//! ```

use crate::proxy::transform::{
    reasoning::extract_reasoning_content,
    sse_parser::{serialize_sse_event, SseParser},
};
use serde_json::json;

/// 流式响应转换状态机
pub struct StreamTransformer {
    parser: SseParser,
    session_id: Option<String>,
    response_id: Option<String>,
    has_sent_created: bool,
    has_sent_in_progress: bool,
    // 当前输出项状态
    current_reasoning_id: Option<String>,
    current_message_id: Option<String>,
    current_tool_call_id: Option<String>,
    reasoning_buffer: String,
    content_buffer: String,
    tool_call_name_buffer: String,
    tool_call_args_buffer: String,
    // 用于检测 finish
    last_finish_reason: Option<String>,
}

impl StreamTransformer {
    pub fn new() -> Self {
        Self {
            parser: SseParser::new(),
            session_id: None,
            response_id: None,
            has_sent_created: false,
            has_sent_in_progress: false,
            current_reasoning_id: None,
            current_message_id: None,
            current_tool_call_id: None,
            reasoning_buffer: String::new(),
            content_buffer: String::new(),
            tool_call_name_buffer: String::new(),
            tool_call_args_buffer: String::new(),
            last_finish_reason: None,
        }
    }

    /// 处理上游返回的字节流，转换为 Codex Responses 格式的 SSE 事件
    pub fn transform_chunk(&mut self, chunk: &[u8]) -> Vec<u8> {
        self.parser.push(chunk);
        let events = self.parser.parse();

        let mut output = Vec::new();

        for event in events {
            if let Some(data) = event.data {
                // 提取 session_id/response_id（第一个事件）
                if self.session_id.is_none() {
                    if let Some(id) = data.get("id").and_then(|v| v.as_str()) {
                        self.session_id = Some(id.to_string());
                        self.response_id = Some(id.to_string());
                    }
                }

                // 发送 response.created（只发送一次）
                if !self.has_sent_created {
                    if let Some(ref response_id) = self.response_id {
                        let created_event = json!({
                            "type": "response.created",
                            "response": {
                                "id": response_id,
                                "object": "realtime.response",
                                "status": "in_progress",
                                "output": []
                            }
                        });
                        output.extend(serialize_sse_event(None, &created_event.to_string()));
                        self.has_sent_created = true;
                    }
                }

                // 发送 response.in_progress（只发送一次）
                if !self.has_sent_in_progress && self.has_sent_created {
                    let in_progress_event = json!({
                        "type": "response.in_progress"
                    });
                    output.extend(serialize_sse_event(None, &in_progress_event.to_string()));
                    self.has_sent_in_progress = true;
                }

                // 处理 delta 内容
                if let Some(choices) = data.get("choices").and_then(|v| v.as_array()) {
                    for choice in choices {
                        if let Some(delta) = choice.get("delta") {
                            // reasoning_content（DeepSeek R1）
                            if let Some(reasoning) = extract_reasoning_content(delta) {
                                output.extend(self.handle_reasoning_delta(&reasoning));
                            }

                            // 普通 content
                            if let Some(content) = delta.get("content").and_then(|v| v.as_str()) {
                                if !content.is_empty() {
                                    output.extend(self.handle_content_delta(content));
                                }
                            }

                            // tool_calls 增量
                            if let Some(tool_calls) = delta.get("tool_calls").and_then(|v| v.as_array()) {
                                for tool_call in tool_calls {
                                    output.extend(self.handle_tool_call_delta(tool_call));
                                }
                            }
                        }

                        // 检查 finish_reason
                        if let Some(finish_reason) =
                            choice.get("finish_reason").and_then(|v| v.as_str())
                        {
                            if finish_reason != "null" && !finish_reason.is_empty() {
                                self.last_finish_reason = Some(finish_reason.to_string());
                            }
                        }
                    }
                }

                // 检查 usage（在最后一个 chunk）
                if let Some(usage) = data.get("usage") {
                    output.extend(self.finalize_all_items());
                    output.extend(self.send_completed(usage));
                }
            } else if let Some(ref raw) = event.raw_data {
                // [DONE] 标记
                if raw.trim() == "[DONE]" {
                    output.extend(self.finalize_all_items());
                    if self.last_finish_reason.is_some() {
                        output.extend(self.send_completed(&json!({})));
                    }
                }
            }
        }

        output
    }

    fn handle_reasoning_delta(&mut self, reasoning: &str) -> Vec<u8> {
        let mut output = Vec::new();

        // 首次 reasoning：发送 output_item.added
        if self.current_reasoning_id.is_none() {
            let item_id = format!("reasoning_{}", uuid::Uuid::new_v4());
            self.current_reasoning_id = Some(item_id.clone());

            let added_event = json!({
                "type": "response.output_item.added",
                "item": {
                    "id": item_id,
                    "type": "reasoning",
                    "content": ""
                }
            });
            output.extend(serialize_sse_event(None, &added_event.to_string()));
        }

        // 发送 delta
        self.reasoning_buffer.push_str(reasoning);
        let delta_event = json!({
            "type": "response.output_item.delta",
            "item_id": self.current_reasoning_id.as_ref().unwrap(),
            "delta": {
                "type": "reasoning",
                "text": reasoning
            }
        });
        output.extend(serialize_sse_event(None, &delta_event.to_string()));

        output
    }

    fn handle_content_delta(&mut self, content: &str) -> Vec<u8> {
        let mut output = Vec::new();

        // 如果有未完成的 reasoning，先完成它
        if self.current_reasoning_id.is_some() {
            output.extend(self.finalize_reasoning());
        }

        // 首次 content：发送 output_item.added
        if self.current_message_id.is_none() {
            let item_id = format!("message_{}", uuid::Uuid::new_v4());
            self.current_message_id = Some(item_id.clone());

            let added_event = json!({
                "type": "response.output_item.added",
                "item": {
                    "id": item_id,
                    "type": "message",
                    "role": "assistant",
                    "content": ""
                }
            });
            output.extend(serialize_sse_event(None, &added_event.to_string()));
        }

        // 发送 delta
        self.content_buffer.push_str(content);
        let delta_event = json!({
            "type": "response.output_item.delta",
            "item_id": self.current_message_id.as_ref().unwrap(),
            "delta": {
                "type": "text",
                "text": content
            }
        });
        output.extend(serialize_sse_event(None, &delta_event.to_string()));

        output
    }

    fn handle_tool_call_delta(&mut self, tool_call: &serde_json::Value) -> Vec<u8> {
        let mut output = Vec::new();

        // 如果有未完成的 reasoning 或 message，先完成它们
        if self.current_reasoning_id.is_some() {
            output.extend(self.finalize_reasoning());
        }
        if self.current_message_id.is_some() {
            output.extend(self.finalize_message());
        }

        // 提取 tool_call 信息
        let call_id = tool_call
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or_default();

        // 首次 tool_call：发送 output_item.added
        if self.current_tool_call_id.is_none() {
            self.current_tool_call_id = Some(call_id.to_string());

            let item_id = format!("tool_call_{}", uuid::Uuid::new_v4());
            let added_event = json!({
                "type": "response.output_item.added",
                "item": {
                    "id": item_id,
                    "type": "function_call",
                    "call_id": call_id,
                    "name": "",
                    "arguments": ""
                }
            });
            output.extend(serialize_sse_event(None, &added_event.to_string()));
        }

        // 提取 function 增量
        if let Some(function) = tool_call.get("function") {
            if let Some(name) = function.get("name").and_then(|v| v.as_str()) {
                if !name.is_empty() {
                    self.tool_call_name_buffer.push_str(name);
                }
            }
            if let Some(args) = function.get("arguments").and_then(|v| v.as_str()) {
                if !args.is_empty() {
                    self.tool_call_args_buffer.push_str(args);

                    // 发送 arguments delta
                    let delta_event = json!({
                        "type": "response.output_item.delta",
                        "item_id": format!("tool_call_{}", call_id),
                        "delta": {
                            "type": "function_call_arguments",
                            "arguments": args
                        }
                    });
                    output.extend(serialize_sse_event(None, &delta_event.to_string()));
                }
            }
        }

        output
    }

    fn finalize_reasoning(&mut self) -> Vec<u8> {
        let mut output = Vec::new();

        if let Some(ref item_id) = self.current_reasoning_id {
            let done_event = json!({
                "type": "response.output_item.done",
                "item": {
                    "id": item_id,
                    "type": "reasoning",
                    "content": self.reasoning_buffer.clone()
                }
            });
            output.extend(serialize_sse_event(None, &done_event.to_string()));

            self.current_reasoning_id = None;
            self.reasoning_buffer.clear();
        }

        output
    }

    fn finalize_message(&mut self) -> Vec<u8> {
        let mut output = Vec::new();

        if let Some(ref item_id) = self.current_message_id {
            let done_event = json!({
                "type": "response.output_item.done",
                "item": {
                    "id": item_id,
                    "type": "message",
                    "role": "assistant",
                    "content": self.content_buffer.clone()
                }
            });
            output.extend(serialize_sse_event(None, &done_event.to_string()));

            self.current_message_id = None;
            self.content_buffer.clear();
        }

        output
    }

    fn finalize_tool_call(&mut self) -> Vec<u8> {
        let mut output = Vec::new();

        if let Some(ref call_id) = self.current_tool_call_id {
            let done_event = json!({
                "type": "response.output_item.done",
                "item": {
                    "id": format!("tool_call_{}", call_id),
                    "type": "function_call",
                    "call_id": call_id,
                    "name": self.tool_call_name_buffer.clone(),
                    "arguments": self.tool_call_args_buffer.clone()
                }
            });
            output.extend(serialize_sse_event(None, &done_event.to_string()));

            self.current_tool_call_id = None;
            self.tool_call_name_buffer.clear();
            self.tool_call_args_buffer.clear();
        }

        output
    }

    fn finalize_all_items(&mut self) -> Vec<u8> {
        let mut output = Vec::new();
        output.extend(self.finalize_reasoning());
        output.extend(self.finalize_message());
        output.extend(self.finalize_tool_call());
        output
    }

    fn send_completed(&mut self, usage: &serde_json::Value) -> Vec<u8> {
        let mut output = Vec::new();

        let status = if self.last_finish_reason.as_deref() == Some("length") {
            "incomplete"
        } else {
            "completed"
        };

        // 映射 usage：prompt_tokens→input_tokens, completion_tokens→output_tokens
        let input_tokens = usage.get("prompt_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
        let output_tokens = usage
            .get("completion_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);

        let completed_event = json!({
            "type": "response.completed",
            "response": {
                "id": self.response_id.as_ref().unwrap_or(&String::new()),
                "status": status,
                "usage": {
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens
                }
            }
        });
        output.extend(serialize_sse_event(None, &completed_event.to_string()));

        output
    }
}

impl Default for StreamTransformer {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_basic_stream_flow() {
        let mut transformer = StreamTransformer::new();

        // 第一个 chunk：带 id，触发 created + in_progress
        let chunk1 = b"data: {\"id\":\"chatcmpl-xxx\",\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"\"}}]}\n\n";
        let output1 = transformer.transform_chunk(chunk1);
        let output1_str = String::from_utf8(output1).unwrap();

        // 应该包含 response.created 和 response.in_progress
        assert!(output1_str.contains("\"type\":\"response.created\""));
        assert!(output1_str.contains("\"type\":\"response.in_progress\""));

        // 第二个 chunk：内容
        let chunk2 =
            b"data: {\"id\":\"chatcmpl-xxx\",\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n\n";
        let output2 = transformer.transform_chunk(chunk2);
        let output2_str = String::from_utf8(output2).unwrap();

        // 应该包含 output_item.added(message) 和 delta
        assert!(output2_str.contains("\"type\":\"response.output_item.added\""));
        assert!(output2_str.contains("\"type\":\"message\""));
        assert!(output2_str.contains("\"type\":\"response.output_item.delta\""));
        assert!(output2_str.contains("\"text\":\"Hello\""));
    }

    #[test]
    fn test_reasoning_content() {
        let mut transformer = StreamTransformer::new();

        let chunk = b"data: {\"id\":\"chatcmpl-xxx\",\"choices\":[{\"delta\":{\"reasoning_content\":\"Let me think...\"}}]}\n\n";
        let output = transformer.transform_chunk(chunk);
        let output_str = String::from_utf8(output).unwrap();

        // 应该包含 reasoning item
        assert!(output_str.contains("\"type\":\"response.output_item.added\""));
        assert!(output_str.contains("\"type\":\"reasoning\""));
        assert!(output_str.contains("\"type\":\"response.output_item.delta\""));
        assert!(output_str.contains("\"text\":\"Let me think...\""));
    }

    #[test]
    fn test_usage_mapping() {
        let mut transformer = StreamTransformer::new();

        // 初始化
        let chunk1 = b"data: {\"id\":\"chatcmpl-xxx\",\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\n\n";
        transformer.transform_chunk(chunk1);

        // 带 usage 的最后 chunk
        let chunk2 = b"data: {\"id\":\"chatcmpl-xxx\",\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":20}}\n\n";
        let output2 = transformer.transform_chunk(chunk2);
        let output2_str = String::from_utf8(output2).unwrap();

        // 应该包含 response.completed with usage
        assert!(output2_str.contains("\"type\":\"response.completed\""));
        assert!(output2_str.contains("\"input_tokens\":10"));
        assert!(output2_str.contains("\"output_tokens\":20"));
    }

    #[test]
    fn test_finish_reason_length_maps_to_incomplete() {
        let mut transformer = StreamTransformer::new();

        let chunk1 = b"data: {\"id\":\"chatcmpl-xxx\",\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\n\n";
        transformer.transform_chunk(chunk1);

        let chunk2 = b"data: {\"id\":\"chatcmpl-xxx\",\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":20}}\n\n";
        let output2 = transformer.transform_chunk(chunk2);
        let output2_str = String::from_utf8(output2).unwrap();

        assert!(output2_str.contains("\"status\":\"incomplete\""));
    }
}
