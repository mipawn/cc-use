use crate::db::Database;
use crate::models::{ApiKey, Provider, ProxySession, RequestLog};
use crate::proxy::console::ConsoleEvent;
use crate::proxy::usage_parser;
use crate::proxy::ProxyState;
use crate::services::cost_calculator;
use crate::shared_runtime::{
    classify_request_auth, decide_route_plan, infer_upstream_family_from_path, RequestAuth,
    RoutePlan, UpstreamFamily,
};

use axum::{
    body::Body,
    extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade},
    extract::FromRequestParts,
    extract::State as AxumState,
    http::{HeaderValue, Request, Response, StatusCode},
    response::IntoResponse,
};
use futures::{SinkExt, Stream, StreamExt};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

struct RouteExecution {
    upstream_url: String,
    real_api_key: Option<String>,
    model_mapping: Option<String>,
    log_ctx: Option<ResolvedSessionContext>,
    provider: Option<Provider>,
    cli_type: Option<String>,
}

#[derive(Clone)]
struct ResolvedSessionContext {
    session_token: String,
    provider_id: String,
    api_key_id: String,
    project_id: Option<String>,
    cost_multiplier: f64,
    // Snapshot names
    key_alias: Option<String>,
    provider_name: Option<String>,
    project_name: Option<String>,
}

/// Bundles everything each exit point needs to emit a `ConsoleEvent`.
/// Grouped so handler / build_route_execution / resolve_session_resources
/// can share the same reject / upstream_error / ok emitters without dragging
/// 4 extra parameters through every helper signature.
struct EmitCtx<'a> {
    state: &'a ProxyState,
    method: &'a str,
    path: &'a str,
    start_time: std::time::Instant,
}

impl<'a> EmitCtx<'a> {
    fn elapsed_ms(&self) -> u64 {
        self.start_time.elapsed().as_millis() as u64
    }

    fn reject(&self, reason: &str) {
        self.state.emit_console(ConsoleEvent::rejected(
            self.method,
            self.path,
            self.elapsed_ms(),
            reason,
        ));
    }

    fn upstream_error(
        &self,
        upstream: &str,
        provider: Option<&str>,
        key_alias: Option<&str>,
        error: &str,
    ) {
        self.state.emit_console(ConsoleEvent::upstream_error(
            self.method,
            self.path,
            self.elapsed_ms(),
            upstream,
            provider,
            key_alias,
            error,
        ));
    }

    fn ok(
        &self,
        status: u16,
        upstream: &str,
        provider: Option<&str>,
        key_alias: Option<&str>,
        is_streaming: bool,
    ) {
        self.state.emit_console(ConsoleEvent::ok(
            self.method,
            self.path,
            status,
            self.elapsed_ms(),
            upstream,
            provider,
            key_alias,
            is_streaming,
        ));
    }

    fn ws_upgraded(&self, upstream: &str, provider: Option<&str>, key_alias: Option<&str>) {
        self.state.emit_console(ConsoleEvent::ws_upgraded(
            self.path,
            self.elapsed_ms(),
            upstream,
            provider,
            key_alias,
        ));
    }
}

