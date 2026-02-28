use crate::db::Database;
use crate::models::ApiKey;

/// Select the highest-priority active, non-exhausted key for a provider
pub fn select_key(db: &Database, provider_id: &str) -> Option<ApiKey> {
    let keys = db.api_key_list(provider_id).ok()?;
    keys.into_iter()
        .filter(|k| k.is_active && !k.is_exhausted)
        .next() // Already sorted by priority ASC
}

/// Check if an HTTP status code is retryable (key might be exhausted)
pub fn is_retryable_error(status_code: u16) -> bool {
    matches!(status_code, 401 | 402 | 429)
}
