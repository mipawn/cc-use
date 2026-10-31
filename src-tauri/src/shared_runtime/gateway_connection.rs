//! The effective upstream connection a gateway outlet uses.
//!
//! A gateway binds one API key and adds its own connection settings on top of
//! the provider: an optional Base URL, an explicit authentication scheme and an
//! optional User-Agent. Model discovery, HTTP, SSE and the WebSocket handshake
//! all resolve through this module so they cannot disagree about which address,
//! credential, header set or User-Agent the upstream sees.
//!
//! Everything here is pure: the caller reads the provider, key and gateway row
//! out of the database and passes them in. Nothing in this module opens a
//! connection or imports `tauri`, so the daemon, the CLI and the app share the
//! same rules.

use crate::models::{ApiKey, GatewayConnectionConfig, Provider};
use crate::shared_runtime::{request_headers, user_agent};
use axum::http::header::{HeaderMap, HeaderName, HeaderValue, USER_AGENT};

/// Deliberately does not repeat the rejected value: it is a URL a person typed
/// and an error travels further than a log line.
pub const INVALID_BASE_URL: &str =
    "Gateway Base URL must be an absolute http(s) URL with a host and without credentials, query or fragment";
pub const INVALID_AUTH_SCHEME: &str =
    "Gateway authentication scheme must be bearer, x-api-key or none";
pub const INVALID_STORED_CONFIG: &str = "The stored gateway connection configuration is invalid";

/// Authentication explicitly chosen by the gateway. Never guessed from the
/// model, the path or a client-typed API key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GatewayAuthScheme {
    Bearer,
    XApiKey,
    None,
}

impl GatewayAuthScheme {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "bearer" => Some(Self::Bearer),
            "x-api-key" => Some(Self::XApiKey),
            "none" => Some(Self::None),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Bearer => "bearer",
            Self::XApiKey => "x-api-key",
            Self::None => "none",
        }
    }
}

/// Everything the request path needs from a gateway row once resolved.
///
/// Contains the bound key's credential, so it is intentionally not `Debug` and
/// is never serialized to the UI.
#[derive(Clone)]
pub struct GatewayConnection {
    pub effective_base_url: String,
    pub auth_scheme: GatewayAuthScheme,
    pub user_agent_override: Option<String>,
    /// The bound key's value; never logged or serialized.
    api_key_value: String,
    pub http_proxy: Option<String>,
}

/// Which traffic the header policy is being built for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GatewayTraffic {
    /// A request forwarded on behalf of an external client.
    Forward,
    /// An active catalogue query: there is no inbound User-Agent to prefer.
    ModelDiscovery,
}