/// Main proxy handler — forwards HTTP requests and WebSocket connections to the upstream provider
pub async fn proxy_handler(
    AxumState(state): AxumState<Arc<ProxyState>>,
    req: Request<Body>,
) -> Result<Response<Body>, Response<Body>> {
    state
        .request_count
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let start_time = std::time::Instant::now();

    let method_str = req.method().as_str().to_string();

    let auth_header = req
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let x_api_key = req
        .headers()
        .get("x-api-key")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let req_path = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| "/".to_string());
    // NB: path-based family inference only matters for PassThrough (i.e.
    // when we're forwarding to official anthropic/openai on the user's
    // behalf). Session-routed requests carry their provider via the
    // session token, so we must not reject them here just because the
    // CLI uses the vanilla `/v1/messages` path (without any /claude or
    // /openai/v1 prefix). Defer the inference to the PassThrough branch.
    let request_auth = classify_request_auth(
        if auth_header.is_empty() {
            None
        } else {
            Some(auth_header)
        },
        if x_api_key.is_empty() {
            None
        } else {
            Some(x_api_key)
        },
    );

    let emit = EmitCtx {
        state: &state,
        method: &method_str,
        path: &req_path,
        start_time,
    };

    let route_execution = {
        let db = match state.db.lock() {
            Ok(db) => db,
            Err(_) => {
                emit.reject("Database lock failed");
                return Err(error_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Database lock failed",
                ));
            }
        };
        let route_plan = route_plan_with_codex_takeover_fallback(&db, &req_path, &request_auth);
        match build_route_execution(&db, &state, &req_path, route_plan, &emit) {
            Ok(re) => re,
            Err(resp) => return Err(resp),
        }
    };

    let is_ws_upgrade = req
        .headers()
        .get("upgrade")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.eq_ignore_ascii_case("websocket"))
        .unwrap_or(false);

    if is_ws_upgrade {
        let (mut parts, _body) = req.into_parts();
        let ws_upgrade: WebSocketUpgrade =
            match WebSocketUpgrade::from_request_parts(&mut parts, &state).await {
                Ok(ws) => ws,
                Err(_) => {
                    emit.reject("WebSocket upgrade failed");
                    return Err(error_response(
                        StatusCode::BAD_REQUEST,
                        "WebSocket upgrade failed",
                    ));
                }
            };
        let ws_url = to_ws_url(&route_execution.upstream_url);
        emit.ws_upgraded(
            &route_execution.upstream_url,
            route_execution
                .log_ctx
                .as_ref()
                .and_then(|c| c.provider_name.as_deref()),
            route_execution
                .log_ctx
                .as_ref()
                .and_then(|c| c.key_alias.as_deref()),
        );
        return Ok(ws_upgrade
            .on_upgrade(move |socket| ws_relay(socket, ws_url, route_execution.real_api_key))
            .into_response());
    }

    let request_path_only = req_path.split('?').next().unwrap_or(req_path.as_str());
    if matches!(
        request_path_only.trim_end_matches('/'),
        "/v1/models" | "/claude-desktop/v1/models"
    ) && route_execution.cli_type.as_deref() == Some("claude_desktop")
    {
        let body = crate::commands::claude_desktop_config::claude_desktop_model_list_response(
            route_execution.model_mapping.as_deref(),
        );
        let response_body = serde_json::to_vec(&body).unwrap_or_else(|_| b"{}".to_vec());
        return Ok(Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "application/json")
            .body(Body::from(response_body))
            .unwrap_or_else(|_| {
                Response::builder()
                    .status(500)
                    .body(Body::from("Internal error"))
                    .unwrap()
            }));
    }

    let method = req.method().clone();
    let mut headers = req.headers().clone();

    if let Some(real_api_key) = route_execution.real_api_key.as_deref() {
        let upstream_url_lower = route_execution.upstream_url.to_ascii_lowercase();
        let is_openai = route_execution
            .provider
            .as_ref()
            .map(|provider| provider_uses_bearer_auth(provider, &upstream_url_lower))
            .unwrap_or(false)
            && !upstream_url_lower.contains("anthropic");

        if is_openai {
            let bearer = format!("Bearer {}", real_api_key);
            match HeaderValue::from_str(&bearer) {
                Ok(v) => {
                    headers.insert("authorization", v);
                }
                Err(_) => {
                    emit.reject("API key contains invalid characters");
                    return Err(error_response(
                        StatusCode::BAD_REQUEST,
                        "API key contains invalid characters",
                    ));
                }
            }
            headers.remove("x-api-key");
        } else {
            match HeaderValue::from_str(real_api_key) {
                Ok(v) => {
                    headers.insert("x-api-key", v);
                }
                Err(_) => {
                    emit.reject("API key contains invalid characters");
                    return Err(error_response(
                        StatusCode::BAD_REQUEST,
                        "API key contains invalid characters",
                    ));
                }
            }
            headers.remove("authorization");
        }
    }

    headers.remove("host");
    headers.remove("accept-encoding");
    headers.remove("content-length");

    let body_bytes = match axum::body::to_bytes(req.into_body(), 50 * 1024 * 1024).await {
        Ok(b) => b,
        Err(_) => {
            emit.reject("Failed to read request body");
            return Err(error_response(
                StatusCode::BAD_REQUEST,
                "Failed to read request body",
            ));
        }
    };

    let request_model = serde_json::from_slice::<serde_json::Value>(&body_bytes)
        .ok()
        .and_then(|v| {
            v.get("model")
                .and_then(|m| m.as_str())
                .map(|s| s.to_string())
        });

    let body_bytes = apply_model_mapping(body_bytes, &route_execution);

    let client = reqwest::Client::new();
    let mut req_builder = client.request(method, &route_execution.upstream_url);

    for (name, value) in &headers {
        if let Ok(v) = value.to_str() {
            req_builder = req_builder.header(name.as_str(), v);
        }
    }

    if !body_bytes.is_empty() {
        req_builder = req_builder.body(body_bytes.to_vec());
    }

    let provider_snapshot = route_execution
        .log_ctx
        .as_ref()
        .and_then(|c| c.provider_name.clone());
    let key_snapshot = route_execution
        .log_ctx
        .as_ref()
        .and_then(|c| c.key_alias.clone());

    let upstream_resp = match req_builder.send().await {
        Ok(r) => r,
        Err(e) => {
            let err_text = e.to_string();
            if let Ok(mut last_err) = state.last_error.lock() {
                *last_err = Some(err_text.clone());
            }
            emit.upstream_error(
                &route_execution.upstream_url,
                provider_snapshot.as_deref(),
                key_snapshot.as_deref(),
                &err_text,
            );
            return Err(error_response(
                StatusCode::BAD_GATEWAY,
                &format!("Upstream error: {}", err_text),
            ));
        }
    };

    let status = upstream_resp.status();
    let resp_headers = upstream_resp.headers().clone();
    let content_type = resp_headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let content_encoding = resp_headers
        .get("content-encoding")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();

    if content_type.contains("text/event-stream") {
        let accumulator = usage_parser::StreamUsageAccumulator::new();
        let tracking_stream = UsageTrackingStream {
            inner: upstream_resp.bytes_stream(),
            accumulator,
            log_ctx: route_execution.log_ctx.as_ref().map(|ctx| LogContext {
                db: state.db.clone(),
                session_token: ctx.session_token.clone(),
                provider_id: ctx.provider_id.clone(),
                api_key_id: ctx.api_key_id.clone(),
                project_id: ctx.project_id.clone(),
                request_model,
                cost_multiplier: ctx.cost_multiplier,
                status_code: status.as_u16(),
                start_time,
                path: req_path.clone(),
                response_content_type: content_type.clone(),
                key_alias: ctx.key_alias.clone(),
                provider_name: ctx.provider_name.clone(),
                project_name: ctx.project_name.clone(),
            }),
            console_ctx: Some(StreamConsoleCtx {
                state: state.clone(),
                method: method_str.clone(),
                path: req_path.clone(),
                upstream_url: route_execution.upstream_url.clone(),
                start_time,
                status: status.as_u16(),
                provider_name: provider_snapshot.clone(),
                key_alias: key_snapshot.clone(),
            }),
            finished: false,
        };

        let mut response = Response::builder().status(status.as_u16());
        for (name, value) in &resp_headers {
            if should_forward_response_header(name.as_str()) {
                if let Ok(v) = value.to_str() {
                    response = response.header(name.as_str(), v);
                }
            }
        }

        return Ok(response
            .body(Body::from_stream(tracking_stream))
            .unwrap_or_else(|_| {
                Response::builder()
                    .status(500)
                    .body(Body::from("Internal error"))
                    .unwrap()
            }));
    }

    let resp_bytes = match upstream_resp.bytes().await {
        Ok(b) => b,
        Err(e) => {
            let err_text = e.to_string();
            emit.upstream_error(
                &route_execution.upstream_url,
                provider_snapshot.as_deref(),
                key_snapshot.as_deref(),
                &err_text,
            );
            return Err(error_response(
                StatusCode::BAD_GATEWAY,
                &format!("Failed to read response: {}", err_text),
            ));
        }
    };

    let decoded = decompress(&resp_bytes, &content_encoding);
    let response_text = String::from_utf8_lossy(&decoded);
    let (usage, model, is_streaming) =
        usage_parser::parse_usage_from_response_data(&response_text, &content_type);

    if let (Some(u), Some(ctx)) = (usage.as_ref(), route_execution.log_ctx.as_ref()) {
        if u.input_tokens > 0 || u.output_tokens > 0 {
            let log_ctx = LogContext {
                db: state.db.clone(),
                session_token: ctx.session_token.clone(),
                provider_id: ctx.provider_id.clone(),
                api_key_id: ctx.api_key_id.clone(),
                project_id: ctx.project_id.clone(),
                request_model,
                cost_multiplier: ctx.cost_multiplier,
                status_code: status.as_u16(),
                start_time,
                path: req_path.clone(),
                response_content_type: content_type.clone(),
                key_alias: ctx.key_alias.clone(),
                provider_name: ctx.provider_name.clone(),
                project_name: ctx.project_name.clone(),
            };
            record_usage(&log_ctx, u, model.as_deref(), is_streaming);
        }
    } else if route_execution.log_ctx.is_some() {
        log::warn!(
            "Usage not recorded: no usage parsed from response; path={}, status={}, content_type={}",
            req_path,
            status.as_u16(),
            content_type
        );
    }

    emit.ok(
        status.as_u16(),
        &route_execution.upstream_url,
        provider_snapshot.as_deref(),
        key_snapshot.as_deref(),
        false,
    );

    let mut response = Response::builder().status(status.as_u16());
    for (name, value) in &resp_headers {
        if should_forward_response_header(name.as_str()) {
            if let Ok(v) = value.to_str() {
                response = response.header(name.as_str(), v);
            }
        }
    }

    Ok(response
        .body(Body::from(resp_bytes.to_vec()))
        .unwrap_or_else(|_| {
            Response::builder()
                .status(500)
                .body(Body::from("Internal error"))
                .unwrap()
        }))
}

