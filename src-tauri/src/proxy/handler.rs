use crate::db::Database;
use crate::models::{ApiKey, Provider, ProxySession, RequestLog};
use crate::proxy::console::ConsoleEvent;
use crate::proxy::usage_parser;
use crate::proxy::{ProxyState, RequestPermits};
use crate::services::cost_calculator;
use crate::shared_runtime::{
    classify_request_auth, decide_route_plan, infer_upstream_family_from_path, RequestAuth,
    RoutePlan, UpstreamFamily,
};

use axum::{
    body::Body,
    extract::ws::{
        CloseFrame as AxumCloseFrame, Message as WsMessage, WebSocket, WebSocketUpgrade,
    },
    extract::FromRequestParts,
    extract::State as AxumState,
    http::{HeaderMap, HeaderValue, Request, Response, StatusCode},
    response::IntoResponse,
};
use futures::{SinkExt, Stream, StreamExt};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

const MAX_REQUEST_BODY_BYTES: usize = 50 * 1024 * 1024;
const MAX_NON_STREAM_RESPONSE_BYTES: usize = 64 * 1024 * 1024;
const MAX_DECOMPRESSED_CAPTURE_BYTES: usize = 64 * 1024 * 1024;
const MAX_COMPRESSED_STREAM_CAPTURE_BYTES: usize = 16 * 1024 * 1024;
const MAX_STREAM_DETAIL_CAPTURE_BYTES: usize = 256 * 1024;
const MAX_SSE_MODEL_NORMALIZATION_LINE_BYTES: usize = 1024 * 1024;
const MAX_WS_MESSAGE_BYTES: usize = 64 * 1024 * 1024;
const MAX_WS_FRAME_BYTES: usize = 16 * 1024 * 1024;
const MAX_WS_WRITE_BUFFER_BYTES: usize = MAX_WS_MESSAGE_BYTES + 128 * 1024;
const WS_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

struct RouteExecution {
    upstream_url: String,
    real_api_key: Option<String>,
    model_mapping: Option<String>,
    auth_scheme: Option<UpstreamAuthScheme>,
    log_ctx: Option<ResolvedSessionContext>,
    provider: Option<Provider>,
    cli_type: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UpstreamAuthScheme {
    XApiKey,
    Bearer,
    None,
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
    request_id: &'a str,
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
            self.request_id,
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
            self.request_id,
            self.method,
            self.path,
            self.elapsed_ms(),
            upstream,
            provider,
            key_alias,
            error,
        ));
    }

    fn ws_upgraded(&self, upstream: &str, provider: Option<&str>, key_alias: Option<&str>) {
        self.state.emit_console(ConsoleEvent::ws_upgraded(
            self.request_id,
            self.path,
            self.elapsed_ms(),
            upstream,
            provider,
            key_alias,
        ));
    }

    fn pending(
        &self,
        upstream: &str,
        provider: Option<&str>,
        key_alias: Option<&str>,
        is_streaming: bool,
        request_headers: Option<Vec<String>>,
        request_body: Option<String>,
    ) {
        let mut evt = ConsoleEvent::pending(
            self.request_id,
            self.method,
            self.path,
            upstream,
            provider,
            key_alias,
            is_streaming,
        );
        if let ConsoleEvent::Request {
            request_headers: ref mut target_headers,
            request_body: ref mut target_body,
            ..
        } = evt
        {
            *target_headers = request_headers;
            *target_body = request_body;
        }
        self.state.emit_console(evt);
    }
}

struct RequestCancellationGuard {
    state: Arc<ProxyState>,
    request_id: String,
    method: String,
    path: String,
    upstream_url: String,
    provider_name: Option<String>,
    key_alias: Option<String>,
    start_time: std::time::Instant,
    status: Option<u16>,
    armed: bool,
}

impl RequestCancellationGuard {
    fn new(
        state: Arc<ProxyState>,
        request_id: &str,
        method: &str,
        path: &str,
        upstream_url: &str,
        provider_name: Option<String>,
        key_alias: Option<String>,
        start_time: std::time::Instant,
    ) -> Self {
        Self {
            state,
            request_id: request_id.to_string(),
            method: method.to_string(),
            path: path.to_string(),
            upstream_url: upstream_url.to_string(),
            provider_name,
            key_alias,
            start_time,
            status: None,
            armed: true,
        }
    }

