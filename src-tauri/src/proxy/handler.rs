use crate::proxy::ProxyState;
use crate::proxy::usage_parser;
use crate::services::cost_calculator;
use crate::models::RequestLog;

use axum::{
    body::Body,
    extract::State as AxumState,
    http::{Request, Response, StatusCode, HeaderValue},
    response::IntoResponse,
};
use futures::Stream;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

/// Main proxy handler — forwards requests to the upstream provider
pub async fn proxy_handler(
    AxumState(state): AxumState<Arc<ProxyState>>,
    req: Request<Body>,
) -> impl IntoResponse {
    state.request_count.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let start_time = std::time::Instant::now();

    // Extract auth header
    let auth_header = req.headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let x_api_key = req.headers()
        .get("x-api-key")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    let api_key_value = if !auth_header.is_empty() {
        auth_header.strip_prefix("Bearer ").unwrap_or(auth_header)
    } else {
        x_api_key
    };

    if api_key_value.is_empty() {
        return error_response(StatusCode::UNAUTHORIZED, "No authorization header");
    }

    // Must be a session token
    if !api_key_value.starts_with("session-") {
        return error_response(StatusCode::UNAUTHORIZED, "Invalid session. Please launch from CC-Use");
    }

    // Resolve session from DB first, then refresh in-memory cache.
    // This keeps long-running proxy state consistent with newly created/updated sessions.
    let db_session = {
        let db = state.db.lock().unwrap();
        db.proxy_session_get(api_key_value).ok().flatten()
    };
    let session = if let Some(s) = db_session {
        let mut sessions = state.sessions.lock().unwrap();
        sessions.insert(s.session_token.clone(), s.clone());
        Some(s)
    } else {
        let sessions = state.sessions.lock().unwrap();
        sessions.get(api_key_value).cloned()
    };

    let session = match session {
        Some(s) => s,
        None => {
            return error_response(StatusCode::UNAUTHORIZED, "Session not found or expired");
        }
    };

    // Look up provider and API key
    let (provider, api_key) = {
        let db = state.db.lock().map_err(|_| ()).unwrap();
        let provider = db.provider_get(&session.provider_id).ok().flatten();
        let api_key = db.api_key_get(&session.api_key_id).ok().flatten();
        (provider, api_key)
    };

    let provider = match provider {
        Some(p) => p,
        None => return error_response(StatusCode::NOT_FOUND, "Provider not found"),
    };

    let api_key = match api_key {
        Some(k) => k,
        None => return error_response(StatusCode::NOT_FOUND, "API key not found"),
    };

    // Parse target URL
    let base_url = provider.base_url.trim_end_matches('/');
    let parsed = match url::Url::parse(base_url) {
        Ok(u) => u,
        Err(_) => return error_response(StatusCode::BAD_GATEWAY, "Invalid provider base URL"),
    };

    let target_origin = format!("{}://{}", parsed.scheme(), parsed.host_str().unwrap_or(""));
    let path_prefix = if parsed.path() == "/" { "" } else { parsed.path().trim_end_matches('/') };

    // Build upstream URL
    let req_path = req.uri().path_and_query().map(|pq| pq.as_str()).unwrap_or("/");
    let upstream_url = format!("{}{}{}", target_origin, path_prefix, req_path);

    // Forward the request
    let method = req.method().clone();
    let mut headers = req.headers().clone();

    // Replace auth headers with real API key
    let bearer = format!("Bearer {}", api_key.value);
    headers.insert("authorization", HeaderValue::from_str(&bearer).unwrap());
    headers.insert("x-api-key", HeaderValue::from_str(&api_key.value).unwrap());

    // Remove host header (reqwest will set it)
    headers.remove("host");

    let body_bytes = match axum::body::to_bytes(req.into_body(), 50 * 1024 * 1024).await {
        Ok(b) => b,
        Err(_) => return error_response(StatusCode::BAD_REQUEST, "Failed to read request body"),
    };

    // Parse request model from body
    let request_model = serde_json::from_slice::<serde_json::Value>(&body_bytes)
        .ok()
        .and_then(|v| v.get("model").and_then(|m| m.as_str()).map(|s| s.to_string()));

    // Apply model mapping: replace model in request body if mapping exists
    let body_bytes = if let (Some(ref req_model), Some(ref mapping)) = (&request_model, &api_key.model_mapping) {
        if let Some(mapped_model) = mapping.get(req_model.as_str()) {
            if let Ok(mut body_json) = serde_json::from_slice::<serde_json::Value>(&body_bytes) {
                body_json["model"] = serde_json::Value::String(mapped_model.clone());
                serde_json::to_vec(&body_json).unwrap_or_else(|_| body_bytes.to_vec()).into()
            } else {
                body_bytes
            }
        } else {
            body_bytes
        }
    } else {
        body_bytes
    };

    let client = reqwest::Client::new();
    let mut req_builder = client.request(method, &upstream_url);

    // Copy headers
    for (name, value) in headers.iter() {
        if let Ok(v) = value.to_str() {
            req_builder = req_builder.header(name.as_str(), v);
        }
    }

    if !body_bytes.is_empty() {
        req_builder = req_builder.body(body_bytes.to_vec());
    }

    let upstream_resp = match req_builder.send().await {
        Ok(r) => r,
        Err(e) => {
            *state.last_error.lock().unwrap() = Some(e.to_string());
            return error_response(StatusCode::BAD_GATEWAY, &format!("Upstream error: {}", e));
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

    // Claude/Codex streaming requests — intercept chunks for usage tracking
    if content_type.contains("text/event-stream") {
        let accumulator = usage_parser::StreamUsageAccumulator::new();
        let tracking_stream = UsageTrackingStream {
            inner: upstream_resp.bytes_stream(),
            accumulator,
            log_ctx: Some(LogContext {
                db: state.db.clone(),
                session_token: session.session_token.clone(),
                provider_id: session.provider_id.clone(),
                api_key_id: session.api_key_id.clone(),
                project_id: session.project_id.clone(),
                request_model,
                cost_multiplier: api_key.cost_multiplier,
                cached_model_pricing: provider.cached_model_pricing.clone(),
                status_code: status.as_u16(),
                start_time,
            }),
            finished: false,
        };

        let mut response = Response::builder().status(status.as_u16());
        for (name, value) in resp_headers.iter() {
            if let Ok(v) = value.to_str() {
                response = response.header(name.as_str(), v);
            }
        }

        return response
            .body(Body::from_stream(tracking_stream))
            .unwrap_or_else(|_| {
                Response::builder()
                    .status(500)
                    .body(Body::from("Internal error"))
                    .unwrap()
            });
    }

    let resp_bytes = match upstream_resp.bytes().await {
        Ok(b) => b,
        Err(e) => {
            return error_response(StatusCode::BAD_GATEWAY, &format!("Failed to read response: {}", e));
        }
    };

    // Decompress for usage parsing
    let decoded = decompress(&resp_bytes, &content_encoding);
    let response_text = String::from_utf8_lossy(&decoded);

    // Parse usage
    let (usage, model, is_streaming) = usage_parser::parse_usage_from_response_data(
        &response_text,
        &content_type,
    );

    // Log request if we got usage data
    if let Some(ref u) = usage {
        if u.input_tokens > 0 || u.output_tokens > 0 {
            let ctx = LogContext {
                db: state.db.clone(),
                session_token: session.session_token.clone(),
                provider_id: session.provider_id.clone(),
                api_key_id: session.api_key_id.clone(),
                project_id: session.project_id.clone(),
                request_model,
                cost_multiplier: api_key.cost_multiplier,
                cached_model_pricing: provider.cached_model_pricing.clone(),
                status_code: status.as_u16(),
                start_time,
            };
            record_usage(&ctx, u, model.as_deref(), is_streaming);
        }
    }

    // Build response
    let mut response = Response::builder().status(status.as_u16());

    // Copy response headers
    for (name, value) in resp_headers.iter() {
        if let Ok(v) = value.to_str() {
            response = response.header(name.as_str(), v);
        }
    }

    response
        .body(Body::from(resp_bytes.to_vec()))
        .unwrap_or_else(|_| {
            Response::builder()
                .status(500)
                .body(Body::from("Internal error"))
                .unwrap()
        })
}

fn error_response(status: StatusCode, message: &str) -> Response<Body> {
    let body = serde_json::json!({
        "error": message,
    });
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_string(&body).unwrap()))
        .unwrap()
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

/// Shared context for recording usage (used by both streaming and non-streaming paths)
struct LogContext {
    db: Arc<Mutex<crate::db::Database>>,
    session_token: String,
    provider_id: String,
    api_key_id: String,
    project_id: Option<String>,
    request_model: Option<String>,
    cost_multiplier: f64,
    cached_model_pricing: Option<std::collections::HashMap<String, crate::models::ModelPricing>>,
    status_code: u16,
    start_time: std::time::Instant,
}

fn record_usage(
    ctx: &LogContext,
    usage: &usage_parser::TokenUsage,
    model: Option<&str>,
    is_streaming: bool,
) {
    let latency_ms = ctx.start_time.elapsed().as_millis() as i64;
    let model_name = model.unwrap_or("unknown");

    let custom_pricing = std::collections::HashMap::new();
    let (input_cost, output_cost, cache_read_cost, cache_creation_cost, total_cost) =
        cost_calculator::calculate_cost(
            model_name,
            usage.input_tokens,
            usage.output_tokens,
            usage.cache_read_tokens,
            usage.cache_creation_tokens,
            ctx.cost_multiplier,
            &custom_pricing,
            &ctx.cached_model_pricing,
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
    };

    let db = ctx.db.lock().unwrap();
    let _ = db.request_log_create(&log);
}

/// Stream wrapper that intercepts SSE chunks for usage tracking,
/// then records usage to the database when the stream ends.
struct UsageTrackingStream<S> {
    inner: S,
    accumulator: usage_parser::StreamUsageAccumulator,
    log_ctx: Option<LogContext>,
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
            Poll::Ready(Some(Err(e))) => {
                Poll::Ready(Some(Err(std::io::Error::new(std::io::ErrorKind::Other, e))))
            }
            Poll::Ready(None) => {
                this.finished = true;
                if let Some(ctx) = this.log_ctx.take() {
                    if let Some(usage) = this.accumulator.get_usage() {
                        record_usage(&ctx, &usage, this.accumulator.model.as_deref(), true);
                    }
                }
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}
