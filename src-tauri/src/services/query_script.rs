//! Account queries written by the user.
//!
//! "How much of this account is left" is answered by a small JavaScript
//! expression the user can read and edit:
//!
//! ```js
//! ({
//!   request: {
//!     url: "{{baseUrl}}/user/balance",
//!     method: "GET",
//!     headers: { Authorization: "Bearer {{apiKey}}" }
//!   },
//!   extractor: (response) => ({ remaining: response.balance, unit: "USD" })
//! })
//! ```
//!
//! The request half is executed by Rust with the app's own HTTP client, so it
//! obeys the provider's proxy settings and the app's TLS policy; the extractor
//! half reads the answer into the standard fields the UI renders. A preset
//! ships one of these per service, which is why "use the built-in rule" and
//! "write your own" are the same mechanism rather than two.
//!
//! The script is evaluated in a sandbox with a hard memory ceiling and a wall
//! clock, because the expression is only ever arithmetic over one response and
//! has no legitimate need for more.
//!
//! A script carries one of two request contracts. The original one asks for a
//! single `request` and reads `extractor(response)`; the named one asks for a
//! map of `requests` and reads `extractor(responses)`, where every request
//! name resolves to the response it returned (or `null` when an optional one
//! failed). A script may use one or the other, never both.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::time::{Duration, Instant};

/// Sandbox limits. Overridable so a test can prove the ceiling is enforced
/// without waiting out the production one.
#[derive(Debug, Clone)]
pub struct ScriptLimits {
    pub memory_bytes: usize,
    pub stack_bytes: usize,
    pub time_limit: Duration,
}

impl Default for ScriptLimits {
    fn default() -> Self {
        Self {
            memory_bytes: 16 * 1024 * 1024,
            stack_bytes: 512 * 1024,
            time_limit: Duration::from_secs(5),
        }
    }
}

/// Values a script may reference, written as `{{name}}`.
#[derive(Debug, Clone, Default)]
pub struct ScriptVars {
    pub base_url: String,
    pub api_key: Option<String>,
    pub access_token: Option<String>,
    pub user_id: Option<String>,
}

/// The request half of a script.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScriptRequest {
    pub url: String,
    #[serde(default = "default_method")]
    pub method: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
}

fn default_method() -> String {
    "GET".to_string()
}

/// One named request of the many-request contract.
///
/// The request half is the same shape the single contract uses, flattened
/// into the name's object; `optional` is the only thing a name adds — a failed
/// optional request answers `null` to the extractor instead of failing the
/// whole refresh.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NamedRequest {
    #[serde(flatten)]
    pub request: ScriptRequest,
    #[serde(default)]
    pub optional: bool,
}

/// The standard shape an extractor returns.
///
/// The same fields for every service: a plain balance fills `remaining`, a
/// metered service fills `windows`, and the card renders one or the other
/// without knowing which vendor answered.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountUsage {
    #[serde(default)]
    pub remaining: Option<f64>,
    #[serde(default)]
    pub total: Option<f64>,
    #[serde(default)]
    pub used: Option<f64>,
    #[serde(default)]
    pub unit: Option<String>,
    #[serde(default)]
    pub is_unlimited: Option<bool>,
    #[serde(default)]
    pub expire_at: Option<String>,
    #[serde(default)]
    pub windows: Vec<AccountWindow>,
    /// Whether the account itself is usable. Defaults to true: a script that
    /// says nothing about validity is not reporting a problem.
    #[serde(default)]
    pub is_valid: Option<bool>,
    #[serde(default)]
    pub invalid_message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountWindow {
    pub id: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub used_percent: Option<f64>,
    #[serde(default)]
    pub resets_at: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum QueryScriptError {
    /// The script did not evaluate, or did not throw the shape it must.
    Script(String),
    /// It ran but was stopped: too long, or too much memory.
    Limit(String),
    /// The extractor returned something that is not the standard shape.
    Result(String),
}

impl QueryScriptError {
    pub fn message(&self) -> &str {
        match self {
            Self::Script(message) | Self::Limit(message) | Self::Result(message) => message,
        }
    }
}

impl std::fmt::Display for QueryScriptError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message())
    }
}

impl std::error::Error for QueryScriptError {}

/// Substitute the `{{name}}` placeholders.
///
/// Values are escaped for a JavaScript string literal, because that is where a
/// placeholder always sits — `url: "{{baseUrl}}/x"`. A key containing a quote
/// would otherwise end the literal and turn the script into something else.
pub fn substitute(script: &str, vars: &ScriptVars) -> String {
    let pairs = [
        ("{{baseUrl}}", Some(vars.base_url.as_str())),
        ("{{apiKey}}", vars.api_key.as_deref()),
        ("{{accessToken}}", vars.access_token.as_deref()),
        ("{{userId}}", vars.user_id.as_deref()),
    ];

    let mut resolved = script.to_string();
    for (token, value) in pairs {
        // An absent value keeps its placeholder rather than becoming empty: an
        // empty base URL reads as a broken script, which is a worse clue than
        // a placeholder that plainly was never filled in.
        let Some(value) = value.filter(|value| !value.trim().is_empty()) else {
            continue;
        };
        resolved = resolved.replace(token, &escape_for_js_string(value));
    }
    resolved
}

