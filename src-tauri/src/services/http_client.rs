use crate::models::Provider;
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::Duration,
};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const POOL_IDLE_TIMEOUT: Duration = Duration::from_secs(90);
const TCP_KEEPALIVE: Duration = Duration::from_secs(60);
const MAX_CACHED_CLIENTS: usize = 32;

static OUTBOUND_CLIENTS: OnceLock<Mutex<HashMap<Option<String>, reqwest::Client>>> =
    OnceLock::new();

pub fn outbound_client_for_provider(
    provider: Option<&Provider>,
) -> Result<reqwest::Client, String> {
    outbound_client_for_proxy(provider.and_then(|p| p.http_proxy.as_deref()))
}

pub fn outbound_client_for_proxy(proxy_url: Option<&str>) -> Result<reqwest::Client, String> {
    let cache_key = normalized_proxy_url(proxy_url);
    let clients = OUTBOUND_CLIENTS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut clients = clients
        .lock()
        .map_err(|_| "HTTP client cache lock is poisoned".to_string())?;

    if let Some(client) = clients.get(&cache_key) {
        return Ok(client.clone());
    }

    let client = outbound_client_builder_for_proxy(cache_key.as_deref())?
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    // Configuration edits can create new cache keys. Keep the cache bounded;
    // existing requests retain their cheap Client clones and finish normally.
    if clients.len() >= MAX_CACHED_CLIENTS {
        clients.clear();
    }
    clients.insert(cache_key, client.clone());

    Ok(client)
}

pub fn outbound_client_builder_for_proxy(
    proxy_url: Option<&str>,
) -> Result<reqwest::ClientBuilder, String> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .pool_idle_timeout(POOL_IDLE_TIMEOUT)
        .tcp_keepalive(TCP_KEEPALIVE);

    if let Some(proxy_url) = normalized_proxy_url(proxy_url) {
        let proxy = reqwest::Proxy::all(&proxy_url)
            .map_err(|e| format!("Invalid HTTP proxy URL: {}", e))?;
        builder = builder.proxy(proxy);
    }

    Ok(builder)
}

#[cfg(test)]
mod tests {
    use super::*;

    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn clear_cache() {
        OUTBOUND_CLIENTS
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .unwrap()
            .clear();
    }

    fn cache_len() -> usize {
        OUTBOUND_CLIENTS
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .unwrap()
            .len()
    }

    #[test]
    fn reuses_clients_for_equivalent_proxy_configuration() {
        let _guard = TEST_LOCK.lock().unwrap();
        clear_cache();

        outbound_client_for_proxy(None).unwrap();
        outbound_client_for_proxy(Some("  ")).unwrap();
        outbound_client_for_proxy(Some(" http://127.0.0.1:8080 ")).unwrap();
        outbound_client_for_proxy(Some("http://127.0.0.1:8080")).unwrap();

        assert_eq!(cache_len(), 2);
    }

    #[test]
    fn rejects_invalid_proxy_without_caching_it() {
        let _guard = TEST_LOCK.lock().unwrap();
        clear_cache();

        let error = outbound_client_for_proxy(Some("://invalid")).unwrap_err();

        assert!(error.contains("Invalid HTTP proxy URL"));
        assert_eq!(cache_len(), 0);
    }
}

pub fn normalized_proxy_url(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}
