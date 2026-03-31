use crate::proxy::ProxyState;
use crate::proxy::usage_parser;
use crate::services::cost_calculator;
use crate::models::RequestLog;

use axum::{
    body::Body,
    extract::State as AxumState,
    extract::FromRequestParts,
    extract::ws::{WebSocketUpgrade, WebSocket, Message as WsMessage},
    http::{Request, Response, StatusCode, HeaderValue},
    response::IntoResponse,
};
use futures::{Stream, StreamExt, SinkExt};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

/// Main proxy handler — forwards HTTP requests and WebSocket connections to the upstream provider
pub async fn proxy_handler(
    AxumState(state): AxumState<Arc<ProxyState>>,
    req: Request<Body>,
) -> Result<Response<Body>, Response<Body>> {
    state.request_count.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let start_time = std::time::Instant::now();

    // ── Extract auth info (borrow only) ──
    let auth_header = req.headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let x_api_key = req.headers()
        .get("x-api-key")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    let session_token = if !auth_header.is_empty() {
        auth_header.strip_prefix("Bearer ").unwrap_or(auth_header).to_string()
    } else {
        x_api_key.to_string()
    };

    if session_token.is_empty() {
        return Err(error_response(StatusCode::UNAUTHORIZED, "No authorization header"));
    }
    if !session_token.starts_with("session-") {
        return Err(error_response(StatusCode::UNAUTHORIZED, "Invalid session. Please launch from CC-Use"));
    }

    // Check for WebSocket upgrade before consuming the request
    let is_ws_upgrade = req.headers()
        .get("upgrade")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.eq_ignore_ascii_case("websocket"))
        .unwrap_or(false);

    // Capture request path before consuming
    let req_path = req.uri().path_and_query().map(|pq| pq.as_str().to_string()).unwrap_or_else(|| "/".to_string());

    // ── Resolve session, provider, and API key atomically ──
    let resolved = {
        let db = lock_or_error(&state.db, "Database lock failed")?;
        db.proxy_session_get(&session_token)
            .ok()
            .flatten()
            .and_then(|session| {
                let provider = db.provider_get(&session.provider_id).ok().flatten();
                let api_key = db.api_key_get(&session.api_key_id).ok().flatten();
                Some((session, provider, api_key))
            })
    };

    let (session, provider, api_key) = if let Some((s, p, k)) = resolved {
        let mut sessions = lock_or_error(&state.sessions, "Session lock failed")?;
        sessions.insert(s.session_token.clone(), s.clone());
        (s, p, k)
    } else {
        let cached = {
            let sessions = lock_or_error(&state.sessions, "Session lock failed")?;
            sessions.get(session_token.as_str()).cloned()
        };
        match cached {
            Some(s) => {
                let db = lock_or_error(&state.db, "Database lock failed")?;
                let provider = db.provider_get(&s.provider_id).ok().flatten();
                let api_key = db.api_key_get(&s.api_key_id).ok().flatten();
                (s, provider, api_key)
            }
            None => {
                return Err(error_response(StatusCode::UNAUTHORIZED, "Session not found or expired"));
            }
        }
    };

    let provider = match provider {
        Some(p) => p,
        None => return Err(error_response(StatusCode::NOT_FOUND, "Provider not found")),
    };

    let api_key = match api_key {
        Some(k) => k,
        None => return Err(error_response(StatusCode::NOT_FOUND, "API key not found")),
    };

    // ── Build upstream URL ──
    let base_url = provider.base_url.trim_end_matches('/');
    let parsed = match url::Url::parse(base_url) {
        Ok(u) => u,
        Err(_) => return Err(error_response(StatusCode::BAD_GATEWAY, "Invalid provider base URL")),
    };

    let target_origin = format!("{}://{}", parsed.scheme(), parsed.host_str().unwrap_or(""));
    let path_prefix = if parsed.path() == "/" { "" } else { parsed.path().trim_end_matches('/') };
    let upstream_url = format!("{}{}{}", target_origin, path_prefix, req_path);

    // ── WebSocket proxy path ──
    if is_ws_upgrade {
        let (mut parts, _body) = req.into_parts();
        let ws_upgrade: WebSocketUpgrade = match WebSocketUpgrade::from_request_parts(&mut parts, &state).await {
            Ok(ws) => ws,
            Err(_) => return Err(error_response(StatusCode::BAD_REQUEST, "WebSocket upgrade failed")),
        };
        let ws_url = to_ws_url(&upstream_url);
        let real_key = api_key.value.clone();
        return Ok(ws_upgrade
            .on_upgrade(move |socket| ws_relay(socket, ws_url, real_key))
            .into_response());
    }

    // ── HTTP proxy path ──
    let method = req.method().clone();
    let mut headers = req.headers().clone();

    // Replace auth headers with real API key
    let bearer = format!("Bearer {}", api_key.value);
    match HeaderValue::from_str(&bearer) {
        Ok(v) => { headers.insert("authorization", v); }
        Err(_) => return Err(error_response(StatusCode::BAD_REQUEST, "API key contains invalid characters")),
    }
    match HeaderValue::from_str(&api_key.value) {
        Ok(v) => { headers.insert("x-api-key", v); }
        Err(_) => return Err(error_response(StatusCode::BAD_REQUEST, "API key contains invalid characters")),
    }

    // Remove host header (reqwest will set it)
    headers.remove("host");

    // Remove accept-encoding so upstream returns uncompressed SSE data,
    // allowing UsageTrackingStream to parse usage from plain-text chunks.
    headers.remove("accept-encoding");

    let body_bytes = match axum::body::to_bytes(req.into_body(), 50 * 1024 * 1024).await {
        Ok(b) => b,
        Err(_) => return Err(error_response(StatusCode::BAD_REQUEST, "Failed to read request body")),
    };

    // Parse request model from body
    let request_model = serde_json::from_slice::<serde_json::Value>(&body_bytes)
        .ok()
        .and_then(|v| v.get("model").and_then(|m| m.as_str()).map(|s| s.to_string()));

    let client = reqwest::Client::new();
    let mut req_builder = client.request(method, &upstream_url);

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
            if let Ok(mut last_err) = state.last_error.lock() {
                *last_err = Some(e.to_string());
            }
            return Err(error_response(StatusCode::BAD_GATEWAY, &format!("Upstream error: {}", e)));
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
            return Err(error_response(StatusCode::BAD_GATEWAY, &format!("Failed to read response: {}", e)));
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
                status_code: status.as_u16(),
                start_time,
            };
            record_usage(&ctx, u, model.as_deref(), is_streaming);
        }
    }

    // Build response
    let mut response = Response::builder().status(status.as_u16());
    for (name, value) in resp_headers.iter() {
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

// ── Shared helpers ──

/// Try to lock a Mutex, returning an error HTTP response on poisoned mutex.
fn lock_or_error<'a, T>(mutex: &'a Mutex<T>, msg: &str) -> Result<std::sync::MutexGuard<'a, T>, Response<Body>> {
    mutex.lock().map_err(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, msg))
}

