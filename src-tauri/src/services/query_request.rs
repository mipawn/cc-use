//! Shared handling for the balance and quota requests.
//!
//! The request a provider sends is stored configuration, not a constant: the
//! settings dialog shows it and lets it be edited, so what it shows has to be
//! what goes out. The *parse rule* is a separate fact and stays in each fetch
//! function — the same request body can be read as New API quota, as a DeepSeek
//! balance object, or as a bare number.

use crate::models::{ApiKey, Provider};

/// The values a stored URL or header may reference.
///
/// Owned rather than borrowed: these are assembled per query, several are
/// trimmed or defaulted on the way in, and the cost of a few small strings is
/// nothing next to the request they are about to describe.
pub(super) struct QueryVars {
    pub base_url: String,
    pub key: Option<String>,
    pub token: Option<String>,
    pub user_id: Option<String>,
}

impl QueryVars {
    /// Variables available to a provider-level query. `key` is the inference
    /// credential the query borrows, when one is picked.
    pub(super) fn for_provider(provider: &Provider, key: Option<&str>) -> Self {
        Self {
            base_url: provider.base_url.trim_end_matches('/').to_string(),
            key: non_empty(key).map(str::to_string),
            token: non_empty(provider.token.as_deref()).map(str::to_string),
            user_id: non_empty(provider.wallet_balance_user_id.as_deref()).map(str::to_string),
        }
    }

    /// Variables available to a per-key query: the key's own credential is the
    /// one being asked about, so `{key}` is that value rather than a borrowed one.
    pub(super) fn for_key(key: &ApiKey, provider: &Provider) -> Self {
        Self {
            base_url: provider.base_url.trim_end_matches('/').to_string(),
            key: non_empty(Some(key.value.as_str())).map(str::to_string),
            token: non_empty(provider.token.as_deref()).map(str::to_string),
            user_id: non_empty(provider.wallet_balance_user_id.as_deref()).map(str::to_string),
        }
    }
}

/// Replace `{name}` placeholders.
///
/// A placeholder with no value is left as written. Dropping it would send a
/// request with a silently empty credential, which reads as an auth failure
/// rather than the misconfiguration it is.
pub(super) fn substitute(raw: &str, vars: &QueryVars) -> String {
    let mut resolved = raw.replace("{baseUrl}", &vars.base_url);
    if let Some(key) = &vars.key {
        resolved = resolved.replace("{key}", key);
    }
    if let Some(token) = &vars.token {
        resolved = resolved.replace("{token}", token);
    }
    if let Some(user_id) = &vars.user_id {
        resolved = resolved.replace("{userId}", user_id);
    }
    resolved
}

/// The stored value when one is set, otherwise the built-in default.
pub(super) fn stored_or<'a>(stored: Option<&'a str>, fallback: &'a str) -> &'a str {
    non_empty(stored).unwrap_or(fallback)
}

/// Whether the user supplied their own URL for this query.
///
/// Worth knowing apart from the resolved value: a provider with a hand-written
/// address must not be silently redirected to a vendor default when the first
/// attempt fails.
pub(super) fn has_stored(stored: Option<&str>) -> bool {
    non_empty(stored).is_some()
}

/// The header object for a query: the stored one when set, otherwise the
/// built-in default, with placeholders substituted in either case.
pub(super) fn resolve_headers(
    stored: Option<&str>,
    default_json: &str,
    vars: &QueryVars,
) -> Result<Vec<(String, String)>, String> {
    let raw = match non_empty(stored) {
        Some(value) => value,
        None => default_json,
    };
    parse_headers(&substitute(raw, vars))
}

pub(super) fn parse_headers(raw: &str) -> Result<Vec<(String, String)>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    let value: serde_json::Value =
        serde_json::from_str(trimmed).map_err(|_| "Invalid headers JSON format".to_string())?;
    let obj = value
        .as_object()
        .ok_or_else(|| "Invalid headers JSON format".to_string())?;

    Ok(obj
        .iter()
        .filter_map(|(k, v)| v.as_str().map(|vv| (k.clone(), vv.to_string())))
        .collect())
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider() -> Provider {
        Provider {
            id: "p1".to_string(),
            name: "relay".to_string(),
            base_url: "https://relay.example.com/".to_string(),
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
        }
    }

    #[test]
    fn every_documented_placeholder_is_replaced() {
        let provider = provider();
        let vars = QueryVars::for_provider(&provider, Some("sk-live"));

        assert_eq!(
            substitute("{baseUrl}/api/user/self", &vars),
            "https://relay.example.com/api/user/self"
        );
        assert_eq!(
            substitute("Authorization: Bearer {key}", &vars),
            "Authorization: Bearer sk-live"
        );
        assert_eq!(
            substitute("Authorization: {token}", &vars),
            "Authorization: tok-1"
        );
        assert_eq!(
            substitute("New-Api-User: {userId}", &vars),
            "New-Api-User: uid-7"
        );
    }

    /// An unresolved placeholder stays visible in the request instead of
    /// becoming an empty string that reads as a bad credential.
    #[test]
    fn an_unknown_placeholder_is_left_alone() {
        let provider = provider();
        let vars = QueryVars::for_provider(&provider, None);

        assert_eq!(substitute("X-Key: {key}", &vars), "X-Key: {key}");
        assert_eq!(substitute("X-Other: {nope}", &vars), "X-Other: {nope}");
    }

    #[test]
    fn a_stored_value_wins_over_the_default() {
        assert_eq!(
            stored_or(Some("https://mine.example.com"), "https://default"),
            "https://mine.example.com"
        );
        assert_eq!(stored_or(Some("   "), "https://default"), "https://default");
        assert_eq!(stored_or(None, "https://default"), "https://default");
    }

    #[test]
    fn a_supplied_address_is_recognised_as_the_users_own() {
        assert!(has_stored(Some("https://mine.example.com")));
        assert!(!has_stored(Some("  ")));
        assert!(!has_stored(None));
    }

    /// The built-in default is what the settings dialog shows and what
    /// `恢复默认` restores, so it has to resolve like any other header object.
    #[test]
    fn the_built_in_headers_are_used_when_none_are_stored() {
        let provider = provider();
        let vars = QueryVars::for_provider(&provider, Some("sk-live"));

        let headers = resolve_headers(
            None,
            r#"{"Authorization": "{token}", "New-Api-User": "{userId}"}"#,
            &vars,
        )
        .expect("default headers parse");

        assert_eq!(
            headers,
            vec![
                ("Authorization".to_string(), "tok-1".to_string()),
                ("New-Api-User".to_string(), "uid-7".to_string()),
            ]
        );
    }

    #[test]
    fn a_stored_header_object_replaces_the_default_outright() {
        let provider = provider();
        let vars = QueryVars::for_provider(&provider, Some("sk-live"));

        let headers = resolve_headers(
            Some(r#"{"X-Only": "{key}"}"#),
            r#"{"Authorization": "{token}"}"#,
            &vars,
        )
        .expect("stored headers parse");

        assert_eq!(headers, vec![("X-Only".to_string(), "sk-live".to_string())]);
    }

    #[test]
    fn unreadable_stored_headers_are_reported_rather_than_ignored() {
        let provider = provider();
        let vars = QueryVars::for_provider(&provider, None);

        assert!(resolve_headers(Some("not json"), "{}", &vars).is_err());
    }
}
