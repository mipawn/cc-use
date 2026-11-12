//! An unsaved draft's quota query, run on demand.
//!
//! The editor needs to prove a query works *before* the user saves it: a
//! provider whose keys do not exist yet, a key being written, a script being
//! typed. This module runs exactly the same engine the refresh runs — the
//! same resolver, credential checks, origin rules, HTTP client and
//! extraction — but against draft values and with nowhere to persist: no
//! entity is created, no cache is written, no check time is stamped.
//!
//! The scope boundary from the runtime applies here, and deliberately more
//! strictly: a key-scope draft answers with the one credential the editor
//! holds, and cannot use `providerId` to fetch account credentials into a
//! per-key answer. Windows are kept in both scopes — they are part of a
//! metering service's answer, not an account-only decoration.

use crate::models::{Provider, QueryTestInput, QueryTestResult, UsageData};
use crate::services::balance_service;
use crate::services::query_script::{
    AccountUsage, AccountWindow, ScriptLimits, ScriptRequest, ScriptVars,
};
use crate::services::usage_service;
use crate::shared_runtime::query_schemes::{SCOPE_ACCOUNT, SCOPE_KEY};
use serde_json::Value;
use std::future::Future;

/// What the account scope falls back to when the draft names no key: the
/// provider's borrow rule, resolved by the caller from saved storage. Only
/// the account scope ever reads it.
pub(crate) type FallbackCredential = Option<String>;

/// Run one draft test. `send` is the injectable HTTP seam: tests stay
/// offline by faking it, and the command wires the real transport — the
/// standard `balance_service::send` over the draft-shaped provider below, so
/// a draft sends through the same proxy-aware client a saved refresh would.
///
/// Unknown scope rejects: there is no defensible envelope for it.
pub(crate) async fn run_draft_query_test<F, Fut>(
    input: &QueryTestInput,
    fallback_credential: FallbackCredential,
    send: F,
) -> Result<QueryTestResult, String>
where
    F: Fn(ScriptRequest) -> Fut,
    Fut: Future<Output = Result<Value, String>>,
{
    let scope = scope(input)?;
    let provider = draft_provider(input)?;

    let (usage, error) = match inner(scope, input, &provider, fallback_credential, send).await {
        Ok(answer) => (answer.data, answer.error),
        Err(message) => (None, Some(redact(&message, input))),
    };
    Ok(QueryTestResult {
        scope: input.scope.clone(),
        usage,
        // A domain failure is a failed test; only a real absence of a problem
        // reads valid, and missing amounts are reported for what they are —
        // never coerced into a zero.
        is_valid: error.is_none(),
        invalid_message: None,
        error,
    })
}

struct DraftAnswer {
    /// `None` whenever `error` is set: a failed test must not silently carry
    /// an answer next to its failure.
    data: Option<UsageData>,
    /// A script that found nothing usable reports that instead of a zero.
    error: Option<String>,
}

