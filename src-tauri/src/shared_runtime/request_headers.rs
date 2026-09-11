//! Extra headers a provider's inference traffic carries.
//!
//! A relay that wants its own marker, a gateway that wants an organisation id:
//! configuration the client does not send and the proxy has no reason to know.
//! Stored as a JSON object of name to value, with `{{baseUrl}}` available for a
//! value that has to name the provider's own address.
//!
//! Additive only. A header the client already sent is left exactly as sent, so
//! a provider can supply a default without overriding the caller's choice —
//! the same rule the request adapter follows for its session header.

use std::collections::BTreeMap;

/// Read the stored rules. A malformed value yields nothing, so a bad entry
/// cannot take the request down with it.
pub fn parse(raw: Option<&str>) -> BTreeMap<String, String> {
    let Some(raw) = raw.map(str::trim).filter(|raw| !raw.is_empty()) else {
        return BTreeMap::new();
    };

    match serde_json::from_str::<serde_json::Value>(raw) {
        Ok(serde_json::Value::Object(entries)) => entries
            .into_iter()
            .filter_map(|(name, value)| {
                let name = name.trim().to_string();
                if name.is_empty() {
                    return None;
                }
                // A non-string value is stringified rather than dropped: a
                // number is a legitimate header value and the user meant it.
                let value = match value {
                    serde_json::Value::String(text) => text,
                    other => other.to_string(),
                };
                Some((name, value))
            })
            .collect(),
        _ => BTreeMap::new(),
    }
}

/// Substitute `{{baseUrl}}` in a header value.
///
/// An unrecognised placeholder is left as written: a header that visibly says
/// `{{apiKey}}` is a better clue than one that silently went out empty.
pub fn resolve(value: &str, base_url: &str) -> String {
    value.replace("{{baseUrl}}", base_url.trim_end_matches('/'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stored_object_reads_back_as_rules() {
        let rules = parse(Some(r#"{"X-Relay": "cc-use", "X-Tenant": "acme"}"#));

        assert_eq!(rules.get("X-Relay").map(String::as_str), Some("cc-use"));
        assert_eq!(rules.get("X-Tenant").map(String::as_str), Some("acme"));
    }

    #[test]
    fn nothing_stored_means_no_rules() {
        assert!(parse(None).is_empty());
        assert!(parse(Some("   ")).is_empty());
        assert!(parse(Some("not json")).is_empty());
        assert!(parse(Some("[1, 2]")).is_empty());
    }

    #[test]
    fn a_value_that_is_not_a_string_is_still_carried() {
        let rules = parse(Some(r#"{"X-Retries": 3, "X-Flag": true}"#));

        assert_eq!(rules.get("X-Retries").map(String::as_str), Some("3"));
        assert_eq!(rules.get("X-Flag").map(String::as_str), Some("true"));
    }

    #[test]
    fn a_nameless_rule_is_dropped_rather_than_sent() {
        let rules = parse(Some(r#"{"  ": "x", "X-Ok": "y"}"#));

        assert_eq!(rules.len(), 1);
        assert!(rules.contains_key("X-Ok"));
    }

    #[test]
    fn the_provider_address_can_be_named_in_a_value() {
        assert_eq!(
            resolve("origin={{baseUrl}}", "https://relay.example.com/"),
            "origin=https://relay.example.com"
        );
    }

    /// A placeholder with no value stays visible instead of going out empty.
    #[test]
    fn an_unknown_placeholder_is_left_alone() {
        assert_eq!(resolve("k={{apiKey}}", "https://x"), "k={{apiKey}}");
    }
}