fn normalize_optional(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// Validate and normalize a caller-supplied connection configuration.
///
/// Empty strings become "not overridden". An invalid URL or User-Agent is
/// refused here, where the editor can show the field-level error; the stored
/// provider address is only validated when the connection is actually used.
pub fn normalize_config(
    config: Option<&GatewayConnectionConfig>,
) -> Result<GatewayConnectionConfig, String> {
    let base_url = match normalize_optional(config.and_then(|value| value.base_url.as_deref())) {
        Some(base_url) => Some(validate_base_url(&base_url)?),
        None => None,
    };
    let auth_scheme = match config
        .map(|value| value.auth_scheme.trim())
        .unwrap_or("bearer")
    {
        "" => GatewayAuthScheme::Bearer,
        raw => GatewayAuthScheme::parse(raw).ok_or_else(|| INVALID_AUTH_SCHEME.to_string())?,
    };
    let user_agent = user_agent::validate(config.and_then(|value| value.user_agent.as_deref()))?;
    Ok(GatewayConnectionConfig {
        base_url,
        auth_scheme: auth_scheme.as_str().to_string(),
        user_agent,
    })
}

/// Effective connection for a gateway row: gateway override else provider
/// address, explicit gateway auth scheme, optional UA override.
pub fn resolve(
    provider: &Provider,
    api_key: &ApiKey,
    config: Option<&GatewayConnectionConfig>,
) -> Result<GatewayConnection, String> {
    let config = normalize_config(config)?;
    let raw_base_url = config
        .base_url
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(provider.base_url.as_str());
    let effective_base_url = validate_base_url(raw_base_url)?;
    let auth_scheme = GatewayAuthScheme::parse(&config.auth_scheme)
        .ok_or_else(|| INVALID_AUTH_SCHEME.to_string())?;
    Ok(GatewayConnection {
        effective_base_url,
        auth_scheme,
        user_agent_override: config.user_agent,
        api_key_value: api_key.value.clone(),
        http_proxy: provider
            .http_proxy
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
    })
}

/// Read the connection configuration stored in `gateway_connection_config`.
///
/// A real SQL `NULL` is the legacy default; a non-NULL value that is not a
/// well-formed object with an explicit `authScheme` is corrupt and reported
/// (without echoing the stored text) instead of silently downgraded.
pub fn config_from_json(raw: Option<&str>) -> Result<Option<GatewayConnectionConfig>, String> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    if raw.trim().is_empty() {
        return Err(INVALID_STORED_CONFIG.to_string());
    }
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Stored {
        #[serde(default)]
        base_url: Option<String>,
        #[serde(default)]
        auth_scheme: Option<String>,
        #[serde(default)]
        user_agent: Option<String>,
    }
    let stored: Stored =
        serde_json::from_str(raw).map_err(|_| INVALID_STORED_CONFIG.to_string())?;
    let auth_scheme = stored
        .auth_scheme
        .as_deref()
        .and_then(GatewayAuthScheme::parse)
        .ok_or_else(|| INVALID_STORED_CONFIG.to_string())?;
    Ok(Some(GatewayConnectionConfig {
        // Historical URL/User-Agent strings are kept for repair; they are
        // only validated when used or explicitly re-saved.
        base_url: normalize_optional(stored.base_url.as_deref()),
        auth_scheme: auth_scheme.as_str().to_string(),
        user_agent: normalize_optional(stored.user_agent.as_deref()),
    }))
}

pub fn config_to_json(config: &GatewayConnectionConfig) -> Result<String, String> {
    serde_json::to_string(config).map_err(|_| INVALID_STORED_CONFIG.to_string())
}

/// Validate an absolute http(s) upstream Base URL and return it without a
/// trailing slash. Path prefixes (and IPv6 literals) are allowed; embedded
/// credentials, queries and fragments are not.
pub fn validate_base_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(INVALID_BASE_URL.to_string());
    }
    let parsed = url::Url::parse(trimmed).map_err(|_| INVALID_BASE_URL.to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(INVALID_BASE_URL.to_string());
    }
    if parsed.host_str().is_none_or(str::is_empty) {
        return Err(INVALID_BASE_URL.to_string());
    }
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(INVALID_BASE_URL.to_string());
    }
    Ok(trimmed.trim_end_matches('/').to_string())
}

/// Join a request path onto the effective Base URL, merging a single `/v1`.
///
/// The gateway is reached at its own root (`/chat/completions`, `/models`),
/// while the provider address may already carry a prefix and `/v1`
/// (`/relay/v1`). The client's query string is preserved verbatim.
pub fn join_upstream_path(base_url: &str, request_path: &str) -> Result<String, String> {
    let base_url = validate_base_url(base_url)?;
    let (path, query) = request_path
        .split_once('?')
        .map_or((request_path, None), |(path, query)| (path, Some(query)));
    let mut parsed = url::Url::parse(&base_url).map_err(|_| INVALID_BASE_URL.to_string())?;
    let base_path = parsed.path().trim_end_matches('/').to_string();
    let client_path = path.trim_start_matches('/');
    let base_has_v1 = base_path == "/v1" || base_path.ends_with("/v1");
    let client_has_v1 = client_path == "v1" || client_path.starts_with("v1/");

    let relative = if client_has_v1 {
        if base_has_v1 {
            // Both carry /v1: keep exactly one.
            client_path
                .strip_prefix("v1")
                .map(str::to_string)
                .unwrap_or_default()
        } else {
            format!("/{client_path}")
        }
    } else if base_has_v1 {
        format!("/{client_path}")
    } else {
        format!("/v1/{client_path}")
    };

    let full_path = if relative.is_empty() {
        if base_path.is_empty() {
            "/".to_string()
        } else {
            base_path
        }
    } else if base_path.is_empty() {
        relative
    } else {
        format!("{base_path}{relative}")
    };
    parsed.set_path(&full_path);
    parsed.set_query(query.filter(|value| !value.is_empty()));
    Ok(parsed.to_string())
}