/// The engine half.
///
/// `provider` is the draft's own shape: the guards and the transport run
/// against exactly the address and proxy the editor holds, not against
/// whatever is stored.
async fn inner<F, Fut>(
    scope: Scope,
    input: &QueryTestInput,
    provider: &Provider,
    fallback_credential: FallbackCredential,
    send: F,
) -> Result<DraftAnswer, String>
where
    F: Fn(ScriptRequest) -> Fut,
    Fut: Future<Output = Result<Value, String>>,
{
    let script = input.script.trim();
    if script.is_empty() {
        return Err("尚未填写查询脚本；请选择一个内置方案或配置自定义脚本".to_string());
    }
    let base_url = input.base_url.trim();
    if base_url.is_empty() {
        return Err("请先填写服务地址".to_string());
    }

    // The key scope answers with the one credential the editor holds. Only
    // the account scope may fall back to the saved borrow, mirroring how a
    // real refresh picks its credential.
    let api_key = non_empty(input.api_key.as_deref()).or(match scope {
        Scope::Account => fallback_credential,
        Scope::Key => None,
    });
    let (access_token, user_id) = match scope {
        Scope::Account => (
            non_empty(input.access_token.as_deref()),
            non_empty(input.user_id.as_deref()),
        ),
        // A key draft never carries, and never borrows, account credentials.
        Scope::Key => (None, None),
    };

    let vars = ScriptVars {
        base_url: provider.base_url.trim_end_matches('/').to_string(),
        api_key,
        access_token,
        user_id,
    };

    let limits = ScriptLimits::default();
    let resolved = balance_service::resolve(script, &vars, &limits)?;

    // The boundary runs before anything is sent, exactly as the refresh runs
    // it: the same account-target refusal and the same key-only wording.
    if let Scope::Key = scope {
        usage_service::guard_key_scope_targets(provider, &resolved)?;
        usage_service::guard_key_scope_credentials(&resolved)?;
    }

    let usage =
        balance_service::execute(&provider.base_url, script, &vars, &limits, resolved, send)
            .await?;

    match scope {
        Scope::Account => {
            let error = account_missing(&usage);
            Ok(DraftAnswer {
                data: if error.is_some() {
                    None
                } else {
                    Some(usage_data(&usage))
                },
                error,
            })
        }
        Scope::Key => {
            // The same reporting rule the saved refresh runs, windows
            // included: a per-key metering answer is a real answer.
            let finalized = usage_service::finalize_key_usage(usage)?;
            Ok(DraftAnswer {
                data: Some(usage_data(&finalized)),
                error: None,
            })
        }
    }
}

/// The IPC usage shape both scopes return.
///
/// Windows are mapped with the label falling back to the id, so a period this
/// build has no name for is still renderable and the stored shape still parses
/// as `UsageData`. Groups stay empty: neither scope reports per-group windows.
fn usage_data(usage: &AccountUsage) -> UsageData {
    UsageData {
        total: usage.total,
        used: usage.used,
        remaining: usage.remaining,
        unit: usage.unit.clone(),
        is_unlimited: usage.is_unlimited,
        expire_at: usage.expire_at.clone(),
        windows: usage.windows.iter().cloned().map(usage_window).collect(),
        groups: Vec::new(),
    }
}

/// No fabricated zeros from the account scope either: the script's explicit
/// "not valid" becomes the error, and an answer that carries no usable field
/// at all is a failed test, not a zero balance.
fn account_missing(usage: &AccountUsage) -> Option<String> {
    if let Some(invalid_message) = usage
        .invalid_message
        .as_deref()
        .map(str::trim)
        .filter(|message| !message.is_empty())
    {
        return Some(invalid_message.to_string());
    }
    let reported = usage.remaining.is_some()
        || usage.total.is_some()
        || usage.used.is_some()
        || usage.is_unlimited.is_some()
        || usage.expire_at.is_some()
        || !usage.windows.is_empty();
    if reported {
        None
    } else {
        Some("查询没有返回可读的额度或用量".to_string())
    }
}

enum Scope {
    Account,
    Key,
}

fn scope(input: &QueryTestInput) -> Result<Scope, String> {
    match input.scope.as_str() {
        SCOPE_ACCOUNT => Ok(Scope::Account),
        SCOPE_KEY => Ok(Scope::Key),
        other => Err(format!("未知的查询范围：{other}")),
    }
}

/// A provider-shaped value so the shared engine machinery (origin checks and
/// the proxy-aware HTTP client) runs literally; nothing about it is stored.
///
/// Exposed so the command's transport closure and this module's internal
/// guards resolve against the *same* draft shape.
pub(crate) fn draft_provider(input: &QueryTestInput) -> Result<Provider, String> {
    serde_json::from_value(serde_json::json!({
        "id": "draft",
        "name": "draft",
        "baseUrl": input.base_url.trim(),
        "httpProxy": input
            .http_proxy
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty()),
        "walletBalanceType": "custom",
        "usageType": "none",
        "isActive": true,
        "sortOrder": 0
    }))
    .map_err(|error| format!("草稿地址无效：{error}"))
}

/// The window shape the composite model uses: the label falls back to the id
/// for a period this build has no dedicated name for.
fn usage_window(window: AccountWindow) -> crate::models::UsageWindow {
    let label = window.label.clone().unwrap_or_else(|| window.id.clone());
    crate::models::UsageWindow {
        id: window.id,
        label,
        used_percent: window.used_percent,
        resets_at: window.resets_at,
        status: window.status,
    }
}

