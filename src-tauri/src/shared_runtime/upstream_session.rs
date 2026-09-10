//! Upstream conversation identity.
//!
//! Some upstreams route on a conversation id the client is expected to send.
//! Three identities exist here and must never be conflated:
//!
//! * the client's own conversation id — what the user thinks of as a session;
//! * the CC Use managed instance / proxy session — one launch, which may carry
//!   several client conversations;
//! * the CC Use route token — a *credential*. It authenticates the local proxy
//!   and must never reach an upstream in any form, not even truncated.
//!
//! The resolution order is deliberately conservative: never overwrite what the
//! client sent, prefer a real conversation id, and only then derive a stable
//! value from the CC Use session. The derived value is recorded as
//! `cc_use_session` so a diagnosis can tell it apart from a native one.

use serde::Serialize;
use sha2::{Digest, Sha256};

/// Where the upstream conversation id came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionSource {
    /// The client sent a conversation id of its own.
    Native,
    /// Derived from the CC Use proxy session — stable per launch, but not
    /// per-conversation proof of isolation.
    CcUseSession,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpstreamSession {
    pub id: String,
    pub source: SessionSource,
}

/// Prefix on derived ids, so one is never mistaken for a client's own.
pub const DERIVED_SESSION_PREFIX: &str = "cc-use-";

/// Length of the derived digest in hex characters.
const DIGEST_CHARS: usize = 32;

/// Decide the conversation id to send upstream.
///
/// Returns `None` when there is no proxy session to derive from, in which case
/// the caller leaves the request alone rather than inventing an identity.
///
/// `existing_header` is what the client already sent: a present, non-blank
/// value is returned unchanged, so a client that knows its own conversation
/// keeps it.
pub fn resolve_upstream_session(
    existing_header: Option<&str>,
    native_session_id: Option<&str>,
    proxy_session_token: &str,
    provider_id: &str,
    client_kind: &str,
) -> Option<UpstreamSession> {
    if let Some(existing) = existing_header.map(str::trim).filter(|v| !v.is_empty()) {
        return Some(UpstreamSession {
            id: existing.to_string(),
            source: SessionSource::Native,
        });
    }

    if let Some(native) = native_session_id.map(str::trim).filter(|v| !v.is_empty()) {
        return Some(UpstreamSession {
            id: native.to_string(),
            source: SessionSource::Native,
        });
    }

    let token = proxy_session_token.trim();
    if token.is_empty() {
        return None;
    }

    Some(UpstreamSession {
        id: derive_session_id(proxy_session_token, provider_id, client_kind),
        source: SessionSource::CcUseSession,
    })
}

/// A one-way digest of the routing context.
///
/// The route token is an input but never an output: the digest is not
/// reversible, and the result carries no part of the credential. The namespace
/// keeps this value from colliding with anything else derived the same way.
fn derive_session_id(proxy_session_token: &str, provider_id: &str, client_kind: &str) -> String {
    let mut hasher = Sha256::new();
    for part in [
        "cc-use/upstream-session/v1",
        proxy_session_token,
        provider_id,
        client_kind,
    ] {
        // Length-prefixing keeps "a" + "bc" from hashing the same as "ab" + "c".
        hasher.update((part.len() as u64).to_le_bytes());
        hasher.update(part.as_bytes());
    }
    let digest = hasher.finalize();
    let hex: String = digest.iter().map(|byte| format!("{:02x}", byte)).collect();
    format!("{}{}", DERIVED_SESSION_PREFIX, &hex[..DIGEST_CHARS])
}

/// A stable, non-credential reference to a CC Use session, for records that
/// must name the session without storing the route token.
pub fn session_reference(proxy_session_token: &str) -> String {
    derive_session_id(proxy_session_token, "", "")
}

/// The header upstreams like OpenCode Go route on.
pub const OPENCODE_SESSION_HEADER: &str = "x-opencode-session";

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "session-abcdefghijklmnop";
    const PROVIDER: &str = "provider-1";
    const CLIENT: &str = "claude_code";

    #[test]
    fn a_client_supplied_session_is_never_rewritten() {
        let resolved = resolve_upstream_session(
            Some("  conv-123  "),
            Some("native-9"),
            TOKEN,
            PROVIDER,
            CLIENT,
        )
        .expect("resolved");

        assert_eq!(resolved.id, "conv-123");
        assert_eq!(resolved.source, SessionSource::Native);
    }

    #[test]
    fn a_blank_client_header_falls_through_instead_of_being_sent() {
        // OpenCode Go rejects an empty value outright, so a blank one must not
        // be forwarded as if it were an identity.
        let resolved =
            resolve_upstream_session(Some("   "), Some("native-9"), TOKEN, PROVIDER, CLIENT)
                .expect("resolved");

        assert_eq!(resolved.id, "native-9");
        assert_eq!(resolved.source, SessionSource::Native);
    }

    #[test]
    fn a_native_conversation_id_wins_over_the_derived_fallback() {
        let resolved = resolve_upstream_session(None, Some("conv-native"), TOKEN, PROVIDER, CLIENT)
            .expect("resolved");

        assert_eq!(resolved.id, "conv-native");
        assert_eq!(resolved.source, SessionSource::Native);
    }

    #[test]
    fn the_derived_id_is_stable_per_session_and_never_leaks_the_token() {
        let first =
            resolve_upstream_session(None, None, TOKEN, PROVIDER, CLIENT).expect("resolved");
        let again =
            resolve_upstream_session(None, None, TOKEN, PROVIDER, CLIENT).expect("resolved");

        assert_eq!(first, again, "same session derives the same id");
        assert_eq!(first.source, SessionSource::CcUseSession);
        assert!(first.id.starts_with(DERIVED_SESSION_PREFIX));
        // The credential is an input to the digest, never part of the result.
        assert!(!first.id.contains(TOKEN));
        assert!(!first.id.contains(&TOKEN[..8]));
        assert!(!first.id.contains("abcdefghijklmnop"));
    }

    #[test]
    fn a_different_session_or_provider_derives_a_different_id() {
        let base = resolve_upstream_session(None, None, TOKEN, PROVIDER, CLIENT).expect("resolved");

        for (token, provider, client) in [
            ("session-zzzzzzzzzzzzzzzz", PROVIDER, CLIENT),
            (TOKEN, "provider-2", CLIENT),
            (TOKEN, PROVIDER, "codex"),
        ] {
            let other =
                resolve_upstream_session(None, None, token, provider, client).expect("resolved");
            assert_ne!(base.id, other.id, "{} / {} / {}", token, provider, client);
        }
    }

    #[test]
    fn a_session_reference_names_the_session_without_being_the_credential() {
        let reference = session_reference(TOKEN);

        assert!(reference.starts_with(DERIVED_SESSION_PREFIX));
        assert!(!reference.contains(TOKEN));
        assert_ne!(reference, session_reference("session-zzzzzzzzzzzzzzzz"));
        assert_eq!(
            reference,
            session_reference(TOKEN),
            "stable for one session"
        );
    }

    #[test]
    fn without_a_proxy_session_no_identity_is_invented() {
        assert!(resolve_upstream_session(None, None, "   ", PROVIDER, CLIENT).is_none());
    }
}
