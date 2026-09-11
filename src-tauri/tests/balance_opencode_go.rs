//! OpenCode Go's metering response, read by the script that ships for it.
//!
//! The reading used to be a Rust parser with these same cases; it is now the
//! `extractor` half of the catalogue's Go script. The fixture is the one that
//! was captured from the live endpoint, so this is still tested against the
//! real shape rather than a guessed one.

use cc_use_lib::services::query_script::{run_extractor, ScriptLimits, ScriptVars};
use cc_use_lib::shared_runtime::account_scripts::{for_legacy_kind, script_for};
use serde_json::{json, Value};

fn read(body: Value) -> Value {
    let template = for_legacy_kind("opencode-go").expect("opencode-go is in the catalogue");
    let usage = run_extractor(
        &script_for(template),
        &ScriptVars::default(),
        &body,
        &ScriptLimits::default(),
    )
    .expect("the shipped script reads its own service's response");
    serde_json::to_value(usage).expect("serialises")
}

/// Captured verbatim from `GET https://opencode.ai/zen/go/v1/usage` on
/// 2026-09-11.
fn live_response() -> Value {
    json!({
        "usage": {
            "rolling": { "status": "ok", "percent": 0, "resetsAt": "2026-09-10T22:06:37.010Z" },
            "weekly": { "status": "ok", "percent": 0, "resetsAt": "2026-09-14T00:00:00.010Z" },
            "monthly": { "status": "ok", "percent": 0, "resetsAt": "2026-10-10T14:01:24.010Z" }
        }
    })
}

#[test]
fn every_period_the_provider_sent_is_reported() {
    let usage = read(live_response());
    let windows = usage["windows"].as_array().expect("windows");

    assert_eq!(windows.len(), 3);
    // All three are returned at once; the UI never has to pick one.
    let ids: Vec<&str> = windows.iter().filter_map(|w| w["id"].as_str()).collect();
    for expected in ["rolling", "weekly", "monthly"] {
        assert!(
            ids.contains(&expected),
            "{} missing from {:?}",
            expected,
            ids
        );
    }

    let rolling = windows.iter().find(|w| w["id"] == "rolling").unwrap();
    assert_eq!(rolling["label"], "5h");
    assert_eq!(rolling["resetsAt"], "2026-09-10T22:06:37.010Z");
    assert_eq!(rolling["status"], "ok");
}

/// A percentage is not money, and the provider never said the account was
/// unlimited — claiming either would be a lie.
#[test]
fn no_unit_and_no_unlimited_claim_are_invented() {
    let usage = read(live_response());

    assert!(usage["unit"].is_null());
    assert!(usage["isUnlimited"].is_null());
}

#[test]
fn a_missing_percent_stays_missing_rather_than_becoming_zero() {
    let usage = read(json!({
        "usage": { "rolling": { "status": "ok", "resetsAt": "2026-01-01T00:00:00Z" } }
    }));

    assert!(usage["windows"][0]["usedPercent"].is_null());
}

#[test]
fn a_period_this_build_does_not_name_keeps_its_raw_id() {
    let usage = read(json!({
        "usage": { "daily": { "status": "ok", "percent": 12.5, "resetsAt": "2026-01-02T00:00:00Z" } }
    }));

    assert_eq!(usage["windows"][0]["id"], "daily");
    assert_eq!(usage["windows"][0]["label"], "daily");
    assert_eq!(usage["windows"][0]["usedPercent"], 12.5);
}

/// "The provider said nothing" and "we could not read what it said" are
/// different facts, and only one of them is the user's to act on.
#[test]
fn a_shape_this_build_cannot_read_is_reported_rather_than_rendered_blank() {
    for body in [
        json!({}),
        json!({ "usage": {} }),
        json!({ "usage": [] }),
        json!({ "usage": "ok" }),
        json!({ "usage": { "rolling": 3 } }),
    ] {
        let usage = read(body.clone());

        assert_eq!(
            usage["isValid"],
            json!(false),
            "{} should have been reported",
            body
        );
        assert!(
            usage["invalidMessage"]
                .as_str()
                .is_some_and(|m| !m.is_empty()),
            "{} needs a reason",
            body
        );
        assert!(usage["windows"].as_array().is_some_and(|w| w.is_empty()));
    }
}