fn route_plan_with_codex_takeover_fallback(
    db: &Database,
    req_path: &str,
    request_auth: &RequestAuth,
) -> RoutePlan {
    let route_plan = decide_route_plan(request_auth);
    if matches!(route_plan, RoutePlan::ExplicitSession { .. })
        || !is_codex_responses_request_path(req_path)
    {
        return route_plan;
    }

    let Ok(Some(session_token)) =
        db.settings_get_value(crate::shared_runtime::CODEX_SESSION_TOKEN_SETTING_KEY)
    else {
        return route_plan;
    };
    let session_token = session_token.trim();
    if session_token.is_empty() {
        return route_plan;
    }

    if db.proxy_session_get(session_token).ok().flatten().is_some() {
        RoutePlan::ExplicitSession {
            session_token: session_token.to_string(),
        }
    } else {
        route_plan
    }
}

fn build_route_execution(
    db: &Database,
    state: &Arc<ProxyState>,
    req_path: &str,
    route_plan: RoutePlan,
    emit: &EmitCtx,
) -> Result<RouteExecution, Response<Body>> {
    match route_plan {
        RoutePlan::ExplicitSession { session_token } => {
            let (session, provider, api_key) =
                resolve_session_resources(db, state, &session_token, emit)?;
            let project_name = session
                .project_id
                .as_deref()
                .and_then(|pid| db.project_get(pid).ok().flatten())
                .map(|p| p.name);
            let mapping = api_key.model_mapping.clone();
            let cli_type = effective_session_cli_type(session.cli_type.as_deref(), req_path);
            let upstream_req_path = if cli_type.as_deref() == Some("claude_desktop") {
                strip_claude_desktop_prefix(req_path).to_string()
            } else {
                req_path.to_string()
            };
            let upstream_url =
                build_provider_upstream_url(&provider.base_url, &upstream_req_path, emit)?;
            Ok(RouteExecution {
                upstream_url,
                real_api_key: Some(api_key.value.clone()),
                model_mapping: mapping,
                log_ctx: Some(ResolvedSessionContext {
                    session_token: session.session_token,
                    provider_id: session.provider_id,
                    api_key_id: session.api_key_id,
                    project_id: session.project_id,
                    cost_multiplier: api_key.cost_multiplier,
                    key_alias: api_key.alias.clone(),
                    provider_name: Some(provider.name.clone()),
                    project_name,
                }),
                provider: Some(provider),
                cli_type,
            })
        }
        RoutePlan::PassThrough => {
            // Only in PassThrough do we need to guess the upstream from the
            // path, because there's no session pointing at a concrete provider.
            let upstream_family = match infer_upstream_family_from_path(req_path) {
                Some(f) => f,
                None => {
                    let reason = "Unsupported proxy path";
                    emit.reject(reason);
                    return Err(error_response(StatusCode::NOT_FOUND, reason));
                }
            };
            let upstream_url = build_official_upstream_url(upstream_family, req_path);
            Ok(RouteExecution {
                upstream_url,
                real_api_key: None,
                model_mapping: None,
                log_ctx: None,
                provider: None,
                cli_type: None,
            })
        }
        RoutePlan::RejectMissingAuth => {
            let reason = "No authorization header";
            emit.reject(reason);
            Err(error_response(StatusCode::UNAUTHORIZED, reason))
        }
    }
}