/// Remove hop-by-hop headers, including every field the `Connection` header
/// names dynamically. Shared by the HTTP forwarding path, the WebSocket
/// handshake and the gateway header policy.
pub fn strip_hop_by_hop_headers(headers: &mut HeaderMap) {
    let connection_headers = headers
        .get_all("connection")
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .filter_map(|value| value.parse::<HeaderName>().ok())
        .collect::<Vec<_>>();

    for name in connection_headers {
        headers.remove(name);
    }
    for name in [
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    ] {
        headers.remove(name);
    }
}

/// Inbound headers a gateway request never forwards as-is. The bound key's
/// credential replaces the local session token, and framing headers are
/// regenerated for the upstream request.
const PROTECTED_HEADERS: &[&str] = &[
    "authorization",
    "x-api-key",
    "proxy-authorization",
    "host",
    "content-length",
    "accept-encoding",
    "connection",
    "upgrade",
    "keep-alive",
    "te",
    "trailer",
    "transfer-encoding",
    "proxy-authenticate",
];

/// Provider header rules must not smuggle any of these: authentication,
/// framing or WebSocket handshake fields are generated by the proxy itself.
fn provider_rule_is_reserved(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    PROTECTED_HEADERS.contains(&name.as_str())
        || name == "content-encoding"
        || name.starts_with("sec-websocket-")
}

/// Build the complete outbound header set for a gateway request.
///
/// Order: filter the inbound request's protected/hop-by-hop headers → merge the
/// provider's additive headers (using the effective Base URL for
/// `{{baseUrl}}`) → apply the gateway's explicit authentication → apply the
/// final User-Agent (`gateway.userAgent > inbound UA > provider UA`; the app
/// default only fills an active catalogue query that has no inbound UA).
pub fn build_headers(
    inbound: Option<&HeaderMap>,
    provider: &Provider,
    connection: &GatewayConnection,
    traffic: GatewayTraffic,
    fallback_user_agent: Option<&str>,
) -> Result<HeaderMap, String> {
    let mut headers = inbound.cloned().unwrap_or_default();
    strip_hop_by_hop_headers(&mut headers);
    for name in PROTECTED_HEADERS {
        headers.remove(*name);
    }

    for (name, value) in request_headers::parse(provider.request_headers.as_deref()) {
        if provider_rule_is_reserved(&name) {
            continue;
        }
        let Ok(header_name) = name.parse::<HeaderName>() else {
            continue;
        };
        if headers.contains_key(&header_name) {
            continue;
        }
        let resolved = request_headers::resolve(&value, &connection.effective_base_url);
        if let Ok(header_value) = HeaderValue::from_str(&resolved) {
            headers.insert(header_name, header_value);
        }
    }

    apply_auth(
        &mut headers,
        &connection.api_key_value,
        connection.auth_scheme,
    )?;

    if let Some(override_agent) = connection.user_agent_override.as_deref() {
        let value = user_agent::parse(Some(override_agent))?.ok_or_else(|| {
            "User-Agent contains characters that cannot be sent in an HTTP header".to_string()
        })?;
        headers.insert(USER_AGENT, value);
    } else if traffic == GatewayTraffic::ModelDiscovery && !headers.contains_key(USER_AGENT) {
        if let Some(fallback) = fallback_user_agent {
            if let Ok(value) = HeaderValue::from_str(fallback) {
                headers.insert(USER_AGENT, value);
            }
        }
    }

    Ok(headers)
}

