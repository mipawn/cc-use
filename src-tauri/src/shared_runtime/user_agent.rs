//! The User-Agent a request carries to the upstream.
//!
//! Two paths let a person name it: the model-list query a key runs, and the
//! inference traffic that key forwards. Both read and write through the
//! functions here, so a value that saves on one path behaves the same on the
//! other and neither can drift into its own validation.
//!
//! Overwriting is deliberate, and it is the opposite of the rule
//! [`crate::shared_runtime::request_headers`] follows. A provider header is a
//! default — it never replaces what the client sent. A chosen UA is not a
//! default: naming one is a request to speak as that client even when the
//! caller is a real CLI, so it replaces whatever arrived.

use axum::http::{header::USER_AGENT, HeaderMap, HeaderValue};

/// Why a value was refused. Names the field and never repeats the value: it is
/// a string a person typed, and an error travels further than a log line.
const INVALID: &str = "User-Agent contains characters that cannot be sent in an HTTP header";

/// Read a UA that is about to be saved or sent on a query.
///
/// Blank means "not specified" rather than an error: the field is optional,
/// and clearing it is how a choice is undone. A value that cannot travel as a
/// header is refused here — where someone is waiting to be told — instead of
/// being dropped silently later at the point it was supposed to matter.
///
/// Returns the trimmed string. A caller that wants a header value builds one
/// from this; this is the single place the rule and its message live.
pub fn validate(raw: Option<&str>) -> Result<Option<String>, String> {
    let Some(raw) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };

    HeaderValue::from_str(raw)
        .map(|_| Some(raw.to_string()))
        .map_err(|_| INVALID.to_string())
}

/// The same read as a header value, for a caller that is about to send it.
pub fn parse(raw: Option<&str>) -> Result<Option<HeaderValue>, String> {
    match validate(raw)? {
        Some(value) => HeaderValue::from_str(&value)
            .map(Some)
            .map_err(|_| INVALID.to_string()),
        None => Ok(None),
    }
}

/// The same read, for a value that is already in storage.
///
/// A stored value can predate validation, so an unusable one is reported and
/// skipped rather than failing the request it was meant to help. The
/// diagnostic names the field and never the value: this is a string a person
/// typed, and a log is not the place to repeat it back.
pub fn parse_stored(raw: Option<&str>, context: &str) -> Option<HeaderValue> {
    match parse(raw) {
        Ok(value) => value,
        Err(_) => {
            log::warn!("{context}: the stored User-Agent is not a usable header value; ignored");
            None
        }
    }
}

/// Overwrite the outgoing UA.
///
/// `insert` drops every value the client sent, so the upstream sees exactly
/// one User-Agent — the chosen one. Appending would leave the client's own
/// value in place beside it and let the upstream pick.
pub fn apply(headers: &mut HeaderMap, value: &HeaderValue) {
    headers.insert(USER_AGENT, value.clone());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ua(headers: &HeaderMap) -> Option<&str> {
        headers
            .get(USER_AGENT)
            .and_then(|value| value.to_str().ok())
    }

    #[test]
    fn a_blank_value_means_not_specified() {
        assert!(parse(None).unwrap().is_none());
        assert!(parse(Some("")).unwrap().is_none());
        assert!(parse(Some("   ")).unwrap().is_none());
    }

    #[test]
    fn an_ordinary_ua_reads_back() {
        let parsed = parse(Some("  claude-cli/2.1.161 (external, cli)  ")).unwrap();

        assert_eq!(
            parsed.and_then(|value| value.to_str().ok().map(str::to_string)),
            Some("claude-cli/2.1.161 (external, cli)".to_string())
        );
    }

    #[test]
    fn a_value_that_cannot_travel_is_refused_with_a_message() {
        // A newline would split the header; the caller has to hear about it.
        let error = parse(Some("claude-cli/2.1\r\nX-Injected: 1")).unwrap_err();

        assert!(error.contains("User-Agent"));
        assert!(
            !error.contains("X-Injected"),
            "the message must not echo the value back"
        );
    }

    #[test]
    fn a_stored_value_that_cannot_travel_is_ignored_rather_than_fatal() {
        assert!(parse_stored(Some("bad\nvalue"), "provider p1").is_none());
        assert!(parse_stored(Some("codex_cli_rs/0.101.0"), "provider p1").is_some());
    }

    #[test]
    fn applying_replaces_every_value_the_client_sent() {
        let mut headers = HeaderMap::new();
        headers.append(USER_AGENT, HeaderValue::from_static("curl/8.0"));
        headers.append(USER_AGENT, HeaderValue::from_static("second/1.0"));

        apply(&mut headers, &HeaderValue::from_static("claude-cli/9.9.9"));

        assert_eq!(ua(&headers), Some("claude-cli/9.9.9"));
        assert_eq!(headers.get_all(USER_AGENT).iter().count(), 1);
    }

    #[test]
    fn applying_sets_a_ua_that_was_absent() {
        let mut headers = HeaderMap::new();

        apply(
            &mut headers,
            &HeaderValue::from_static("codex_cli_rs/9.9.9"),
        );

        assert_eq!(ua(&headers), Some("codex_cli_rs/9.9.9"));
    }
}
