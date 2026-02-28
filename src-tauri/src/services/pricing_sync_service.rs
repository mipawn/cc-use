use crate::models::{ApiKey, ModelPricing, Provider};
use serde_json::{Map, Value};
use std::collections::HashMap;

const QUOTA_PER_UNIT: f64 = 500000.0;

pub async fn sync_pricing(
    provider: &Provider,
    fallback_api_keys: &[ApiKey],
) -> Result<serde_json::Value, String> {
    let is_newapi_provider =
        provider.wallet_balance_type == "newapi" || provider.usage_type == "newapi";
    if !is_newapi_provider {
        return Ok(serde_json::json!({
            "count": 0,
            "pricing": {},
            "error": "Pricing sync is only supported for NewAPI providers",
        }));
    }

    let auth_token = provider
        .token
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string)
        .or_else(|| pick_first_available_key(fallback_api_keys))
        .ok_or_else(|| "No authentication token available".to_string())?;

    let url = format!("{}/api/pricing", provider.base_url.trim_end_matches('/'));
    let resp = reqwest::Client::new()
        .get(&url)
        .header("Authorization", format!("Bearer {}", auth_token))
        .header("Content-Type", "application/json")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Ok(serde_json::json!({
            "count": 0,
            "pricing": {},
            "error": format!("HTTP {}: {}", resp.status().as_u16(), resp.status()),
        }));
    }

    let data: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let parsed = parse_pricing_response(&data);

    let mut pricing_map: HashMap<String, ModelPricing> = HashMap::new();
    for (raw_model, pricing) in parsed.pricing {
        let normalized = normalize_newapi_model_name(&raw_model);
        if normalized.is_empty() || !is_model_allowed_for_pricing_sync(&normalized) {
            continue;
        }
        pricing_map.insert(normalized, pricing);
    }

    let count = pricing_map.len();
    if count == 0 {
        return Ok(serde_json::json!({
            "count": 0,
            "pricing": {},
            "error": "No allowed models found in pricing response",
        }));
    }

    Ok(serde_json::json!({
        "count": count,
        "pricing": pricing_map,
        "error": null,
    }))
}

fn parse_pricing_response(data: &Value) -> PricingParseResult {
    let mut pricing: HashMap<String, ModelPricing> = HashMap::new();
    let mut numeric_key_total = 0usize;
    let mut unresolved_numeric_keys: Vec<String> = Vec::new();

    let mut parsed_items = 0usize;
    let mut skipped_no_name = 0usize;
    let mut skipped_no_pricing = 0usize;

    let id_name_map = build_id_name_map(data);
    let models = locate_models_root(data);

    match models {
        Some(Value::Array(arr)) => {
            for item in arr {
                let Some(obj) = item.as_object() else {
                    continue;
                };

                let mut model_name = extract_name_from_model(obj);
                if model_name.is_none() {
                    if let Some(id) = pick_string_id(obj) {
                        if id.chars().all(|c| c.is_ascii_digit()) {
                            numeric_key_total += 1;
                        }
                        model_name = id_name_map.get(&id).cloned();
                        if model_name.is_none() && id.chars().all(|c| c.is_ascii_digit()) {
                            unresolved_numeric_keys.push(id);
                        }
                    }
                }

                let Some(model_name) = model_name else {
                    skipped_no_name += 1;
                    continue;
                };
                if model_name.chars().all(|c| c.is_ascii_digit()) {
                    continue;
                }

                if let Some(p) = convert_model_pricing(obj) {
                    pricing.insert(model_name, p);
                    parsed_items += 1;
                } else {
                    skipped_no_pricing += 1;
                }
            }
        }
        Some(Value::Object(map)) => {
            for (raw_key, model_data) in map {
                let Some(obj) = model_data.as_object() else {
                    continue;
                };

                let key_is_numeric = raw_key.chars().all(|c| c.is_ascii_digit());
                let mut model_name = if key_is_numeric {
                    numeric_key_total += 1;
                    extract_name_from_model(obj).or_else(|| id_name_map.get(raw_key).cloned())
                } else {
                    extract_name_from_model(obj).or_else(|| Some(raw_key.clone()))
                };

                if model_name.is_none() && key_is_numeric {
                    if let Some(id) = pick_string_id(obj) {
                        model_name = id_name_map.get(&id).cloned();
                    }
                }

                let Some(model_name) = model_name else {
                    if key_is_numeric {
                        unresolved_numeric_keys.push(raw_key.clone());
                    }
                    continue;
                };
                if model_name.chars().all(|c| c.is_ascii_digit()) {
                    continue;
                }

                if let Some(p) = convert_model_pricing(obj) {
                    pricing.insert(model_name, p);
                    parsed_items += 1;
                } else {
                    skipped_no_pricing += 1;
                }
            }
        }
        _ => {}
    }

    PricingParseResult {
        pricing,
        numeric_key_total,
        unresolved_numeric_keys,
        parsed_items,
        skipped_no_name,
        skipped_no_pricing,
    }
}

