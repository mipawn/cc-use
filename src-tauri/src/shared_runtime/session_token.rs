pub const SESSION_TOKEN_PREFIX: &str = "session-";
pub const CODEX_SESSION_TOKEN_SETTING_KEY: &str = "codex_session_token";

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
        return Some(strip_bearer_prefix(auth));
    }

    x_api_key.map(str::trim).filter(|value| !value.is_empty())
}

fn strip_bearer_prefix(value: &str) -> &str {
    let value = value.trim();
    let Some((scheme_end, _)) = value
        .char_indices()
        .find(|(_, ch)| ch.is_ascii_whitespace())
    else {
        return value;
    };
    let (scheme, rest) = value.split_at(scheme_end);
    if scheme.eq_ignore_ascii_case("bearer") {
        rest.trim_start()
    } else {
        value
    }
}
