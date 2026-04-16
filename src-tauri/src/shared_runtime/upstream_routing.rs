#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpstreamFamily {
    Anthropic,
    OpenAi,
}

impl UpstreamFamily {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Anthropic => "anthropic",
            Self::OpenAi => "openai",
        }
    }

    pub fn official_base_url(&self) -> &'static str {
        match self {
            Self::Anthropic => "https://api.anthropic.com",
            Self::OpenAi => "https://api.openai.com",
        }
    }
}

pub fn infer_upstream_family_from_path(path: &str) -> Option<UpstreamFamily> {
    if path == "/claude" || path.starts_with("/claude/") {
        Some(UpstreamFamily::Anthropic)
    } else if path == "/openai/v1" || path.starts_with("/openai/v1/") {
        Some(UpstreamFamily::OpenAi)
    } else {
        None
    }
}
