use crate::models::ModelPricing;
use chrono::{NaiveDate, Utc};
use std::collections::HashMap;

/// Default model pricing table (per million tokens, in USD)
pub fn default_pricing() -> HashMap<String, ModelPricing> {
    default_pricing_for_date(Utc::now().date_naive())
}

fn default_pricing_for_date(date: NaiveDate) -> HashMap<String, ModelPricing> {
    let mut m = HashMap::new();

    // Claude models
    m.insert(
        "claude-opus-5".to_string(),
        ModelPricing {
            input: 5.0,
            output: 25.0,
            cache_read: Some(0.5),
            cache_creation: Some(6.25),
        },
    );
    let sonnet_5_intro_ends = NaiveDate::from_ymd_opt(2026, 9, 1).unwrap();
    let sonnet_5_pricing = if date < sonnet_5_intro_ends {
        ModelPricing {
            input: 2.0,
            output: 10.0,
            cache_read: Some(0.2),
            cache_creation: Some(2.5),
        }
    } else {
        ModelPricing {
            input: 3.0,
            output: 15.0,
            cache_read: Some(0.3),
            cache_creation: Some(3.75),
        }
    };
    m.insert("claude-sonnet-5".to_string(), sonnet_5_pricing);
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
        "claude-sonnet-4-6".to_string(),
        ModelPricing {
            input: 3.0,
            output: 15.0,
            cache_read: Some(0.3),
            cache_creation: Some(3.75),
        },
    );

    // OpenAI models
    m.insert(
        "gpt-5.6-sol".to_string(),
        ModelPricing {
            input: 5.0,
            output: 30.0,
            cache_read: Some(0.5),
            cache_creation: Some(6.25),
        },
    );
    m.insert(
        "gpt-5.6".to_string(),
        ModelPricing {
            input: 5.0,
            output: 30.0,
            cache_read: Some(0.5),
            cache_creation: Some(6.25),
        },
    );
    m.insert(
        "gpt-5.6-terra".to_string(),
        ModelPricing {
            input: 2.5,
            output: 15.0,
            cache_read: Some(0.25),
            cache_creation: Some(3.125),
        },
    );
    m.insert(
        "gpt-5.6-luna".to_string(),
        ModelPricing {
            input: 1.0,
            output: 6.0,
            cache_read: Some(0.1),
            cache_creation: Some(1.25),
        },
    );
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

    // DeepSeek models
    m.insert(
        "deepseek-v4-pro".to_string(),
        ModelPricing {
            input: 0.435,
            output: 0.87,
            cache_read: Some(0.003625),
            cache_creation: None,
        },
    );
    m.insert(
        "deepseek-v4-flash".to_string(),
        ModelPricing {
            input: 0.14,
            output: 0.28,
            cache_read: Some(0.0028),
            cache_creation: None,
        },
    );

    // Z.AI models
    m.insert(
        "glm-5.2".to_string(),
        ModelPricing {
            input: 1.4,
            output: 4.4,
            cache_read: Some(0.26),
            cache_creation: Some(0.0),
        },
    );

    // xAI models
    for alias in ["grok-4.5", "grok-4.5-latest"] {
        m.insert(
            alias.to_string(),
            ModelPricing {
                input: 2.0,
                output: 6.0,
                cache_read: Some(0.3),
                cache_creation: None,
            },
        );
    }

    m
}

/// Find pricing for a model, supporting fuzzy/prefix matching
pub fn find_pricing(
    model: &str,
    custom_pricing: &HashMap<String, ModelPricing>,
) -> Option<ModelPricing> {
    find_pricing_match(model, custom_pricing).map(|matched| matched.pricing)
}

struct PricingMatch {
    key: String,
    pricing: ModelPricing,
    is_custom: bool,
}

fn find_pricing_match(
    model: &str,
    custom_pricing: &HashMap<String, ModelPricing>,
) -> Option<PricingMatch> {
    let defaults = default_pricing();
    let candidates = pricing_model_candidates(model);

    // Custom pricing always wins, including its prefix matches.
    if let Some((key, pricing)) = exact_match(&candidates, custom_pricing)
        .or_else(|| longest_prefix_match(&candidates, custom_pricing, &[]))
    {
        return Some(PricingMatch {
            key,
            pricing,
            is_custom: true,
        });
    }

    // Built-in exact/prefix match (e.g. dated model IDs).
    let (key, pricing) = exact_match(&candidates, &defaults)
        .or_else(|| longest_prefix_match(&candidates, &defaults, &["glm-5.2"]))?;
    Some(PricingMatch {
        key,
        pricing,
        is_custom: false,
    })
}

