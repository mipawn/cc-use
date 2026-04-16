#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectSessionContext {
    pub project_id: String,
    pub provider_id: Option<String>,
    pub api_key_id: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProjectSessionOverrides {
    pub provider_id: Option<String>,
    pub api_key_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExistingProjectSession {
    pub session_token: String,
    pub project_id: Option<String>,
    pub provider_id: String,
    pub api_key_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectSessionPlan {
    Reuse {
        session_token: String,
        provider_id: String,
        api_key_id: String,
    },
    Create {
        session_token: String,
        project_id: String,
        provider_id: String,
        api_key_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlanProjectSessionError {
    MissingProvider,
    MissingApiKey,
}

pub fn plan_project_session<F>(
    context: &ProjectSessionContext,
    overrides: ProjectSessionOverrides,
    existing_sessions: &[ExistingProjectSession],
    new_session_token: F,
) -> Result<ProjectSessionPlan, PlanProjectSessionError>
where
    F: FnOnce() -> String,
{
    let provider_id = overrides
        .provider_id
        .or_else(|| context.provider_id.clone())
        .ok_or(PlanProjectSessionError::MissingProvider)?;
    let api_key_id = overrides
        .api_key_id
        .or_else(|| context.api_key_id.clone())
        .ok_or(PlanProjectSessionError::MissingApiKey)?;

    if let Some(existing) = existing_sessions.iter().find(|session| {
        session.project_id.as_deref() == Some(context.project_id.as_str())
            && session.provider_id == provider_id
            && session.api_key_id == api_key_id
    }) {
        return Ok(ProjectSessionPlan::Reuse {
            session_token: existing.session_token.clone(),
            provider_id,
            api_key_id,
        });
    }

    Ok(ProjectSessionPlan::Create {
        session_token: new_session_token(),
        project_id: context.project_id.clone(),
        provider_id,
        api_key_id,
    })
}
