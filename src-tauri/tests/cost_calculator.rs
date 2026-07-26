use cc_use_lib::models::ModelPricing;
use cc_use_lib::services::cost_calculator::{calculate_cost, find_pricing};
use std::collections::HashMap;

#[test]
fn calculate_cost_claude_sonnet() {
    let custom = HashMap::new();
    let (input, output, _, _, total) =
        calculate_cost("claude-sonnet-4-6", 1000, 500, 0, 0, 1.0, &custom);

    assert!((input - 0.003).abs() < 1e-9);
    assert!((output - 0.0075).abs() < 1e-9);
    assert!((total - 0.0105).abs() < 1e-9);
}

#[test]
fn calculate_cost_with_cache_tokens() {
    let custom = HashMap::new();
    let (_, _, cache_read, cache_creation, _) =
        calculate_cost("claude-sonnet-4-6", 0, 0, 10000, 5000, 1.0, &custom);

    assert!((cache_read - 0.003).abs() < 1e-9);
    assert!((cache_creation - 0.01875).abs() < 1e-9);
}

#[test]
fn calculate_cost_with_multiplier() {
    let custom = HashMap::new();
    let (_, _, _, _, total) = calculate_cost("claude-sonnet-4-6", 1_000_000, 0, 0, 0, 1.5, &custom);

    assert!((total - 4.5).abs() < 1e-6);
}

#[test]
fn model_pricing_prefix_match() {
    let custom = HashMap::new();
    let pricing = find_pricing("anthropic.claude-sonnet-4-6-v1:0", &custom);
    assert!(pricing.is_some());
    assert!((pricing.unwrap().input - 3.0).abs() < 1e-6);
}

#[test]
fn latest_claude_prices_match_provider_prefixed_models() {
    let custom = HashMap::new();

    let opus_5 = find_pricing("anthropic.claude-opus-5", &custom).unwrap();
    assert!((opus_5.input - 5.0).abs() < 1e-6);
    assert!((opus_5.output - 25.0).abs() < 1e-6);
    assert_eq!(opus_5.cache_read, Some(0.5));
    assert_eq!(opus_5.cache_creation, Some(6.25));

    assert!(find_pricing("claude-sonnet-5", &custom).is_some());

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

    let sol_alias = find_pricing("gpt-5.6", &custom).unwrap();
    assert!((sol_alias.input - 5.0).abs() < 1e-6);
    assert!((sol_alias.output - 30.0).abs() < 1e-6);
    assert_eq!(sol_alias.cache_read, Some(0.5));
    assert_eq!(sol_alias.cache_creation, Some(6.25));

    let sol = find_pricing("openai.gpt-5.6-sol-20260709", &custom).unwrap();
    assert!((sol.input - 5.0).abs() < 1e-6);
    assert!((sol.output - 30.0).abs() < 1e-6);

    let terra = find_pricing("gpt-5.6-terra", &custom).unwrap();
    assert!((terra.input - 2.5).abs() < 1e-6);
    assert!((terra.output - 15.0).abs() < 1e-6);
    assert_eq!(terra.cache_read, Some(0.25));
    assert_eq!(terra.cache_creation, Some(3.125));

    let luna = find_pricing("gpt-5.6-luna", &custom).unwrap();
    assert!((luna.input - 1.0).abs() < 1e-6);
    assert!((luna.output - 6.0).abs() < 1e-6);
    assert_eq!(luna.cache_read, Some(0.1));
    assert_eq!(luna.cache_creation, Some(1.25));

    let gpt = find_pricing("gpt-5.5", &custom).unwrap();
    assert!((gpt.input - 5.0).abs() < 1e-6);
    assert!((gpt.output - 30.0).abs() < 1e-6);

    let pro = find_pricing("openai.gpt-5.5-pro", &custom).unwrap();
    assert!((pro.input - 30.0).abs() < 1e-6);
    assert!((pro.output - 180.0).abs() < 1e-6);

    let mini = find_pricing("openai.gpt-5.4-mini-20260618", &custom).unwrap();
    assert!((mini.input - 0.75).abs() < 1e-6);
    assert!((mini.output - 4.5).abs() < 1e-6);

    assert!(find_pricing("gpt-5.3-codex", &custom).is_none());
    assert!(find_pricing("gpt-4o", &custom).is_none());
}

#[test]
fn longest_prefix_match_prefers_specific_model_price() {
    let custom = HashMap::new();
    let pricing = find_pricing("gpt-5.4-mini-20260618", &custom).unwrap();

    assert!((pricing.input - 0.75).abs() < 1e-6);
    assert!((pricing.output - 4.5).abs() < 1e-6);
}

#[test]
fn generic_generation_does_not_match_unknown_minor_version() {
    let custom = HashMap::new();
    assert!(find_pricing("gpt-5.99", &custom).is_none());
}

