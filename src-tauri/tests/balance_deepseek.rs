//! DeepSeek's published balance response, read by the script that ships for it.
//!
//! The reading used to be a Rust branch; it is now the `extractor` half of the
//! catalogue's DeepSeek script. These cases are the same ones, kept where the
//! behaviour now lives.

use cc_use_lib::services::query_script::{run_extractor, ScriptLimits, ScriptVars};
use cc_use_lib::shared_runtime::account_scripts::{for_legacy_kind, script_for};
use serde_json::json;

fn read(body: serde_json::Value) -> serde_json::Value {
    let template = for_legacy_kind("deepseek").expect("deepseek is in the catalogue");
    let usage = run_extractor(
        &script_for(template),
        &ScriptVars::default(),
        &body,
        &ScriptLimits::default(),
    )
    .expect("the shipped script reads its own service's response");

    serde_json::to_value(usage).expect("serialises")
}

#[test]
fn a_normal_cny_balance_is_read() {
    let usage = read(json!({
        "is_available": true,
        "balance_infos": [
            {
                "currency": "CNY",
                "total_balance": "110.00",
                "granted_balance": "10.00",
                "topped_up_balance": "100.00"
            }
        ]
    }));

    assert_eq!(usage["remaining"], json!(110.0));
}

#[test]
fn cny_wins_over_usd_when_both_are_reported() {
    let usage = read(json!({
        "is_available": true,
        "balance_infos": [
            { "currency": "USD", "total_balance": "50.00" },
            { "currency": "CNY", "total_balance": "220.00" }
        ]
    }));

    assert_eq!(usage["remaining"], json!(220.0));
}

#[test]
fn a_single_foreign_currency_is_still_read() {
    let usage = read(json!({
        "is_available": true,
        "balance_infos": [{ "currency": "USD", "total_balance": "42.50" }]
    }));

    assert_eq!(usage["remaining"], json!(42.50));
    assert_eq!(usage["unit"], json!("USD"));
}

/// "Not available" is not "zero": reporting 0 would claim the account is empty,
/// which is a different fact the user cannot act on.
#[test]
fn an_unavailable_account_is_reported_as_such_rather_than_as_zero() {
    let usage = read(json!({ "is_available": false, "balance_infos": [] }));

    assert_eq!(usage["isValid"], json!(false));
    assert!(usage["remaining"].is_null());
    assert!(usage["invalidMessage"].as_str().is_some_and(|m| !m.is_empty()));
}

#[test]
fn an_empty_entry_list_is_reported_rather_than_read_as_zero() {
    let usage = read(json!({ "is_available": true, "balance_infos": [] }));

    assert_eq!(usage["isValid"], json!(false));
    assert!(usage["remaining"].is_null());
}

#[test]
fn an_entry_without_a_total_is_reported_rather_than_read_as_zero() {
    let usage = read(json!({
        "is_available": true,
        "balance_infos": [{ "currency": "CNY", "granted_balance": "10.00" }]
    }));

    assert_eq!(usage["isValid"], json!(false));
    assert!(usage["remaining"].is_null());
}

/// The API quotes the amount as a string; the script has to read it as a number.
#[test]
fn a_string_amount_is_read_as_a_number() {
    let usage = read(json!({
        "is_available": true,
        "balance_infos": [{ "currency": "CNY", "total_balance": "99.99" }]
    }));

    assert_eq!(usage["remaining"], json!(99.99));
}

/// The renderer must not have to assume dollars for a CNY balance.
#[test]
fn the_currency_it_was_quoted_in_travels_with_the_amount() {
    let usage = read(json!({
        "is_available": true,
        "balance_infos": [{ "currency": "CNY", "total_balance": "110.00" }]
    }));

    assert_eq!(usage["remaining"], json!(110.0));
    assert_eq!(usage["unit"], json!("CNY"));
}
