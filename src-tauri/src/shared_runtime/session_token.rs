pub const SESSION_TOKEN_PREFIX: &str = "session-";

pub fn new_session_token() -> String {
    format!("{}{}", SESSION_TOKEN_PREFIX, nanoid::nanoid!(16))
}

pub fn is_session_token(token: &str) -> bool {
    token.starts_with(SESSION_TOKEN_PREFIX)
}

pub fn extract_session_token<'a>(
    authorization: Option<&'a str>,
    x_api_key: Option<&'a str>,
) -> Option<&'a str> {
    if let Some(auth) = authorization.filter(|value| !value.is_empty()) {
        return Some(auth.strip_prefix("Bearer ").unwrap_or(auth));
    }

    x_api_key.filter(|value| !value.is_empty())
}
