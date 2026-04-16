use cc_use_lib::shared_runtime::{
    classify_request_auth, decide_route_plan, infer_upstream_family_from_path, RequestAuth,
    RoutePlan, UpstreamFamily,
};

#[test]
fn infer_upstream_family_from_supported_prefixes() {
    assert_eq!(
        infer_upstream_family_from_path("/claude/v1/messages"),
        Some(UpstreamFamily::Anthropic)
    );
    assert_eq!(
        infer_upstream_family_from_path("/openai/v1/chat/completions"),
        Some(UpstreamFamily::OpenAi)
    );
    assert_eq!(infer_upstream_family_from_path("/unknown"), None);
}

#[test]
fn classify_request_auth_distinguishes_session_provider_and_missing() {
    assert_eq!(
        classify_request_auth(Some("Bearer session-abc"), None),
        RequestAuth::SessionToken("session-abc".to_string())
    );
    assert_eq!(
        classify_request_auth(Some("Bearer sk-live"), None),
        RequestAuth::ProviderCredential
    );
    assert_eq!(
        classify_request_auth(None, Some("sk-x-api-key")),
        RequestAuth::ProviderCredential
    );
    assert_eq!(classify_request_auth(None, None), RequestAuth::Missing);
}

#[test]
fn decide_route_plan_maps_auth_types_correctly() {
    assert_eq!(
        decide_route_plan(&RequestAuth::SessionToken("session-abc".to_string())),
        RoutePlan::ExplicitSession {
            session_token: "session-abc".to_string()
        }
    );
    assert_eq!(
        decide_route_plan(&RequestAuth::ProviderCredential),
        RoutePlan::PassThrough
    );
    assert_eq!(
        decide_route_plan(&RequestAuth::Missing),
        RoutePlan::RejectMissingAuth
    );
}