fn exact_match(
    candidates: &[String],
    pricing: &HashMap<String, ModelPricing>,
) -> Option<(String, ModelPricing)> {
    for candidate in candidates {
        if let Some(value) = pricing.get(candidate) {
            return Some((candidate.clone(), value.clone()));
        }
    }
    None
}

fn longest_prefix_match(
    candidates: &[String],
    pricing: &HashMap<String, ModelPricing>,
    exact_only_keys: &[&str],
) -> Option<(String, ModelPricing)> {
    let mut keys: Vec<&String> = pricing.keys().collect();
    keys.sort_by_key(|key| std::cmp::Reverse(key.len()));

    for candidate in candidates {
        for key in &keys {
            if exact_only_keys.contains(&key.as_str()) {
                continue;
            }
            if model_key_matches(candidate, key) {
                return pricing
                    .get(*key)
                    .cloned()
                    .map(|value| ((*key).clone(), value));
            }
        }
    }
    None
}

fn model_key_matches(candidate: &str, key: &str) -> bool {
    let Some(suffix) = candidate.strip_prefix(key) else {
        return false;
    };
    suffix.is_empty()
        || suffix.starts_with('-')
        || suffix.starts_with(':')
        || suffix.starts_with('@')
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
    let qualified_candidates = candidates.clone();
    for candidate in qualified_candidates {
        if let Some(rest) = candidate.strip_suffix("[1m]") {
            push_candidate(&mut candidates, rest);
        }
    }

    let seeds = candidates.clone();
    for seed in seeds {
        for prefix in [
            "anthropic.",
            "openai.",
            "bedrock.",
            "vertex.",
            "google.",
            "xai.",
            "deepseek.",
            "zai.",
            "zhipu.",
        ] {
            if let Some(rest) = seed.strip_prefix(prefix) {
                push_candidate(&mut candidates, rest);
            }
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
    let matched = match find_pricing_match(model, custom_pricing) {
        Some(matched) => matched,
        None => return (0.0, 0.0, 0.0, 0.0, 0.0),
    };
    let total_input_tokens = input_tokens
        .saturating_add(cache_read_tokens)
        .saturating_add(cache_creation_tokens);
    let pricing = if matched.is_custom {
        matched.pricing
    } else {
        apply_context_tier(&matched.key, matched.pricing, total_input_tokens)
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

fn apply_context_tier(
    model_key: &str,
    mut pricing: ModelPricing,
    total_input_tokens: i64,
) -> ModelPricing {
    let (input_multiplier, output_multiplier) =
        if is_openai_long_context_model(model_key) && total_input_tokens > 272_000 {
            (2.0, 1.5)
        } else if is_xai_long_context_model(model_key) && total_input_tokens >= 200_000 {
            (2.0, 2.0)
        } else {
            return pricing;
        };

    pricing.input *= input_multiplier;
    pricing.output *= output_multiplier;
    pricing.cache_read = pricing.cache_read.map(|price| price * input_multiplier);
    pricing.cache_creation = pricing.cache_creation.map(|price| price * input_multiplier);
    pricing
}

fn is_openai_long_context_model(model_key: &str) -> bool {
    model_key.starts_with("gpt-5.6")
        || matches!(
            model_key,
            "gpt-5.5" | "gpt-5.5-pro" | "gpt-5.4" | "gpt-5.4-pro"
        )
}

fn is_xai_long_context_model(model_key: &str) -> bool {
    model_key.starts_with("grok-4.5")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sonnet_5_introductory_price_transitions_on_schedule() {
        let intro = default_pricing_for_date(NaiveDate::from_ymd_opt(2026, 8, 31).unwrap())
            ["claude-sonnet-5"]
            .clone();
        let standard = default_pricing_for_date(NaiveDate::from_ymd_opt(2026, 9, 1).unwrap())
            ["claude-sonnet-5"]
            .clone();

        assert_eq!(intro.input, 2.0);
        assert_eq!(intro.output, 10.0);
        assert_eq!(intro.cache_creation, Some(2.5));
        assert_eq!(standard.input, 3.0);
        assert_eq!(standard.output, 15.0);
        assert_eq!(standard.cache_creation, Some(3.75));
    }
}