    fn set_status(&mut self, status: u16) {
        self.status = Some(status);
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for RequestCancellationGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        self.state.emit_console(ConsoleEvent::cancelled(
            &self.request_id,
            &self.method,
            &self.path,
            self.status,
            self.start_time.elapsed().as_millis() as u64,
            &self.upstream_url,
            self.provider_name.as_deref(),
            self.key_alias.as_deref(),
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
    let request_id = nanoid::nanoid!();

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
        request_id: &request_id,
        method: &method_str,
        path: &req_path,
        start_time,
    };

    let request_permits = match state.try_acquire_request_permits(match &request_auth {
        RequestAuth::SessionToken(token) => Some(token.as_str()),
        _ => None,
    }) {
        Ok(permits) => permits,
        Err(reason) => {
            emit.reject(reason);
            return Err(error_response(StatusCode::TOO_MANY_REQUESTS, reason));
        }
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
        match build_route_execution(&db, &req_path, route_plan, &emit) {
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
        let incoming_headers = parts.headers.clone();
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
        let upstream_request = match build_upstream_ws_request(
            &ws_url,
            &incoming_headers,
            &route_execution,
            &req_path,
        ) {
            Ok(request) => request,
            Err(error) => {
                emit.reject(&error);
                return Err(error_response(StatusCode::BAD_REQUEST, &error));
            }
        };
        let upstream_proxy = route_execution
            .provider
            .as_ref()
            .and_then(|provider| provider.http_proxy.as_deref());
        let (upstream, upstream_response) =
            match connect_upstream_websocket(upstream_request, upstream_proxy).await {
                Ok(connection) => connection,
                Err(error) => {
                    if let Ok(mut last_err) = state.last_error.lock() {
                        *last_err = Some(error.clone());
                    }
                    emit.upstream_error(
                        &route_execution.upstream_url,
                        route_execution
                            .log_ctx
                            .as_ref()
                            .and_then(|ctx| ctx.provider_name.as_deref()),
                        route_execution
                            .log_ctx
                            .as_ref()
                            .and_then(|ctx| ctx.key_alias.as_deref()),
                        &error,
                    );
                    return Err(error_response(StatusCode::BAD_GATEWAY, &error));
                }
            };
        let selected_protocol = upstream_response
            .headers()
            .get("sec-websocket-protocol")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let ws_upgrade = ws_upgrade
            .max_message_size(MAX_WS_MESSAGE_BYTES)
            .max_frame_size(MAX_WS_FRAME_BYTES)
            .max_write_buffer_size(MAX_WS_WRITE_BUFFER_BYTES);
        let ws_upgrade = if let Some(protocol) = selected_protocol {
            ws_upgrade.protocols([protocol])
        } else {
            ws_upgrade
        };
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
            .on_upgrade(move |socket| async move {
                let _request_permits = request_permits;
                ws_relay(socket, upstream).await;
            })
            .into_response());
    }

    let method = req.method().clone();
    let mut headers = req.headers().clone();

    if let Err(error) = apply_upstream_auth_headers(&mut headers, &route_execution, &req_path) {
        emit.reject(error);
        return Err(error_response(StatusCode::BAD_REQUEST, error));
    }

    strip_hop_by_hop_headers(&mut headers);
    headers.remove("accept-encoding");
    headers.remove("host");
    headers.remove("content-length");

    let body_bytes = match axum::body::to_bytes(req.into_body(), MAX_REQUEST_BODY_BYTES).await {
        Ok(b) => b,
        Err(_) => {
            emit.reject("Failed to read request body");
            return Err(error_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                "Request body exceeds local size limit or could not be read",
            ));
        }
    };

    let request_json = serde_json::from_slice::<serde_json::Value>(&body_bytes).ok();
    let request_model = request_json
        .as_ref()
        .and_then(|v| v.get("model").and_then(|m| m.as_str()))
        .map(|s| s.to_string());
    let request_declares_stream = request_json
        .as_ref()
        .and_then(|v| v.get("stream"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let body_bytes = apply_model_mapping(body_bytes, &route_execution);
    let forwarded_request_model = serde_json::from_slice::<serde_json::Value>(&body_bytes)
        .ok()
        .and_then(|value| {
            value
                .get("model")
                .and_then(|model| model.as_str())
                .map(str::to_string)
        });

    let client = match crate::services::http_client::outbound_client_for_provider(
        route_execution.provider.as_ref(),
    ) {
        Ok(client) => client,
        Err(e) => {
            emit.reject(&e);
            return Err(error_response(StatusCode::BAD_GATEWAY, &e));
        }
    };
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

    let detail_mode_at_dispatch = state.detail_mode.load(std::sync::atomic::Ordering::Relaxed);
    let request_content_type = headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let (pending_req_h, pending_req_b, _, _) =
        crate::proxy::console::build_detail_fields_with_content_type(
            &headers,
            &body_bytes,
            &hyper::HeaderMap::new(),
            &[],
            request_content_type,
            "",
            detail_mode_at_dispatch,
        );
    emit.pending(
        &route_execution.upstream_url,
        provider_snapshot.as_deref(),
        key_snapshot.as_deref(),
        request_declares_stream,
        pending_req_h,
        pending_req_b,
    );
    let mut cancellation_guard = RequestCancellationGuard::new(
        state.clone(),
        &request_id,
        &method_str,
        &req_path,
        &route_execution.upstream_url,
        provider_snapshot.clone(),
        key_snapshot.clone(),
        start_time,
    );

    let upstream_resp = match req_builder.send().await {
        Ok(r) => r,
        Err(e) => {
            cancellation_guard.disarm();
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
    cancellation_guard.set_status(status.as_u16());
    let raw_resp_headers = upstream_resp.headers().clone();
    let mut resp_headers = raw_resp_headers.clone();
    strip_hop_by_hop_headers(&mut resp_headers);
    let content_type = raw_resp_headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let content_encoding = raw_resp_headers
        .get("content-encoding")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();

    if content_type
        .to_ascii_lowercase()
        .contains("text/event-stream")
    {
        let detail_capture = detail_mode_at_dispatch;
        let accumulator = usage_parser::StreamUsageAccumulator::new();
        let response_model =
            if route_execution.cli_type.as_deref() == Some("grok") && content_encoding.is_empty() {
                forwarded_request_model
                    .clone()
                    .or_else(|| request_model.clone())
            } else {
                None
            };
        let tracking_stream = UsageTrackingStream {
            inner: SseModelNormalizingStream::new(upstream_resp.bytes_stream(), response_model),
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
                request_id: request_id.clone(),
                method: method_str.clone(),
                path: req_path.clone(),
                upstream_url: route_execution.upstream_url.clone(),
                start_time,
                status: status.as_u16(),
                provider_name: provider_snapshot.clone(),
                key_alias: key_snapshot.clone(),
                request_headers: headers.clone(),
                request_body: if detail_capture {
                    body_bytes.to_vec()
                } else {
                    Vec::new()
                },
                response_headers: resp_headers.clone(),
            }),
            finished: false,
            content_encoding: content_encoding.clone(),
            detail_capture,
            capture_buffer: Vec::new(),
            capture_truncated: false,
            _request_permits: Some(request_permits),
        };

        let mut response = Response::builder().status(status.as_u16());
        for (name, value) in &resp_headers {
            if should_forward_response_header(name.as_str()) {
                if let Ok(v) = value.to_str() {
                    response = response.header(name.as_str(), v);
                }
            }
        }

        cancellation_guard.disarm();
        return Ok(response
            .body(Body::from_stream(tracking_stream))
            .unwrap_or_else(|_| {
                Response::builder()
                    .status(500)
                    .body(Body::from("Internal error"))
                    .unwrap()
            }));
    }

    if raw_resp_headers
        .get("content-length")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|length| length > MAX_NON_STREAM_RESPONSE_BYTES)
    {
        let reason = "Upstream response exceeds local size limit";
        cancellation_guard.disarm();
        emit.upstream_error(
            &route_execution.upstream_url,
            provider_snapshot.as_deref(),
            key_snapshot.as_deref(),
            reason,
        );
        return Err(error_response(StatusCode::BAD_GATEWAY, reason));
    }

    let resp_bytes = match collect_response_body_limited(
        upstream_resp.bytes_stream(),
        MAX_NON_STREAM_RESPONSE_BYTES,
    )
    .await
    {
        Ok(bytes) => bytes,
        Err(err_text) => {
            cancellation_guard.disarm();
            emit.upstream_error(
                &route_execution.upstream_url,
                provider_snapshot.as_deref(),
                key_snapshot.as_deref(),
                &err_text,
            );
            return Err(error_response(StatusCode::BAD_GATEWAY, &err_text));
        }
    };

    let mut decoded = match decompress_limited(
        &resp_bytes,
        &content_encoding,
        MAX_DECOMPRESSED_CAPTURE_BYTES,
    ) {
        Ok(decoded) => decoded,
        Err(error) => {
            log::warn!(
                "Skipping oversized decompressed response capture: {}",
                error
            );
            Vec::new()
        }
    };
    let response_model_was_added = route_execution.cli_type.as_deref() == Some("grok")
        && ensure_chat_completion_response_model(
            &mut decoded,
            forwarded_request_model
                .as_deref()
                .or(request_model.as_deref()),
        );
    let outgoing_resp_bytes = if response_model_was_added {
        decoded.clone()
    } else {
        resp_bytes
    };
    let mut outgoing_resp_headers = resp_headers.clone();
    if response_model_was_added {
        // The normalized body is decoded and re-serialized, so stale encoding
        // and length metadata must not be forwarded.
        outgoing_resp_headers.remove("content-encoding");
        outgoing_resp_headers.remove("content-length");
    }
    let response_text = String::from_utf8_lossy(&decoded);
    let (usage, model, is_streaming) =
        usage_parser::parse_usage_from_response_data(&response_text, &content_type);

    if let (Some(u), Some(ctx)) = (usage.as_ref(), route_execution.log_ctx.as_ref()) {
        if has_billable_usage(u) {
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
        log::debug!(
            "Usage not recorded: no usage parsed from response; path={}, status={}, content_type={}",
            req_path,
            status.as_u16(),
            content_type
        );
    }

    let detail_mode = detail_mode_at_dispatch;
    let request_content_type = headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let (req_h, req_b, resp_h, resp_b) =
        crate::proxy::console::build_detail_fields_with_content_type(
            &headers,
            &body_bytes,
            &outgoing_resp_headers,
            &decoded,
            request_content_type,
            &content_type,
            detail_mode,
        );
    let mut evt = ConsoleEvent::ok(
        &request_id,
        &method_str,
        &req_path,
        status.as_u16(),
        start_time.elapsed().as_millis() as u64,
        &route_execution.upstream_url,
        provider_snapshot.as_deref(),
        key_snapshot.as_deref(),
        false,
    );
    if detail_mode {
        if let ConsoleEvent::Request {
            ref mut request_headers,
            ref mut request_body,
            ref mut response_headers,
            ref mut response_body,
            ..
        } = evt
        {
            *request_headers = req_h;
            *request_body = req_b;
            *response_headers = resp_h;
            *response_body = resp_b;
        }
    }
    cancellation_guard.disarm();
    state.emit_console(evt);

    let mut response = Response::builder().status(status.as_u16());
    for (name, value) in &outgoing_resp_headers {
        if should_forward_response_header(name.as_str()) {
            if let Ok(v) = value.to_str() {
                response = response.header(name.as_str(), v);
            }
        }
    }

    Ok(response
        .body(Body::from(outgoing_resp_bytes))
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
    req_path: &str,
    route_plan: RoutePlan,
    emit: &EmitCtx,
) -> Result<RouteExecution, Response<Body>> {
    match route_plan {
        RoutePlan::ExplicitSession { session_token } => {
            let (session, provider, api_key) = resolve_session_resources(db, &session_token, emit)?;
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
            let client_config_key = session_client_config_key(cli_type.as_deref());
            // Resolve base_url: clientConfigs[cli_type].baseUrl > provider.baseUrl
            let resolved_base_url = api_key
                .client_configs
                .as_ref()
                .and_then(|configs| configs.get(client_config_key))
                .and_then(|cfg| cfg.get("baseUrl"))
                .and_then(|v| v.as_str())
                .unwrap_or(&provider.base_url);
            let client_config = api_key
                .client_configs
                .as_ref()
                .and_then(|configs| configs.get(client_config_key));
            let upstream_url =
                build_provider_upstream_url(resolved_base_url, &upstream_req_path, emit)?;
            Ok(RouteExecution {
                upstream_url,
                real_api_key: Some(api_key.value.clone()),
                model_mapping: mapping,
                auth_scheme: client_config.and_then(read_auth_scheme),
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
                auth_scheme: None,
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
    session_token: &str,
    emit: &EmitCtx,
) -> Result<(ProxySession, Provider, ApiKey), Response<Body>> {
    let session = match db.proxy_session_get(session_token) {
        Ok(Some(session)) => session,
        Ok(None) => {
            let reason = "Session not found";
            emit.reject(reason);
            return Err(error_response(StatusCode::UNAUTHORIZED, reason));
        }
        Err(error) => {
            emit.reject("Failed to read session");
            return Err(error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("Failed to read session: {}", error),
            ));
        }
    };

    if session.revoked_at.is_some() {
        let reason = session
            .revoked_reason
            .as_deref()
            .map(|reason| format!("Session revoked: {}", reason))
            .unwrap_or_else(|| "Session revoked".to_string());
        emit.reject(&reason);
        return Err(error_response(StatusCode::UNAUTHORIZED, &reason));
    }

    if session
        .expires_at
        .as_deref()
        .is_some_and(session_time_has_passed)
    {
        let reason = "Session expired";
        emit.reject(reason);
        return Err(error_response(StatusCode::UNAUTHORIZED, reason));
    }

    if session.session_kind == "managed" {
        let instance = db
            .managed_instance_get_by_session_token(session_token)
            .map_err(|error| {
                error_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    &format!("Failed to read managed instance: {}", error),
                )
            })?;
        match instance {
            Some(instance)
                if matches!(instance.status.as_str(), "launching" | "running" | "stale") => {}
            Some(_) => {
                let reason = "Managed session is no longer active";
                emit.reject(reason);
                return Err(error_response(StatusCode::UNAUTHORIZED, reason));
            }
            None => {
                let reason = "Managed session has no instance";
                emit.reject(reason);
                return Err(error_response(StatusCode::UNAUTHORIZED, reason));
            }
        }
    }

    let provider = match db.provider_get(&session.provider_id) {
        Ok(provider) => provider,
        Err(error) => {
            emit.reject("Failed to read provider");
            return Err(error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("Failed to read provider: {}", error),
            ));
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
    if !provider.is_active {
        let reason = "Provider is disabled";
        emit.reject(reason);
        return Err(error_response(StatusCode::FORBIDDEN, reason));
    }

    let api_key = match db.api_key_get(&session.api_key_id) {
        Ok(api_key) => api_key,
        Err(error) => {
            emit.reject("Failed to read API key");
            return Err(error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("Failed to read API key: {}", error),
            ));
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

    if api_key.provider_id != provider.id {
        let reason = "API key does not belong to session provider";
        emit.reject(reason);
        return Err(error_response(StatusCode::FORBIDDEN, reason));
    }
    if !api_key.is_active {
        let reason = "API key is disabled";
        emit.reject(reason);
        return Err(error_response(StatusCode::FORBIDDEN, reason));
    }
    if api_key.is_exhausted {
        let reason = "API key is marked exhausted";
        emit.reject(reason);
        return Err(error_response(StatusCode::FORBIDDEN, reason));
    }
    if !api_key_supports_session_client(&api_key, session.cli_type.as_deref()) {
        let reason = "API key does not support this client";
        emit.reject(reason);
        return Err(error_response(StatusCode::FORBIDDEN, reason));
    }

    let now = chrono::Utc::now().to_rfc3339();
    if let Err(error) = db.proxy_session_touch(session_token, &now) {
        emit.reject("Failed to update session activity");
        return Err(error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("Failed to update session activity: {}", error),
        ));
    }
    Ok((session, provider, api_key))
}

fn session_time_has_passed(value: &str) -> bool {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|time| time.with_timezone(&chrono::Utc) <= chrono::Utc::now())
        .unwrap_or(true)
}

fn api_key_supports_session_client(api_key: &ApiKey, cli_type: Option<&str>) -> bool {
    let required_type = match cli_type {
        Some("codex" | "codex-app") => Some("codex"),
        Some("grok") => Some("grok"),
        Some("claude_desktop") => Some("claude_desktop"),
        Some("claude" | "claude_code") => Some("claude_code"),
        Some(_) => return false,
        None => None,
    };

    required_type.is_none_or(|required| api_key.types.iter().any(|kind| kind == required))
}

fn session_client_config_key(cli_type: Option<&str>) -> &str {
    match cli_type {
        Some("codex-app") => "codex",
        Some("claude") => "claude_code",
        Some(value) => value,
        None => "claude_code",
    }
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
    let mapping_str = match route.model_mapping.as_deref() {
        Some(s) if !s.is_empty() => s,
        _ if route_uses_openai_payload(route) => return body_bytes,
        _ => return strip_one_m_suffix(body_bytes),
    };

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ModelMapping {
        haiku: Option<String>,
        sonnet: Option<String>,
        opus: Option<String>,
        model_overrides: Option<std::collections::HashMap<String, String>>,
        codex: Option<String>,
        grok: Option<String>,
    }

    let mapping: ModelMapping = match serde_json::from_str(mapping_str) {
        Ok(m) => m,
        Err(_) if route_uses_openai_payload(route) => return body_bytes,
        Err(_) => return strip_one_m_suffix(body_bytes),
    };

    if route_uses_openai_payload(route) {
        let target_model = match route.cli_type.as_deref() {
            Some("grok") => mapping.grok.as_deref(),
            _ => mapping.codex.as_deref(),
        };
        return rewrite_request_model(body_bytes, target_model);
    }

    let mut json: serde_json::Value = match serde_json::from_slice(&body_bytes) {
        Ok(v) => v,
        Err(_) => return body_bytes,
    };

    let model = match json.get("model").and_then(|m| m.as_str()) {
        Some(m) => m.to_string(),
        None => return body_bytes,
    };

    let model_without_context = strip_one_m_model_suffix(model.trim());
    let exact_mapped = mapping.model_overrides.as_ref().and_then(|overrides| {
        overrides
            .get(model.trim())
            .or_else(|| overrides.get(model_without_context))
            .map(String::as_str)
            .map(str::trim)
            .filter(|mapped| !mapped.is_empty())
    });
    let model_lower = model_without_context.to_lowercase();

    let family_mapped = if model_lower.contains("haiku") {
        mapping.haiku.as_deref().map(|m| m.to_string())
    } else if model_lower.contains("opus") {
        mapping.opus.as_deref().map(|m| m.to_string())
    } else if model_lower.contains("sonnet") {
        mapping.sonnet.as_deref().map(|m| m.to_string())
    } else {
        None
    };
    let mapped = exact_mapped
        .map(str::to_string)
        .or_else(|| family_mapped.map(|mapped| mapped.trim().to_string()))
        .filter(|mapped| !mapped.is_empty());

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

fn rewrite_request_model(
    body_bytes: axum::body::Bytes,
    target_model: Option<&str>,
) -> axum::body::Bytes {
    let target_model = match target_model.map(str::trim) {
        Some(model) if !model.is_empty() => model,
        _ => return body_bytes,
    };

    let mut json: serde_json::Value = match serde_json::from_slice(&body_bytes) {
        Ok(value) => value,
        Err(_) => return body_bytes,
    };

    if !json.get("model").is_some_and(serde_json::Value::is_string) {
        return body_bytes;
    }

    json["model"] = serde_json::Value::String(target_model.to_string());
    axum::body::Bytes::from(serde_json::to_vec(&json).unwrap_or_else(|_| body_bytes.to_vec()))
}

fn ensure_chat_completion_response_model(body: &mut Vec<u8>, request_model: Option<&str>) -> bool {
    let request_model = match request_model.map(str::trim) {
        Some(model) if !model.is_empty() => model,
        _ => return false,
    };
    let mut json = match serde_json::from_slice::<serde_json::Value>(body) {
        Ok(serde_json::Value::Object(object)) => serde_json::Value::Object(object),
        _ => return false,
    };
    if json.get("model").is_some() {
        return false;
    }
    if !matches!(
        json.get("object").and_then(|value| value.as_str()),
        Some("chat.completion" | "chat.completion.chunk")
    ) {
        return false;
    }

    json["model"] = serde_json::Value::String(request_model.to_string());
    match serde_json::to_vec(&json) {
        Ok(normalized) => {
            *body = normalized;
            true
        }
        Err(_) => false,
    }
}

fn normalize_sse_model_lines(bytes: &[u8], request_model: &str) -> Vec<u8> {
    let mut normalized = Vec::with_capacity(bytes.len());
    for line in bytes.split_inclusive(|byte| *byte == b'\n') {
        let (content, line_ending) = if let Some(content) = line.strip_suffix(b"\r\n") {
            (content, b"\r\n".as_slice())
        } else if let Some(content) = line.strip_suffix(b"\n") {
            (content, b"\n".as_slice())
        } else {
            (line, b"".as_slice())
        };
        let Some(mut payload) = content.strip_prefix(b"data:") else {
            normalized.extend_from_slice(line);
            continue;
        };
        while payload.first().is_some_and(u8::is_ascii_whitespace) {
            payload = &payload[1..];
        }
        if payload == b"[DONE]" {
            normalized.extend_from_slice(line);
            continue;
        }

        let mut json = payload.to_vec();
        if ensure_chat_completion_response_model(&mut json, Some(request_model)) {
            normalized.extend_from_slice(b"data: ");
            normalized.extend_from_slice(&json);
            normalized.extend_from_slice(line_ending);
        } else {
            normalized.extend_from_slice(line);
        }
    }
    normalized
}

struct SseModelNormalizingStream<S> {
    inner: S,
    request_model: Option<String>,
    buffer: Vec<u8>,
    pending_error: Option<reqwest::Error>,
    finished: bool,
}

impl<S> SseModelNormalizingStream<S> {
    fn new(inner: S, request_model: Option<String>) -> Self {
        Self {
            inner,
            request_model,
            buffer: Vec::new(),
            pending_error: None,
            finished: false,
        }
    }
}

impl<S> Stream for SseModelNormalizingStream<S>
where
    S: Stream<Item = Result<axum::body::Bytes, reqwest::Error>> + Unpin,
{
    type Item = Result<axum::body::Bytes, reqwest::Error>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        let Some(request_model) = this.request_model.clone() else {
            return Pin::new(&mut this.inner).poll_next(cx);
        };
        if let Some(error) = this.pending_error.take() {
            return Poll::Ready(Some(Err(error)));
        }
        if this.finished {
            return Poll::Ready(None);
        }

        loop {
            match Pin::new(&mut this.inner).poll_next(cx) {
                Poll::Ready(Some(Ok(bytes))) => {
                    this.buffer.extend_from_slice(&bytes);
                    let Some(last_newline) = this.buffer.iter().rposition(|byte| *byte == b'\n')
                    else {
                        if this.buffer.len() > MAX_SSE_MODEL_NORMALIZATION_LINE_BYTES {
                            // A malformed or exceptionally large event must not stall the
                            // downstream client or grow memory without bound. Once the limit is
                            // crossed, flush what we have and pass through the rest of this stream.
                            this.request_model = None;
                            return Poll::Ready(Some(Ok(axum::body::Bytes::from(std::mem::take(
                                &mut this.buffer,
                            )))));
                        }
                        continue;
                    };
                    let complete = this.buffer.drain(..=last_newline).collect::<Vec<_>>();
                    return Poll::Ready(Some(Ok(axum::body::Bytes::from(
                        normalize_sse_model_lines(&complete, &request_model),
                    ))));
                }
                Poll::Ready(Some(Err(error))) => {
                    if this.buffer.is_empty() {
                        return Poll::Ready(Some(Err(error)));
                    }
                    this.pending_error = Some(error);
                    let remaining = std::mem::take(&mut this.buffer);
                    return Poll::Ready(Some(Ok(axum::body::Bytes::from(
                        normalize_sse_model_lines(&remaining, &request_model),
                    ))));
                }
                Poll::Ready(None) => {
                    this.finished = true;
                    if this.buffer.is_empty() {
                        return Poll::Ready(None);
                    }
                    let remaining = std::mem::take(&mut this.buffer);
                    return Poll::Ready(Some(Ok(axum::body::Bytes::from(
                        normalize_sse_model_lines(&remaining, &request_model),
                    ))));
                }
                Poll::Pending => return Poll::Pending,
            }
        }
    }
}

fn route_uses_openai_payload(route: &RouteExecution) -> bool {
    matches!(
        route.cli_type.as_deref(),
        Some("codex") | Some("codex-app") | Some("grok")
    )
}

fn route_uses_bearer_auth(route: &RouteExecution, req_path: &str) -> bool {
    match route.auth_scheme {
        Some(UpstreamAuthScheme::Bearer) => return true,
        Some(UpstreamAuthScheme::XApiKey) => return false,
        Some(UpstreamAuthScheme::None) => return false,
        None => {}
    }

    match route.cli_type.as_deref() {
        Some("codex") | Some("codex-app") | Some("grok") => true,
        Some("claude") | Some("claude_code") | Some("claude_desktop") => false,
        Some(_) => false,
        None if is_codex_responses_request_path(req_path) => true,
        None => {
            let upstream_url_lower = route.upstream_url.to_ascii_lowercase();
            !upstream_url_lower.contains("anthropic")
                && (upstream_url_lower.contains("openai")
                    || upstream_url_lower.contains("/responses")
                    || req_path.contains("/responses"))
        }
    }
}

fn apply_upstream_auth_headers(
    headers: &mut HeaderMap,
    route: &RouteExecution,
    req_path: &str,
) -> Result<(), &'static str> {
    let Some(real_api_key) = route.real_api_key.as_deref() else {
        return Ok(());
    };

    if route.auth_scheme == Some(UpstreamAuthScheme::None) {
        headers.remove("x-api-key");
        headers.remove("authorization");
        return Ok(());
    }

    if route_uses_bearer_auth(route, req_path) {
        let bearer = format!("Bearer {}", real_api_key);
        let value =
            HeaderValue::from_str(&bearer).map_err(|_| "API key contains invalid characters")?;
        headers.insert("authorization", value);
        headers.remove("x-api-key");
    } else {
        let value = HeaderValue::from_str(real_api_key)
            .map_err(|_| "API key contains invalid characters")?;
        headers.insert("x-api-key", value);
        headers.remove("authorization");
    }

    Ok(())
}

fn strip_hop_by_hop_headers(headers: &mut HeaderMap) {
    let connection_headers = headers
        .get_all("connection")
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .filter_map(|value| value.parse::<axum::http::header::HeaderName>().ok())
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

fn read_auth_scheme(config: &serde_json::Value) -> Option<UpstreamAuthScheme> {
    match config.get("authScheme").and_then(|value| value.as_str()) {
        Some("bearer") => Some(UpstreamAuthScheme::Bearer),
        Some("x-api-key") => Some(UpstreamAuthScheme::XApiKey),
        Some("none") => Some(UpstreamAuthScheme::None),
        _ => None,
    }
}

/// Strips the [1M] suffix that Claude Code appends to model names for 1M context.
const ONE_M_MARKER: &str = "[1M]";

fn strip_one_m_model_suffix(model: &str) -> &str {
    let trimmed = model.trim_end();
    let bytes = trimmed.as_bytes();
    let marker = ONE_M_MARKER.as_bytes();

    if bytes.len() >= marker.len()
        && bytes[bytes.len() - marker.len()..].eq_ignore_ascii_case(marker)
    {
        trimmed[..trimmed.len() - marker.len()].trim_end()
    } else {
        model
    }
}

fn strip_one_m_suffix(body_bytes: axum::body::Bytes) -> axum::body::Bytes {
    let mut json: serde_json::Value = match serde_json::from_slice(&body_bytes) {
        Ok(v) => v,
        Err(_) => return body_bytes,
    };

    let model = match json.get("model").and_then(|m| m.as_str()) {
        Some(m) => m,
        None => return body_bytes,
    };

    let stripped = strip_one_m_model_suffix(model);
    if stripped != model {
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

async fn collect_response_body_limited<S>(mut stream: S, limit: usize) -> Result<Vec<u8>, String>
where
    S: Stream<Item = Result<axum::body::Bytes, reqwest::Error>> + Unpin,
{
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("Failed to read response: {}", error))?;
        if body.len().saturating_add(chunk.len()) > limit {
            return Err("Upstream response exceeds local size limit".to_string());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn decompress_limited(data: &[u8], encoding: &str, limit: usize) -> Result<Vec<u8>, String> {
    let encodings = encoding
        .split(',')
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty() && value != "identity")
        .collect::<Vec<_>>();
    if encodings.is_empty() {
        return if data.len() <= limit {
            Ok(data.to_vec())
        } else {
            Err("Decoded response exceeds local capture limit".to_string())
        };
    };

    let mut decoded = data.to_vec();
    for current_encoding in encodings.iter().rev() {
        decoded = match current_encoding.as_str() {
            "gzip" => read_decoded_limited(flate2::read::GzDecoder::new(decoded.as_slice()), limit),
            "br" => {
                read_decoded_limited(brotli::Decompressor::new(decoded.as_slice(), 4096), limit)
            }
            "deflate" => decode_deflate_limited(&decoded, limit),
            unsupported => {
                return Err(format!(
                    "Unsupported response content encoding: {}",
                    unsupported
                ))
            }
        }?;
    }

    Ok(decoded)
}

fn read_decoded_limited<R: std::io::Read>(reader: R, limit: usize) -> Result<Vec<u8>, String> {
    use std::io::Read;

    let mut decoded = Vec::new();
    reader
        .take(limit as u64 + 1)
        .read_to_end(&mut decoded)
        .map_err(|error| format!("Failed to decode bounded response: {}", error))?;
    if decoded.len() > limit {
        Err("Decoded response exceeds local capture limit".to_string())
    } else {
        Ok(decoded)
    }
}

fn decode_deflate_limited(data: &[u8], limit: usize) -> Result<Vec<u8>, String> {
    read_decoded_limited(flate2::read::ZlibDecoder::new(data), limit)
        .or_else(|_| read_decoded_limited(flate2::read::DeflateDecoder::new(data), limit))
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
    request_id: String,
    method: String,
    path: String,
    upstream_url: String,
    start_time: std::time::Instant,
    status: u16,
    provider_name: Option<String>,
    key_alias: Option<String>,
    /// Request headers captured at entry, for detail-mode emission.
    request_headers: hyper::HeaderMap,
    /// Request body captured at entry, for detail-mode emission.
    request_body: Vec<u8>,
    /// Upstream response headers captured before body streaming begins.
    response_headers: hyper::HeaderMap,
}

fn has_billable_usage(usage: &usage_parser::TokenUsage) -> bool {
    usage.input_tokens > 0
        || usage.output_tokens > 0
        || usage.cache_read_tokens > 0
        || usage.cache_creation_tokens > 0
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
    /// Upstream `Content-Encoding` (gzip/br/deflate or empty). reqwest is built
    /// without auto-decompression, so the streaming path must decompress itself.
    content_encoding: String,
    /// Snapshot of detail-mode at stream start. If it was enabled, buffer enough
    /// bytes to render response details even for non-billable streams.
    detail_capture: bool,
    /// Bounded capture used for compressed usage parsing or Console details.
    /// Bytes forwarded to the client are always the untouched originals.
    capture_buffer: Vec<u8>,
    capture_truncated: bool,
    _request_permits: Option<RequestPermits>,
}

impl<S> UsageTrackingStream<S> {
    fn finalize_usage(&mut self) -> bool {
        self.accumulator.flush();
        let Some(log_ctx) = self.log_ctx.take() else {
            return false;
        };
        let Some(usage) = self.accumulator.get_usage() else {
            return false;
        };
        if has_billable_usage(&usage) {
            record_usage(&log_ctx, &usage, self.accumulator.model.as_deref(), true);
            true
        } else {
            false
        }
    }

    fn parse_compressed_capture(&mut self) {
        if self.content_encoding.is_empty() || self.capture_buffer.is_empty() {
            return;
        }
        match decompress_limited(
            &self.capture_buffer,
            &self.content_encoding,
            MAX_DECOMPRESSED_CAPTURE_BYTES,
        ) {
            Ok(decoded) => self.accumulator.process_bytes(&decoded),
            Err(error) => {
                log::debug!("Compressed stream capture is not parseable: {}", error);
            }
        }
    }

    fn emit_cancelled(&mut self) {
        let Some(ctx) = self.console_ctx.take() else {
            return;
        };
        ctx.state.emit_console(ConsoleEvent::cancelled(
            &ctx.request_id,
            &ctx.method,
            &ctx.path,
            Some(ctx.status),
            ctx.start_time.elapsed().as_millis() as u64,
            &ctx.upstream_url,
            ctx.provider_name.as_deref(),
            ctx.key_alias.as_deref(),
        ));
    }
}

impl<S> Drop for UsageTrackingStream<S> {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        self.finished = true;
        self.parse_compressed_capture();
        let _ = self.finalize_usage();
        self.emit_cancelled();
    }
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
                if this.content_encoding.is_empty() {
                    if this.log_ctx.is_some() {
                        this.accumulator.process_bytes(&bytes);
                    }
                    if this.detail_capture {
                        append_bounded_tail(
                            &mut this.capture_buffer,
                            &bytes,
                            MAX_STREAM_DETAIL_CAPTURE_BYTES,
                        );
                    }
                } else if !this.capture_truncated && (this.log_ctx.is_some() || this.detail_capture)
                {
                    if this.capture_buffer.len().saturating_add(bytes.len())
                        <= MAX_COMPRESSED_STREAM_CAPTURE_BYTES
                    {
                        this.capture_buffer.extend_from_slice(&bytes);
                    } else {
                        this.capture_buffer.clear();
                        this.capture_truncated = true;
                        log::warn!(
                            "Compressed stream capture exceeded local limit; usage/details skipped"
                        );
                    }
                }
                Poll::Ready(Some(Ok(bytes)))
            }
            Poll::Ready(Some(Err(e))) => {
                this.finished = true;

                // Flush accumulated usage before reporting error.
                this.parse_compressed_capture();
                let _ = this.finalize_usage();

                let err_text = e.to_string();
                if let Some(ctx) = this.console_ctx.take() {
                    ctx.state.emit_console(ConsoleEvent::upstream_error(
                        &ctx.request_id,
                        &ctx.method,
                        &ctx.path,
                        ctx.start_time.elapsed().as_millis() as u64,
                        &ctx.upstream_url,
                        ctx.provider_name.as_deref(),
                        ctx.key_alias.as_deref(),
                        &err_text,
                    ));
                }
                Poll::Ready(Some(Err(std::io::Error::other(err_text))))
            }
            Poll::Ready(None) => {
                this.finished = true;
                let decoded = if this.capture_buffer.is_empty() {
                    Vec::new()
                } else if this.content_encoding.is_empty() {
                    std::mem::take(&mut this.capture_buffer)
                } else {
                    decompress_limited(
                        &this.capture_buffer,
                        &this.content_encoding,
                        MAX_DECOMPRESSED_CAPTURE_BYTES,
                    )
                    .unwrap_or_else(|error| {
                        log::warn!("Skipping compressed stream capture: {}", error);
                        Vec::new()
                    })
                };
                if let Some(log_ctx) = this.log_ctx.as_ref() {
                    let diagnostics = (
                        log_ctx.path.clone(),
                        log_ctx.status_code,
                        log_ctx.response_content_type.clone(),
                    );
                    if !this.content_encoding.is_empty() && !decoded.is_empty() {
                        this.accumulator.process_bytes(&decoded);
                    }
                    if !this.finalize_usage() {
                        log::debug!(
                            "Usage not recorded: no usage parsed from streaming response; path={}, status={}, content_type={}, diagnostics={}",
                            diagnostics.0,
                            diagnostics.1,
                            diagnostics.2,
                            this.accumulator.diagnostics_summary()
                        );
                    }
                }
                if let Some(ctx) = this.console_ctx.take() {
                    let detail_mode = this.detail_capture;
                    let request_content_type = ctx
                        .request_headers
                        .get("content-type")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("");
                    let response_content_type = ctx
                        .response_headers
                        .get("content-type")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("");
                    let (req_h, req_b, _resp_h, _resp_b) =
                        crate::proxy::console::build_detail_fields_with_content_type(
                            &ctx.request_headers,
                            &ctx.request_body,
                            &ctx.response_headers,
                            &decoded,
                            request_content_type,
                            response_content_type,
                            detail_mode,
                        );
                    let mut evt = ConsoleEvent::ok(
                        &ctx.request_id,
                        &ctx.method,
                        &ctx.path,
                        ctx.status,
                        ctx.start_time.elapsed().as_millis() as u64,
                        &ctx.upstream_url,
                        ctx.provider_name.as_deref(),
                        ctx.key_alias.as_deref(),
                        true,
                    );
                    if detail_mode {
                        if let ConsoleEvent::Request {
                            ref mut request_headers,
                            ref mut request_body,
                            ref mut response_headers,
                            ref mut response_body,
                            ..
                        } = evt
                        {
                            *request_headers = req_h;
                            *request_body = req_b;
                            *response_headers = _resp_h;
                            *response_body = _resp_b;
                        }
                    }
                    ctx.state.emit_console(evt);
                }
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

fn append_bounded_tail(buffer: &mut Vec<u8>, chunk: &[u8], limit: usize) {
    if chunk.len() >= limit {
        buffer.clear();
        buffer.extend_from_slice(&chunk[chunk.len() - limit..]);
        return;
    }

    let overflow = buffer
        .len()
        .saturating_add(chunk.len())
        .saturating_sub(limit);
    if overflow > 0 {
        buffer.drain(..overflow);
    }
    buffer.extend_from_slice(chunk);
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

trait WebSocketIo: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send {}
impl<T> WebSocketIo for T where T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send {}

type BoxedWebSocketIo = Box<dyn WebSocketIo>;
type UpstreamWebSocket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<BoxedWebSocketIo>>;

fn build_upstream_ws_request(
    upstream_url: &str,
    incoming_headers: &HeaderMap,
    route: &RouteExecution,
    req_path: &str,
) -> Result<tokio_tungstenite::tungstenite::http::Request<()>, String> {
    use tokio_tungstenite::tungstenite;

    let mut forwarded_headers = incoming_headers.clone();
    apply_upstream_auth_headers(&mut forwarded_headers, route, req_path).map_err(str::to_string)?;
    strip_hop_by_hop_headers(&mut forwarded_headers);
    for name in [
        "host",
        "content-length",
        "sec-websocket-key",
        "sec-websocket-version",
        "sec-websocket-extensions",
    ] {
        forwarded_headers.remove(name);
    }

    let mut request = tungstenite::http::Request::builder()
        .uri(upstream_url)
        .header("Host", extract_host(upstream_url).unwrap_or_default())
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Sec-WebSocket-Version", "13")
        .header(
            "Sec-WebSocket-Key",
            tungstenite::handshake::client::generate_key(),
        )
        .body(())
        .map_err(|error| format!("Failed to build upstream WebSocket request: {}", error))?;
    for (name, value) in &forwarded_headers {
        request.headers_mut().append(name.clone(), value.clone());
    }

    Ok(request)
}

async fn connect_upstream_websocket(
    request: tokio_tungstenite::tungstenite::http::Request<()>,
    proxy_url: Option<&str>,
) -> Result<
    (
        UpstreamWebSocket,
        tokio_tungstenite::tungstenite::handshake::client::Response,
    ),
    String,
> {
    let proxy_url = proxy_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    match tokio::time::timeout(WS_CONNECT_TIMEOUT, async move {
        let upstream_url = url::Url::parse(&request.uri().to_string())
            .map_err(|error| format!("Invalid upstream WebSocket URL: {}", error))?;
        let stream = open_websocket_transport(&upstream_url, proxy_url.as_deref()).await?;
        let config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
            .max_message_size(Some(MAX_WS_MESSAGE_BYTES))
            .max_frame_size(Some(MAX_WS_FRAME_BYTES))
            .max_write_buffer_size(MAX_WS_WRITE_BUFFER_BYTES);
        tokio_tungstenite::client_async_tls_with_config(request, stream, Some(config), None)
            .await
            .map_err(|error| format!("Upstream WebSocket error: {}", error))
    })
    .await
    {
        Ok(Ok(connection)) => Ok(connection),
        Ok(Err(error)) => Err(error),
        Err(_) => Err(format!(
            "Upstream WebSocket connection timed out after {} seconds",
            WS_CONNECT_TIMEOUT.as_secs()
        )),
    }
}

async fn open_websocket_transport(
    upstream_url: &url::Url,
    proxy_url: Option<&str>,
) -> Result<BoxedWebSocketIo, String> {
    let upstream_host = upstream_url
        .host_str()
        .ok_or_else(|| "Upstream WebSocket URL has no host".to_string())?;
    let upstream_port = upstream_url
        .port_or_known_default()
        .ok_or_else(|| "Upstream WebSocket URL has no port".to_string())?;

    let Some(proxy_url) = proxy_url else {
        let stream = tokio::net::TcpStream::connect((upstream_host, upstream_port))
            .await
            .map_err(|error| format!("Failed to connect upstream WebSocket: {}", error))?;
        stream
            .set_nodelay(true)
            .map_err(|error| format!("Failed to configure upstream WebSocket: {}", error))?;
        return Ok(Box::new(stream));
    };

    let parsed_proxy = url::Url::parse(proxy_url)
        .map_err(|error| format!("Invalid WebSocket proxy URL: {}", error))?;
    if !matches!(parsed_proxy.scheme(), "http" | "https") {
        return Err("WebSocket proxy must use http:// or https://".to_string());
    }
    let proxy_host = parsed_proxy
        .host_str()
        .ok_or_else(|| "WebSocket proxy URL has no host".to_string())?;
    let proxy_port = parsed_proxy
        .port_or_known_default()
        .ok_or_else(|| "WebSocket proxy URL has no port".to_string())?;
    let tcp = tokio::net::TcpStream::connect((proxy_host, proxy_port))
        .await
        .map_err(|error| format!("Failed to connect WebSocket proxy: {}", error))?;
    tcp.set_nodelay(true)
        .map_err(|error| format!("Failed to configure WebSocket proxy: {}", error))?;

    let mut stream: BoxedWebSocketIo = if parsed_proxy.scheme() == "https" {
        let connector = tokio_native_tls::native_tls::TlsConnector::new()
            .map_err(|error| format!("Failed to create WebSocket proxy TLS: {}", error))?;
        let connector = tokio_native_tls::TlsConnector::from(connector);
        let tls = connector
            .connect(proxy_host, tcp)
            .await
            .map_err(|error| format!("Failed to establish WebSocket proxy TLS: {}", error))?;
        Box::new(tls)
    } else {
        Box::new(tcp)
    };

    let authority = format_host_port(upstream_host, upstream_port);
    establish_http_connect_tunnel(&mut stream, &authority, &parsed_proxy).await?;
    Ok(stream)
}

async fn establish_http_connect_tunnel(
    stream: &mut BoxedWebSocketIo,
    authority: &str,
    proxy_url: &url::Url,
) -> Result<(), String> {
    use base64::Engine as _;
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

    let proxy_authorization = if proxy_url.username().is_empty() {
        String::new()
    } else {
        let username = urlencoding::decode(proxy_url.username())
            .map_err(|_| "Invalid WebSocket proxy username".to_string())?;
        let password = proxy_url
            .password()
            .map(urlencoding::decode)
            .transpose()
            .map_err(|_| "Invalid WebSocket proxy password".to_string())?
            .unwrap_or_default();
        let credential =
            base64::engine::general_purpose::STANDARD.encode(format!("{}:{}", username, password));
        format!("Proxy-Authorization: Basic {}\r\n", credential)
    };
    let request =
        format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n{proxy_authorization}\r\n");
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|error| format!("Failed to write WebSocket proxy CONNECT: {}", error))?;
    stream
        .flush()
        .await
        .map_err(|error| format!("Failed to flush WebSocket proxy CONNECT: {}", error))?;

    const MAX_PROXY_RESPONSE_HEADER_BYTES: usize = 16 * 1024;
    let mut response = Vec::new();
    let mut chunk = [0u8; 1024];
    while !response.windows(4).any(|window| window == b"\r\n\r\n") {
        let read = stream
            .read(&mut chunk)
            .await
            .map_err(|error| format!("Failed to read WebSocket proxy CONNECT: {}", error))?;
        if read == 0 {
            return Err("WebSocket proxy closed during CONNECT".to_string());
        }
        if response.len().saturating_add(read) > MAX_PROXY_RESPONSE_HEADER_BYTES {
            return Err("WebSocket proxy CONNECT response header is too large".to_string());
        }
        response.extend_from_slice(&chunk[..read]);
    }

    let status_line = String::from_utf8_lossy(&response)
        .lines()
        .next()
        .unwrap_or_default()
        .to_string();
    let status = status_line.split_whitespace().nth(1).unwrap_or_default();
    if status != "200" {
        return Err(format!("WebSocket proxy CONNECT failed: {}", status_line));
    }
    Ok(())
}

fn format_host_port(host: &str, port: u16) -> String {
    if host.contains(':') {
        format!("[{}]:{}", host, port)
    } else {
        format!("{}:{}", host, port)
    }
}

fn axum_close_to_upstream(
    frame: Option<AxumCloseFrame>,
) -> Option<tokio_tungstenite::tungstenite::protocol::CloseFrame> {
    frame.map(
        |frame| tokio_tungstenite::tungstenite::protocol::CloseFrame {
            code: frame.code.into(),
            reason: frame.reason.to_string().into(),
        },
    )
}

fn upstream_close_to_axum(
    frame: Option<tokio_tungstenite::tungstenite::protocol::CloseFrame>,
) -> Option<AxumCloseFrame> {
    frame.map(|frame| AxumCloseFrame {
        code: frame.code.into(),
        reason: frame.reason.to_string().into(),
    })
}

async fn ws_relay(mut client: WebSocket, mut upstream: UpstreamWebSocket) {
    use tokio_tungstenite::tungstenite;

    let mut close_sent_to_client = false;
    let mut close_sent_to_upstream = false;

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
                    Some(Ok(WsMessage::Close(frame))) => {
                        close_sent_to_upstream = upstream
                            .send(tungstenite::Message::Close(axum_close_to_upstream(frame)))
                            .await
                            .is_ok();
                        break;
                    }
                    None => break,
                    Some(Err(error)) => {
                        log::debug!("Client WebSocket closed with error: {}", error);
                        break;
                    }
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
                    Some(Ok(tungstenite::Message::Close(frame))) => {
                        close_sent_to_client = client
                            .send(WsMessage::Close(upstream_close_to_axum(frame)))
                            .await
                            .is_ok();
                        break;
                    }
                    Some(Ok(_)) => {}
                    None => break,
                    Some(Err(error)) => {
                        log::debug!("Upstream WebSocket closed with error: {}", error);
                        break;
                    }
                }
            }
        }
    }

    if !close_sent_to_client {
        let _ = client.close().await;
    }
    if !close_sent_to_upstream {
        let _ = upstream.close(None).await;
    }
}

fn extract_host(url: &str) -> Option<String> {
    url::Url::parse(url).ok().and_then(|url| {
        url.host_str().map(|host| {
            let host = if host.contains(':') {
                format!("[{}]", host)
            } else {
                host.to_string()
            };
            if let Some(port) = url.port() {
                format!("{}:{}", host, port)
            } else {
                host
            }
        })
    })
}

#[cfg(test)]
mod tests {
    use super::{
        api_key_supports_session_client, append_bounded_tail, apply_model_mapping,
        build_upstream_ws_request, collect_response_body_limited, decompress_limited,
        effective_session_cli_type, has_billable_usage, is_codex_responses_request_path,
        record_usage, route_plan_with_codex_takeover_fallback, route_uses_bearer_auth,
        session_client_config_key, should_forward_response_header, strip_hop_by_hop_headers,
        LogContext, RequestCancellationGuard, RouteExecution, SseModelNormalizingStream,
        StreamConsoleCtx, UpstreamAuthScheme, UsageTrackingStream,
        MAX_SSE_MODEL_NORMALIZATION_LINE_BYTES,
    };
    use crate::db::Database;
    use crate::models::{CreateApiKeyInput, CreateProviderInput, ProxySession};
    use crate::proxy::console::ConsoleEvent;
    use crate::proxy::usage_parser;
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
    fn request_header_filter_removes_connection_nominated_headers() {
        let mut headers = hyper::HeaderMap::new();
        headers.insert("connection", "keep-alive, x-local-hop".parse().unwrap());
        headers.insert("keep-alive", "timeout=5".parse().unwrap());
        headers.insert("x-local-hop", "remove-me".parse().unwrap());
        headers.insert("user-agent", "cc-client/1.0".parse().unwrap());

        strip_hop_by_hop_headers(&mut headers);

        assert!(!headers.contains_key("connection"));
        assert!(!headers.contains_key("keep-alive"));
        assert!(!headers.contains_key("x-local-hop"));
        assert_eq!(headers["user-agent"], "cc-client/1.0");
    }

    #[tokio::test]
    async fn dropping_inflight_request_guard_emits_cancelled_without_upstream_status() {
        let state = crate::proxy::build_proxy_state(std::sync::Arc::new(std::sync::Mutex::new(
            Database::new_in_memory().unwrap(),
        )))
        .unwrap();
        let mut rx = state.console_tx.subscribe();

        let guard = RequestCancellationGuard::new(
            state,
            "request-inflight",
            "POST",
            "/v1/messages",
            "https://example.com/v1/messages",
            Some("provider".to_string()),
            Some("key".to_string()),
            std::time::Instant::now(),
        );
        drop(guard);

        let event = tokio::time::timeout(std::time::Duration::from_millis(200), rx.recv())
            .await
            .expect("cancelled event should be emitted")
            .expect("cancelled event should be readable");
        match event {
            ConsoleEvent::Request { kind, status, .. } => {
                assert_eq!(kind, "cancelled");
                assert_eq!(status, None);
            }
            _ => panic!("expected request event"),
        }
    }

    #[tokio::test]
    async fn non_stream_response_collection_rejects_limit_overflow() {
        let stream = futures::stream::iter(vec![
            Ok::<_, reqwest::Error>(axum::body::Bytes::from_static(b"1234")),
            Ok::<_, reqwest::Error>(axum::body::Bytes::from_static(b"5678")),
        ]);

        let error = collect_response_body_limited(stream, 7).await.unwrap_err();
        assert!(error.contains("size limit"));
    }

    #[tokio::test]
    async fn sse_model_normalizer_falls_back_after_an_oversized_incomplete_line() {
        let oversized = vec![b'x'; MAX_SSE_MODEL_NORMALIZATION_LINE_BYTES + 1];
        let next_event =
            axum::body::Bytes::from_static(b"data: {\"object\":\"chat.completion.chunk\"}\n");
        let inner = futures::stream::iter(vec![
            Ok::<_, reqwest::Error>(axum::body::Bytes::from(oversized.clone())),
            Ok::<_, reqwest::Error>(next_event.clone()),
        ]);
        let mut stream = SseModelNormalizingStream::new(inner, Some("grok-4.5".to_string()));

        let first = futures::StreamExt::next(&mut stream)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(first.as_ref(), oversized.as_slice());

        let second = futures::StreamExt::next(&mut stream)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(second, next_event);
    }

    #[test]
    fn decompression_and_detail_tail_are_bounded() {
        let compressed = gzip_compress(&vec![b'a'; 1024]);
        assert!(decompress_limited(&compressed, "gzip", 100).is_err());

        let mut tail = b"1234".to_vec();
        append_bounded_tail(&mut tail, b"56789", 6);
        assert_eq!(tail, b"456789");
    }

    #[test]
    fn gzip_brotli_and_zlib_deflate_captures_decode_with_limits() {
        let sample = b"transparent gateway";
        assert_eq!(
            decompress_limited(&gzip_compress(sample), "gzip", 1024).unwrap(),
            sample
        );
        assert_eq!(
            decompress_limited(&brotli_compress(sample), "br", 1024).unwrap(),
            sample
        );
        assert_eq!(
            decompress_limited(&zlib_compress(sample), "deflate", 1024).unwrap(),
            sample
        );

        let nested = brotli_compress(&gzip_compress(sample));
        assert_eq!(
            decompress_limited(&nested, "gzip, br", 1024).unwrap(),
            sample
        );
        assert!(decompress_limited(sample, "zstd", 1024).is_err());
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

    fn route_for_auth(cli_type: Option<&str>, upstream_url: &str) -> RouteExecution {
        RouteExecution {
            upstream_url: upstream_url.to_string(),
            real_api_key: Some("sk-test".to_string()),
            model_mapping: None,
            auth_scheme: None,
            log_ctx: None,
            provider: None,
            cli_type: cli_type.map(str::to_string),
        }
    }

    fn route_for_auth_with_scheme(
        cli_type: Option<&str>,
        upstream_url: &str,
        auth_scheme: UpstreamAuthScheme,
    ) -> RouteExecution {
        RouteExecution {
            auth_scheme: Some(auth_scheme),
            ..route_for_auth(cli_type, upstream_url)
        }
    }

    #[test]
    fn claude_clients_use_x_api_key_even_for_custom_base_urls() {
        for cli_type in ["claude_code", "claude_desktop"] {
            let route = route_for_auth(Some(cli_type), "https://gateway.example.com/v1/messages");
            assert!(
                !route_uses_bearer_auth(&route, "/v1/messages"),
                "{cli_type} should use x-api-key"
            );
        }
    }

    #[test]
    fn codex_clients_use_bearer_even_for_non_openai_base_urls() {
        let route = route_for_auth(
            Some("codex-app"),
            "https://gateway.example.com/v1/responses",
        );
        assert!(route_uses_bearer_auth(&route, "/v1/responses"));

        let legacy_route = route_for_auth(None, "https://gateway.example.com/v1/responses");
        assert!(route_uses_bearer_auth(&legacy_route, "/v1/responses"));
    }

    #[test]
    fn codex_app_sessions_read_the_codex_client_config() {
        assert_eq!(session_client_config_key(Some("codex-app")), "codex");
        assert_eq!(session_client_config_key(Some("claude")), "claude_code");
        assert_eq!(
            session_client_config_key(Some("claude_desktop")),
            "claude_desktop"
        );
    }

    #[test]
    fn grok_uses_bearer_and_its_own_model_mapping() {
        let mut route = route_for_auth(Some("grok"), "https://gateway.example.com/v1/responses");
        route.model_mapping =
            Some(r#"{"codex":"codex-upstream","grok":"grok-upstream"}"#.to_string());

        assert!(route_uses_bearer_auth(&route, "/v1/responses"));
        let mapped = apply_model_mapping(
            axum::body::Bytes::from_static(br#"{"model":"grok-build"}"#),
            &route,
        );
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&mapped).unwrap()["model"],
            "grok-upstream"
        );
    }

    #[test]
    fn grok_session_requires_a_grok_enabled_key() {
        let db = Database::new_in_memory().unwrap();
        let provider = db
            .provider_create(&CreateProviderInput {
                name: "grok-provider".to_string(),
                base_url: "https://api.x.ai/v1".to_string(),
                http_proxy: None,
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
            })
            .unwrap();
        let grok_key = db
            .api_key_create(&CreateApiKeyInput {
                provider_id: provider.id.clone(),
                alias: None,
                value: "xai-key".to_string(),
                types: Some(vec!["grok".to_string()]),
                priority: None,
                is_active: None,
                config: None,
                cost_multiplier: None,
                usage_type: None,
                usage_url: None,
                usage_path: None,
                usage_headers: None,
                model_mapping: None,
                client_configs: None,
            })
            .unwrap();
        let mut claude_key = grok_key.clone();
        claude_key.types = vec!["claude_code".to_string()];

        assert!(api_key_supports_session_client(&grok_key, Some("grok")));
        assert!(!api_key_supports_session_client(&claude_key, Some("grok")));
    }

    #[test]
    fn client_auth_scheme_override_wins_over_default() {
        let claude_route = route_for_auth_with_scheme(
            Some("claude_code"),
            "https://gateway.example.com/v1/messages",
            UpstreamAuthScheme::Bearer,
        );
        assert!(route_uses_bearer_auth(&claude_route, "/v1/messages"));

        let codex_route = route_for_auth_with_scheme(
            Some("codex-app"),
            "https://gateway.example.com/v1/responses",
            UpstreamAuthScheme::XApiKey,
        );
        assert!(!route_uses_bearer_auth(&codex_route, "/v1/responses"));
    }

    #[test]
    fn websocket_handshake_preserves_client_metadata_and_replaces_auth() {
        let route = route_for_auth(Some("codex-app"), "https://gateway.example.com/v1/realtime");
        let mut headers = hyper::HeaderMap::new();
        headers.insert(
            "authorization",
            "Bearer session-local-token".parse().unwrap(),
        );
        headers.insert("user-agent", "codex-cli/9.9".parse().unwrap());
        headers.insert("origin", "https://desktop.local".parse().unwrap());
        headers.insert(
            "sec-websocket-protocol",
            "realtime, openai-insecure-api-key".parse().unwrap(),
        );
        headers.insert(
            "sec-websocket-key",
            "dGhlIHNhbXBsZSBub25jZQ==".parse().unwrap(),
        );
        headers.insert("openai-beta", "realtime=v1".parse().unwrap());
        headers.insert("connection", "Upgrade, x-local-hop".parse().unwrap());
        headers.insert("x-local-hop", "remove-me".parse().unwrap());

        let request = build_upstream_ws_request(
            "wss://gateway.example.com/v1/realtime",
            &headers,
            &route,
            "/v1/realtime",
        )
        .unwrap();

        assert_eq!(request.headers()["host"], "gateway.example.com");
        assert_eq!(request.headers()["user-agent"], "codex-cli/9.9");
        assert_eq!(request.headers()["origin"], "https://desktop.local");
        assert_eq!(request.headers()["openai-beta"], "realtime=v1");
        assert_eq!(
            request.headers()["sec-websocket-protocol"],
            "realtime, openai-insecure-api-key"
        );
        assert_eq!(request.headers()["authorization"], "Bearer sk-test");
        assert!(!request.headers().contains_key("x-api-key"));
        assert!(!request.headers().contains_key("x-local-hop"));
        assert_ne!(
            request.headers()["sec-websocket-key"],
            headers["sec-websocket-key"]
        );
    }

    #[test]
    fn websocket_handshake_honors_x_api_key_and_no_auth_overrides() {
        let incoming = hyper::HeaderMap::new();
        let x_api_route = route_for_auth_with_scheme(
            Some("codex-app"),
            "https://gateway.example.com/v1/realtime",
            UpstreamAuthScheme::XApiKey,
        );
        let x_api_request = build_upstream_ws_request(
            "wss://gateway.example.com/v1/realtime",
            &incoming,
            &x_api_route,
            "/v1/realtime",
        )
        .unwrap();
        assert_eq!(x_api_request.headers()["x-api-key"], "sk-test");
        assert!(!x_api_request.headers().contains_key("authorization"));

        let no_auth_route = route_for_auth_with_scheme(
            Some("codex-app"),
            "https://gateway.example.com/v1/realtime",
            UpstreamAuthScheme::None,
        );
        let no_auth_request = build_upstream_ws_request(
            "wss://gateway.example.com/v1/realtime",
            &incoming,
            &no_auth_route,
            "/v1/realtime",
        )
        .unwrap();
        assert!(!no_auth_request.headers().contains_key("x-api-key"));
        assert!(!no_auth_request.headers().contains_key("authorization"));
    }

    #[test]
    fn cache_only_usage_is_billable_for_request_logs() {
        let usage = usage_parser::TokenUsage {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 42,
            cache_creation_tokens: 0,
        };

        assert!(has_billable_usage(&usage));
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
            session_kind: "desktop".to_string(),
            last_seen_at: chrono::Utc::now().to_rfc3339(),
            expires_at: None,
            revoked_at: None,
            revoked_reason: None,
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
                http_proxy: None,
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
        // GPT-5.5 requests above 272K input use 2x input and 1.5x output rates.
        assert!((rows[0].total_cost_usd - 55.0).abs() < 1e-6);
    }

    // ---- Streaming usage recording (Claude) regression tests ----

    fn claude_sse_sample() -> String {
        // Minimal Claude streaming response: input tokens in message_start,
        // output tokens in message_delta. Includes CJK text to exercise
        // multibyte UTF-8 handling.
        concat!(
            "event: message_start\n",
            "data: {\"type\":\"message_start\",\"message\":{\"model\":\"claude-3-5-sonnet\",\"usage\":{\"input_tokens\":1234,\"cache_read_input_tokens\":0,\"cache_creation_input_tokens\":0}}}\n\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"你好，世界🌏\"}}\n\n",
            "event: message_delta\n",
            "data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":567}}\n\n",
            "event: message_stop\n",
            "data: {\"type\":\"message_stop\"}\n\n"
        )
        .to_string()
    }

    fn gzip_compress(data: &[u8]) -> Vec<u8> {
        use flate2::write::GzEncoder;
        use flate2::Compression;
        use std::io::Write;
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(data).unwrap();
        encoder.finish().unwrap()
    }

    fn brotli_compress(data: &[u8]) -> Vec<u8> {
        use std::io::Write;
        let mut output = Vec::new();
        {
            let mut writer = brotli::CompressorWriter::new(&mut output, 4096, 5, 22);
            writer.write_all(data).unwrap();
        }
        output
    }

    fn zlib_compress(data: &[u8]) -> Vec<u8> {
        use flate2::write::ZlibEncoder;
        use flate2::Compression;
        use std::io::Write;
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(data).unwrap();
        encoder.finish().unwrap()
    }

    /// Split a byte slice into chunks of `size` bytes — deliberately ignores
    /// UTF-8 boundaries so multibyte codepoints get cut across chunks.
    fn chunk_bytes(data: &[u8], size: usize) -> Vec<axum::body::Bytes> {
        data.chunks(size)
            .map(|c| axum::body::Bytes::copy_from_slice(c))
            .collect()
    }

    fn streaming_log_ctx(
        db: &std::sync::Arc<std::sync::Mutex<Database>>,
        provider_id: &str,
        api_key_id: &str,
    ) -> LogContext {
        LogContext {
            db: db.clone(),
            session_token: "session-claude".to_string(),
            provider_id: provider_id.to_string(),
            api_key_id: api_key_id.to_string(),
            project_id: None,
            request_model: Some("claude-3-5-sonnet".to_string()),
            cost_multiplier: 1.0,
            status_code: 200,
            start_time: std::time::Instant::now(),
            path: "/v1/messages".to_string(),
            response_content_type: "text/event-stream".to_string(),
            key_alias: Some("claude-key".to_string()),
            provider_name: Some("claude-provider".to_string()),
            project_name: None,
        }
    }

    async fn drive_stream(chunks: Vec<axum::body::Bytes>, content_encoding: &str, ctx: LogContext) {
        let inner = futures::stream::iter(
            chunks
                .into_iter()
                .map(Ok::<_, reqwest::Error>)
                .collect::<Vec<_>>(),
        );
        let mut stream = UsageTrackingStream {
            inner,
            accumulator: usage_parser::StreamUsageAccumulator::new(),
            log_ctx: Some(ctx),
            console_ctx: None,
            finished: false,
            content_encoding: content_encoding.to_string(),
            detail_capture: false,
            capture_buffer: Vec::new(),
            capture_truncated: false,
            _request_permits: None,
        };
        // Drain to completion so the stream-end recording path runs.
        while futures::StreamExt::next(&mut stream).await.is_some() {}
    }

    async fn drive_detail_stream(
        chunks: Vec<axum::body::Bytes>,
        content_encoding: &str,
        state: std::sync::Arc<crate::proxy::ProxyState>,
        resp_headers: hyper::HeaderMap,
    ) -> crate::proxy::console::ConsoleEvent {
        let mut rx = state.console_tx.subscribe();
        let inner = futures::stream::iter(
            chunks
                .into_iter()
                .map(Ok::<_, reqwest::Error>)
                .collect::<Vec<_>>(),
        );
        let mut stream = UsageTrackingStream {
            inner,
            accumulator: usage_parser::StreamUsageAccumulator::new(),
            log_ctx: None,
            console_ctx: Some(StreamConsoleCtx {
                state: state.clone(),
                request_id: "request-test".to_string(),
                method: "POST".to_string(),
                path: "/v1/messages".to_string(),
                upstream_url: "https://example.com/v1/messages".to_string(),
                start_time: std::time::Instant::now(),
                status: 200,
                provider_name: Some("claude-provider".to_string()),
                key_alias: Some("claude-key".to_string()),
                request_headers: hyper::HeaderMap::new(),
                request_body: br#"{"model":"claude-3-5-sonnet"}"#.to_vec(),
                response_headers: resp_headers,
            }),
            finished: false,
            content_encoding: content_encoding.to_string(),
            detail_capture: true,
            capture_buffer: Vec::new(),
            capture_truncated: false,
            _request_permits: None,
        };
        while futures::StreamExt::next(&mut stream).await.is_some() {}
        tokio::time::timeout(std::time::Duration::from_millis(200), rx.recv())
            .await
            .expect("console event should be emitted")
            .expect("console event should be readable")
    }

    /// Returns (db, provider_id, api_key_id) with a real provider+key so the
    /// request_logs foreign keys resolve.
    fn billing_db() -> (std::sync::Arc<std::sync::Mutex<Database>>, String, String) {
        let raw_db = Database::new_in_memory().unwrap();
        let provider = raw_db
            .provider_create(&CreateProviderInput {
                name: "claude-provider".to_string(),
                base_url: "https://example.com".to_string(),
                http_proxy: None,
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
            })
            .unwrap();
        let api_key = raw_db
            .api_key_create(&CreateApiKeyInput {
                provider_id: provider.id.clone(),
                alias: Some("claude-key".to_string()),
                value: "sk-test".to_string(),
                types: Some(vec!["claude".to_string()]),
                priority: None,
                is_active: None,
                config: None,
                cost_multiplier: None,
                usage_type: None,
                usage_url: None,
                usage_path: None,
                usage_headers: None,
                model_mapping: None,
                client_configs: None,
            })
            .unwrap();
        let provider_id = provider.id.clone();
        let api_key_id = api_key.id.clone();
        (
            std::sync::Arc::new(std::sync::Mutex::new(raw_db)),
            provider_id,
            api_key_id,
        )
    }

    #[tokio::test]
    async fn streaming_records_usage_for_plain_sse_split_across_utf8_boundaries() {
        let (db, provider_id, api_key_id) = billing_db();
        let sample = claude_sse_sample();
        // 3-byte chunks slice through the multibyte CJK/emoji codepoints.
        let chunks = chunk_bytes(sample.as_bytes(), 3);
        drive_stream(
            chunks,
            "",
            streaming_log_ctx(&db, &provider_id, &api_key_id),
        )
        .await;

        let rows = db.lock().unwrap().request_log_list_all().unwrap();
        assert_eq!(rows.len(), 1, "expected one billed row");
        assert_eq!(rows[0].input_tokens, 1234);
        assert_eq!(rows[0].output_tokens, 567);
    }

    #[tokio::test]
    async fn streaming_records_usage_for_gzip_encoded_sse() {
        let (db, provider_id, api_key_id) = billing_db();
        let sample = claude_sse_sample();
        let compressed = gzip_compress(sample.as_bytes());
        let chunks = chunk_bytes(&compressed, 5);
        drive_stream(
            chunks,
            "gzip",
            streaming_log_ctx(&db, &provider_id, &api_key_id),
        )
        .await;

        let rows = db.lock().unwrap().request_log_list_all().unwrap();
        assert_eq!(rows.len(), 1, "expected one billed row from gzip stream");
        assert_eq!(rows[0].input_tokens, 1234);
        assert_eq!(rows[0].output_tokens, 567);
    }

    #[tokio::test]
    async fn dropping_stream_records_partial_usage_and_emits_cancelled() {
        use futures::StreamExt as _;

        let (db, provider_id, api_key_id) = billing_db();
        let state = crate::proxy::build_proxy_state(db.clone()).unwrap();
        let mut rx = state.console_tx.subscribe();
        let chunk = axum::body::Bytes::from_static(
            b"data:{\"type\":\"message_start\",\"message\":{\"model\":\"claude-3-5-sonnet\",\"usage\":{\"input_tokens\":321}}}\n\n",
        );
        let inner = futures::stream::iter(vec![Ok::<_, reqwest::Error>(chunk)])
            .chain(futures::stream::pending());
        let mut stream = UsageTrackingStream {
            inner,
            accumulator: usage_parser::StreamUsageAccumulator::new(),
            log_ctx: Some(streaming_log_ctx(&db, &provider_id, &api_key_id)),
            console_ctx: Some(StreamConsoleCtx {
                state: state.clone(),
                request_id: "request-cancelled".to_string(),
                method: "POST".to_string(),
                path: "/v1/messages".to_string(),
                upstream_url: "https://example.com/v1/messages".to_string(),
                start_time: std::time::Instant::now(),
                status: 200,
                provider_name: Some("claude-provider".to_string()),
                key_alias: Some("claude-key".to_string()),
                request_headers: hyper::HeaderMap::new(),
                request_body: Vec::new(),
                response_headers: hyper::HeaderMap::new(),
            }),
            finished: false,
            content_encoding: String::new(),
            detail_capture: false,
            capture_buffer: Vec::new(),
            capture_truncated: false,
            _request_permits: Some(
                state
                    .try_acquire_request_permits(Some("session-cancelled"))
                    .unwrap(),
            ),
        };

        assert!(futures::StreamExt::next(&mut stream).await.is_some());
        drop(stream);

        let rows = db.lock().unwrap().request_log_list_all().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].input_tokens, 321);
        let event = tokio::time::timeout(std::time::Duration::from_millis(200), rx.recv())
            .await
            .expect("cancelled event should be emitted")
            .expect("cancelled event should be readable");
        match event {
            ConsoleEvent::Request {
                kind,
                request_id,
                message,
                ..
            } => {
                assert_eq!(kind, "cancelled");
                assert_eq!(request_id.as_deref(), Some("request-cancelled"));
                assert_eq!(message.as_deref(), Some("client disconnected"));
            }
            _ => panic!("expected request event"),
        }
        assert!(state
            .try_acquire_request_permits(Some("session-cancelled"))
            .is_ok());
    }

    #[tokio::test]
    async fn streaming_detail_mode_emits_response_headers_and_decoded_body() {
        let state = crate::proxy::build_proxy_state(std::sync::Arc::new(std::sync::Mutex::new(
            Database::new_in_memory().unwrap(),
        )))
        .unwrap();
        state
            .detail_mode
            .store(true, std::sync::atomic::Ordering::Relaxed);
        let sample = claude_sse_sample();
        let compressed = gzip_compress(sample.as_bytes());
        let mut resp_headers = hyper::HeaderMap::new();
        resp_headers.insert("content-type", "text/event-stream".parse().unwrap());
        resp_headers.insert("content-encoding", "gzip".parse().unwrap());

        let event =
            drive_detail_stream(chunk_bytes(&compressed, 5), "gzip", state, resp_headers).await;

        match event {
            ConsoleEvent::Request {
                response_headers,
                response_body,
                ..
            } => {
                let headers = response_headers.expect("response headers should be present");
                assert!(headers.iter().any(|h| h == "content-encoding: gzip"));
                let body = response_body.expect("response body should be present");
                assert!(!body.contains("message_start"));
                assert!(body.contains("你好，世界"));
            }
            _ => panic!("expected request event"),
        }
    }
}
