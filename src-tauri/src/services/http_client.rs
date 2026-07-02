use crate::models::Provider;

pub fn outbound_client_for_provider(
    provider: Option<&Provider>,
) -> Result<reqwest::Client, String> {
    outbound_client_builder_for_proxy(provider.and_then(|p| p.http_proxy.as_deref()))?
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))
}

pub fn outbound_client_builder_for_proxy(
    proxy_url: Option<&str>,
) -> Result<reqwest::ClientBuilder, String> {
    let mut builder = reqwest::Client::builder();

    if let Some(proxy_url) = normalized_proxy_url(proxy_url) {
        let proxy = reqwest::Proxy::all(&proxy_url)
            .map_err(|e| format!("Invalid HTTP proxy URL: {}", e))?;
        builder = builder.proxy(proxy);
    }

    Ok(builder)
}

pub fn normalized_proxy_url(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}