fn effective_session_cli_type(cli_type: Option<&str>, req_path: &str) -> Option<String> {
    match cli_type {
        Some(value) if !value.trim().is_empty() => Some(value.to_string()),
        _ if is_codex_responses_request_path(req_path) => Some("codex-app".to_string()),
        _ => None,
    }
}

fn is_codex_responses_request_path(req_path: &str) -> bool {
    let path = req_path.split('?').next().unwrap_or(req_path);
    matches!(
        path.trim_end_matches('/'),
        "/v1/responses" | "/responses" | "/v1/responses/compact" | "/responses/compact"
    )
}

fn resolve_session_resources(
    db: &Database,
    state: &Arc<ProxyState>,
    session_token: &str,
    emit: &EmitCtx,
) -> Result<(ProxySession, Provider, ApiKey), Response<Body>> {
    let resolved = db
        .proxy_session_get(session_token)
        .ok()
        .flatten()
        .and_then(|session| {
            let provider = db.provider_get(&session.provider_id).ok().flatten();
            let api_key = db.api_key_get(&session.api_key_id).ok().flatten();
            Some((session, provider, api_key))
        });

    let (session, provider, api_key) = if let Some((s, p, k)) = resolved {
        let mut sessions = match state.sessions.lock() {
            Ok(g) => g,
            Err(_) => {
                emit.reject("Session lock failed");
                return Err(error_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Session lock failed",
                ));
            }
        };
        sessions.insert(s.session_token.clone(), s.clone());
        (s, p, k)
    } else {
        let cached = {
            let sessions = match state.sessions.lock() {
                Ok(g) => g,
                Err(_) => {
                    emit.reject("Session lock failed");
                    return Err(error_response(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "Session lock failed",
                    ));
                }
            };
            sessions.get(session_token).cloned()
        };
        match cached {
            Some(s) => {
                let provider = db.provider_get(&s.provider_id).ok().flatten();
                let api_key = db.api_key_get(&s.api_key_id).ok().flatten();
                (s, provider, api_key)
            }
            None => {
                let reason = "Session not found or expired";
                emit.reject(reason);
                return Err(error_response(StatusCode::UNAUTHORIZED, reason));
            }
        }
    };

    let provider = match provider {
        Some(p) => p,
        None => {
            let reason = "Provider not found";
            emit.reject(reason);
            return Err(error_response(StatusCode::NOT_FOUND, reason));
        }
    };
    let api_key = match api_key {
        Some(k) => k,
        None => {
            let reason = "API key not found";
            emit.reject(reason);
            return Err(error_response(StatusCode::NOT_FOUND, reason));
        }
    };
    Ok((session, provider, api_key))
}

fn build_provider_upstream_url(
    base_url: &str,
    req_path: &str,
    emit: &EmitCtx,
) -> Result<String, Response<Body>> {
    let parsed = match url::Url::parse(base_url) {
        Ok(p) => p,
        Err(_) => {
            let reason = "Invalid provider base URL";
            emit.reject(reason);
            return Err(error_response(StatusCode::BAD_GATEWAY, reason));
        }
    };
    let target_origin = match parsed.port() {
        Some(port) => format!(
            "{}://{}:{}",
            parsed.scheme(),
            parsed.host_str().unwrap_or(""),
            port
        ),
        None => format!("{}://{}", parsed.scheme(), parsed.host_str().unwrap_or("")),
    };
    let path_prefix = if parsed.path() == "/" {
        ""
    } else {
        parsed.path().trim_end_matches('/')
    };

    // 避免路径重复：如果 base_url 末尾已经包含 req_path 的前缀（如 /v1），
    // 只拼接 req_path 的剩余部分
    let final_req_path = if let Some(stripped) = strip_common_prefix(path_prefix, req_path) {
        stripped
    } else {
        req_path
    };

    Ok(format!(
        "{}{}{}",
        target_origin, path_prefix, final_req_path
    ))
}

