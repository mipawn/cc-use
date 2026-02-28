use serde::{Deserialize, Serialize};

/// Token usage from API response
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TokenUsage {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_creation_tokens: i64,
}

/// Parse usage from a non-streaming JSON response
pub fn parse_usage_from_response(body: &str) -> (Option<TokenUsage>, Option<String>) {
    let json: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => return (None, None),
    };

    let model = json.get("model").and_then(|m| m.as_str()).map(|s| s.to_string());
    let usage = parse_usage_from_json(&json);

    (usage, model)
}

fn parse_usage_from_json(json: &serde_json::Value) -> Option<TokenUsage> {
    let usage = json.get("usage")?;

    // Claude format
    if usage.get("input_tokens").is_some() || usage.get("output_tokens").is_some() {
        return Some(TokenUsage {
            input_tokens: usage.get("input_tokens").and_then(|v| v.as_i64()).unwrap_or(0),
            output_tokens: usage.get("output_tokens").and_then(|v| v.as_i64()).unwrap_or(0),
            cache_read_tokens: usage.get("cache_read_input_tokens").and_then(|v| v.as_i64()).unwrap_or(0),
            cache_creation_tokens: usage.get("cache_creation_input_tokens").and_then(|v| v.as_i64()).unwrap_or(0),
        });
    }

    // OpenAI format
    if usage.get("prompt_tokens").is_some() || usage.get("completion_tokens").is_some() {
        return Some(TokenUsage {
            input_tokens: usage.get("prompt_tokens").and_then(|v| v.as_i64()).unwrap_or(0),
            output_tokens: usage.get("completion_tokens").and_then(|v| v.as_i64()).unwrap_or(0),
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
        });
    }

    None
}

/// Accumulate usage from SSE streaming chunks
pub struct StreamUsageAccumulator {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_creation_tokens: i64,
    pub model: Option<String>,
}

impl StreamUsageAccumulator {
    pub fn new() -> Self {
        Self {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            model: None,
        }
    }

    pub fn process_chunk(&mut self, chunk: &str) {
        for line in chunk.lines() {
            if !line.starts_with("data: ") {
                continue;
            }
            let json_str = &line[6..];
            if json_str == "[DONE]" {
                continue;
            }

            let data: serde_json::Value = match serde_json::from_str(json_str) {
                Ok(v) => v,
                Err(_) => continue,
            };

            // Extract model
            if let Some(msg) = data.get("message") {
                if let Some(m) = msg.get("model").and_then(|v| v.as_str()) {
                    self.model = Some(m.to_string());
                }
            }
            if self.model.is_none() {
                if let Some(m) = data.get("model").and_then(|v| v.as_str()) {
                    self.model = Some(m.to_string());
                }
            }

            // Claude message_start — input tokens
            if data.get("type").and_then(|v| v.as_str()) == Some("message_start") {
                if let Some(usage) = data.get("message").and_then(|m| m.get("usage")) {
                    self.input_tokens = usage.get("input_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
                    self.cache_read_tokens = usage.get("cache_read_input_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
                    self.cache_creation_tokens = usage.get("cache_creation_input_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
                }
            }

            // Claude message_delta — output tokens
            if data.get("type").and_then(|v| v.as_str()) == Some("message_delta") {
                if let Some(usage) = data.get("usage") {
                    self.output_tokens = usage.get("output_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
                }
            }

            // OpenAI format — full usage in final chunk
            if let Some(usage) = data.get("usage") {
                if usage.get("prompt_tokens").is_some() {
                    self.input_tokens = usage.get("prompt_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
                    self.output_tokens = usage.get("completion_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
                }
            }
        }
    }

    pub fn get_usage(&self) -> Option<TokenUsage> {
        if self.input_tokens == 0 && self.output_tokens == 0 {
            return None;
        }
        Some(TokenUsage {
            input_tokens: self.input_tokens,
            output_tokens: self.output_tokens,
            cache_read_tokens: self.cache_read_tokens,
            cache_creation_tokens: self.cache_creation_tokens,
        })
    }
}

/// Parse usage from collected response data (handles both SSE and JSON)
pub fn parse_usage_from_response_data(
    response_text: &str,
    content_type: &str,
) -> (Option<TokenUsage>, Option<String>, bool) {
    let is_sse = content_type.contains("text/event-stream")
        || response_text.trim_start().starts_with("data: ");

    if is_sse {
        let mut acc = StreamUsageAccumulator::new();
        acc.process_chunk(response_text);
        (acc.get_usage(), acc.model.clone(), true)
    } else {
        let (usage, model) = parse_usage_from_response(response_text);
        (usage, model, false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_claude_response() {
        let body = r#"{"usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":10,"cache_creation_input_tokens":5},"model":"claude-sonnet-4"}"#;
        let (usage, model) = parse_usage_from_response(body);
        let u = usage.unwrap();
        assert_eq!(u.input_tokens, 100);
        assert_eq!(u.output_tokens, 50);
        assert_eq!(u.cache_read_tokens, 10);
        assert_eq!(u.cache_creation_tokens, 5);
        assert_eq!(model.unwrap(), "claude-sonnet-4");
    }

    #[test]
    fn test_parse_openai_response() {
        let body = r#"{"usage":{"prompt_tokens":200,"completion_tokens":100},"model":"gpt-4o"}"#;
        let (usage, model) = parse_usage_from_response(body);
        let u = usage.unwrap();
        assert_eq!(u.input_tokens, 200);
        assert_eq!(u.output_tokens, 100);
        assert_eq!(model.unwrap(), "gpt-4o");
    }

    #[test]
    fn test_parse_no_usage() {
        let body = r#"{"error":"bad request"}"#;
        let (usage, _) = parse_usage_from_response(body);
        assert!(usage.is_none());
    }

    #[test]
    fn test_parse_streaming_sse() {
        let chunk = "data: {\"type\":\"message_start\",\"message\":{\"model\":\"claude-sonnet-4\",\"usage\":{\"input_tokens\":500,\"cache_read_input_tokens\":20}}}\n\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":300}}\n\n";
        let mut acc = StreamUsageAccumulator::new();
        acc.process_chunk(chunk);
        let u = acc.get_usage().unwrap();
        assert_eq!(u.input_tokens, 500);
        assert_eq!(u.output_tokens, 300);
        assert_eq!(u.cache_read_tokens, 20);
        assert_eq!(acc.model.unwrap(), "claude-sonnet-4");
    }
}