#[test]
fn current_deepseek_glm_and_xai_prices_are_available() {
    let custom = HashMap::new();

    let deepseek = find_pricing("deepseek.deepseek-v4-pro", &custom).unwrap();
    assert!((deepseek.input - 0.435).abs() < 1e-6);
    assert!((deepseek.output - 0.87).abs() < 1e-6);
    assert_eq!(deepseek.cache_read, Some(0.003625));

    assert!(find_pricing("deepseek-reasoner", &custom).is_none());
    assert!(find_pricing("deepseek-chat", &custom).is_none());
    assert!(find_pricing("models/gemini-3.6-flash", &custom).is_none());
    assert!(find_pricing("google.gemini-2.5-flash", &custom).is_none());
    assert!(find_pricing("claude-sonnet-4-5", &custom).is_none());
    assert!(find_pricing("claude-3-5-sonnet", &custom).is_none());

    let glm = find_pricing("zhipu.glm-5.2[1m]", &custom).unwrap();
    assert!((glm.input - 1.4).abs() < 1e-6);
    assert!((glm.output - 4.4).abs() < 1e-6);
    assert_eq!(glm.cache_read, Some(0.26));
    assert_eq!(glm.cache_creation, Some(0.0));
    assert!(find_pricing("glm-5.1", &custom).is_none());
    assert!(find_pricing("glm-5.2-air", &custom).is_none());
    let (_, _, cache_read, cache_creation, total) = calculate_cost(
        "zai/glm-5.2[1m]",
        1_000_000,
        1_000_000,
        1_000_000,
        0,
        1.0,
        &custom,
    );
    assert!((cache_read - 0.26).abs() < 1e-6);
    assert_eq!(cache_creation, 0.0);
    assert!((total - 6.06).abs() < 1e-6);

    let grok = find_pricing("xai.grok-4.5-latest", &custom).unwrap();
    assert!((grok.input - 2.0).abs() < 1e-6);
    assert!((grok.output - 6.0).abs() < 1e-6);
    assert_eq!(grok.cache_read, Some(0.3));

    assert!(find_pricing("grok-build-0.1", &custom).is_none());
    assert!(find_pricing("grok-build-latest", &custom).is_none());
    assert!(find_pricing("grok-4.3", &custom).is_none());
    assert!(find_pricing("grok-4.20-0309-reasoning", &custom).is_none());
}

#[test]
fn custom_prefix_overrides_more_specific_builtin_price() {
    let mut custom = HashMap::new();
    custom.insert(
        "gpt-5.6".to_string(),
        ModelPricing {
            input: 9.0,
            output: 19.0,
            cache_read: Some(0.9),
            cache_creation: None,
        },
    );

    let pricing = find_pricing("gpt-5.6-terra", &custom).unwrap();
    assert_eq!(pricing.input, 9.0);
    assert_eq!(pricing.output, 19.0);

    custom.insert(
        "gemini-3.6-flash".to_string(),
        ModelPricing {
            input: 0.8,
            output: 4.0,
            cache_read: Some(0.08),
            cache_creation: None,
        },
    );
    let gemini = find_pricing("models/gemini-3.6-flash-001", &custom).unwrap();
    assert_eq!(gemini.input, 0.8);
    assert_eq!(gemini.output, 4.0);
}

#[test]
fn official_long_context_tiers_apply_to_builtin_prices_only() {
    let custom = HashMap::new();

    let (input, output, _, _, total) =
        calculate_cost("gpt-5.6-terra", 1_000_000, 1_000_000, 0, 0, 1.0, &custom);
    assert!((input - 5.0).abs() < 1e-9);
    assert!((output - 22.5).abs() < 1e-9);
    assert!((total - 27.5).abs() < 1e-9);

    let (input, output, cache, _, total) =
        calculate_cost("grok-4.5", 150_000, 100_000, 50_000, 0, 1.0, &custom);
    assert!((input - 0.6).abs() < 1e-9);
    assert!((output - 1.2).abs() < 1e-9);
    assert!((cache - 0.03).abs() < 1e-9);
    assert!((total - 1.83).abs() < 1e-9);

    let mut custom = HashMap::new();
    custom.insert(
        "grok-4.5".to_string(),
        ModelPricing {
            input: 1.0,
            output: 1.0,
            cache_read: Some(1.0),
            cache_creation: None,
        },
    );
    let (input, output, cache, _, _) =
        calculate_cost("grok-4.5", 150_000, 100_000, 50_000, 0, 1.0, &custom);
    assert!((input - 0.15).abs() < 1e-9);
    assert!((output - 0.1).abs() < 1e-9);
    assert!((cache - 0.05).abs() < 1e-9);
}