fn strip_claude_desktop_prefix(req_path: &str) -> &str {
    const PREFIX: &str = "/claude-desktop";
    let Some(rest) = req_path.strip_prefix(PREFIX) else {
        return req_path;
    };
    if rest.is_empty() {
        "/"
    } else if rest.starts_with('/') || rest.starts_with('?') {
        rest
    } else {
        req_path
    }
}

/// 如果 req_path 的开头与 base_path 的结尾有公共部分（如 /v1），
/// 返回去掉公共部分后的 req_path
fn strip_common_prefix<'a>(base_path: &str, req_path: &'a str) -> Option<&'a str> {
    if base_path.is_empty() {
        return None;
    }

    // 例如：base_path = "/v1", req_path = "/v1/responses"
    // 应该返回 "/responses"
    if req_path.starts_with(base_path) {
        let rest = &req_path[base_path.len()..];
        // 确保剩余部分以 / 开头或为空
        if rest.is_empty() || rest.starts_with('/') {
            return Some(rest);
        }
    }

    None
}

fn build_official_upstream_url(upstream_family: UpstreamFamily, req_path: &str) -> String {
    match upstream_family {
        UpstreamFamily::Anthropic => format!(
            "{}{}",
            upstream_family.official_base_url(),
            req_path.strip_prefix("/claude").unwrap_or(req_path)
        ),
        UpstreamFamily::OpenAi => format!(
            "{}{}",
            upstream_family.official_base_url(),
            req_path.strip_prefix("/openai/v1").unwrap_or(req_path)
        ),
    }
}

fn apply_model_mapping(body_bytes: axum::body::Bytes, route: &RouteExecution) -> axum::body::Bytes {
    let is_claude_like_provider = route
        .provider
        .as_ref()
        .map(|provider| {
            !provider_uses_bearer_auth(provider, &provider.base_url.to_ascii_lowercase())
        })
        .unwrap_or(true);

    if !is_claude_like_provider {
        return body_bytes;
    }

    let mapping_str = match route.model_mapping.as_deref() {
        Some(s) if !s.is_empty() => s,
        _ => return strip_one_m_suffix(body_bytes),
    };

    #[derive(serde::Deserialize)]
    struct ModelMapping {
        haiku: Option<String>,
        sonnet: Option<String>,
        opus: Option<String>,
        fable: Option<String>,
        default: Option<String>,
    }

    let mapping: ModelMapping = match serde_json::from_str(mapping_str) {
        Ok(m) => m,
        Err(_) => return strip_one_m_suffix(body_bytes),
    };

    let mut json: serde_json::Value = match serde_json::from_slice(&body_bytes) {
        Ok(v) => v,
        Err(_) => return body_bytes,
    };

    let model = match json.get("model").and_then(|m| m.as_str()) {
        Some(m) => m.to_string(),
        None => return body_bytes,
    };

    let model_lower = model.to_lowercase();

    let mapped = if model_lower.contains("haiku") {
        mapping.haiku.as_deref().map(|m| m.to_string())
    } else if model_lower.contains("opus") {
        mapping.opus.as_deref().map(|m| m.to_string())
    } else if model_lower.contains("fable") {
        mapping
            .fable
            .as_deref()
            .or(mapping.opus.as_deref())
            .or(mapping.default.as_deref())
            .map(|m| m.to_string())
    } else if model_lower.contains("sonnet") {
        mapping.sonnet.as_deref().map(|m| m.to_string())
    } else {
        mapping.default.as_deref().map(|m| m.to_string())
    };

    if let Some(mapped) = mapped {
        if mapped != model {
            json["model"] = serde_json::Value::String(mapped);
            let mapped_bytes = axum::body::Bytes::from(
                serde_json::to_vec(&json).unwrap_or_else(|_| body_bytes.to_vec()),
            );
            return strip_one_m_suffix(mapped_bytes);
        }
    }

    strip_one_m_suffix(body_bytes)
}

fn provider_uses_bearer_auth(provider: &Provider, url_lower: &str) -> bool {
    if url_lower.contains("anthropic") {
        return false;
    }

    match provider.provider_type.as_deref() {
        Some("claude" | "claude_code" | "claude_desktop" | "anthropic") => false,
        Some(
            "openai" | "codex" | "deepseek" | "newapi" | "zhipu" | "siliconflow" | "minimax"
            | "kimi" | "moonshot" | "xiaomi",
        ) => true,
        _ => url_lower.contains("/v1") || url_lower.contains("openai"),
    }
}

/// Strips the [1M] suffix that Claude Code appends to model names for 1M context.
const ONE_M_MARKER: &str = "[1M]";

fn strip_one_m_suffix(body_bytes: axum::body::Bytes) -> axum::body::Bytes {
    let mut json: serde_json::Value = match serde_json::from_slice(&body_bytes) {
        Ok(v) => v,
        Err(_) => return body_bytes,
    };

    let model = match json.get("model").and_then(|m| m.as_str()) {
        Some(m) => m,
        None => return body_bytes,
    };

    let trimmed = model.trim_end();
    let bytes = trimmed.as_bytes();
    let marker = ONE_M_MARKER.as_bytes();

    if bytes.len() >= marker.len()
        && bytes[bytes.len() - marker.len()..].eq_ignore_ascii_case(marker)
    {
        let stripped = trimmed[..trimmed.len() - marker.len()].trim_end();
        json["model"] = serde_json::Value::String(stripped.to_string());
        return axum::body::Bytes::from(
            serde_json::to_vec(&json).unwrap_or_else(|_| body_bytes.to_vec()),
        );
    }

    body_bytes
}