fn locate_models_root<'a>(data: &'a Value) -> Option<&'a Value> {
    let obj = data.as_object()?;
    if let Some(d) = obj.get("data") {
        if d.is_array() {
            return Some(d);
        }
        if let Some(d_obj) = d.as_object() {
            if let Some(inner) = d_obj.get("data") {
                if inner.is_array() {
                    return Some(inner);
                }
            }
            return Some(d);
        }
    }

    if !obj.contains_key("success") && !obj.contains_key("message") {
        return Some(data);
    }
    None
}

fn build_id_name_map(data: &Value) -> HashMap<String, String> {
    let mut map = HashMap::new();

    fn add_from_models_array(value: Option<&Value>, map: &mut HashMap<String, String>) {
        let Some(Value::Array(arr)) = value else {
            return;
        };
        for item in arr {
            let Some(obj) = item.as_object() else {
                continue;
            };
            let id = pick_string_id(obj);
            let name = pick_string(
                obj.get("model_name")
                    .or_else(|| obj.get("modelName"))
                    .or_else(|| obj.get("name"))
                    .or_else(|| obj.get("model")),
            );
            if let (Some(id), Some(name)) = (id, name) {
                if !name.trim().is_empty() {
                    map.insert(id, name);
                }
            }
        }
    }

    fn add_from_string_map(value: Option<&Value>, map: &mut HashMap<String, String>) {
        let Some(Value::Object(obj)) = value else {
            return;
        };
        for (k, v) in obj {
            if let Some(name) = v.as_str() {
                let trimmed = name.trim();
                if !trimmed.is_empty() {
                    map.insert(k.clone(), trimmed.to_string());
                }
            }
        }
    }

    let root_obj = match data.as_object() {
        Some(o) => o,
        None => return map,
    };

    add_from_models_array(root_obj.get("models"), &mut map);
    add_from_models_array(root_obj.get("model_list"), &mut map);
    add_from_models_array(root_obj.get("modelList"), &mut map);
    add_from_string_map(root_obj.get("model_map"), &mut map);
    add_from_string_map(root_obj.get("modelMap"), &mut map);

    if let Some(Value::Object(data_obj)) = root_obj.get("data") {
        add_from_models_array(data_obj.get("models"), &mut map);
        add_from_models_array(data_obj.get("model_list"), &mut map);
        add_from_models_array(data_obj.get("modelList"), &mut map);
        add_from_string_map(data_obj.get("model_map"), &mut map);
        add_from_string_map(data_obj.get("modelMap"), &mut map);

        if let Some(Value::Object(inner)) = data_obj.get("data") {
            add_from_models_array(inner.get("models"), &mut map);
            add_from_models_array(inner.get("model_list"), &mut map);
            add_from_models_array(inner.get("modelList"), &mut map);
        }
    }

    map
}

fn extract_name_from_model(m: &Map<String, Value>) -> Option<String> {
    pick_string(
        m.get("model_name")
            .or_else(|| m.get("modelName"))
            .or_else(|| m.get("display_name"))
            .or_else(|| m.get("displayName"))
            .or_else(|| m.get("name"))
            .or_else(|| m.get("model")),
    )
    .or_else(|| {
        m.get("model")
            .and_then(|v| v.as_object())
            .and_then(extract_name_from_model)
    })
    .or_else(|| {
        m.get("info")
            .and_then(|v| v.as_object())
            .and_then(extract_name_from_model)
    })
}