fn escape_for_js_string(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '\\' => escaped.push_str("\\\\"),
            '"' => escaped.push_str("\\\""),
            '\'' => escaped.push_str("\\'"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\u{2028}' => escaped.push_str("\\u2028"),
            '\u{2029}' => escaped.push_str("\\u2029"),
            other => escaped.push(other),
        }
    }
    escaped
}

/// Read the request a script describes.
pub fn resolve_request(
    script: &str,
    vars: &ScriptVars,
    limits: &ScriptLimits,
) -> Result<ScriptRequest, QueryScriptError> {
    let source = substitute(script, vars);
    let json = evaluate(&format!("JSON.stringify(({source}).request)"), limits)?;

    let request: ScriptRequest = serde_json::from_str(&json)
        .map_err(|error| QueryScriptError::Script(format!("request is not usable: {error}")))?;

    if request.url.trim().is_empty() {
        return Err(QueryScriptError::Script("request.url is empty".to_string()));
    }

    if !request.method.eq_ignore_ascii_case("GET") {
        return Err(QueryScriptError::Script(format!(
            "only GET is supported, the script asked for {}",
            request.method
        )));
    }

    Ok(request)
}

/// Which request form a script uses.
///
/// The one-request contract is carried verbatim: its branch is the same
/// [`resolve_request`] call it always was, so an existing single-request
/// script resolves exactly as it did before named requests existed.
#[derive(Debug, Clone, PartialEq)]
pub enum ResolvedRequests {
    Single(ScriptRequest),
    Many(BTreeMap<String, NamedRequest>),
}

/// The sandboxed probe's answer: which request form the script carries.
///
/// `JSON.stringify` drops keys whose value is `undefined`, so the evaluation
/// of `{request: s.request, requests: s.requests}` reads back an absent form
/// as one that is simply not there.
#[derive(Deserialize)]
struct RequestProbe {
    #[serde(default)]
    request: Option<Value>,
    #[serde(default)]
    requests: Option<BTreeMap<String, NamedRequest>>,
}

/// Read the requests a script describes, in either contract.
///
/// `request` and `requests` are exclusive: both present is a script error, two
/// present at write time being the one mistake a user cannot fix by picking a
/// form later. The single form delegates to [`resolve_request`], which keeps
/// the old contract byte-for-byte — including the error a script that names
/// neither form always gave.
pub fn resolve_requests(
    script: &str,
    vars: &ScriptVars,
    limits: &ScriptLimits,
) -> Result<ResolvedRequests, QueryScriptError> {
    let source = substitute(script, vars);
    let json = evaluate(
        &format!(
            "JSON.stringify((function(){{var s=({source});\
              return {{request: s.request, requests: s.requests}};}})())"
        ),
        limits,
    )?;

    let probe: RequestProbe = serde_json::from_str(&json)
        .map_err(|error| QueryScriptError::Script(format!("request is not usable: {error}")))?;

    match (probe.request, probe.requests) {
        (Some(_), Some(_)) => Err(QueryScriptError::Script(
            "request 与 requests 二选一，不要同时写".to_string(),
        )),
        (Some(_), None) => resolve_request(script, vars, limits).map(ResolvedRequests::Single),
        (None, Some(requests)) => {
            validate_named_requests(&requests)?;
            Ok(ResolvedRequests::Many(requests))
        }
        (None, None) => resolve_request(script, vars, limits).map(ResolvedRequests::Single),
    }
}

/// The requirements the named contract adds: a request must have a name for
/// the extractor to reference, a URL to send, and GET.
fn validate_named_requests(
    requests: &BTreeMap<String, NamedRequest>,
) -> Result<(), QueryScriptError> {
    for (name, named) in requests {
        if name.trim().is_empty() {
            return Err(QueryScriptError::Script(
                "request name must not be empty".to_string(),
            ));
        }
        if named.request.url.trim().is_empty() {
            return Err(QueryScriptError::Script(format!(
                "request \"{name}\" has an empty url"
            )));
        }
        if !named.request.method.eq_ignore_ascii_case("GET") {
            return Err(QueryScriptError::Script(format!(
                "only GET is supported, the request \"{name}\" asked for {}",
                named.request.method
            )));
        }
    }
    Ok(())
}

/// Run the extractor over a response.
pub fn run_extractor(
    script: &str,
    vars: &ScriptVars,
    response: &Value,
    limits: &ScriptLimits,
) -> Result<AccountUsage, QueryScriptError> {
    let source = substitute(script, vars);
    // The response travels as a JSON string literal: JSON is a subset of
    // JavaScript, so the escaping `serde_json` produces is valid here too.
    let literal = serde_json::to_string(&response.to_string())
        .map_err(|error| QueryScriptError::Result(error.to_string()))?;

    let json = evaluate(
        &format!(
            "(function(){{const response = JSON.parse({literal});\
              return JSON.stringify(({source}).extractor(response));}})()"
        ),
        limits,
    )?;

    parse_usage(&json)
}

