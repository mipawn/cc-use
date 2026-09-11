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

    let value: Value = serde_json::from_str(&json).map_err(|error| {
        QueryScriptError::Result(format!("extractor returned no object: {error}"))
    })?;

    if !value.is_object() {
        return Err(QueryScriptError::Result(
            "extractor must return an object".to_string(),
        ));
    }

    serde_json::from_value(value)
        .map_err(|error| QueryScriptError::Result(format!("unexpected field: {error}")))
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
}
