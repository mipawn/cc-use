//! The account queries the catalogue ships.
//!
//! Every service answers "how much of this account is left" with one request,
//! so every service is one script. The request differs, and so does the reading
//! of the answer, but the shape the script returns is the same — which is what
//! lets the card render DeepSeek's balance and OpenCode Go's metering periods
//! without knowing which vendor answered.
//!
//! The scripts are composed rather than written out whole, because the
//! migration that lifts a pre-script provider onto this model has to keep the
//! address that provider was actually using.

/// One service's account query, in the two parts that vary independently.
pub struct AccountScript {
    pub url: &'static str,
    /// A JSON object of request headers, with `{{var}}` placeholders.
    pub headers: &'static str,
    /// A JavaScript function `(response) => standardFields`.
    pub extractor: &'static str,
}

const DEEPSEEK: AccountScript = AccountScript {
    url: "https://api.deepseek.com/user/balance",
    headers: r#"{"Authorization": "Bearer {{apiKey}}"}"#,
    extractor: r#"function (response) {
    if (response.is_available === false) {
      return { isValid: false, invalidMessage: "DeepSeek 报告该账户余额不可用" }
    }
    var infos = response.balance_infos || []
    var entry = infos.filter(function (i) { return i.currency === "CNY" })[0] || infos[0]
    if (!entry || entry.total_balance == null) {
      return { isValid: false, invalidMessage: "响应中没有余额条目" }
    }
    // The amount arrives as a string; the standard field is a number.
    var amount = Number(entry.total_balance)
    if (!isFinite(amount)) {
      return { isValid: false, invalidMessage: "余额不是数字" }
    }
    return { remaining: amount, unit: entry.currency }
  }"#,
};

/// New API quotes quota in units of 500000 to the dollar.
const NEWAPI_ACCOUNT: AccountScript = AccountScript {
    url: "{{baseUrl}}/api/user/self",
    headers: r#"{"Authorization": "{{accessToken}}", "New-Api-User": "{{userId}}"}"#,
    extractor: r#"function (response) {
    var data = response.data
    if (!data) {
      return { isValid: false, invalidMessage: "响应中没有 data" }
    }
    var quota = Number(data.quota) || 0
    var used = Number(data.used_quota) || 0
    return { remaining: quota / 500000, used: used / 500000, total: (quota + used) / 500000, unit: "USD" }
  }"#,
};

/// Both New API quota routes answer the same shape; they differ only in whose
/// quota they report.
const NEWAPI_USAGE_EXTRACTOR: &str = r#"function (response) {
    var data = response.data || response
    var pick = function () {
      for (var i = 0; i < arguments.length; i++) {
        if (arguments[i] != null) { return Number(arguments[i]) }
      }
      return null
    }
    var stamp = function (value) {
      return value == null ? null : new Date(Number(value) * 1000).toISOString()
    }
    return {
      remaining: pick(data.total_available, data.remaining, data.available),
      total: pick(data.total_granted, data.total),
      used: pick(data.total_used, data.used),
      unit: data.unit || "USD",
      isUnlimited: !!(data.unlimited_quota || data.is_unlimited || data.isUnlimited),
      expireAt: stamp(data.expires_at != null ? data.expires_at : data.expire_time)
    }
  }"#;

const NEWAPI_KEY_USAGE: AccountScript = AccountScript {
    url: "{{baseUrl}}/api/usage/token/",
    headers: r#"{"Authorization": "Bearer {{apiKey}}"}"#,
    extractor: NEWAPI_USAGE_EXTRACTOR,
};

/// The account-wide quota route. It has no trailing slash: the two are
/// different routes on the same service.
const NEWAPI_ACCOUNT_USAGE: AccountScript = AccountScript {
    url: "{{baseUrl}}/api/usage/token",
    headers: r#"{"Authorization": "Bearer {{apiKey}}"}"#,
    extractor: NEWAPI_USAGE_EXTRACTOR,
};

