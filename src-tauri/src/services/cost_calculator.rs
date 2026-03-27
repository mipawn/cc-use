use crate::models::ModelPricing;
use std::collections::HashMap;

/// Default model pricing table (per million tokens, in USD)
pub fn default_pricing() -> HashMap<String, ModelPricing> {
    let mut m = HashMap::new();

    // Claude models
    m.insert("claude-opus-4".to_string(), ModelPricing { input: 15.0, output: 75.0, cache_read: Some(1.5), cache_creation: Some(18.75) });
    m.insert("claude-sonnet-4".to_string(), ModelPricing { input: 3.0, output: 15.0, cache_read: Some(0.3), cache_creation: Some(3.75) });
    m.insert("claude-haiku-4".to_string(), ModelPricing { input: 0.8, output: 4.0, cache_read: Some(0.08), cache_creation: Some(1.0) });
    m.insert("claude-3-5-sonnet".to_string(), ModelPricing { input: 3.0, output: 15.0, cache_read: Some(0.3), cache_creation: Some(3.75) });
    m.insert("claude-3-5-haiku".to_string(), ModelPricing { input: 0.8, output: 4.0, cache_read: Some(0.08), cache_creation: Some(1.0) });
    m.insert("claude-3-opus".to_string(), ModelPricing { input: 15.0, output: 75.0, cache_read: Some(1.5), cache_creation: Some(18.75) });
    m.insert("claude-3-sonnet".to_string(), ModelPricing { input: 3.0, output: 15.0, cache_read: Some(0.3), cache_creation: Some(3.75) });
    m.insert("claude-3-haiku".to_string(), ModelPricing { input: 0.25, output: 1.25, cache_read: Some(0.03), cache_creation: Some(0.3) });

    // OpenAI models
    m.insert("gpt-4o".to_string(), ModelPricing { input: 2.5, output: 10.0, cache_read: Some(1.25), cache_creation: None });
    m.insert("gpt-4o-mini".to_string(), ModelPricing { input: 0.15, output: 0.6, cache_read: Some(0.075), cache_creation: None });
    m.insert("gpt-4-turbo".to_string(), ModelPricing { input: 10.0, output: 30.0, cache_read: None, cache_creation: None });
    m.insert("gpt-4".to_string(), ModelPricing { input: 30.0, output: 60.0, cache_read: None, cache_creation: None });
    m.insert("o1".to_string(), ModelPricing { input: 15.0, output: 60.0, cache_read: Some(7.5), cache_creation: None });
    m.insert("o1-mini".to_string(), ModelPricing { input: 3.0, output: 12.0, cache_read: Some(1.5), cache_creation: None });
    m.insert("o3-mini".to_string(), ModelPricing { input: 1.1, output: 4.4, cache_read: Some(0.55), cache_creation: None });
    m.insert("o4-mini".to_string(), ModelPricing { input: 1.1, output: 4.4, cache_read: Some(0.55), cache_creation: None });
    m.insert("codex-mini".to_string(), ModelPricing { input: 1.5, output: 6.0, cache_read: Some(0.75), cache_creation: None });

    // DeepSeek models
    m.insert("deepseek-chat".to_string(), ModelPricing { input: 0.27, output: 1.1, cache_read: Some(0.07), cache_creation: None });
    m.insert("deepseek-reasoner".to_string(), ModelPricing { input: 0.55, output: 2.19, cache_read: Some(0.14), cache_creation: None });

    // Google models
    m.insert("gemini-2.5-pro".to_string(), ModelPricing { input: 1.25, output: 10.0, cache_read: None, cache_creation: None });
    m.insert("gemini-2.5-flash".to_string(), ModelPricing { input: 0.15, output: 0.6, cache_read: None, cache_creation: None });
    m.insert("gemini-2.0-flash".to_string(), ModelPricing { input: 0.1, output: 0.4, cache_read: None, cache_creation: None });

    m
}

