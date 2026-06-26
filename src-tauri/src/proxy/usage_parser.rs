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

    let model = json
        .get("model")
        .or_else(|| json.get("response").and_then(|r| r.get("model")))
        .and_then(|m| m.as_str())
        .map(|s| s.to_string());
    let usage = parse_usage_from_json(&json);

    (usage, model)
}

fn parse_usage_from_json(json: &serde_json::Value) -> Option<TokenUsage> {
    let usage = json
        .get("usage")
        .or_else(|| json.get("response").and_then(|r| r.get("usage")))
        .or_else(|| find_usage_value(json))?;
    parse_usage_value(usage)
}

fn find_usage_value(json: &serde_json::Value) -> Option<&serde_json::Value> {
    match json {
        serde_json::Value::Object(map) => {
            if let Some(usage) = map.get("usage") {
                if usage.get("input_tokens").is_some()
                    || usage.get("output_tokens").is_some()
                    || usage.get("prompt_tokens").is_some()
                    || usage.get("completion_tokens").is_some()
                {
                    return Some(usage);
                }
            }
            map.values().find_map(find_usage_value)
        }
        serde_json::Value::Array(items) => items.iter().find_map(find_usage_value),
        _ => None,
    }
}

fn parse_usage_value(usage: &serde_json::Value) -> Option<TokenUsage> {
    let cache_read_tokens = usage
        .get("cache_read_input_tokens")
        .or_else(|| {
            usage
                .get("input_tokens_details")
                .and_then(|details| details.get("cached_tokens"))
        })
        .and_then(|v| v.as_i64())
        .unwrap_or(0);

    // Claude / OpenAI Responses format
    if usage.get("input_tokens").is_some() || usage.get("output_tokens").is_some() {
        return Some(TokenUsage {
            input_tokens: usage
                .get("input_tokens")
                .and_then(|v| v.as_i64())
                .unwrap_or(0),
            output_tokens: usage
                .get("output_tokens")
                .and_then(|v| v.as_i64())
                .unwrap_or(0),
            cache_read_tokens,
            cache_creation_tokens: usage
                .get("cache_creation_input_tokens")
                .and_then(|v| v.as_i64())
                .unwrap_or(0),
        });
    }

    // OpenAI format
    if usage.get("prompt_tokens").is_some() || usage.get("completion_tokens").is_some() {
        return Some(TokenUsage {
            input_tokens: usage
                .get("prompt_tokens")
                .and_then(|v| v.as_i64())
                .unwrap_or(0),
            output_tokens: usage
                .get("completion_tokens")
                .and_then(|v| v.as_i64())
                .unwrap_or(0),
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
        });
    }

    None
}

/// Accumulate usage from SSE streaming chunks.
///
/// Handles cross-chunk line splitting by buffering incomplete lines.
pub struct StreamUsageAccumulator {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_creation_tokens: i64,
    pub model: Option<String>,
    data_event_count: usize,
    invalid_json_count: usize,
    event_types: Vec<String>,
    top_level_keys: Vec<String>,
    /// Buffer for incomplete lines that span across TCP chunks
    line_buffer: String,
}

impl StreamUsageAccumulator {
    pub fn new() -> Self {
        Self {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            model: None,
            data_event_count: 0,
            invalid_json_count: 0,
            event_types: Vec::new(),
            top_level_keys: Vec::new(),
            line_buffer: String::new(),
        }
    }

    pub fn process_chunk(&mut self, chunk: &str) {
        // Prepend any buffered incomplete line from previous chunk
        let data_to_process = if self.line_buffer.is_empty() {
            chunk.to_string()
        } else {
            let combined = format!("{}{}", self.line_buffer, chunk);
            self.line_buffer.clear();
            combined
        };

        // If the chunk doesn't end with a newline, the last line is incomplete
        let ends_with_newline = data_to_process.ends_with('\n');
        let lines: Vec<&str> = data_to_process.lines().collect();

        for (i, line) in lines.iter().enumerate() {
            // If this is the last line and chunk didn't end with newline,
            // buffer it for the next chunk
            if i == lines.len() - 1 && !ends_with_newline {
                self.line_buffer = line.to_string();
                break;
            }

            self.process_sse_line(line);
        }
    }

