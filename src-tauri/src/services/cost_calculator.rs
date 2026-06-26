use crate::models::ModelPricing;
use std::collections::HashMap;

/// Default model pricing table (per million tokens, in USD)
pub fn default_pricing() -> HashMap<String, ModelPricing> {
    let mut m = HashMap::new();

    // Claude models
    m.insert(
        "claude-fable-5".to_string(),
        ModelPricing {
            input: 10.0,
            output: 50.0,
            cache_read: Some(1.0),
            cache_creation: Some(12.5),
        },
    );
    m.insert(
        "claude-mythos-5".to_string(),
        ModelPricing {
            input: 10.0,
            output: 50.0,
            cache_read: Some(1.0),
            cache_creation: Some(12.5),
        },
    );
    m.insert(
        "claude-opus-4-8".to_string(),
        ModelPricing {
            input: 5.0,
            output: 25.0,
            cache_read: Some(0.5),
            cache_creation: Some(6.25),
        },
    );
    m.insert(
        "claude-opus-4-7".to_string(),
        ModelPricing {
            input: 5.0,
            output: 25.0,
            cache_read: Some(0.5),
            cache_creation: Some(6.25),
        },
    );
    m.insert(
        "claude-opus-4-6".to_string(),
        ModelPricing {
            input: 5.0,
            output: 25.0,
            cache_read: Some(0.5),
            cache_creation: Some(6.25),
        },
    );
    m.insert(
        "claude-opus-4-5".to_string(),
        ModelPricing {
            input: 5.0,
            output: 25.0,
            cache_read: Some(0.5),
            cache_creation: Some(6.25),
        },
    );
    m.insert(
        "claude-opus-4-1".to_string(),
        ModelPricing {
            input: 15.0,
            output: 75.0,
            cache_read: Some(1.5),
            cache_creation: Some(18.75),
        },
    );
    m.insert(
        "claude-opus-4".to_string(),
        ModelPricing {
            input: 15.0,
            output: 75.0,
            cache_read: Some(1.5),
            cache_creation: Some(18.75),
        },
    );
    m.insert(
        "claude-sonnet-4-6".to_string(),
        ModelPricing {
            input: 3.0,
            output: 15.0,
            cache_read: Some(0.3),
            cache_creation: Some(3.75),
        },
    );
    m.insert(
        "claude-sonnet-4-5".to_string(),
        ModelPricing {
            input: 3.0,
            output: 15.0,
            cache_read: Some(0.3),
            cache_creation: Some(3.75),
        },
    );
    m.insert(
        "claude-sonnet-4".to_string(),
        ModelPricing {
            input: 3.0,
            output: 15.0,
            cache_read: Some(0.3),
            cache_creation: Some(3.75),
        },
    );
    m.insert(
        "claude-haiku-4-5".to_string(),
        ModelPricing {
            input: 1.0,
            output: 5.0,
            cache_read: Some(0.1),
            cache_creation: Some(1.25),
        },
    );
    m.insert(
        "claude-haiku-4".to_string(),
        ModelPricing {
            input: 0.8,
            output: 4.0,
            cache_read: Some(0.08),
            cache_creation: Some(1.0),
        },
    );
    m.insert(
        "claude-3-5-sonnet".to_string(),
        ModelPricing {
            input: 3.0,
            output: 15.0,
            cache_read: Some(0.3),
            cache_creation: Some(3.75),
        },
    );
    m.insert(
        "claude-3-5-haiku".to_string(),
        ModelPricing {
            input: 0.8,
            output: 4.0,
            cache_read: Some(0.08),
            cache_creation: Some(1.0),
        },
    );
    m.insert(
        "claude-3-opus".to_string(),
        ModelPricing {
            input: 15.0,
            output: 75.0,
            cache_read: Some(1.5),
            cache_creation: Some(18.75),
        },
    );
    m.insert(
        "claude-3-sonnet".to_string(),
        ModelPricing {
            input: 3.0,
            output: 15.0,
            cache_read: Some(0.3),
            cache_creation: Some(3.75),
        },
    );
    m.insert(
        "claude-3-haiku".to_string(),
        ModelPricing {
            input: 0.25,
            output: 1.25,
            cache_read: Some(0.03),
            cache_creation: Some(0.3),
        },
    );

    // OpenAI models
    m.insert(
        "gpt-5.5-pro".to_string(),
        ModelPricing {
            input: 30.0,
            output: 180.0,
            cache_read: None,
            cache_creation: None,
        },
    );
    m.insert(
        "gpt-5.5".to_string(),
        ModelPricing {
            input: 5.0,
            output: 30.0,
            cache_read: Some(0.5),
            cache_creation: None,
        },
    );
    m.insert(
        "gpt-5.4-pro".to_string(),
        ModelPricing {
            input: 30.0,
            output: 180.0,
            cache_read: None,
            cache_creation: None,
        },
    );
    m.insert(
        "gpt-5.4-mini".to_string(),
        ModelPricing {
            input: 0.75,
            output: 4.5,
            cache_read: Some(0.075),
            cache_creation: None,
        },
    );
    m.insert(
        "gpt-5.4-nano".to_string(),
        ModelPricing {
            input: 0.2,
            output: 1.25,
            cache_read: Some(0.02),
            cache_creation: None,
        },
    );
    m.insert(
        "gpt-5.4".to_string(),
        ModelPricing {
            input: 2.5,
            output: 15.0,
            cache_read: Some(0.25),
            cache_creation: None,
        },
    );
    m.insert(
        "gpt-5.3-codex".to_string(),
        ModelPricing {
            input: 1.75,
            output: 14.0,
            cache_read: Some(0.175),
            cache_creation: None,
        },
    );
    m.insert(
        "chat-latest".to_string(),
        ModelPricing {
            input: 5.0,
            output: 30.0,
            cache_read: Some(0.5),
            cache_creation: None,
        },
    );
    m.insert(
        "gpt-4o".to_string(),
        ModelPricing {
            input: 2.5,
            output: 10.0,
            cache_read: Some(1.25),
            cache_creation: None,
        },
    );
    m.insert(
        "gpt-4o-mini".to_string(),
        ModelPricing {
            input: 0.15,
            output: 0.6,
            cache_read: Some(0.075),
            cache_creation: None,
        },
    );
    m.insert(
        "gpt-4-turbo".to_string(),
        ModelPricing {
            input: 10.0,
            output: 30.0,
            cache_read: None,
            cache_creation: None,
        },
    );
    m.insert(
        "gpt-4".to_string(),
        ModelPricing {
            input: 30.0,
            output: 60.0,
            cache_read: None,
            cache_creation: None,
        },
    );
    m.insert(
        "o1".to_string(),
        ModelPricing {
            input: 15.0,
            output: 60.0,
            cache_read: Some(7.5),
            cache_creation: None,
        },
    );
    m.insert(
        "o1-mini".to_string(),
        ModelPricing {
            input: 3.0,
            output: 12.0,
            cache_read: Some(1.5),
            cache_creation: None,
        },
    );
    m.insert(
        "o3-mini".to_string(),
        ModelPricing {
            input: 1.1,
            output: 4.4,
            cache_read: Some(0.55),
            cache_creation: None,
        },
    );
    m.insert(
        "o4-mini".to_string(),
        ModelPricing {
            input: 1.1,
            output: 4.4,
            cache_read: Some(0.55),
            cache_creation: None,
        },
    );
    m.insert(
        "codex-mini".to_string(),
        ModelPricing {
            input: 1.5,
            output: 6.0,
            cache_read: Some(0.75),
            cache_creation: None,
        },
    );

    // DeepSeek models
    m.insert(
        "deepseek-v4-pro".to_string(),
        ModelPricing {
            input: 2.0,
            output: 4.0,
            cache_read: Some(0.02),
            cache_creation: None,
        },
    );
    m.insert(
        "deepseek-v4-flash".to_string(),
        ModelPricing {
            input: 1.0,
            output: 2.0,
            cache_read: Some(0.02),
            cache_creation: Some(0.02),
        },
    );
    m.insert(
        "deepseek-chat".to_string(),
        ModelPricing {
            input: 0.27,
            output: 1.1,
            cache_read: Some(0.07),
            cache_creation: None,
        },
    );
    m.insert(
        "deepseek-reasoner".to_string(),
        ModelPricing {
            input: 0.55,
            output: 2.19,
            cache_read: Some(0.14),
            cache_creation: None,
        },
    );

    // Google models
    m.insert(
        "gemini-2.5-pro".to_string(),
        ModelPricing {
            input: 1.25,
            output: 10.0,
            cache_read: None,
            cache_creation: None,
        },
    );
    m.insert(
        "gemini-2.5-flash".to_string(),
        ModelPricing {
            input: 0.15,
            output: 0.6,
            cache_read: None,
            cache_creation: None,
        },
    );
    m.insert(
        "gemini-2.0-flash".to_string(),
        ModelPricing {
            input: 0.1,
            output: 0.4,
            cache_read: None,
            cache_creation: None,
        },
    );

    m
}

