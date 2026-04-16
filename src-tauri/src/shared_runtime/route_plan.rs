use super::session_token::{extract_session_token, is_session_token};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RequestAuth {
    SessionToken(String),
    ProviderCredential,
    Missing,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RoutePlan {
    ExplicitSession { session_token: String },
    PassThrough,
    RejectMissingAuth,
}

pub fn classify_request_auth(authorization: Option<&str>, x_api_key: Option<&str>) -> RequestAuth {
    let authorization = authorization.filter(|value| !value.is_empty());
    let x_api_key = x_api_key.filter(|value| !value.is_empty());

    match extract_session_token(authorization, x_api_key) {
        Some(token) if is_session_token(token) => RequestAuth::SessionToken(token.to_string()),
        Some(_) => RequestAuth::ProviderCredential,
        None => RequestAuth::Missing,
    }
}

pub fn decide_route_plan(auth: &RequestAuth) -> RoutePlan {
    match auth {
        RequestAuth::SessionToken(session_token) => RoutePlan::ExplicitSession {
            session_token: session_token.clone(),
        },
        RequestAuth::ProviderCredential => RoutePlan::PassThrough,
        RequestAuth::Missing => RoutePlan::RejectMissingAuth,
    }
}