fn convert_model_pricing(m: &Map<String, Value>) -> Option<ModelPricing> {
    let model_obj = m.get("model").and_then(|v| v.as_object());
    let pricing_obj = m
        .get("pricing")
        .or_else(|| m.get("prices"))
        .or_else(|| m.get("price"))
        .and_then(|v| v.as_object());

    let quota_type = first_number(&[
        get_number(m, "quota_type"),
        get_number(m, "quotaType"),
        model_obj.and_then(|o| get_number(o, "quota_type")),
        model_obj.and_then(|o| get_number(o, "quotaType")),
    ])
    .unwrap_or(0.0);

    if (quota_type - 1.0).abs() < f64::EPSILON {
        let model_price = first_number(&[
            get_number(m, "model_price"),
            get_number(m, "prompt_price"),
            get_number(m, "promptPrice"),
            get_number(m, "input_price"),
            get_number(m, "inputPrice"),
            get_number(m, "price"),
            pricing_obj.and_then(|o| get_number(o, "model_price")),
            pricing_obj.and_then(|o| get_number(o, "prompt_price")),
            pricing_obj.and_then(|o| get_number(o, "input_price")),
            pricing_obj.and_then(|o| get_number(o, "price")),
            model_obj.and_then(|o| get_number(o, "model_price")),
            model_obj.and_then(|o| get_number(o, "prompt_price")),
            model_obj.and_then(|o| get_number(o, "input_price")),
        ])?;

        let completion_price = first_number(&[
            get_number(m, "completion_price"),
            get_number(m, "completionPrice"),
            get_number(m, "output_price"),
            get_number(m, "outputPrice"),
            pricing_obj.and_then(|o| get_number(o, "completion_price")),
            pricing_obj.and_then(|o| get_number(o, "output_price")),
            model_obj.and_then(|o| get_number(o, "completion_price")),
            model_obj.and_then(|o| get_number(o, "output_price")),
        ]);

        let input_per_million = interpret_price_per_million(model_price);
        let output_per_million = completion_price
            .map(interpret_price_per_million)
            .unwrap_or(input_per_million);

        let cache_price = first_number(&[
            get_number(m, "cache_price"),
            get_number(m, "cache_read_price"),
            get_number(m, "cacheReadPrice"),
            get_number(m, "cache_price_read"),
            get_number(m, "cachePrice"),
            pricing_obj.and_then(|o| get_number(o, "cache_price")),
            pricing_obj.and_then(|o| get_number(o, "cache_read_price")),
            model_obj.and_then(|o| get_number(o, "cache_price")),
            model_obj.and_then(|o| get_number(o, "cache_read_price")),
        ]);

        Some(ModelPricing {
            input: round6(input_per_million),
            output: round6(output_per_million),
            cache_read: cache_price.map(interpret_price_per_million).map(round6),
            cache_creation: None,
        })
    } else {
        let model_ratio = first_number(&[
            get_number(m, "model_ratio"),
            get_number(m, "prompt_ratio"),
            get_number(m, "promptRatio"),
            get_number(m, "input_ratio"),
            get_number(m, "inputRatio"),
            get_number(m, "ratio"),
            pricing_obj.and_then(|o| get_number(o, "model_ratio")),
            pricing_obj.and_then(|o| get_number(o, "prompt_ratio")),
            pricing_obj.and_then(|o| get_number(o, "input_ratio")),
            pricing_obj.and_then(|o| get_number(o, "ratio")),
            model_obj.and_then(|o| get_number(o, "model_ratio")),
            model_obj.and_then(|o| get_number(o, "prompt_ratio")),
            model_obj.and_then(|o| get_number(o, "input_ratio")),
        ])?;

        let completion_ratio = first_number(&[
            get_number(m, "completion_ratio"),
            get_number(m, "completionRatio"),
            get_number(m, "output_ratio"),
            get_number(m, "outputRatio"),
            pricing_obj.and_then(|o| get_number(o, "completion_ratio")),
            pricing_obj.and_then(|o| get_number(o, "output_ratio")),
            model_obj.and_then(|o| get_number(o, "completion_ratio")),
            model_obj.and_then(|o| get_number(o, "output_ratio")),
        ])
        .unwrap_or(1.0);

        Some(ModelPricing {
            input: round6(model_ratio * 2.0),
            output: round6(model_ratio * completion_ratio * 2.0),
            cache_read: None,
            cache_creation: None,
        })
    }
}