/// Run an extractor over a named set of responses.
///
/// The map is the object the script asked for via `requests`: every request
/// name resolves to the parsed response that returned, and a failed optional
/// request answers `null`. One sandbox evaluation covers the whole set under
/// the same limits the single contract keeps; each response travels as a JSON
/// string literal, the escaping `serde_json` produces being valid here too.
pub fn run_extractor_many(
    script: &str,
    vars: &ScriptVars,
    responses: &BTreeMap<String, Option<Value>>,
    limits: &ScriptLimits,
) -> Result<AccountUsage, QueryScriptError> {
    let source = substitute(script, vars);

    let names: Vec<&str> = responses.keys().map(String::as_str).collect();
    let payloads: Vec<Value> = responses
        .values()
        .map(|response| match response {
            // A body travels as a JSON string holding the JSON text, the way
            // the single contract feeds one body: `serde_json` escapes the
            // text into a JS string literal, and `JSON.parse` reads the
            // object the wire delivered.
            Some(body) => serde_json::to_string(body)
                .map(serde_json::Value::String)
                .map_err(|error| QueryScriptError::Result(error.to_string())),
            // A failed optional request is the JSON null, parsed like any body.
            None => Ok(serde_json::Value::String("null".to_string())),
        })
        .collect::<Result<Vec<Value>, QueryScriptError>>()?;

    let json = evaluate(
        &format!(
            "(function(){{var names={names},payloads={payloads};\
              const responses={{}};\
              for (var i=0;i<names.length;i++){{responses[names[i]]=JSON.parse(payloads[i]);}}\
              return JSON.stringify(({source}).extractor(responses));}})()",
            names = serde_json::to_string(&names)
                .map_err(|error| QueryScriptError::Result(error.to_string()))?,
            payloads = serde_json::to_string(&payloads)
                .map_err(|error| QueryScriptError::Result(error.to_string()))?,
        ),
        limits,
    )?;

    parse_usage(&json)
}

/// Read an extractor's JSON answer into the standard shape.
///
/// Shared by both contracts: unknown fields are reported rather than dropped,
/// windows may arrive with just an id, and a script that answered nothing
/// fails rather than reading as an empty success.
fn parse_usage(json: &str) -> Result<AccountUsage, QueryScriptError> {
    let value: Value = serde_json::from_str(json).map_err(|error| {
        QueryScriptError::Result(format!("extractor returned no object: {error}"))
    })?;

    if !value.is_object() {
        return Err(QueryScriptError::Result(
            "extractor must return an object".to_string(),
        ));
    }

    let mut usage: AccountUsage = serde_json::from_value(value)
        .map_err(|error| QueryScriptError::Result(format!("unexpected field: {error}")))?;
    // Cache readers require a label, while scripts may provide just the id.
    for window in &mut usage.windows {
        if window
            .label
            .as_deref()
            .is_none_or(|label| label.trim().is_empty())
        {
            window.label = Some(window.id.clone());
        }
    }
    if usage.is_valid != Some(false)
        && usage.remaining.is_none()
        && usage.total.is_none()
        && usage.used.is_none()
        && usage.is_unlimited != Some(true)
        && usage.windows.is_empty()
    {
        return Err(QueryScriptError::Result(
            "查询未返回余额或用量，请检查查询脚本中的字段路径".to_string(),
        ));
    }
    Ok(usage)
}

/// Evaluate one expression under the sandbox limits.
fn evaluate(source: &str, limits: &ScriptLimits) -> Result<String, QueryScriptError> {
    let runtime =
        rquickjs::Runtime::new().map_err(|error| QueryScriptError::Script(error.to_string()))?;
    runtime.set_memory_limit(limits.memory_bytes);
    runtime.set_max_stack_size(limits.stack_bytes);

    // QuickJS calls this while it runs; returning true aborts the script. The
    // clock is the only thing a runaway loop cannot escape.
    let started = Instant::now();
    let time_limit = limits.time_limit;
    runtime.set_interrupt_handler(Some(Box::new(move || started.elapsed() > time_limit)));

    let context = rquickjs::Context::full(&runtime)
        .map_err(|error| QueryScriptError::Script(error.to_string()))?;

    context.with(|ctx| {
        ctx.eval::<String, _>(source).map_err(|error| {
            let message = error.to_string();
            // An aborted script surfaces as an exception like any other; the
            // distinction matters because "you wrote a bug" and "you wrote an
            // infinite loop" need different advice.
            if started.elapsed() > time_limit {
                QueryScriptError::Limit(format!("script ran longer than {}s", time_limit.as_secs()))
            } else {
                QueryScriptError::Script(message)
            }
        })
    })
}

