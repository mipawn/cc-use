use cc_use_lib::shared_runtime::{
    extract_session_token, is_session_token, new_session_token, SESSION_TOKEN_PREFIX,
};

#[test]
fn new_session_token_uses_session_prefix() {
    let token = new_session_token();

    assert!(token.starts_with(SESSION_TOKEN_PREFIX));
    assert!(token.len() > SESSION_TOKEN_PREFIX.len());
}

#[test]
fn is_session_token_accepts_prefixed_token() {
    assert!(is_session_token("session-abc123"));
}

#[test]
fn is_session_token_rejects_non_prefixed_token() {
    assert!(!is_session_token("sk-live-token"));
    assert!(!is_session_token("preview-session-token"));
    assert!(!is_session_token(""));
}

#[test]
fn extract_session_token_prefers_authorization_over_x_api_key() {
    let token = extract_session_token(
        Some("Bearer session-from-auth"),
        Some("session-from-x-api-key"),
    );

    assert_eq!(token, Some("session-from-auth"));
}

#[test]
fn extract_session_token_strips_exact_bearer_prefix_only() {
    assert_eq!(
        extract_session_token(Some("Bearer session-abc"), None),
        Some("session-abc")
    );
    assert_eq!(
        extract_session_token(Some("bearer session-abc"), None),
        Some("bearer session-abc")
    );
}

#[test]
fn extract_session_token_returns_none_for_missing_or_empty_values() {
    assert_eq!(extract_session_token(None, None), None);
    assert_eq!(extract_session_token(Some(""), None), None);
    assert_eq!(extract_session_token(None, Some("")), None);
    assert_eq!(
        extract_session_token(None, Some("session-from-x-api-key")),
        Some("session-from-x-api-key")
    );
}