/// OpenCode Go meters by period instead of holding a balance.
const OPENCODE_GO: AccountScript = AccountScript {
    url: "{{baseUrl}}/v1/usage",
    headers: r#"{"Authorization": "Bearer {{apiKey}}"}"#,
    extractor: r#"function (response) {
    var usage = response.usage
    // A shape this build cannot read is reported, not rendered as no windows:
    // "the provider said nothing" and "we could not read what it said" are
    // different facts and only one of them is the user's to act on.
    if (usage == null || typeof usage !== "object" || Array.isArray(usage)) {
      return { isValid: false, invalidMessage: "响应里没有 usage 对象" }
    }
    var ids = Object.keys(usage)
    if (ids.length === 0) {
      return { isValid: false, invalidMessage: "usage 里没有计量周期" }
    }
    var labels = { rolling: "5h", weekly: "Weekly", monthly: "Monthly" }
    var windows = []
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i]
      var period = usage[id]
      if (period == null || typeof period !== "object" || Array.isArray(period)) {
        return { isValid: false, invalidMessage: "计量周期 " + id + " 不是对象" }
      }
      windows.push({
        id: id,
        label: labels[id] || id,
        // A missing percentage stays missing rather than becoming zero.
        usedPercent: period.percent == null ? null : Number(period.percent),
        resetsAt: period.resets_at || period.resetsAt || null,
        status: period.status || null
      })
    }
    // No unit and no unlimited claim: a percentage is not a currency, and the
    // provider never said the account was unlimited.
    return { windows: windows }
  }"#,
};

/// Look up a service's query by the id the stored columns used.
pub fn for_legacy_kind(kind: &str) -> Option<&'static AccountScript> {
    match kind {
        "deepseek" => Some(&DEEPSEEK),
        "newapi" => Some(&NEWAPI_ACCOUNT),
        "opencode-go" => Some(&OPENCODE_GO),
        _ => None,
    }
}

/// The account-wide quota route, for the services that report one separately
/// from their balance.
pub fn usage_for_legacy_kind(kind: &str) -> Option<&'static AccountScript> {
    match kind {
        "newapi" => Some(&NEWAPI_ACCOUNT_USAGE),
        "opencode-go" => Some(&OPENCODE_GO),
        _ => None,
    }
}

/// The per-key quota query, for the one service that offers it.
pub fn key_usage_for_legacy_kind(kind: &str) -> Option<&'static AccountScript> {
    match kind {
        "newapi" => Some(&NEWAPI_KEY_USAGE),
        _ => None,
    }
}

/// Write a pre-script query out as the script that reproduces it.
///
/// Providers created before scripts existed kept a query as a kind plus an
/// address. Rather than leave those dark until someone retypes them, each is
/// written out as the script it always meant — keeping the address that
/// provider was actually using, which is the part a vendor default would lose.
pub fn lift_from_legacy(
    kind: &str,
    url: Option<&str>,
    headers: Option<&str>,
    path: Option<&str>,
) -> Option<String> {
    lift_with(kind, for_legacy_kind(kind.trim()), url, headers, path)
}

/// The same, for a key's own quota query.
///
/// A key asks a different route than the account does — New API serves the
/// per-key quota from `/api/usage/token/` and the account's from
/// `/api/user/self` — so the two cannot share one lookup.
pub fn lift_key_usage_from_legacy(
    kind: &str,
    url: Option<&str>,
    headers: Option<&str>,
    path: Option<&str>,
) -> Option<String> {
    lift_with(
        kind,
        key_usage_for_legacy_kind(kind.trim()),
        url,
        headers,
        path,
    )
}

fn lift_with(
    kind: &str,
    script: Option<&'static AccountScript>,
    url: Option<&str>,
    headers: Option<&str>,
    path: Option<&str>,
) -> Option<String> {
    let kind = kind.trim();
    if kind.is_empty() || kind == "none" {
        return None;
    }

    // A hand-written query is only its address, headers and path; there is no
    // vendor reading to fall back on, so all three have to be there.
    if kind == "custom" {
        let url = non_empty(url).map(modernize)?;
        let headers = modernize_headers(non_empty(headers).unwrap_or("{}"));
        let path = non_empty(path)?;
        return Some(compose(&url, &headers, &reading_a_path(path)));
    }

    let script = script?;
    let url = non_empty(url)
        .map(modernize)
        .unwrap_or_else(|| script.url.to_string());
    let headers = non_empty(headers)
        .map(modernize_headers)
        .unwrap_or_else(|| script.headers.to_string());

    Some(compose(&url, &headers, script.extractor))
}