/// Find pricing for a model, supporting fuzzy/prefix matching
pub fn find_pricing(
    model: &str,
    custom_pricing: &HashMap<String, ModelPricing>,
) -> Option<ModelPricing> {
    let defaults = default_pricing();
    let candidates = pricing_model_candidates(model);

    // 1. Exact match in custom pricing
    for candidate in &candidates {
        if let Some(p) = custom_pricing.get(candidate) {
            return Some(p.clone());
        }
    }

    // 2. Exact match in defaults
    for candidate in &candidates {
        if let Some(p) = defaults.get(candidate) {
            return Some(p.clone());
        }
    }

    // 3. Prefix match (e.g., "claude-sonnet-4-20250514" → "claude-sonnet-4")
    if let Some(p) = longest_prefix_match(&candidates, &defaults) {
        return Some(p);
    }

    // 4. Prefix match in custom pricing
    longest_prefix_match(&candidates, custom_pricing)
}

fn longest_prefix_match(
    candidates: &[String],
    pricing: &HashMap<String, ModelPricing>,
) -> Option<ModelPricing> {
    let mut keys: Vec<&String> = pricing.keys().collect();
    keys.sort_by_key(|key| std::cmp::Reverse(key.len()));

    for candidate in candidates {
        for key in &keys {
            if candidate.starts_with(key.as_str()) {
                return pricing.get(*key).cloned();
            }
        }
    }
    None
}

