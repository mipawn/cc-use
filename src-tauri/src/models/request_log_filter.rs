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
        ] {
            assert!(serde_json::from_value::<RequestLogFilter>(value).is_err());
        }
    }
}