/// Rewrite the single-brace placeholders the old fields used into the
/// double-brace ones the scripts substitute.
pub fn modernize(value: &str) -> String {
    value
        .replace("{baseUrl}", "{{baseUrl}}")
        .replace("{key}", "{{apiKey}}")
        .replace("{token}", "{{accessToken}}")
        .replace("{userId}", "{{userId}}")
}

/// The same rewrite applied to every value of a stored header object.
fn modernize_headers(headers: &str) -> String {
    let Ok(parsed) = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(headers)
    else {
        return headers.to_string();
    };

    let rewritten: serde_json::Map<String, serde_json::Value> = parsed
        .into_iter()
        .map(|(name, value)| {
            let value = match value {
                serde_json::Value::String(text) => serde_json::Value::String(modernize(&text)),
                other => other,
            };
            (name, value)
        })
        .collect();

    serde_json::to_string(&rewritten).unwrap_or_else(|_| headers.to_string())
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

/// A script that reads one number out of the response at `path`.
///
/// The path is the only thing a hand-written query had to say about the shape
/// of the answer, so it is the only thing to carry over.
pub fn reading_a_path(path: &str) -> String {
    let normalized = path.trim().replace('[', ".").replace(']', "");
    let mut expression = String::from("response");
    for segment in normalized.split('.') {
        let segment = segment.trim();
        if segment.is_empty() {
            continue;
        }
        expression.push('[');
        expression.push_str(&serde_json::to_string(segment).unwrap_or_else(|_| "\"\"".into()));
        expression.push(']');
    }

    format!(
        r#"function (response) {{
    var value = {expression}
    var number = Number(value)
    if (value == null || !isFinite(number)) {{
      return {{ isValid: false, invalidMessage: "路径 {path} 上没有可用的数字" }}
    }}
    return {{ remaining: number }}
  }}"#
    )
}

/// Assemble the script text from its parts.
pub fn compose(url: &str, headers_json: &str, extractor: &str) -> String {
    format!(
        "({{\n  request: {{\n    url: \"{}\",\n    method: \"GET\",\n    headers: {}\n  }},\n  extractor: {}\n}})",
        escape_js_string(url),
        headers_json.trim(),
        extractor.trim()
    )
}

/// The whole script for a service, as the catalogue ships it.
pub fn script_for(script: &AccountScript) -> String {
    compose(script.url, script.headers, script.extractor)
}

