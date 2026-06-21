//! 推理链(reasoning_content)处理
//!
//! DeepSeek R1、OpenAI o1/o3 等模型会在响应中返回推理过程,需要特殊处理。

use serde_json::Value;

/// 判断模型是否为推理模型(reasoning model)。
///
/// 推理模型需要使用 `max_completion_tokens` 而非 `max_tokens`。
///
/// # Examples
///
/// ```
/// use cc_use_lib::proxy::transform::reasoning::is_reasoning_model;
///
/// assert!(is_reasoning_model("o1-preview"));
/// assert!(is_reasoning_model("o3-mini"));
/// assert!(is_reasoning_model("gpt-5-turbo"));
/// assert!(!is_reasoning_model("gpt-4-turbo"));
/// assert!(!is_reasoning_model("deepseek-chat"));
/// ```
pub fn is_reasoning_model(model: &str) -> bool {
    let m = model.to_lowercase();
    m.starts_with("o1") || m.starts_with("o3") || m.starts_with("o4") || m.starts_with("gpt-5")
}

/// 从 OpenAI Chat delta 中提取 reasoning_content(如 DeepSeek R1)。
///
/// 返回 `Some(content)` 如果存在且非空,否则返回 `None`。
///
/// # Examples
///
/// ```
/// use serde_json::json;
/// use cc_use_lib::proxy::transform::reasoning::extract_reasoning_content;
///
/// let delta = json!({"reasoning_content": "Let me think..."});
/// assert_eq!(extract_reasoning_content(&delta), Some("Let me think...".to_string()));
///
/// let delta = json!({"reasoning_content": ""});
/// assert_eq!(extract_reasoning_content(&delta), None);
///
/// let delta = json!({"content": "Hello"});
/// assert_eq!(extract_reasoning_content(&delta), None);
/// ```
pub fn extract_reasoning_content(delta: &Value) -> Option<String> {
    delta
        .get("reasoning_content")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(String::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_is_reasoning_model_o1() {
        assert!(is_reasoning_model("o1-preview"));
        assert!(is_reasoning_model("o1-mini"));
        assert!(is_reasoning_model("O1-PREVIEW"));
    }

    #[test]
    fn test_is_reasoning_model_o3() {
        assert!(is_reasoning_model("o3-mini"));
        assert!(is_reasoning_model("o3"));
    }

    #[test]
    fn test_is_reasoning_model_o4() {
        assert!(is_reasoning_model("o4-preview"));
    }

    #[test]
    fn test_is_reasoning_model_gpt5() {
        assert!(is_reasoning_model("gpt-5"));
        assert!(is_reasoning_model("gpt-5-turbo"));
        assert!(is_reasoning_model("GPT-5"));
    }

    #[test]
    fn test_is_not_reasoning_model() {
        assert!(!is_reasoning_model("gpt-4-turbo"));
        assert!(!is_reasoning_model("gpt-4o"));
        assert!(!is_reasoning_model("deepseek-chat"));
        assert!(!is_reasoning_model("claude-3-opus"));
    }

    #[test]
    fn test_extract_reasoning_content_present() {
        let delta = json!({"reasoning_content": "Let me think..."});
        assert_eq!(
            extract_reasoning_content(&delta),
            Some("Let me think...".to_string())
        );
    }

    #[test]
    fn test_extract_reasoning_content_empty() {
        let delta = json!({"reasoning_content": ""});
        assert_eq!(extract_reasoning_content(&delta), None);
    }

    #[test]
    fn test_extract_reasoning_content_absent() {
        let delta = json!({"content": "Hello"});
        assert_eq!(extract_reasoning_content(&delta), None);
    }

    #[test]
    fn test_extract_reasoning_content_wrong_type() {
        let delta = json!({"reasoning_content": 123});
        assert_eq!(extract_reasoning_content(&delta), None);
    }

    #[test]
    fn test_extract_reasoning_content_null() {
        let delta = json!({"reasoning_content": null});
        assert_eq!(extract_reasoning_content(&delta), None);
    }
}
