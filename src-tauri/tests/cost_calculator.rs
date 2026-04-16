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