fn error_response(status: StatusCode, message: &str) -> Response<Body> {
    let body = serde_json::json!({ "error": message });
    let json = serde_json::to_string(&body).unwrap_or_else(|_| r#"{"error":"internal error"}"#.to_string());
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::from(json))
        .unwrap_or_else(|_| {
            Response::new(Body::from(r#"{"error":"internal error"}"#))
        })
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

// ── Usage tracking ──

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

    if let Ok(db) = ctx.db.lock() {
        if let Err(e) = db.request_log_create(&log) {
            log::error!("Failed to record usage log: {}", e);
        }
    } else {
        log::error!("Failed to lock database for usage recording");
    }
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
                    this.accumulator.flush();
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

// ── WebSocket proxy ──

/// Convert an HTTP(S) URL to a WebSocket URL (https→wss, http→ws).
fn to_ws_url(http_url: &str) -> String {
    if http_url.starts_with("https://") {
        format!("wss://{}", &http_url[8..])
    } else if http_url.starts_with("http://") {
        format!("ws://{}", &http_url[7..])
    } else {
        http_url.to_string()
    }
}

/// Relay messages between a client WebSocket (from Codex CLI) and an upstream provider WebSocket.
async fn ws_relay(mut client: WebSocket, upstream_url: String, api_key: String) {
    use tokio_tungstenite::tungstenite;

    // Build upstream WebSocket request with real API key
    let ws_request = match tungstenite::http::Request::builder()
        .uri(&upstream_url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Host", extract_host(&upstream_url).unwrap_or_default())
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Sec-WebSocket-Version", "13")
        .header("Sec-WebSocket-Key", tungstenite::handshake::client::generate_key())
        .body(())
    {
        Ok(r) => r,
        Err(e) => {
            log::error!("Failed to build upstream WS request: {}", e);
            return;
        }
    };

    let (mut upstream, _) = match tokio_tungstenite::connect_async(ws_request).await {
        Ok(conn) => conn,
        Err(e) => {
            log::error!("Failed to connect upstream WebSocket {}: {}", upstream_url, e);
            return;
        }
    };

    // Bidirectional message relay
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
                    Some(Ok(_)) => {} // Frame variants, ignore
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
    use super::*;

    #[test]
    fn test_error_response_does_not_panic() {
        let resp = error_response(StatusCode::BAD_REQUEST, "test error");
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn test_error_response_contains_json_body() {
        let resp = error_response(StatusCode::NOT_FOUND, "not found");
        assert_eq!(
            resp.headers().get("content-type").unwrap().to_str().unwrap(),
            "application/json"
        );
    }

    #[test]
    fn test_error_response_various_status_codes() {
        for status in [
            StatusCode::UNAUTHORIZED,
            StatusCode::INTERNAL_SERVER_ERROR,
            StatusCode::BAD_GATEWAY,
        ] {
            let resp = error_response(status, "msg");
            assert_eq!(resp.status(), status);
        }
    }
}