/// Defensive scrubbing so a failure message can never echo a credential.
///
/// Nothing in the flow is supposed to put a credential into a message, but a
/// cheap replace before the result leaves the module makes that claim hold
/// against whatever a future producer does.
fn redact(message: &str, input: &QueryTestInput) -> String {
    let mut redacted = message.to_string();
    for secret in [
        input.api_key.as_deref(),
        input.access_token.as_deref(),
        input.user_id.as_deref(),
    ]
    .into_iter()
    .flatten()
    .map(str::trim)
    .filter(|secret| !secret.is_empty())
    {
        redacted = redacted.replace(secret, "***");
    }
    redacted
}

fn non_empty(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared_runtime::account_scripts;
    use crate::shared_runtime::query_schemes;
    use std::pin::Pin;
    use std::sync::{Arc, Mutex};

    /// The one single-form script every answer test runs, with placeholders
    /// the engine resolves the same way a saved refresh does.
    const ACCOUNT_SCRIPT: &str = "({request:{url:'{{baseUrl}}/v1/quota',method:'GET',headers:{Authorization:'Bearer {{apiKey}}'}},extractor:function(r){return {remaining:r.remaining}}})";

    type SentFuture = Pin<Box<dyn Future<Output = Result<Value, String>>>>;

    /// A sender that answers with whatever the engine resolved: quoting the
    /// resolved request keeps assertions honest about what would be sent.
    fn echo_send() -> impl Fn(ScriptRequest) -> SentFuture {
        |request: ScriptRequest| {
            Box::pin(async move {
                Ok(serde_json::json!({
                    "sent": {
                        "url": request.url,
                        "method": request.method,
                        "headers": request.headers,
                    }
                }))
            })
        }
    }

    /// The sender the failure-echo test uses: an upstream that repeats the
    /// credential in its answer, exactly the accidental echo redact guards.
    fn failing_send(message: &'static str) -> impl Fn(ScriptRequest) -> SentFuture {
        move |_request: ScriptRequest| Box::pin(async move { Err(message.to_string()) })
    }

    fn input(scope: &str, script: &str) -> QueryTestInput {
        serde_json::from_value(serde_json::json!({
            "scope": scope,
            "baseUrl": "https://relay.example.com",
            "script": script,
            "apiKey": null,
            "accessToken": null,
            "userId": null,
            "providerId": null
        }))
        .expect("test input fixture")
    }

    #[tokio::test]
    async fn an_unknown_scope_is_rejected_outright() {
        let input = input("wat", ACCOUNT_SCRIPT);

        let error = run_draft_query_test(&input, None, echo_send())
            .await
            .expect_err("unknown scope");
        assert_eq!(error, "未知的查询范围：wat");
    }

    #[tokio::test]
    async fn a_key_draft_never_borrows_the_saved_fallback() {
        let input = input("key", ACCOUNT_SCRIPT);

        let result = run_draft_query_test(&input, Some("sk-saved".to_string()), echo_send())
            .await
            .expect("a domain answer");

        assert!(result.usage.is_none());
        assert!(!result.is_valid);
        // The wording belongs to the key scope, and the fallback credential
        // was never used to resolve the request.
        assert_eq!(result.error.as_deref(), Some("请先填写或保存当前 API 密钥"));
    }

    #[tokio::test]
    async fn an_account_draft_borrows_the_saved_fallback_like_a_refresh() {
        let mut input = input("account", ACCOUNT_SCRIPT);
        input.api_key = None;
        let captured: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let sink = captured.clone();

        let result =
            run_draft_query_test(&input, Some("sk-borrowed".to_string()), move |request| {
                let sink = sink.clone();
                Box::pin(async move {
                    *sink.lock().expect("sink") = request.headers.get("Authorization").cloned();
                    Ok(serde_json::json!({ "remaining": 42 }))
                }) as SentFuture
            })
            .await
            .expect("borrowed like a refresh");

        assert_eq!(result.error, None);
        assert_eq!(result.usage.as_ref().expect("usage").remaining, Some(42.0));
        assert_eq!(
            captured.lock().expect("sink").clone(),
            Some("Bearer sk-borrowed".to_string())
        );
    }

    #[tokio::test]
    async fn a_key_draft_pointing_at_account_endpoints_is_refused_before_sending() {
        for script in [
            account_scripts::script_for(
                account_scripts::for_legacy_kind("deepseek").expect("deepseek script"),
            ),
            account_scripts::script_for(
                account_scripts::for_legacy_kind("newapi").expect("newapi account script"),
            ),
        ] {
            let mut key_input = input("key", &script);
            key_input.api_key = Some("sk-live".to_string());

            let result =
                run_draft_query_test(&key_input, Some("sk-saved".to_string()), echo_send())
                    .await
                    .expect("a domain answer");

            assert!(result.usage.is_none());
            assert!(!result.is_valid);
            assert_eq!(
                result.error.as_deref(),
                Some(query_schemes::KEY_QUERY_ACCOUNT_TARGET_MESSAGE)
            );
        }
    }

    /// The Command Code script is a key-scope answer now: it passes both key
    /// guards and, with the fake transport, reports its credits balance plus
    /// the metering windows — the draft keeps them.
    #[tokio::test]
    async fn a_key_draft_with_the_command_code_script_keeps_the_balance_and_windows() {
        let script = query_schemes::scheme_script(query_schemes::SCHEME_COMMAND_CODE_KEY)
            .expect("shipped key script");
        let mut key_input = input("key", &script);
        // The shipped script addresses Command Code's own origin directly, so
        // the draft's address has to be that origin (as the preset's is).
        key_input.base_url = "https://api.commandcode.ai/provider".to_string();
        key_input.api_key = Some("sk-live".to_string());

        let result = run_draft_query_test(&key_input, None, |request: ScriptRequest| {
            Box::pin(async move {
                if request.url.ends_with("/alpha/billing/credits") {
                    Ok(serde_json::json!({
                        "credits": {
                            "monthlyCredits": 10,
                            "purchasedCredits": 2,
                            "freeCredits": 1
                        },
                        "windowLimits": {
                            "fiveHour": { "cap": 100, "used": 20 },
                            "weekly": { "cap": 500, "used": 100 }
                        }
                    }))
                } else {
                    // The two optional requests may be unavailable; the
                    // extractor reports the monthly row with a missing
                    // percentage instead of failing the whole answer.
                    Err("optional request unavailable".to_string())
                }
            }) as SentFuture
        })
        .await
        .expect("a domain answer");

        assert_eq!(result.error, None);
        assert!(result.is_valid);
        let usage = result.usage.expect("usage");
        assert_eq!(usage.remaining, Some(13.0));
        assert_eq!(usage.unit.as_deref(), Some("credits"));
        let ids: Vec<&str> = usage.windows.iter().map(|w| w.id.as_str()).collect();
        assert_eq!(ids, ["rolling", "weekly", "monthly"]);
        // A period the script named no label for stays readable.
        assert_eq!(usage.windows[0].label, "rolling");
        assert_eq!(usage.windows[2].label, "monthly");
        assert_eq!(usage.windows[2].used_percent, None);
    }

    /// A window-only per-key answer is valid and keeps its windows.
    #[tokio::test]
    async fn a_key_answer_with_windows_keeps_its_windows() {
        let script = "({request:{url:'{{baseUrl}}/v1/usage',headers:{Authorization:'Bearer {{apiKey}}'}},extractor:function(r){return {windows:r.usage}}})";
        let mut key_input = input("key", script);
        key_input.api_key = Some("sk-live".to_string());

        let result = run_draft_query_test(&key_input, None, |_request: ScriptRequest| {
            Box::pin(async move {
                Ok(serde_json::json!({
                    "usage": [
                        { "id": "rolling_5h", "label": "5h", "usedPercent": 30.0 }
                    ]
                }))
            }) as SentFuture
        })
        .await
        .expect("a domain answer");

        assert_eq!(result.error, None);
        let usage = result.usage.expect("usage");
        assert_eq!(usage.remaining, None);
        assert_eq!(usage.windows.len(), 1);
        assert_eq!(usage.windows[0].id, "rolling_5h");
        assert_eq!(usage.windows[0].label, "5h");
    }

    #[tokio::test]
    async fn a_account_drafts_own_key_beats_the_fallback() {
        let mut input = input("account", ACCOUNT_SCRIPT);
        input.api_key = Some("sk-draft".to_string());
        let captured: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let sink = captured.clone();

        let result =
            run_draft_query_test(&input, Some("sk-borrowed".to_string()), move |request| {
                let sink = sink.clone();
                Box::pin(async move {
                    *sink.lock().expect("sink") = request.headers.get("Authorization").cloned();
                    Ok(serde_json::json!({ "remaining": 1 }))
                }) as SentFuture
            })
            .await
            .expect("draft key wins");

        assert_eq!(result.error, None);
        assert_eq!(
            captured.lock().expect("sink").clone(),
            Some("Bearer sk-draft".to_string())
        );
    }

    #[tokio::test]
    async fn a_failure_message_never_echoes_a_draft_credential() {
        let mut input = input("account", ACCOUNT_SCRIPT);
        input.api_key = Some("sk-secret".to_string());

        let result =
            run_draft_query_test(&input, None, failing_send("HTTP 401 at Bearer sk-secret"))
                .await
                .expect("a domain answer");

        assert!(result.usage.is_none());
        assert!(!result.is_valid);
        assert_eq!(result.error.as_deref(), Some("HTTP 401 at Bearer ***"));
    }

    #[tokio::test]
    async fn an_account_draft_with_no_usable_fields_fails_the_test() {
        // A credential so the request resolves — the point of the test is the
        // answer shape, not the missing-key wording. The extractor skips the
        // amount fields entirely, so the engine's own strictness reports the
        // unreadable field path rather than inventing a zero.
        let mut input = input(
            "account",
            "({request:{url:'{{baseUrl}}/v1/quota',method:'GET',headers:{Authorization:'Bearer {{apiKey}}'}},extractor:function(r){return {unit:r.unit||null}}})",
        );
        input.api_key = Some("sk-draft".to_string());

        let result = run_draft_query_test(&input, None, echo_send())
            .await
            .expect("a domain answer");

        assert!(result.usage.is_none());
        assert!(!result.is_valid);
        assert_eq!(
            result.error.as_deref(),
            Some("查询未返回余额或用量，请检查查询脚本中的字段路径")
        );
    }

    #[tokio::test]
    async fn an_account_draft_relays_the_script_s_invalidation_reason() {
        let mut input = input(
            "account",
            "({request:{url:'{{baseUrl}}/v1/quota',method:'GET',headers:{Authorization:'Bearer {{apiKey}}'}},extractor:function(r){return {isValid:r.usable===true, invalidMessage:r.message||null}}})",
        );
        input.api_key = Some("sk-draft".to_string());

        let result = run_draft_query_test(&input, None, move |_request: ScriptRequest| {
            Box::pin(async move {
                Ok(serde_json::json!({ "usable": false, "message": "服务报告密钥不可用" }))
            }) as SentFuture
        })
        .await
        .expect("a domain answer");

        assert!(result.usage.is_none());
        assert!(!result.is_valid);
        assert_eq!(result.error.as_deref(), Some("服务报告密钥不可用"));
    }

    #[tokio::test]
    async fn an_account_answer_with_windows_keeps_its_windows() {
        let input = input("account", "({request:{url:'{{baseUrl}}/v1/quota'},extractor:function(r){return {remaining:r.remaining, windows:r.windows}}})");

        let result = run_draft_query_test(&input, None, |_request: ScriptRequest| {
            Box::pin(async move {
                Ok(serde_json::json!({
                    "remaining": 10,
                    "windows": [{ "id": "rolling", "usedPercent": 30.0 }]
                }))
            }) as SentFuture
        })
        .await
        .expect("a domain answer");

        let usage = result.usage.expect("usage");
        assert_eq!(usage.remaining, Some(10.0));
        assert_eq!(usage.windows.len(), 1);
        // The label fallback keeps a window readable when the script named none.
        assert_eq!(usage.windows[0].label, "rolling");
        assert_eq!(result.error, None);
    }
}
