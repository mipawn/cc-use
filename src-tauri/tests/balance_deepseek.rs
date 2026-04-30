use cc_use_lib::services::balance_service::parse_deepseek_balance_response;
use serde_json::json;

#[test]
fn parse_deepseek_normal_cny_balance() {
    let body = json!({
        "is_available": true,
        "balance_infos": [
            {
                "currency": "CNY",
                "total_balance": "110.00",
                "granted_balance": "10.00",
                "topped_up_balance": "100.00"
            }
        ]
    });

    let result = parse_deepseek_balance_response(&body).unwrap();
    assert_eq!(result["balance"], json!(110.0));
    assert_eq!(result["error"], json!(null));
}

#[test]
fn parse_deepseek_prefers_cny_over_usd() {
    let body = json!({
        "is_available": true,
        "balance_infos": [
            {
                "currency": "USD",
                "total_balance": "50.00",
                "granted_balance": "0.00",
                "topped_up_balance": "50.00"
            },
            {
                "currency": "CNY",
                "total_balance": "220.00",
                "granted_balance": "20.00",
                "topped_up_balance": "200.00"
            }
        ]
    });

    let result = parse_deepseek_balance_response(&body).unwrap();
    // Should prefer CNY (220.0), not USD (50.0)
    assert_eq!(result["balance"], json!(220.0));
}

#[test]
fn parse_deepseek_fallback_to_first_currency() {
    let body = json!({
        "is_available": true,
        "balance_infos": [
            {
                "currency": "USD",
                "total_balance": "42.50",
                "granted_balance": "0.00",
                "topped_up_balance": "42.50"
            }
        ]
    });

    let result = parse_deepseek_balance_response(&body).unwrap();
    assert_eq!(result["balance"], json!(42.5));
}

#[test]
fn parse_deepseek_not_available() {
    let body = json!({
        "is_available": false,
        "balance_infos": []
    });

    let result = parse_deepseek_balance_response(&body).unwrap();
    assert_eq!(result["balance"], json!(0.0));
    assert_ne!(result["error"], json!(null));
}

#[test]
fn parse_deepseek_empty_balance_infos() {
    let body = json!({
        "is_available": true,
        "balance_infos": []
    });

    let result = parse_deepseek_balance_response(&body);
    assert!(result.is_err());
}

#[test]
fn parse_deepseek_missing_total_balance() {
    let body = json!({
        "is_available": true,
        "balance_infos": [
            {
                "currency": "CNY",
                "granted_balance": "10.00"
            }
        ]
    });

    let result = parse_deepseek_balance_response(&body);
    assert!(result.is_err());
}

#[test]
fn parse_deepseek_string_total_balance() {
    // total_balance is a string in the DeepSeek API
    let body = json!({
        "is_available": true,
        "balance_infos": [
            {
                "currency": "CNY",
                "total_balance": "99.99",
                "granted_balance": "0.00",
                "topped_up_balance": "99.99"
            }
        ]
    });

    let result = parse_deepseek_balance_response(&body).unwrap();
    assert_eq!(result["balance"], json!(99.99));
}