pub fn error_response(status: StatusCode, message: &str) -> Response<Body> {
    let body = serde_json::json!({ "error": message });
    let json = serde_json::to_string(&body)
        .unwrap_or_else(|_| r#"{"error":"internal error"}"#.to_string());
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::from(json))
        .unwrap_or_else(|_| Response::new(Body::from(r#"{"error":"internal error"}"#)))
}

fn should_forward_response_header(name: &str) -> bool {
    !matches!(
        name.to_ascii_lowercase().as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
            | "content-length"
    )
}

fn decompress(data: &[u8], encoding: &str) -> Vec<u8> {
    if encoding.contains("gzip") {
        use flate2::read::GzDecoder;
        use std::io::Read;
        let mut decoder = GzDecoder::new(data);
        let mut decoded = Vec::new();
        if decoder.read_to_end(&mut decoded).is_ok() {
            return decoded;
        }
    } else if encoding.contains("br") {
        use brotli::Decompressor;
        use std::io::Read;
        let mut decoder = Decompressor::new(data, 4096);
        let mut decoded = Vec::new();
        if decoder.read_to_end(&mut decoded).is_ok() {
            return decoded;
        }
    } else if encoding.contains("deflate") {
        use flate2::read::DeflateDecoder;
        use std::io::Read;
        let mut decoder = DeflateDecoder::new(data);
        let mut decoded = Vec::new();
        if decoder.read_to_end(&mut decoded).is_ok() {
            return decoded;
        }
    }
    data.to_vec()
}

struct LogContext {
    db: Arc<Mutex<crate::db::Database>>,
    session_token: String,
    provider_id: String,
    api_key_id: String,
    project_id: Option<String>,
    request_model: Option<String>,
    cost_multiplier: f64,
    status_code: u16,
    start_time: std::time::Instant,
    path: String,
    response_content_type: String,
    // Snapshot names for request_logs persistence
    key_alias: Option<String>,
    provider_name: Option<String>,
    project_name: Option<String>,
}

/// Mirrors what the streaming-response success emitter needs. Kept separate
/// from `LogContext` because PassThrough responses (no session) still need to
/// emit a console event even though there's nothing to record in `request_logs`.
struct StreamConsoleCtx {
    state: Arc<ProxyState>,
    method: String,
    path: String,
    upstream_url: String,
    start_time: std::time::Instant,
    status: u16,
    provider_name: Option<String>,
    key_alias: Option<String>,
}

fn record_usage(
    ctx: &LogContext,
    usage: &usage_parser::TokenUsage,
    model: Option<&str>,
    is_streaming: bool,
) {
    let latency_ms = ctx.start_time.elapsed().as_millis() as i64;
    let model_name = model.or(ctx.request_model.as_deref()).unwrap_or("unknown");

    let custom_pricing = {
        let db = ctx.db.lock().unwrap();
        match db.settings_get_value("customModelPricing") {
            Ok(Some(json)) => serde_json::from_str(&json).unwrap_or_default(),
            _ => std::collections::HashMap::new(),
        }
    };
    let (input_cost, output_cost, cache_read_cost, cache_creation_cost, total_cost) =
        cost_calculator::calculate_cost(
            model_name,
            usage.input_tokens,
            usage.output_tokens,
            usage.cache_read_tokens,
            usage.cache_creation_tokens,
            ctx.cost_multiplier,
            &custom_pricing,
        );

    let log = RequestLog {
        id: nanoid::nanoid!(),
        provider_id: Some(ctx.provider_id.clone()),
        api_key_id: Some(ctx.api_key_id.clone()),
        project_id: ctx.project_id.clone(),
        session_id: Some(ctx.session_token.clone()),
        model: Some(model_name.to_string()),
        request_model: ctx.request_model.clone(),
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_read_tokens: usage.cache_read_tokens,
        cache_creation_tokens: usage.cache_creation_tokens,
        input_cost_usd: input_cost,
        output_cost_usd: output_cost,
        cache_read_cost_usd: cache_read_cost,
        cache_creation_cost_usd: cache_creation_cost,
        total_cost_usd: total_cost,
        cost_multiplier: ctx.cost_multiplier,
        latency_ms: Some(latency_ms),
        first_token_ms: None,
        status_code: Some(ctx.status_code as i32),
        error_message: None,
        is_streaming,
        created_at: chrono::Utc::now().to_rfc3339(),
        key_alias: ctx.key_alias.clone(),
        provider_name: ctx.provider_name.clone(),
        project_name: ctx.project_name.clone(),
    };

    if let Ok(db) = ctx.db.lock() {
        if let Err(e) = db.request_log_create(&log) {
            log::error!("Failed to record usage log: {}", e);
        }
    } else {
        log::error!("Failed to lock database for usage recording");
    }
}

struct UsageTrackingStream<S> {
    inner: S,
    accumulator: usage_parser::StreamUsageAccumulator,
    log_ctx: Option<LogContext>,
    console_ctx: Option<StreamConsoleCtx>,
    finished: bool,
}

impl<S> Stream for UsageTrackingStream<S>
where
    S: Stream<Item = Result<axum::body::Bytes, reqwest::Error>> + Unpin,
{
    type Item = Result<axum::body::Bytes, std::io::Error>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();

        if this.finished {
            return Poll::Ready(None);
        }

        match Pin::new(&mut this.inner).poll_next(cx) {
            Poll::Ready(Some(Ok(bytes))) => {
                if let Ok(text) = std::str::from_utf8(&bytes) {
                    this.accumulator.process_chunk(text);
                }
                Poll::Ready(Some(Ok(bytes)))
            }
            Poll::Ready(Some(Err(e))) => Poll::Ready(Some(Err(std::io::Error::other(e)))),
            Poll::Ready(None) => {
                this.finished = true;
                if let Some(ctx) = this.log_ctx.take() {
                    this.accumulator.flush();
                    if let Some(usage) = this.accumulator.get_usage() {
                        record_usage(&ctx, &usage, this.accumulator.model.as_deref(), true);
                    } else {
                        log::warn!(
                            "Usage not recorded: no usage parsed from streaming response; path={}, status={}, content_type={}, diagnostics={}",
                            ctx.path,
                            ctx.status_code,
                            ctx.response_content_type,
                            this.accumulator.diagnostics_summary()
                        );
                    }
                }
                if let Some(ctx) = this.console_ctx.take() {
                    ctx.state.emit_console(ConsoleEvent::ok(
                        &ctx.method,
                        &ctx.path,
                        ctx.status,
                        ctx.start_time.elapsed().as_millis() as u64,
                        &ctx.upstream_url,
                        ctx.provider_name.as_deref(),
                        ctx.key_alias.as_deref(),
                        true,
                    ));
                }
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

fn to_ws_url(http_url: &str) -> String {
    if http_url.starts_with("https://") {
        format!("wss://{}", &http_url[8..])
    } else if http_url.starts_with("http://") {
        format!("ws://{}", &http_url[7..])
    } else {
        http_url.to_string()
    }
}

async fn ws_relay(mut client: WebSocket, upstream_url: String, api_key: Option<String>) {
    use tokio_tungstenite::tungstenite;

    let mut request = tungstenite::http::Request::builder()
        .uri(&upstream_url)
        .header("Host", extract_host(&upstream_url).unwrap_or_default())
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Sec-WebSocket-Version", "13")
        .header(
            "Sec-WebSocket-Key",
            tungstenite::handshake::client::generate_key(),
        );
    if let Some(api_key) = api_key {
        request = request.header("Authorization", format!("Bearer {}", api_key));
    }
    let ws_request = match request.body(()) {
        Ok(r) => r,
        Err(e) => {
            log::error!("Failed to build upstream WS request: {}", e);
            return;
        }
    };

    let (mut upstream, _) = match tokio_tungstenite::connect_async(ws_request).await {
        Ok(conn) => conn,
        Err(e) => {
            log::error!(
                "Failed to connect upstream WebSocket {}: {}",
                upstream_url,
                e
            );
            return;
        }
    };

    loop {
        tokio::select! {
            msg = client.recv() => {
                match msg {
                    Some(Ok(WsMessage::Text(t))) => {
                        if upstream.send(tungstenite::Message::Text(t.to_string().into())).await.is_err() { break; }
                    }
                    Some(Ok(WsMessage::Binary(b))) => {
                        if upstream.send(tungstenite::Message::Binary(b.to_vec().into())).await.is_err() { break; }
                    }
                    Some(Ok(WsMessage::Ping(p))) => {
                        if upstream.send(tungstenite::Message::Ping(p.to_vec().into())).await.is_err() { break; }
                    }
                    Some(Ok(WsMessage::Pong(p))) => {
                        if upstream.send(tungstenite::Message::Pong(p.to_vec().into())).await.is_err() { break; }
                    }
                    Some(Ok(WsMessage::Close(_))) | None => break,
                    Some(Err(_)) => break,
                }
            }
            msg = upstream.next() => {
                match msg {
                    Some(Ok(tungstenite::Message::Text(t))) => {
                        if client.send(WsMessage::Text(t.to_string().into())).await.is_err() { break; }
                    }
                    Some(Ok(tungstenite::Message::Binary(b))) => {
                        if client.send(WsMessage::Binary(b.to_vec().into())).await.is_err() { break; }
                    }
                    Some(Ok(tungstenite::Message::Ping(p))) => {
                        if client.send(WsMessage::Ping(p.to_vec().into())).await.is_err() { break; }
                    }
                    Some(Ok(tungstenite::Message::Pong(p))) => {
                        if client.send(WsMessage::Pong(p.to_vec().into())).await.is_err() { break; }
                    }
                    Some(Ok(tungstenite::Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
        }
    }

    let _ = client.close().await;
    let _ = upstream.close(None).await;
}

fn extract_host(url: &str) -> Option<String> {
    url::Url::parse(url).ok().and_then(|u| {
        u.host_str().map(|h| {
            if let Some(port) = u.port() {
                format!("{}:{}", h, port)
            } else {
                h.to_string()
            }
        })
    })
}

#[cfg(test)]
mod tests {
    use super::{
        effective_session_cli_type, is_codex_responses_request_path, record_usage,
        route_plan_with_codex_takeover_fallback, should_forward_response_header, LogContext,
    };
    use crate::db::Database;
    use crate::models::{CreateApiKeyInput, CreateProviderInput, ProxySession};
    use crate::shared_runtime::{RequestAuth, RoutePlan, CODEX_SESSION_TOKEN_SETTING_KEY};

    #[test]
    fn response_header_filter_drops_hop_by_hop_headers() {
        for header in [
            "connection",
            "Connection",
            "keep-alive",
            "proxy-authenticate",
            "proxy-authorization",
            "te",
            "trailer",
            "transfer-encoding",
            "Transfer-Encoding",
            "upgrade",
            "content-length",
        ] {
            assert!(!should_forward_response_header(header), "{header}");
        }
    }

    #[test]
    fn response_header_filter_keeps_end_to_end_headers() {
        for header in ["content-type", "server", "x-request-id"] {
            assert!(should_forward_response_header(header), "{header}");
        }
    }

    #[test]
    fn codex_responses_paths_are_detected_for_takeover_fallback() {
        for path in [
            "/v1/responses",
            "/v1/responses?stream=true",
            "/responses",
            "/v1/responses/compact",
        ] {
            assert!(is_codex_responses_request_path(path), "{path}");
        }
        assert!(!is_codex_responses_request_path("/v1/chat/completions"));
        assert!(!is_codex_responses_request_path("/v1/models"));
    }

    #[test]
    fn legacy_empty_session_type_is_treated_as_codex_app_for_responses() {
        assert_eq!(
            effective_session_cli_type(None, "/v1/responses").as_deref(),
            Some("codex-app")
        );
        assert_eq!(
            effective_session_cli_type(Some(""), "/v1/responses").as_deref(),
            Some("codex-app")
        );
        assert_eq!(
            effective_session_cli_type(Some("claude_desktop"), "/v1/responses").as_deref(),
            Some("claude_desktop")
        );
        assert_eq!(effective_session_cli_type(None, "/v1/messages"), None);
    }

    #[test]
    fn codex_responses_provider_auth_uses_saved_takeover_session() {
        let db = Database::new_in_memory().unwrap();
        let session_token = "session-fixed-codex";
        db.settings_set_value(CODEX_SESSION_TOKEN_SETTING_KEY, session_token)
            .unwrap();
        db.proxy_session_create(&ProxySession {
            session_token: session_token.to_string(),
            provider_id: "provider".to_string(),
            api_key_id: "key".to_string(),
            project_id: None,
            created_at: chrono::Utc::now().to_rfc3339(),
            cli_type: Some("codex-app".to_string()),
        })
        .unwrap();

        assert_eq!(
            route_plan_with_codex_takeover_fallback(
                &db,
                "/v1/responses",
                &RequestAuth::ProviderCredential,
            ),
            RoutePlan::ExplicitSession {
                session_token: session_token.to_string()
            }
        );
        assert_eq!(
            route_plan_with_codex_takeover_fallback(
                &db,
                "/v1/models",
                &RequestAuth::ProviderCredential,
            ),
            RoutePlan::PassThrough
        );
    }

    #[test]
    fn record_usage_persists_request_model_when_response_model_missing() {
        let raw_db = Database::new_in_memory().unwrap();
        let provider = raw_db
            .provider_create(&CreateProviderInput {
                name: "codex-provider".to_string(),
                base_url: "https://example.com/v1".to_string(),
                provider_type: Some("codex".to_string()),
                website: None,
                remark: None,
                token: None,
                icon: None,
                wallet_balance_type: None,
                wallet_balance_url: None,
                wallet_balance_path: None,
                wallet_balance_headers: None,
                wallet_balance_user_id: None,
                usage_type: None,
                usage_url: None,
                usage_path: None,
                usage_headers: None,
                api_format: None,
                transform_enabled: None,
            })
            .unwrap();
        let api_key = raw_db
            .api_key_create(&CreateApiKeyInput {
                provider_id: provider.id.clone(),
                alias: Some("codex-key".to_string()),
                value: "sk-test".to_string(),
                types: Some(vec!["codex".to_string()]),
                priority: None,
                is_active: None,
                config: None,
                cost_multiplier: None,
                usage_type: None,
                usage_url: None,
                usage_path: None,
                usage_headers: None,
                model_mapping: None,
                api_format: None,
                transform_enabled: None,
                client_configs: None,
            })
            .unwrap();
        let db = std::sync::Arc::new(std::sync::Mutex::new(raw_db));
        let ctx = LogContext {
            db: db.clone(),
            session_token: "session-codex".to_string(),
            provider_id: provider.id.clone(),
            api_key_id: api_key.id.clone(),
            project_id: None,
            request_model: Some("gpt-5.5".to_string()),
            cost_multiplier: 1.0,
            status_code: 200,
            start_time: std::time::Instant::now(),
            path: "/v1/responses".to_string(),
            response_content_type: "text/event-stream".to_string(),
            key_alias: Some("codex-key".to_string()),
            provider_name: Some("codex-provider".to_string()),
            project_name: None,
        };
        let usage = crate::proxy::usage_parser::TokenUsage {
            input_tokens: 1_000_000,
            output_tokens: 1_000_000,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
        };

        record_usage(&ctx, &usage, None, true);

        let rows = db.lock().unwrap().request_log_list_all().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].model.as_deref(), Some("gpt-5.5"));
        assert_eq!(rows[0].request_model.as_deref(), Some("gpt-5.5"));
        assert!((rows[0].total_cost_usd - 35.0).abs() < 1e-6);
    }
}
