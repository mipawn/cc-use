use cc_use_lib::services::cost_calculator::{calculate_cost, find_pricing};
use std::collections::HashMap;

#[test]
fn calculate_cost_claude_sonnet() {
    let custom = HashMap::new();
    let (input, output, _, _, total) =
        calculate_cost("claude-sonnet-4", 1000, 500, 0, 0, 1.0, &custom);

    assert!((input - 0.003).abs() < 1e-9);
    assert!((output - 0.0075).abs() < 1e-9);
    assert!((total - 0.0105).abs() < 1e-9);
}

#[test]
fn calculate_cost_with_cache_tokens() {
    let custom = HashMap::new();
    let (_, _, cache_read, cache_creation, _) =
        calculate_cost("claude-sonnet-4", 0, 0, 10000, 5000, 1.0, &custom);

    assert!((cache_read - 0.003).abs() < 1e-9);
    assert!((cache_creation - 0.01875).abs() < 1e-9);
}

#[test]
fn calculate_cost_with_multiplier() {
    let custom = HashMap::new();
    let (_, _, _, _, total) = calculate_cost("claude-sonnet-4", 1_000_000, 0, 0, 0, 1.5, &custom);

    assert!((total - 4.5).abs() < 1e-6);
}

#[test]
fn model_pricing_prefix_match() {
    let custom = HashMap::new();
    let pricing = find_pricing("claude-sonnet-4-20250514", &custom);
    assert!(pricing.is_some());
    assert!((pricing.unwrap().input - 3.0).abs() < 1e-6);
}

#[test]
fn latest_claude_prices_match_provider_prefixed_models() {
    let custom = HashMap::new();

    let sonnet = find_pricing("anthropic.claude-sonnet-4-6-20260601", &custom).unwrap();
    assert!((sonnet.input - 3.0).abs() < 1e-6);
    assert!((sonnet.output - 15.0).abs() < 1e-6);

    let opus = find_pricing("anthropic.claude-opus-4-8", &custom).unwrap();
    assert!((opus.input - 5.0).abs() < 1e-6);
    assert!((opus.output - 25.0).abs() < 1e-6);

    let fable = find_pricing("claude-fable-5", &custom).unwrap();
    assert!((fable.input - 10.0).abs() < 1e-6);
    assert!((fable.output - 50.0).abs() < 1e-6);
}

#[test]
fn latest_openai_prices_match_codex_and_gpt_models() {
    let custom = HashMap::new();

    let gpt = find_pricing("gpt-5.5", &custom).unwrap();
    assert!((gpt.input - 5.0).abs() < 1e-6);
    assert!((gpt.output - 30.0).abs() < 1e-6);

    let pro = find_pricing("openai.gpt-5.5-pro", &custom).unwrap();
    assert!((pro.input - 30.0).abs() < 1e-6);
    assert!((pro.output - 180.0).abs() < 1e-6);

    let codex = find_pricing("gpt-5.3-codex-20260618", &custom).unwrap();
    assert!((codex.input - 1.75).abs() < 1e-6);
    assert!((codex.output - 14.0).abs() < 1e-6);
}

#[test]
fn longest_prefix_match_prefers_specific_model_price() {
    let custom = HashMap::new();
    let pricing = find_pricing("gpt-4o-mini-20240718", &custom).unwrap();

    assert!((pricing.input - 0.15).abs() < 1e-6);
    assert!((pricing.output - 0.6).abs() < 1e-6);
}
