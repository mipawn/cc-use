use crate::management::DaemonState;
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::sse::{Event, KeepAlive, Sse},
    response::{IntoResponse, Response},
    Json,
};
use cc_use_lib::shared_runtime::validate_management_token;
use futures::stream::{Stream, StreamExt};
use std::convert::Infallible;
use std::time::Duration;
use tokio_stream::wrappers::BroadcastStream;

/// Realtime console SSE endpoint. The subscriber gets every `ConsoleEvent`
/// broadcast by `proxy_handler` from the moment they connect. Events that
/// occurred before the subscription are not replayed — the console is
/// "what's happening now", not a log. A slow consumer will see events
/// dropped (Lagged) rather than block the forwarding path.
pub async fn console_stream(
    State(state): State<DaemonState>,
    headers: HeaderMap,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, Response> {
    let provided = headers
        .get("x-cc-use-management-token")
        .and_then(|v| v.to_str().ok());
    if !validate_management_token(&state.management_token, provided) {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid management token" })),
        )
            .into_response());
    }

    let rx = state.proxy_state.console_tx.subscribe();
    let stream = BroadcastStream::new(rx).filter_map(|res| async move {
        match res {
            Ok(event) => match serde_json::to_string(&event) {
                Ok(json) => Some(Ok(Event::default().data(json))),
                Err(err) => {
                    eprintln!("console_stream: serialize event failed: {}", err);
                    None
                }
            },
            // Lagged subscriber drops an event — expected under bursts, skip.
            Err(_) => None,
        }
    });

    Ok(Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keepalive"),
    ))
}