/// Escape a value for the inside of a double-quoted JavaScript string.
///
/// A substituted address or key containing a quote would otherwise end the
/// literal and turn the script into something else entirely.
pub fn escape_js_string(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '\\' => escaped.push_str("\\\\"),
            '"' => escaped.push_str("\\\""),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\u{2028}' => escaped.push_str("\\u2028"),
            '\u{2029}' => escaped.push_str("\\u2029"),
            other => escaped.push(other),
        }
    }
    escaped
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The scripts are text until something runs them, so the cheapest useful
    /// check here is that they are shaped like the contract requires. Their
    /// behaviour is covered by `services::query_script`, which executes them.
    #[test]
    fn every_shipped_script_has_both_halves() {
        let script = script_for(&DEEPSEEK);

        assert!(script.contains("request: {"));
        assert!(script.contains("url: \"https://api.deepseek.com/user/balance\""));
        assert!(script.contains("extractor: function (response)"));
    }

    #[test]
    fn an_address_with_a_quote_cannot_end_the_string_it_sits_in() {
        let script = compose(
            "https://x/\"} evil(); ({\"",
            "{}",
            "function (r) { return {} }",
        );

        assert!(script.contains(r#"url: "https://x/\"} evil(); ({\"""#));
    }

    #[test]
    fn a_dotted_path_becomes_a_lookup_that_cannot_be_injected() {
        let reader = reading_a_path("data.balance");

        assert!(reader.contains("response[\"data\"][\"balance\"]"));
    }

    /// The stored paths used `[0]` style indices; they have to survive.
    #[test]
    fn an_indexed_path_becomes_a_lookup_too() {
        let reader = reading_a_path("data[0].balance");

        assert!(reader.contains("response[\"data\"][\"0\"][\"balance\"]"));
    }

    /// A path is data, not code. Whatever it contains stays inside a quoted
    /// key, so nothing in it can run.
    #[test]
    fn a_path_that_looks_like_code_is_quoted_rather_than_evaluated() {
        let reader = reading_a_path("a\"];evil();[\"b");

        let expression = reader
            .lines()
            .find(|line| line.contains("var value"))
            .expect("the reader names a value");

        // Every segment is bracket-quoted, so the path stays data.
        assert!(expression.contains(r#"response["a\";evil();"]["\"b"]"#));
    }

    /// The old placeholders were single-braced; the scripts use double.
    #[test]
    fn a_legacy_placeholder_is_rewritten_rather_than_left_literal() {
        assert_eq!(
            modernize("{baseUrl}/api/user/self"),
            "{{baseUrl}}/api/user/self"
        );
        assert_eq!(modernize("Bearer {key}"), "Bearer {{apiKey}}");
        assert_eq!(modernize("{token}"), "{{accessToken}}");
        assert_eq!(modernize("{userId}"), "{{userId}}");
        // Nothing was there to rewrite.
        assert_eq!(
            modernize("https://api.deepseek.com"),
            "https://api.deepseek.com"
        );
    }

    #[test]
    fn a_lifted_query_keeps_the_address_the_provider_was_using() {
        let script = lift_from_legacy(
            "deepseek",
            Some("https://relay.example.com/balance"),
            None,
            None,
        )
        .expect("lifted");

        assert!(script.contains(r#"url: "https://relay.example.com/balance""#));
        assert!(!script.contains("api.deepseek.com"));
        // The reader still comes from the catalogue.
        assert!(script.contains("balance_infos"));
    }

    #[test]
    fn a_lifted_query_rewrites_the_headers_it_carries() {
        let script = lift_from_legacy(
            "custom",
            Some("{baseUrl}/api/user/balance"),
            Some(r#"{"Authorization": "Bearer {key}"}"#),
            Some("data.balance"),
        )
        .expect("lifted");

        assert!(script.contains(r#"url: "{{baseUrl}}/api/user/balance""#));
        assert!(script.contains(r#""Bearer {{apiKey}}""#));
        assert!(script.contains(r#"response["data"]["balance"]"#));
    }

    #[test]
    fn a_lifted_query_falls_back_to_the_catalogue_address() {
        let script = lift_from_legacy("opencode-go", None, None, None).expect("lifted");

        assert!(script.contains(r#"url: "{{baseUrl}}/v1/usage""#));
    }

    /// A key asks a different route than the account does, so lifting a key's
    /// query must not borrow the account's address.
    #[test]
    fn a_lifted_key_query_uses_the_per_key_route() {
        let script = lift_key_usage_from_legacy("newapi", None, None, None).expect("lifted");

        assert!(script.contains("{{baseUrl}}/api/usage/token/"));
        assert!(!script.contains("/api/user/self"));
    }

    /// The provider's own lift still uses the account route.
    #[test]
    fn a_lifted_account_query_uses_the_account_route() {
        let script = lift_from_legacy("newapi", None, None, None).expect("lifted");

        assert!(script.contains("{{baseUrl}}/api/user/self"));
    }

    #[test]
    fn nothing_to_lift_yields_nothing() {
        assert!(lift_from_legacy("none", None, None, None).is_none());
        assert!(lift_from_legacy("", None, None, None).is_none());
        // A hand-written query with no address had nothing to send.
        assert!(lift_from_legacy("custom", None, None, Some("data.balance")).is_none());
        // And one with no path had nothing to read.
        assert!(lift_from_legacy("custom", Some("{baseUrl}/x"), None, None).is_none());
    }

    #[test]
    fn each_legacy_kind_maps_to_the_service_it_named() {
        assert_eq!(
            for_legacy_kind("deepseek").map(|s| s.url),
            Some("https://api.deepseek.com/user/balance")
        );
        assert_eq!(
            for_legacy_kind("opencode-go").map(|s| s.url),
            Some("{{baseUrl}}/v1/usage")
        );
        assert!(for_legacy_kind("custom").is_none());
        assert!(for_legacy_kind("none").is_none());
        assert!(key_usage_for_legacy_kind("newapi").is_some());
        assert!(key_usage_for_legacy_kind("custom").is_none());
    }
}
