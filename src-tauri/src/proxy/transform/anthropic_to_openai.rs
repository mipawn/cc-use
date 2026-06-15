//! Anthropic Messages API → OpenAI Chat Completions API 转换
//!
//! 场景：用户使用 Claude Code CLI，但 Provider 只提供 OpenAI Chat Completions API
//!
//! TODO: Week 1 Day 4 实现

use crate::proxy::transform::TransformedRequest;
use serde_json::Value;

pub fn transform_request(_body: Value, _target_model: Option<&str>) -> TransformedRequest {
    todo!("Week 1 Day 4")
}