fn pricing_model_candidates(model: &str) -> Vec<String> {
    let mut candidates = Vec::new();
    push_candidate(&mut candidates, model);

    if let Some((_, rest)) = model.rsplit_once('/') {
        push_candidate(&mut candidates, rest);
    }
    if let Some(rest) = model.strip_prefix("models/") {
        push_candidate(&mut candidates, rest);
    }

    for prefix in ["anthropic.", "openai.", "bedrock.", "vertex.", "google."] {
        if let Some(rest) = model.strip_prefix(prefix) {
            push_candidate(&mut candidates, rest);
        }
    }

    candidates
}

fn push_candidate(candidates: &mut Vec<String>, value: &str) {
    let candidate = value.trim().to_ascii_lowercase();
    if !candidate.is_empty() && !candidates.contains(&candidate) {
        candidates.push(candidate);
    }
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
        * pricing.cache_read.unwrap_or(0.0)
        * cost_multiplier;
    let cache_creation_cost = (cache_creation_tokens as f64 / 1_000_000.0)
        * pricing.cache_creation.unwrap_or(0.0)
        * cost_multiplier;
    let total = input_cost + output_cost + cache_read_cost + cache_creation_cost;

    (
        input_cost,
        output_cost,
        cache_read_cost,
        cache_creation_cost,
        total,
    )
}
