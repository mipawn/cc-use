//! Stable, non-secret scopes for the request ledger. Session tokens are never inputs.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestLogFilter {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<RequestLogOutcome>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub population: Option<RequestLogPopulation>,
    /// v3.24.0: which ledger produced the row. Omitted means the merged view.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<RequestLogSource>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RequestLogOutcome {
    Success,
    /// Every non-null outcome other than success, including future/legacy failures.
    Failed,
    ClientError,
    UpstreamError,
    TransportError,
}

/// Where a ledger row came from: the local proxy or one of the indexed
/// Antigravity installations. The string values double as the stored
/// `antigravity_usage_events.source` discriminator.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum RequestLogSource {
    Proxy,
    AntigravityDesktop,
    AntigravityCli,
}

impl RequestLogSource {
    pub const ALL: [RequestLogSource; 3] =
        [Self::Proxy, Self::AntigravityDesktop, Self::AntigravityCli];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Proxy => "proxy",
            Self::AntigravityDesktop => "antigravity_desktop",
            Self::AntigravityCli => "antigravity_cli",
        }
    }

    /// Stable display label used as `provider_name` in the merged ledger.
    pub fn display_name(self) -> &'static str {
        match self {
            Self::Proxy => "Proxy Gateway",
            Self::AntigravityDesktop => "Antigravity Desktop",
            Self::AntigravityCli => "Antigravity CLI",
        }
    }

    pub fn is_antigravity(self) -> bool {
        !matches!(self, Self::Proxy)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RequestLogPopulation {
    All,
    WithUsage,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn observation_filter_round_trip_uses_non_secret_camel_case_scope() {
        let value = json!({
            "providerId": "provider-1", "apiKeyId": "key-1", "instanceId": "instance-1",
            "outcome": "failed", "population": "with_usage"
        });
        let filter: RequestLogFilter = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(filter).unwrap(), value);
        assert_eq!(
            serde_json::from_value::<RequestLogFilter>(json!({})).unwrap(),
            RequestLogFilter::default()
        );
    }

    #[test]
    fn observation_filter_rejects_unknown_fields_and_enum_values() {
        for value in [
            json!({"sessionToken": "not-accepted"}),
            json!({"clientKind": "grok"}),
            json!({"outcome": "typo"}),
            json!({"population": "typo"}),
            json!({"source": "antigravity"}),
        ] {
            assert!(serde_json::from_value::<RequestLogFilter>(value).is_err());
        }
    }

    #[test]
    fn observation_filter_round_trips_every_ledger_source() {
        for source in RequestLogSource::ALL {
            let value = json!({ "source": source.as_str() });
            let filter: RequestLogFilter = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(filter.source, Some(source));
            assert_eq!(serde_json::to_value(&filter).unwrap(), value);
        }
        assert_eq!(RequestLogSource::Proxy.as_str(), "proxy");
        assert_eq!(
            RequestLogSource::AntigravityDesktop.as_str(),
            "antigravity_desktop"
        );
        assert_eq!(RequestLogSource::AntigravityCli.as_str(), "antigravity_cli");
        assert!(!RequestLogSource::Proxy.is_antigravity());
        assert!(RequestLogSource::AntigravityCli.is_antigravity());
    }
}