fn apply_auth(
    headers: &mut HeaderMap,
    key_value: &str,
    scheme: GatewayAuthScheme,
) -> Result<(), String> {
    match scheme {
        GatewayAuthScheme::Bearer => {
            let value = HeaderValue::from_str(&format!("Bearer {key_value}"))
                .map_err(|_| "API key contains invalid characters".to_string())?;
            headers.insert("authorization", value);
            headers.remove("x-api-key");
        }
        GatewayAuthScheme::XApiKey => {
            let value = HeaderValue::from_str(key_value)
                .map_err(|_| "API key contains invalid characters".to_string())?;
            headers.insert("x-api-key", value);
            headers.remove("authorization");
        }
        GatewayAuthScheme::None => {
            headers.remove("authorization");
            headers.remove("x-api-key");
        }
    }
    Ok(())
}

/// Flatten a header map into name/value pairs for clients that build their own
/// request (reqwest, tokio-tungstenite). Duplicate values are preserved.
pub fn header_pairs(headers: &HeaderMap) -> Vec<(String, String)> {
    headers
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.as_str().to_string(), value.to_string()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn provider(base_url: &str) -> Provider {
        Provider {
            request_headers: None,
            wallet_balance_script: None,
            id: "provider-1".to_string(),
            name: "Provider".to_string(),
            base_url: base_url.to_string(),
            http_proxy: None,
            website: None,
            remark: None,
            token: None,
            icon: None,
            wallet_balance_type: "none".to_string(),
            wallet_balance_url: None,
            wallet_balance_path: None,
            wallet_balance_headers: None,
            wallet_balance_user_id: None,
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

    fn api_key(value: &str) -> ApiKey {
        ApiKey {
            usage_script: None,
            id: "key-1".to_string(),
            provider_id: "provider-1".to_string(),
            alias: None,
            value: value.to_string(),
            types: vec!["claude_code".to_string()],
            priority: 0,
            is_exhausted: false,
            is_active: true,
            config: None,
            usage_type: "none".to_string(),
            usage_url: None,
            usage_path: None,
            usage_headers: None,
            cached_usage: None,
            last_usage_checked_at: None,
            model_mapping: None,
            client_configs: None,
        }
    }

    fn config(base_url: Option<&str>, scheme: &str, ua: Option<&str>) -> GatewayConnectionConfig {
        GatewayConnectionConfig {
            base_url: base_url.map(str::to_string),
            auth_scheme: scheme.to_string(),
            user_agent: ua.map(str::to_string),
        }
    }

    #[test]
    fn gateway_override_wins_over_the_provider_address() {
        let provider = provider("https://provider.example.com");
        let key = api_key("sk-real");
        let resolved = resolve(
            &provider,
            &key,
            Some(&config(
                Some("https://gateway.example.com/relay"),
                "x-api-key",
                None,
            )),
        )
        .expect("resolve");
        assert_eq!(
            resolved.effective_base_url,
            "https://gateway.example.com/relay"
        );
        assert_eq!(resolved.auth_scheme, GatewayAuthScheme::XApiKey);
        assert!(resolved.user_agent_override.is_none());
    }

    #[test]
    fn empty_override_falls_back_to_the_provider_address() {
        let provider = provider("https://provider.example.com/v1");
        let key = api_key("sk-real");
        let resolved = resolve(
            &provider,
            &key,
            Some(&config(Some("  "), "bearer", Some(""))),
        )
        .expect("resolve");
        assert_eq!(
            resolved.effective_base_url,
            "https://provider.example.com/v1"
        );
        assert_eq!(resolved.auth_scheme, GatewayAuthScheme::Bearer);
        assert!(resolved.user_agent_override.is_none());
    }

    #[test]
    fn location_credentials_and_queries_are_rejected_without_echoing_the_url() {
        for raw in [
            "ftp://example.com",
            "https://user:secret@example.com",
            "https://example.com/v1?token=secret",
            "https://example.com/v1#frag",
            "not a url",
            "https://",
        ] {
            let error = validate_base_url(raw).unwrap_err();
            assert!(
                !error.contains("secret"),
                "error must not echo the URL: {error}"
            );
        }
    }

    #[test]
    fn path_joining_merges_a_single_v1() {
        let cases = [
            (
                "https://example.com",
                "/models",
                "https://example.com/v1/models",
            ),
            (
                "https://example.com/",
                "/v1/models",
                "https://example.com/v1/models",
            ),
            (
                "https://example.com/v1",
                "/responses",
                "https://example.com/v1/responses",
            ),
            (
                "https://example.com/v1",
                "/v1/responses",
                "https://example.com/v1/responses",
            ),
            (
                "https://example.com/relay",
                "/chat/completions",
                "https://example.com/relay/v1/chat/completions",
            ),
            (
                "https://example.com/relay/v1",
                "/v1/chat/completions?x=1",
                "https://example.com/relay/v1/chat/completions?x=1",
            ),
            (
                "http://[::1]:8080/v1",
                "/models",
                "http://[::1]:8080/v1/models",
            ),
        ];
        for (base, path, expected) in cases {
            assert_eq!(
                join_upstream_path(base, path).expect("join"),
                expected,
                "base={base} path={path}"
            );
        }
    }

    #[test]
    fn auth_application_keeps_only_one_credential_header() {
        let provider = provider("https://example.com");
        let mut inbound = HeaderMap::new();
        inbound.insert(
            "authorization",
            HeaderValue::from_static("Bearer session-local"),
        );
        inbound.insert("x-api-key", HeaderValue::from_static("sk-inbound"));

        let bearer = GatewayConnection {
            effective_base_url: "https://example.com".to_string(),
            auth_scheme: GatewayAuthScheme::Bearer,
            user_agent_override: None,
            api_key_value: "sk-real".to_string(),
            http_proxy: None,
        };
        let headers = build_headers(
            Some(&inbound),
            &provider,
            &bearer,
            GatewayTraffic::Forward,
            None,
        )
        .unwrap();
        assert_eq!(
            headers.get("authorization").and_then(|v| v.to_str().ok()),
            Some("Bearer sk-real")
        );
        assert!(headers.get("x-api-key").is_none());

        let x_api_key = GatewayConnection {
            effective_base_url: "https://example.com".to_string(),
            auth_scheme: GatewayAuthScheme::XApiKey,
            user_agent_override: None,
            api_key_value: "sk-real".to_string(),
            http_proxy: None,
        };
        let headers = build_headers(
            Some(&inbound),
            &provider,
            &x_api_key,
            GatewayTraffic::Forward,
            None,
        )
        .unwrap();
        assert_eq!(
            headers.get("x-api-key").and_then(|v| v.to_str().ok()),
            Some("sk-real")
        );
        assert!(headers.get("authorization").is_none());

        let none = GatewayConnection {
            effective_base_url: "https://example.com".to_string(),
            auth_scheme: GatewayAuthScheme::None,
            user_agent_override: None,
            api_key_value: "sk-real".to_string(),
            http_proxy: None,
        };
        let headers = build_headers(
            Some(&inbound),
            &provider,
            &none,
            GatewayTraffic::Forward,
            None,
        )
        .unwrap();
        assert!(headers.get("authorization").is_none());
        assert!(headers.get("x-api-key").is_none());
    }

    #[test]
    fn user_agent_priority_gateway_then_inbound_then_provider_then_default() {
        let mut provider = provider("https://example.com");
        provider.request_headers = Some(r#"{"User-Agent":"provider-agent/1.0"}"#.to_string());

        let with_override = GatewayConnection {
            effective_base_url: "https://example.com".to_string(),
            auth_scheme: GatewayAuthScheme::Bearer,
            user_agent_override: Some("gateway-agent/9".to_string()),
            api_key_value: "sk-real".to_string(),
            http_proxy: None,
        };
        let mut inbound = HeaderMap::new();
        inbound.insert(USER_AGENT, HeaderValue::from_static("client-agent/2"));
        let headers = build_headers(
            Some(&inbound),
            &provider,
            &with_override,
            GatewayTraffic::Forward,
            None,
        )
        .unwrap();
        assert_eq!(
            headers.get(USER_AGENT).and_then(|v| v.to_str().ok()),
            Some("gateway-agent/9")
        );

        let no_override = GatewayConnection {
            effective_base_url: "https://example.com".to_string(),
            auth_scheme: GatewayAuthScheme::Bearer,
            user_agent_override: None,
            api_key_value: "sk-real".to_string(),
            http_proxy: None,
        };
        let headers = build_headers(
            Some(&inbound),
            &provider,
            &no_override,
            GatewayTraffic::Forward,
            None,
        )
        .unwrap();
        assert_eq!(
            headers.get(USER_AGENT).and_then(|v| v.to_str().ok()),
            Some("client-agent/2")
        );

        let headers = build_headers(
            None,
            &provider,
            &no_override,
            GatewayTraffic::ModelDiscovery,
            Some("cc-use/3.x"),
        )
        .unwrap();
        assert_eq!(
            headers.get(USER_AGENT).and_then(|v| v.to_str().ok()),
            Some("provider-agent/1.0"),
            "provider UA fills an active discovery with no inbound value"
        );

        provider.request_headers = None;
        let headers = build_headers(
            None,
            &provider,
            &no_override,
            GatewayTraffic::ModelDiscovery,
            Some("cc-use/3.x"),
        )
        .unwrap();
        assert_eq!(
            headers.get(USER_AGENT).and_then(|v| v.to_str().ok()),
            Some("cc-use/3.x")
        );

        // Plain forwarding never forces the app's catalogue User-Agent.
        let headers =
            build_headers(None, &provider, &no_override, GatewayTraffic::Forward, None).unwrap();
        assert!(headers.get(USER_AGENT).is_none());
    }

    #[test]
    fn provider_headers_are_additive_and_replace_the_base_url_template() {
        let mut provider = provider("https://provider.example.com/v1");
        provider.request_headers = Some(
            r#"{"X-Relay":"origin={{baseUrl}}","Authorization":"Bearer provider-secret","Upgrade":"h2c","Sec-WebSocket-Key":"injected"}"#
                .to_string(),
        );
        let connection = GatewayConnection {
            effective_base_url: "https://gateway.example.com/relay".to_string(),
            auth_scheme: GatewayAuthScheme::Bearer,
            user_agent_override: None,
            api_key_value: "sk-real".to_string(),
            http_proxy: None,
        };
        let mut inbound = HeaderMap::new();
        inbound.insert("x-relay", HeaderValue::from_static("client-value"));
        let headers = build_headers(
            Some(&inbound),
            &provider,
            &connection,
            GatewayTraffic::Forward,
            None,
        )
        .unwrap();
        assert_eq!(
            headers.get("x-relay").and_then(|v| v.to_str().ok()),
            Some("client-value"),
            "inbound value wins over the provider rule"
        );
        assert_eq!(
            headers.get("authorization").and_then(|v| v.to_str().ok()),
            Some("Bearer sk-real")
        );
        assert!(headers.get("upgrade").is_none());
        assert!(headers.get("sec-websocket-key").is_none());
    }

    #[test]
    fn connection_declared_hop_by_hop_headers_are_dropped() {
        let provider = provider("https://example.com");
        let connection = GatewayConnection {
            effective_base_url: "https://example.com".to_string(),
            auth_scheme: GatewayAuthScheme::None,
            user_agent_override: None,
            api_key_value: "sk-real".to_string(),
            http_proxy: None,
        };
        let mut inbound = HeaderMap::new();
        inbound.insert("connection", HeaderValue::from_static("x-hop, keep-alive"));
        inbound.insert("x-hop", HeaderValue::from_static("drop-me"));
        inbound.insert("connection-keep", HeaderValue::from_static("keep-me"));
        let headers = build_headers(
            Some(&inbound),
            &provider,
            &connection,
            GatewayTraffic::Forward,
            None,
        )
        .unwrap();
        assert!(headers.get("x-hop").is_none());
        assert!(headers.get("connection").is_none());
    }

    #[test]
    fn stored_config_reads_back_and_rejects_corrupt_json_safely() {
        let parsed = config_from_json(Some(
            r#"{"baseUrl":"https://gateway.example.com","authScheme":"x-api-key","userAgent":"agent/1"}"#,
        ))
        .unwrap()
        .expect("stored config");
        assert_eq!(
            parsed.base_url.as_deref(),
            Some("https://gateway.example.com")
        );
        assert_eq!(parsed.auth_scheme, "x-api-key");
        assert_eq!(parsed.user_agent.as_deref(), Some("agent/1"));

        assert!(config_from_json(None).unwrap().is_none());
        let error = config_from_json(Some(r#"{"baseUrl":"SECRET-RAW"#)).unwrap_err();
        assert!(
            !error.contains("SECRET-RAW"),
            "error must not echo raw JSON"
        );
        let error = config_from_json(Some(r#"{"baseUrl":"x"}"#)).unwrap_err();
        assert!(error.contains("invalid"));
    }

    #[test]
    fn draft_config_validation_accepts_defaults_and_rejects_bad_fields() {
        let defaults = normalize_config(None).unwrap();
        assert_eq!(defaults.auth_scheme, "bearer");
        assert!(defaults.base_url.is_none());

        let normalized = normalize_config(Some(&config(
            Some("  https://example.com/relay/  "),
            "X-API-KEY",
            Some("  agent/1  "),
        )))
        .unwrap();
        assert_eq!(
            normalized.base_url.as_deref(),
            Some("https://example.com/relay")
        );
        assert_eq!(normalized.auth_scheme, "x-api-key");
        assert_eq!(normalized.user_agent.as_deref(), Some("agent/1"));

        assert!(normalize_config(Some(&config(Some("nope"), "bearer", None))).is_err());
        assert!(normalize_config(Some(&config(None, "basic", None))).is_err());
        let ua_error =
            normalize_config(Some(&config(None, "bearer", Some("bad\nagent")))).unwrap_err();
        assert!(
            !ua_error.contains("bad"),
            "error must not echo the User-Agent"
        );
    }

    #[test]
    fn stored_json_round_trips_through_the_dto() {
        let raw = config_to_json(&GatewayConnectionConfig {
            base_url: Some("https://gateway.example.com".to_string()),
            auth_scheme: "bearer".to_string(),
            user_agent: None,
        })
        .unwrap();
        assert_eq!(
            raw,
            r#"{"baseUrl":"https://gateway.example.com","authScheme":"bearer","userAgent":null}"#
        );
        let parsed = config_from_json(Some(&raw)).unwrap().expect("config");
        assert_eq!(parsed.auth_scheme, "bearer");
    }

    #[test]
    fn api_keys_that_cannot_travel_are_rejected_without_echoing_them() {
        let provider = provider("https://example.com");
        let connection = GatewayConnection {
            effective_base_url: "https://example.com".to_string(),
            auth_scheme: GatewayAuthScheme::Bearer,
            user_agent_override: None,
            api_key_value: "sk-real\r\nx-injected: 1".to_string(),
            http_proxy: None,
        };
        let error =
            build_headers(None, &provider, &connection, GatewayTraffic::Forward, None).unwrap_err();
        assert!(!error.contains("injected"));
    }
}