    fn process_sse_line(&mut self, line: &str) {
        if !line.starts_with("data: ") {
            return;
        }
        let json_str = &line[6..];
        if json_str == "[DONE]" {
            return;
        }
        self.data_event_count += 1;

        let data: serde_json::Value = match serde_json::from_str(json_str) {
            Ok(v) => v,
            Err(_) => {
                self.invalid_json_count += 1;
                return;
            }
        };

        if let Some(obj) = data.as_object() {
            for key in obj.keys() {
                push_limited_unique(&mut self.top_level_keys, key);
            }
        }

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

        let event_type = data.get("type").and_then(|v| v.as_str());
        if let Some(event_type) = event_type {
            push_limited_unique(&mut self.event_types, event_type);
        }

        // Claude message_start — input tokens
        if event_type == Some("message_start") {
            if let Some(usage) = data.get("message").and_then(|m| m.get("usage")) {
                self.input_tokens = usage
                    .get("input_tokens")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0);
                self.cache_read_tokens = usage
                    .get("cache_read_input_tokens")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0);
                self.cache_creation_tokens = usage
                    .get("cache_creation_input_tokens")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0);
            }
        }

        // Claude message_delta — output tokens (final cumulative value)
        if event_type == Some("message_delta") {
            if let Some(usage) = data.get("usage") {
                if let Some(v) = usage.get("output_tokens").and_then(|v| v.as_i64()) {
                    self.output_tokens = v;
                }
            }
        }

        // OpenAI format — full usage in final chunk
        if let Some(usage) = data.get("usage") {
            if usage.get("prompt_tokens").is_some() {
                self.input_tokens = usage
                    .get("prompt_tokens")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0);
                self.output_tokens = usage
                    .get("completion_tokens")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0);
            }
        }

        // OpenAI Responses streaming format — final events often wrap usage
        // under `response.usage` instead of putting it at the top level.
        if let Some(usage) = data
            .get("response")
            .and_then(|response| response.get("usage"))
            .or_else(|| {
                if event_type
                    .map(|event_type| event_type.starts_with("response."))
                    .unwrap_or(false)
                {
                    find_usage_value(&data)
                } else {
                    None
                }
            })
        {
            if let Some(parsed) = parse_usage_value(usage) {
                self.input_tokens = parsed.input_tokens;
                self.output_tokens = parsed.output_tokens;
                self.cache_read_tokens = parsed.cache_read_tokens;
                self.cache_creation_tokens = parsed.cache_creation_tokens;
            }
        }
        if self.model.is_none() {
            if let Some(m) = data
                .get("response")
                .and_then(|response| response.get("model"))
                .and_then(|v| v.as_str())
            {
                self.model = Some(m.to_string());
            }
        }
    }

    /// Flush any remaining buffered line (call when stream ends)
    pub fn flush(&mut self) {
        if !self.line_buffer.is_empty() {
            let line = std::mem::take(&mut self.line_buffer);
            self.process_sse_line(&line);
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

    pub fn diagnostics_summary(&self) -> String {
        format!(
            "data_events={}, invalid_json={}, event_types=[{}], top_level_keys=[{}], model_seen={}",
            self.data_event_count,
            self.invalid_json_count,
            self.event_types.join(","),
            self.top_level_keys.join(","),
            self.model.as_deref().unwrap_or("")
        )
    }
}

fn push_limited_unique(values: &mut Vec<String>, value: &str) {
    if values.len() >= 16 || values.iter().any(|existing| existing == value) {
        return;
    }
    values.push(value.to_string());
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
        acc.flush();
        (acc.get_usage(), acc.model.clone(), true)
    } else {
        let (usage, model) = parse_usage_from_response(response_text);
        (usage, model, false)
    }
}