/// Find pricing for a model, supporting fuzzy/prefix matching
pub fn find_pricing(
    model: &str,
    custom_pricing: &HashMap<String, ModelPricing>,
) -> Option<ModelPricing> {
    // 1. Exact match in custom pricing
    if let Some(p) = custom_pricing.get(model) {
        return Some(p.clone());
    }

    let defaults = default_pricing();

    // 2. Exact match in defaults
    if let Some(p) = defaults.get(model) {
        return Some(p.clone());
    }

    // 3. Prefix match (e.g., "claude-sonnet-4-20250514" → "claude-sonnet-4")
    for (key, pricing) in defaults.iter() {
        if model.starts_with(key) {
            return Some(pricing.clone());
        }
    }

    // 4. Prefix match in custom pricing
    for (key, pricing) in custom_pricing.iter() {
        if model.starts_with(key) {
            return Some(pricing.clone());
        }
    }

    None
}

/// Calculate cost for a request (returns cost in USD)
pub fn calculate_cost(
    model: &str,
    input_tokens: i64,
    output_tokens: i64,
    cache_read_tokens: i64,
    cache_creation_tokens: i64,
    cost_multiplier: f64,
    custom_pricing: &HashMap<String, ModelPricing>,
) -> (f64, f64, f64, f64, f64) {
    let pricing = match find_pricing(model, custom_pricing) {
        Some(p) => p,
        None => return (0.0, 0.0, 0.0, 0.0, 0.0),
    };

    let input_cost = (input_tokens as f64 / 1_000_000.0) * pricing.input * cost_multiplier;
    let output_cost = (output_tokens as f64 / 1_000_000.0) * pricing.output * cost_multiplier;
    let cache_read_cost = (cache_read_tokens as f64 / 1_000_000.0)
        * pricing.cache_read.unwrap_or(0.0) * cost_multiplier;
    let cache_creation_cost = (cache_creation_tokens as f64 / 1_000_000.0)
        * pricing.cache_creation.unwrap_or(0.0) * cost_multiplier;
    let total = input_cost + output_cost + cache_read_cost + cache_creation_cost;

    (input_cost, output_cost, cache_read_cost, cache_creation_cost, total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_calculate_cost_claude_sonnet() {
        let custom = HashMap::new();
        let (input, output, _, _, total) = calculate_cost(
            "claude-sonnet-4",
            1000, 500, 0, 0, 1.0,
            &custom,
        );
        // 1000/1M * 3.0 = 0.003
        assert!((input - 0.003).abs() < 1e-9);
        // 500/1M * 15.0 = 0.0075
        assert!((output - 0.0075).abs() < 1e-9);
        assert!((total - 0.0105).abs() < 1e-9);
    }

    #[test]
    fn test_calculate_cost_with_cache_tokens() {
        let custom = HashMap::new();
        let (_, _, cache_read, cache_creation, _) = calculate_cost(
            "claude-sonnet-4",
            0, 0, 10000, 5000, 1.0,
            &custom,
        );
        // 10000/1M * 0.3 = 0.003
        assert!((cache_read - 0.003).abs() < 1e-9);
        // 5000/1M * 3.75 = 0.01875
        assert!((cache_creation - 0.01875).abs() < 1e-9);
    }

    #[test]
    fn test_calculate_cost_with_multiplier() {
        let custom = HashMap::new();
        let (_, _, _, _, total) = calculate_cost(
            "claude-sonnet-4",
            1_000_000, 0, 0, 0, 1.5,
            &custom,
        );
        // 1M/1M * 3.0 * 1.5 = 4.5
        assert!((total - 4.5).abs() < 1e-6);
    }

    #[test]
    fn test_model_pricing_prefix_match() {
        let custom = HashMap::new();
        let pricing = find_pricing("claude-sonnet-4-20250514", &custom);
        assert!(pricing.is_some());
        assert!((pricing.unwrap().input - 3.0).abs() < 1e-6);
    }
}