/// The origin (`scheme://host[:port]`) of an absolute URL, if it has one.
pub fn origin_of(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    if scheme.is_empty() || rest.is_empty() {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.is_empty() {
        return None;
    }
    Some(format!(
        "{}://{}",
        scheme.to_ascii_lowercase(),
        authority.to_ascii_lowercase()
    ))
}

/// Whether a query may be sent to this URL on behalf of this provider.
///
/// Two rules, both about the credential the request carries. It must be HTTPS,
/// so a key never crosses the wire in clear text; and it must address the
/// provider's own origin, so a script arriving from an imported configuration
/// cannot post that key to somebody else's server.
pub fn is_permitted_target(url: &str, provider_base_url: &str) -> Result<(), String> {
    let Some(target) = origin_of(url) else {
        return Err(format!("`{url}` is not an absolute URL"));
    };
    if !target.starts_with("https://") {
        return Err("the query URL must use https".to_string());
    }

    let Some(base) = origin_of(provider_base_url) else {
        return Err(format!(
            "the provider address `{provider_base_url}` is not an absolute URL"
        ));
    };
    if target != base {
        return Err(format!(
            "the query URL must be on the provider's own origin ({base}), not {target}"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared_runtime::account_scripts::command_code_script;
    use serde_json::json;

    fn vars() -> ScriptVars {
        ScriptVars {
            base_url: "https://relay.example.com".to_string(),
            api_key: Some("sk-live".to_string()),
            access_token: Some("tok-1".to_string()),
            user_id: Some("uid-7".to_string()),
        }
    }

    const SIMPLE: &str = r#"({
        request: {
            url: "{{baseUrl}}/user/balance",
            method: "GET",
            headers: { Authorization: "Bearer {{apiKey}}" }
        },
        extractor: (response) => ({ remaining: response.balance, unit: response.currency })
    })"#;

    #[test]
    fn placeholders_are_replaced_wherever_they_appear() {
        let resolved = substitute(SIMPLE, &vars());

        assert!(resolved.contains("https://relay.example.com/user/balance"));
        assert!(resolved.contains("Bearer sk-live"));
        assert!(!resolved.contains("{{baseUrl}}"));
    }

    /// A key with a quote in it must not be able to end the string literal it
    /// was substituted into.
    #[test]
    fn a_value_cannot_escape_the_literal_it_is_written_into() {
        let vars = ScriptVars {
            api_key: Some("sk-\"}; evil(); ({\"".to_string()),
            ..vars()
        };

        let resolved = substitute(SIMPLE, &vars);
        let request = resolve_request(&resolved, &ScriptVars::default(), &ScriptLimits::default())
            .expect("the script still parses");

        assert_eq!(
            request.headers.get("Authorization").map(String::as_str),
            Some("Bearer sk-\"}; evil(); ({\"")
        );
    }

    #[test]
    fn an_unfilled_placeholder_stays_visible() {
        let vars = ScriptVars {
            access_token: None,
            ..vars()
        };

        // Left as written rather than emptied: an empty base URL reads as a
        // broken script, which is a worse clue than an obvious placeholder.
        let resolved = substitute("GET {{baseUrl}}/x {{accessToken}}", &vars);
        assert_eq!(resolved, "GET https://relay.example.com/x {{accessToken}}");
    }

    #[test]
    fn a_script_yields_the_request_it_describes() {
        let request = resolve_request(SIMPLE, &vars(), &ScriptLimits::default()).expect("resolves");

        assert_eq!(request.url, "https://relay.example.com/user/balance");
        assert_eq!(request.method, "GET");
        assert_eq!(
            request.headers.get("Authorization").map(String::as_str),
            Some("Bearer sk-live")
        );
    }

    #[test]
    fn an_extractor_reads_the_standard_fields() {
        let usage = run_extractor(
            SIMPLE,
            &vars(),
            &json!({ "balance": 12.5, "currency": "USD" }),
            &ScriptLimits::default(),
        )
        .expect("runs");

        assert_eq!(
            usage,
            AccountUsage {
                remaining: Some(12.5),
                unit: Some("USD".to_string()),
                ..AccountUsage::default()
            }
        );
    }

    /// The whole point of the standard shape: a metered service fills the same
    /// struct a balance service does, and the card renders either.
    #[test]
    fn a_metered_service_fills_the_same_shape_as_a_balance() {
        let script = r#"({
            request: { url: "{{baseUrl}}/v1/usage", headers: { Authorization: "Bearer {{apiKey}}" } },
            extractor: (response) => ({
                isUnlimited: false,
                windows: Object.entries(response.usage).map(([id, period]) => ({
                    id,
                    label: period.label,
                    usedPercent: period.percent,
                    resetsAt: period.resets_at,
                    status: period.status
                }))
            })
        })"#;

        let usage = run_extractor(
            script,
            &vars(),
            &json!({ "usage": {
                "rolling": { "label": "5h", "percent": 42, "resets_at": "2026-09-11T15:00:00Z", "status": "ok" }
            }}),
            &ScriptLimits::default(),
        )
        .expect("runs");

        assert_eq!(usage.windows.len(), 1);
        assert_eq!(usage.windows[0].id, "rolling");
        assert_eq!(usage.windows[0].label.as_deref(), Some("5h"));
        assert_eq!(usage.windows[0].used_percent, Some(42.0));
        assert_eq!(usage.remaining, None);
    }

    #[test]
    fn a_script_that_does_not_run_says_so() {
        let error = resolve_request(
            "({ this is not javascript",
            &vars(),
            &ScriptLimits::default(),
        )
        .expect_err("rejected");

        assert!(matches!(error, QueryScriptError::Script(_)));
    }

    #[test]
    fn a_script_with_no_request_object_is_rejected() {
        let error = resolve_request(
            "({ extractor: () => ({}) })",
            &vars(),
            &ScriptLimits::default(),
        )
        .expect_err("rejected");

        assert!(matches!(error, QueryScriptError::Script(_)));
    }

    #[test]
    fn an_extractor_must_return_an_object() {
        let error = run_extractor(
            "({ extractor: () => 42 })",
            &vars(),
            &json!({}),
            &ScriptLimits::default(),
        )
        .expect_err("rejected");

        assert!(matches!(error, QueryScriptError::Result(_)));
    }

    #[test]
    fn an_unknown_field_is_reported_rather_than_dropped() {
        // Silently ignoring it would leave the user believing their script said
        // something the UI never received.
        let error = run_extractor(
            "({ extractor: () => ({ remaning: 1 }) })",
            &vars(),
            &json!({}),
            &ScriptLimits::default(),
        )
        .expect_err("rejected");

        assert!(matches!(error, QueryScriptError::Result(_)));
    }

    /// The clock is the only limit a runaway loop cannot escape.
    #[test]
    fn a_runaway_script_is_stopped_by_the_clock() {
        let limits = ScriptLimits {
            time_limit: Duration::from_millis(120),
            ..ScriptLimits::default()
        };

        let error = resolve_request("(() => { while (true) {} })()", &vars(), &limits)
            .expect_err("stopped");

        assert!(matches!(error, QueryScriptError::Limit(_)), "got {error:?}");
    }

    #[test]
    fn a_query_may_only_leave_for_the_providers_own_origin() {
        let base = "https://relay.example.com";

        assert!(is_permitted_target("https://relay.example.com/api/user/self", base).is_ok());
        // An imported configuration must not be able to post the key elsewhere.
        assert!(is_permitted_target("https://evil.example.com/collect", base).is_err());
        // Nor to send it in clear text.
        assert!(is_permitted_target("http://relay.example.com/x", base).is_err());
        assert!(is_permitted_target("not a url", base).is_err());
        // A port is part of the origin, so it has to match too.
        assert!(is_permitted_target("https://relay.example.com:8443/x", base).is_err());
    }

    #[test]
    fn origin_parsing_keeps_the_port_and_drops_the_path() {
        assert_eq!(
            origin_of("HTTPS://Relay.Example.com:8443/a/b?c=1").as_deref(),
            Some("https://relay.example.com:8443")
        );
        assert_eq!(
            origin_of("https://relay.example.com").as_deref(),
            Some("https://relay.example.com")
        );
        assert_eq!(origin_of("/api/user/self"), None);
    }

    #[test]
    fn unlabeled_windows_survive_the_persisted_usage_contract() {
        let usage = run_extractor(
            "({extractor: () => ({windows: [{id: 'weekly', usedPercent: 25}]})})",
            &ScriptVars::default(),
            &serde_json::json!({}),
            &ScriptLimits::default(),
        )
        .unwrap();
        let cached: crate::models::UsageData =
            serde_json::from_value(serde_json::to_value(usage).unwrap()).unwrap();
        assert_eq!(cached.windows[0].label, "weekly");
        assert_eq!(cached.windows[0].used_percent, Some(25.0));
    }

    #[test]
    fn missing_balance_field_is_not_a_successful_empty_query() {
        let result = run_extractor(
            "({extractor: (response) => ({remaining: response.missing, unit: 'USD'})})",
            &ScriptVars::default(),
            &serde_json::json!({}),
            &ScriptLimits::default(),
        );
        assert!(result.is_err());
        let zero = run_extractor(
            "({extractor: () => ({remaining: 0, unit: 'USD'})})",
            &ScriptVars::default(),
            &serde_json::json!({}),
            &ScriptLimits::default(),
        )
        .unwrap();
        assert_eq!(zero.remaining, Some(0.0));
    }

    // The named-request contract. Every check here runs against the shipped
    // Command Code template — the script the preset installs — so the parser,
    // the sandbox assembly and one real multi-request script stay in step.

    const NAMED_SIMPLE: &str = r#"({
        request: { url: "{{baseUrl}}/single" },
        requests: { first: { url: "{{baseUrl}}/named" } },
        extractor: (responses) => ({})
    })"#;

    #[test]
    fn both_request_forms_in_one_script_are_rejected_with_the_reported_cause() {
        let error = resolve_requests(NAMED_SIMPLE, &vars(), &ScriptLimits::default())
            .expect_err("rejected");

        assert!(
            matches!(error, QueryScriptError::Script(message) if message == "request 与 requests 二选一，不要同时写")
        );
    }

    #[test]
    fn a_script_using_one_form_yields_what_the_form_always_did() {
        let via_named = resolve_requests(SIMPLE, &vars(), &ScriptLimits::default()).unwrap();
        assert_eq!(
            via_named,
            ResolvedRequests::Single(
                resolve_request(SIMPLE, &vars(), &ScriptLimits::default()).unwrap()
            )
        );

        // The error for a script that names neither form is the one the single
        // contract always gave, left as the fallback path it is.
        let old = resolve_request(
            "({ extractor: () => ({}) })",
            &vars(),
            &ScriptLimits::default(),
        )
        .unwrap_err();
        let named = resolve_requests(
            "({ extractor: () => ({}) })",
            &vars(),
            &ScriptLimits::default(),
        )
        .unwrap_err();
        assert_eq!(old, named);
    }

    #[test]
    fn a_named_script_resolves_each_request_under_its_name() {
        let resolved = resolve_requests(
            r#"({
                requests: {
                    credit: { url: "{{baseUrl}}/credits", headers: { Authorization: "Bearer {{apiKey}}" } },
                    glance: { url: "{{baseUrl}}/glance", optional: true }
                },
                extractor: (responses) => ({})
            })"#,
            &vars(),
            &ScriptLimits::default(),
        )
        .expect("resolves");

        let ResolvedRequests::Many(named) = resolved else {
            panic!("a named set resolves to Many, got {resolved:?}");
        };
        assert_eq!(named.len(), 2);
        assert_eq!(
            named["credit"].request.url,
            "https://relay.example.com/credits"
        );
        // The placeholder is substituted in every request, not just the first.
        assert_eq!(
            named["credit"]
                .request
                .headers
                .get("Authorization")
                .map(String::as_str),
            Some("Bearer sk-live")
        );
        assert!(!named["credit"].optional);
        assert!(named["glance"].optional);
    }

    #[test]
    fn a_single_request_that_also_carries_requests_optional_is_not_flattened() {
        // `optional` belongs to the named form only; a single request is
        // resolved by the legacy path, which must not start reading it.
        let resolved = resolve_requests(
            "({ request: { url: 'https://relay.example.com/x', optional: true } })",
            &ScriptVars::default(),
            &ScriptLimits::default(),
        )
        .expect("still the legacy shape");

        let ResolvedRequests::Single(request) = resolved else {
            panic!("the legacy form resolves to Single, got {resolved:?}");
        };
        assert_eq!(request.url, "https://relay.example.com/x");
    }

    #[test]
    fn named_requests_keep_the_same_per_request_rules() {
        let base = "https://relay.example.com";

        let error = resolve_requests(
            r#"({ requests: { first: { url: "  " } }, extractor: () => ({}) })"#,
            &ScriptVars::default(),
            &ScriptLimits::default(),
        )
        .unwrap_err();
        assert!(
            matches!(error, QueryScriptError::Script(message) if message.contains("has an empty url"))
        );

        let error = resolve_requests(
            r#"({ requests: { first: { url: "...", method: "POST" } } })"#
                .replace("...", &format!("{base}/up"))
                .as_str(),
            &ScriptVars::default(),
            &ScriptLimits::default(),
        )
        .unwrap_err();
        assert!(
            matches!(error, QueryScriptError::Script(message) if message.contains("only GET is supported"))
        );

        let error = resolve_requests(
            r#"({ requests: { "": { url: "https://relay.example.com/x" } } })"#,
            &ScriptVars::default(),
            &ScriptLimits::default(),
        )
        .unwrap_err();
        assert!(
            matches!(error, QueryScriptError::Script(message) if message.contains("must not be empty"))
        );
    }

    /// The responses travel into the sandbox as one object under their names.
    fn run_command_code(
        credit: serde_json::Value,
        subscription: Option<serde_json::Value>,
        summary: Option<serde_json::Value>,
    ) -> Result<AccountUsage, QueryScriptError> {
        run_extractor_many(
            command_code_script(),
            &vars(),
            &BTreeMap::from([
                ("credit".to_string(), Some(credit)),
                ("subscription".to_string(), subscription),
                ("summary".to_string(), summary),
            ]),
            &ScriptLimits::default(),
        )
    }

    /// The first documented credits nesting: amounts and the window limits
    /// both live on `body.credits` itself.
    fn flat_credits_body() -> serde_json::Value {
        json!({
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
        })
    }

    #[test]
    fn the_command_code_template_reads_the_flat_credits_shape() {
        let usage = run_command_code(
            flat_credits_body(),
            Some(json!({
                "success": true,
                "data": {
                    "planId": "individual-provider",
                    "status": "active",
                    "currentPeriodStart": 1764547200000i64,
                    "currentPeriodEnd": 1767225600000i64
                }
            })),
            Some(json!({ "totalCost": 3.75 })),
        )
        .expect("reads");

        // max(0, monthly) + max(0, purchased) + max(0, free), and credits is a
        // unit, never a currency.
        assert_eq!(usage.remaining, Some(15.0));
        assert_eq!(usage.unit.as_deref(), Some("credits"));

        let by_id = |id: &str| usage.windows.iter().find(|window| window.id == id).cloned();
        let rolling = by_id("rolling").expect("the 5h window was reported");
        assert_eq!(rolling.used_percent, Some(20.0));
        assert_eq!(
            rolling.resets_at.as_deref(),
            Some("2026-01-01T00:00:00.000Z")
        );

        // cap <= 0 is "was never reported", not a window that is empty.
        let weekly = by_id("weekly").expect("the weekly window was reported");
        assert_eq!(weekly.used_percent, None);

        let monthly = by_id("monthly").expect("the pair arrived, so the month was reported");
        assert_eq!(monthly.used_percent, Some(25.0));
        assert_eq!(
            monthly.resets_at.as_deref(),
            Some("2026-01-01T00:00:00.000Z")
        );
    }

    /// The second documented nesting: the amounts another layer down, and the
    /// window limits either beside them or on the outer object.
    #[test]
    fn the_command_code_template_reads_the_nested_credits_shape() {
        let usage = run_command_code(
            json!({
                "credits": {
                    "credits": {
                        "monthlyCredits": 8,
                        "purchasedCredits": 0,
                        "freeCredits": 0,
                        "planId": "individual-max",
                        "windowLimits": {
                            "fiveHour": { "used": 1, "cap": 4, "resetAt": 0 },
                            // cap and resetAt missing entirely: still a
                            // window, its numbers just were not said.
                            "weekly": { "used": 3 }
                        }
                    }
                }
            }),
            None,
            None,
        )
        .expect("reads");

        assert_eq!(usage.remaining, Some(8.0));
        // The account does report windows, so the monthly row is present but
        // honest about having nothing to compute with yet.
        let ids: Vec<&str> = usage
            .windows
            .iter()
            .map(|window| window.id.as_str())
            .collect();
        assert_eq!(ids, vec!["rolling", "weekly", "monthly"]);
        assert_eq!(usage.windows[0].used_percent, Some(25.0));
        assert_eq!(
            usage.windows[0].resets_at.as_deref(),
            Some("1970-01-01T00:00:00.000Z")
        );
        // cap missing → percent "未返回"; resetAt missing → no reset time.
        assert_eq!(usage.windows[1].used_percent, None);
        assert_eq!(usage.windows[1].resets_at, None);
        assert_eq!(usage.windows[2].used_percent, None);
        assert_eq!(usage.windows[2].resets_at, None);
    }

    /// The live answer (2026-11-09): the amounts under `credits`, and
    /// `windowLimits` beside it on the response body — the level the public
    /// client reads (`usageData.credits.windowLimits` names that body). The
    /// shipped template originally looked only inside `credits`, so a real
    /// refresh produced a balance and no windows at all.
    #[test]
    fn the_command_code_template_reads_the_live_credits_shape() {
        let usage = run_command_code(
            json!({
                "credits": {
                    "belowThreshold": false,
                    "creditThreshold": 0,
                    "monthlyCredits": 63.2690194024,
                    "purchasedCredits": 0,
                    "freeCredits": 0
                },
                "windowLimits": {
                    "limited": true,
                    "exceeded": null,
                    "fiveHour": {
                        "used": 0.4135450662,
                        "cap": 14,
                        "exceeded": false,
                        "resetAt": 1794209929502i64
                    },
                    "weekly": {
                        "used": 6.7204242476,
                        "cap": 35,
                        "exceeded": false,
                        "resetAt": 1794210865746i64
                    }
                },
                "sandboxAccess": true
            }),
            Some(json!({
                "success": true,
                "data": {
                    "planId": "individual-goat",
                    "status": "active",
                    "currentPeriodStart": "2026-10-16T08:29:24.000Z",
                    "currentPeriodEnd": "2026-11-16T08:29:24.000Z",
                    "cancelAtPeriodEnd": false
                }
            })),
            Some(json!({ "totalCost": 6.724491370799999 })),
        )
        .expect("reads");

        assert_eq!(usage.remaining, Some(63.2690194024));
        assert_eq!(usage.unit.as_deref(), Some("credits"));

        let by_id = |id: &str| usage.windows.iter().find(|window| window.id == id).cloned();
        let approx = |actual: Option<f64>, expected: f64| {
            let actual = actual.expect("the window reported its percentage");
            assert!(
                (actual - expected).abs() < 1e-6,
                "expected {expected}, got {actual}"
            );
        };

        // 5h 0.4135/14 and weekly 6.7204/35 come from the limits next to the
        // amounts; the old reading found neither.
        let rolling = by_id("rolling").expect("the 5h window was reported");
        approx(rolling.used_percent, 2.9538933299999997);
        assert_eq!(
            rolling.resets_at.as_deref(),
            Some("2026-11-09T07:38:49.502Z")
        );

        let weekly = by_id("weekly").expect("the weekly window was reported");
        approx(weekly.used_percent, 19.201212136);
        assert_eq!(
            weekly.resets_at.as_deref(),
            Some("2026-11-09T07:54:25.746Z")
        );

        // The month pairs summary.totalCost with the plan snapshot
        // (individual-goat → 70) and keeps the subscription's period end.
        let monthly = by_id("monthly").expect("the plan account carries a month row");
        approx(monthly.used_percent, 9.606416243999998);
        assert_eq!(
            monthly.resets_at.as_deref(),
            Some("2026-11-16T08:29:24.000Z")
        );
    }

    #[test]
    fn a_monthly_percent_stays_missing_when_its_inputs_do_not_add_up() {
        // An unknown planId: the row is there with the reset time, but no
        // fabricated percentage.
        let usage = run_command_code(
            flat_credits_body(),
            Some(json!({
                "success": true,
                "data": { "planId": "individual-mystery", "status": "active",
                    "currentPeriodEnd": 1767225600000i64 }
            })),
            Some(json!({ "totalCost": 3.75 })),
        )
        .expect("reads");
        let monthly = usage.windows.iter().find(|w| w.id == "monthly");
        assert_eq!(monthly.map(|window| window.used_percent), Some(None));

        // A status that is neither active nor trialing does not count a
        // cancelled period's spend against the plan.
        let usage = run_command_code(
            flat_credits_body(),
            Some(json!({
                "success": true,
                "data": { "planId": "individual-provider", "status": "canceled" }
            })),
            Some(json!({ "totalCost": 3.75 })),
        )
        .expect("reads");
        let monthly = usage.windows.iter().find(|w| w.id == "monthly");
        assert_eq!(monthly.map(|window| window.used_percent), Some(None));
    }

    #[test]
    fn a_string_period_end_is_accepted_like_a_millisecond_number() {
        let usage = run_command_code(
            flat_credits_body(),
            Some(json!({
                "success": true,
                "data": { "planId": "individual-provider", "status": "active",
                    "currentPeriodEnd": "2026-02-01T00:00:00.000Z" }
            })),
            Some(json!({ "totalCost": 3.75 })),
        )
        .expect("reads");

        let monthly = usage
            .windows
            .iter()
            .find(|window| window.id == "monthly")
            .expect("the month was reported");
        assert_eq!(
            monthly.resets_at.as_deref(),
            Some("2026-02-01T00:00:00.000Z")
        );
    }

    #[test]
    fn a_summary_envelope_wrapped_in_data_is_read_the_same() {
        // The CLI only ever reads a top-level totalCost; a `data` wrapper is
        // read one level below before the month is left unreported, so the
        // two plausible envelopes answer the same question.
        let usage = run_command_code(
            flat_credits_body(),
            Some(json!({
                "success": true,
                "data": { "planId": "individual-provider", "status": "active",
                    "currentPeriodEnd": 1767225600000i64 }
            })),
            Some(json!({ "data": { "totalCost": 3.75 } })),
        )
        .expect("reads");

        let monthly = usage
            .windows
            .iter()
            .find(|window| window.id == "monthly")
            .expect("the month was reported");
        assert_eq!(monthly.used_percent, Some(25.0));
    }

    #[test]
    fn a_plan_id_falls_back_to_the_one_credits_reported() {
        // subscriptions did not name a plan; credits did, spelled the old way
        // with an underscore, and the pair still synthesizes the month.
        let usage = run_command_code(
            flat_credits_body(),
            Some(json!({
                "success": true,
                "data": { "status": "active", "currentPeriodEnd": 1767225600000i64 }
            })),
            Some(json!({ "totalCost": 3.75 })),
        )
        .expect("reads");

        let monthly = usage
            .windows
            .iter()
            .find(|window| window.id == "monthly")
            .expect("the month was reported");
        assert_eq!(monthly.used_percent, Some(25.0));
    }

    /// All three amounts missing is the endpoint reporting nothing — which is
    /// a different fact from an empty account, and gets its own message.
    #[test]
    fn amount_less_credits_are_reported_invalid_not_read_as_zero() {
        let usage = run_command_code(
            json!({ "credits": { "planId": "individual-provider" } }),
            None,
            None,
        )
        .expect("the template answers with a standard reading");

        assert_eq!(usage.is_valid, Some(false));
        assert_eq!(usage.invalid_message.as_deref(), Some("credits 数值缺失"));
        assert_eq!(usage.remaining, None);
    }

    /// A real zero is a number the endpoint reported, and survives as 0.
    #[test]
    fn a_real_zero_balance_survives_as_zero() {
        let usage = run_command_code(
            json!({ "credits": { "monthlyCredits": 0, "purchasedCredits": 0, "freeCredits": 0 } }),
            None,
            None,
        )
        .expect("reads");

        assert_eq!(usage.remaining, Some(0.0));
        assert_eq!(usage.is_valid, None);
        assert!(usage.windows.is_empty(), "no windowLimits, no window rows");
    }

    #[test]
    fn a_failed_optional_request_reaches_the_extractor_as_null() {
        // The null entries are what optional failures inject; the windows
        // the account does report stay, the month keeps its row but honestly
        // has nothing filled in.
        let usage = run_command_code(flat_credits_body(), None, None).expect("reads");

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
            .expect("a plan account always carries the monthly row");
        assert_eq!(monthly.used_percent, None);
        assert_eq!(monthly.resets_at, None);
        assert_eq!(usage.remaining, Some(15.0));
        assert_eq!(usage.unit.as_deref(), Some("credits"));
    }

    /// A pay-as-you-go account reports no windowLimits: nothing may be
    /// invented for it, not even the monthly row, while the optional pair
    /// answered.
    #[test]
    fn a_metered_account_with_no_window_limits_gets_no_window_rows_at_all() {
        let usage = run_command_code(
            json!({
                "credits": {
                    "monthlyCredits": 40,
                    "purchasedCredits": 0,
                    "freeCredits": 0,
                    "planId": "individual-go"
                }
            }),
            Some(json!({
                "success": true,
                "data": { "planId": "individual-go", "status": "active",
                    "currentPeriodEnd": 1767225600000i64 }
            })),
            Some(json!({ "totalCost": 1.25 })),
        )
        .expect("reads");

        assert!(
            usage.windows.is_empty(),
            "no windows were invented: {usage:?}"
        );
        assert_eq!(usage.remaining, Some(40.0));
    }

    #[test]
    fn the_named_contract_keeps_the_standard_shape_checks() {
        // An unknown field still fails loudly rather than being dropped.
        let error = run_extractor_many(
            "({requests:{a:{url:'https://x/y'}},extractor:()=>({remaning: 1})})",
            &ScriptVars::default(),
            &BTreeMap::from([("a".to_string(), Some(json!({})))]),
            &ScriptLimits::default(),
        )
        .unwrap_err();
        assert!(
            matches!(error, QueryScriptError::Result(message) if message.contains("unexpected"))
        );

        // An answer with nothing in it is not a successful empty query.
        let error = run_extractor_many(
            "({requests:{a:{url:'https://x/y'}},extractor:()=>({})})",
            &ScriptVars::default(),
            &BTreeMap::from([("a".to_string(), Some(json!({})))]),
            &ScriptLimits::default(),
        )
        .unwrap_err();
        assert!(error
            .message()
            .contains("查询未返回余额或用量，请检查查询脚本中的字段路径"));

        // A missing extractor is a script error, like the single contract.
        let error = run_extractor_many(
            "({requests:{a:{url:'https://x/y'}}})",
            &ScriptVars::default(),
            &BTreeMap::from([("a".to_string(), Some(json!({})))]),
            &ScriptLimits::default(),
        )
        .unwrap_err();
        assert!(matches!(error, QueryScriptError::Script(_)));
    }
}
