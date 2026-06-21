use crate::db::Database;
use crate::models::{ApiKey, Provider, ProxySession, RequestLog};
use crate::proxy::console::ConsoleEvent;
use crate::proxy::transform_bridge;
use crate::proxy::usage_parser;
use crate::proxy::ProxyState;
use crate::services::cost_calculator;
use crate::shared_runtime::{
    classify_request_auth, decide_route_plan, infer_upstream_family_from_path, RoutePlan,
    UpstreamFamily,
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
    provider_type: Option<String>,
    model_mapping: Option<String>,
    log_ctx: Option<ResolvedSessionContext>,
    // v3.2.0: 格式转换支持
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
        self.state
            .emit_console(ConsoleEvent::rejected(self.method, self.path, self.elapsed_ms(), reason));
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
        let route_plan = decide_route_plan(&request_auth);
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

    let method = req.method().clone();
    let mut headers = req.headers().clone();

    if let Some(real_api_key) = route_execution.real_api_key.as_deref() {
        let is_openai = route_execution
            .provider_type
            .as_deref()
            .map(|t| t == "codex")
            .unwrap_or(false);

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

    // v3.2.0: 格式转换 - 请求转换
    let (body_bytes, final_path) = if let Some(ref provider) = route_execution.provider {
        match transform_bridge::transform_request_if_needed(
            body_bytes.to_vec(),
            &req_path,
            provider,
            route_execution.cli_type.as_deref(),
        ) {
            Ok((transformed_bytes, transformed_path)) => (transformed_bytes.into(), transformed_path),
            Err(e) => {
                emit.reject(&format!("Request transform failed: {}", e));
                return Err(error_response(
                    StatusCode::BAD_REQUEST,
                    &format!("Request transform failed: {}", e),
                ));
            }
        }
    } else {
        (body_bytes, req_path.clone())
    };

    let client = reqwest::Client::new();
    // 构建上游 URL。注意 upstream_url 已经包含原始 req_path
    // （见 build_provider_upstream_url / build_official_upstream_url），所以：
    // - final_path 是完整 URL：直接使用；
    // - 未转换（final_path == req_path）：直接用 upstream_url，避免把 req_path 拼第二次；
    // - 转换改写了路径：剥掉 upstream_url 末尾的原 req_path，再接转换后的 final_path。
    let final_url = if final_path.starts_with("http://") || final_path.starts_with("https://") {
        final_path
    } else if final_path == req_path {
        route_execution.upstream_url.clone()
    } else {
        let base = route_execution
            .upstream_url
            .strip_suffix(req_path.as_str())
            .unwrap_or(&route_execution.upstream_url);
        format!("{}{}", base.trim_end_matches('/'), final_path)
    };
    let mut req_builder = client.request(method, &final_url);

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
        // v3.2.0: 检查是否需要响应转换
        let transform_path = if let Some(ref provider) = route_execution.provider {
            transform_bridge::should_transform_response(
                provider,
                route_execution.cli_type.as_deref(),
            )
        } else {
            None
        };

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
            // v3.2.0: 格式转换器
            transformer: transform_path.map(|path| transform_bridge::create_stream_transformer(path)),
        };

        let mut response = Response::builder().status(status.as_u16());
        for (name, value) in &resp_headers {
            if let Ok(v) = value.to_str() {
                response = response.header(name.as_str(), v);
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
                key_alias: ctx.key_alias.clone(),
                provider_name: ctx.provider_name.clone(),
                project_name: ctx.project_name.clone(),
            };
            record_usage(&log_ctx, u, model.as_deref(), is_streaming);
        }
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
        if let Ok(v) = value.to_str() {
            response = response.header(name.as_str(), v);
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
            let upstream_url = build_provider_upstream_url(&provider.base_url, req_path, emit)?;
            let ptype = provider.provider_type.clone();
            let mapping = api_key.model_mapping.clone();
            let cli_type = session.cli_type.clone();
            Ok(RouteExecution {
                upstream_url,
                real_api_key: Some(api_key.value.clone()),
                provider_type: ptype,
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
                provider_type: None,
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
        Some(port) => format!("{}://{}:{}", parsed.scheme(), parsed.host_str().unwrap_or(""), port),
        None => format!("{}://{}", parsed.scheme(), parsed.host_str().unwrap_or("")),
    };
    let path_prefix = if parsed.path() == "/" {
        ""
    } else {
        parsed.path().trim_end_matches('/')
    };
    Ok(format!("{}{}{}", target_origin, path_prefix, req_path))
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
    let is_claude = route
        .provider_type
        .as_deref()
        .map(|t| t != "codex")
        .unwrap_or(true);

    if !is_claude {
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
    } else if model_lower.contains("sonnet") {
        mapping.sonnet.as_deref().map(|m| m.to_string())
    } else {
        mapping.default.as_deref().map(|m| m.to_string())
    };

    if let Some(mapped) = mapped {
        if mapped != model {
            json["model"] = serde_json::Value::String(mapped);
            let mapped_bytes = axum::body::Bytes::from(serde_json::to_vec(&json).unwrap_or_else(|_| body_bytes.to_vec()));
            return strip_one_m_suffix(mapped_bytes);
        }
    }

    strip_one_m_suffix(body_bytes)
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
        return axum::body::Bytes::from(serde_json::to_vec(&json).unwrap_or_else(|_| body_bytes.to_vec()));
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
    let model_name = model.unwrap_or("unknown");

    let custom_pricing = {
        let db = ctx.db.lock().unwrap();
        match db.settings_get_value("customModelPricing") {
            Ok(Some(json)) => {
                serde_json::from_str(&json).unwrap_or_default()
            }
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
        model: model.map(|s| s.to_string()),
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
    // v3.2.0: 格式转换器（可选）
    transformer: Option<Box<dyn transform_bridge::StreamTransformer + Send>>,
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
                // 用原始 bytes 做 usage tracking（转换前的格式）
                if let Ok(text) = std::str::from_utf8(&bytes) {
                    this.accumulator.process_chunk(text);
                }

                // v3.2.0: 如果有转换器，先转换再返回
                let output_bytes = if let Some(ref mut transformer) = this.transformer {
                    let transformed = transformer.transform_chunk(&bytes);
                    axum::body::Bytes::from(transformed)
                } else {
                    bytes
                };

                Poll::Ready(Some(Ok(output_bytes)))
            }
            Poll::Ready(Some(Err(e))) => Poll::Ready(Some(Err(std::io::Error::other(e)))),
            Poll::Ready(None) => {
                this.finished = true;
                if let Some(ctx) = this.log_ctx.take() {
                    this.accumulator.flush();
                    if let Some(usage) = this.accumulator.get_usage() {
                        record_usage(&ctx, &usage, this.accumulator.model.as_deref(), true);
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