fn get_number(obj: &Map<String, Value>, key: &str) -> Option<f64> {
    to_number(obj.get(key))
}

fn to_number(v: Option<&Value>) -> Option<f64> {
    match v {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => s.trim().parse::<f64>().ok(),
        _ => None,
    }
}

fn pick_string(v: Option<&Value>) -> Option<String> {
    v.and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn pick_string_id(obj: &Map<String, Value>) -> Option<String> {
    pick_string(obj.get("id"))
        .or_else(|| pick_string(obj.get("model_id")))
        .or_else(|| pick_string(obj.get("modelId")))
}

fn first_number(values: &[Option<f64>]) -> Option<f64> {
    values.iter().copied().flatten().find(|v| v.is_finite())
}

fn interpret_price_per_million(v: f64) -> f64 {
    if !v.is_finite() || v < 0.0 {
        return v;
    }
    if v <= 1.0 {
        return v * 1000.0;
    }
    if v <= 200.0 {
        return v;
    }
    (v * 1000.0) / QUOTA_PER_UNIT
}

fn round6(v: f64) -> f64 {
    (v * 1_000_000.0).round() / 1_000_000.0
}

fn pick_first_available_key(api_keys: &[ApiKey]) -> Option<String> {
    api_keys
        .iter()
        .filter(|k| k.is_active && !k.is_exhausted && !k.value.trim().is_empty())
        .min_by_key(|k| k.priority)
        .map(|k| k.value.clone())
}

fn normalize_newapi_model_name(name: &str) -> String {
    let mut n = name.trim().to_string();
    if n.is_empty() {
        return n;
    }

    for dash_like in [
        '\u{2010}', '\u{2011}', '\u{2012}', '\u{2013}', '\u{2014}', '\u{2015}', '\u{2212}',
        '\u{FE63}', '\u{FF0D}',
    ] {
        n = n.replace(dash_like, "-");
    }

    if let Some(last) = n.rsplit('/').next() {
        n = last.to_string();
    }
    if let Some(last) = n.rsplit(':').next() {
        n = last.to_string();
    }
    if let Some((left, _)) = n.split_once('@') {
        n = left.to_string();
    }
    if let Some((left, _)) = n.split_once('(') {
        n = left.trim().to_string();
    }
    if n.contains(' ') {
        n = n.split_whitespace().next().unwrap_or("").to_string();
    }

    n = n.to_lowercase().replace('_', "-").trim().to_string();

    match n.as_str() {
        "gpt4o" => "gpt-4o".to_string(),
        "gpt4o-mini" => "gpt-4o-mini".to_string(),
        "o1preview" => "o1-preview".to_string(),
        _ => n,
    }
}

fn is_model_allowed_for_pricing_sync(model_name: &str) -> bool {
    let m = normalize_newapi_model_name(model_name);
    let is_claude = m.starts_with("claude-");
    let is_gpt = m.starts_with("gpt-");
    let mut chars = m.chars();
    let is_o_digit = matches!((chars.next(), chars.next()), (Some('o'), Some(c)) if c.is_ascii_digit());
    let is_o_family = is_o_digit || m == "o1" || m.starts_with("o1-") || m.starts_with("o3-");
    is_claude || is_gpt || is_o_family
}

struct PricingParseResult {
    pricing: HashMap<String, ModelPricing>,
    #[allow(dead_code)]
    numeric_key_total: usize,
    #[allow(dead_code)]
    unresolved_numeric_keys: Vec<String>,
    #[allow(dead_code)]
    parsed_items: usize,
    #[allow(dead_code)]
    skipped_no_name: usize,
    #[allow(dead_code)]
    skipped_no_pricing: usize,
}
