use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagementTokenPaths {
    pub state_dir: PathBuf,
    pub token_path: PathBuf,
}

impl ManagementTokenPaths {
    pub fn from_home(home_dir: &Path) -> Self {
        let state_dir = home_dir.join(".cc-use").join("state");
        let token_path = state_dir.join("management-token");
        Self {
            state_dir,
            token_path,
        }
    }
}

pub fn ensure_management_token(paths: &ManagementTokenPaths) -> Result<String, String> {
    if let Some(token) = read_management_token(paths)? {
        return Ok(token);
    }

    std::fs::create_dir_all(&paths.state_dir)
        .map_err(|e| format!("Failed to create state directory: {}", e))?;

    let token = format!("mgmt-{}", nanoid::nanoid!(32));
    std::fs::write(&paths.token_path, &token)
        .map_err(|e| format!("Failed to write management token: {}", e))?;
    set_owner_only_permissions(&paths.token_path)?;
    Ok(token)
}

pub fn read_management_token(paths: &ManagementTokenPaths) -> Result<Option<String>, String> {
    if !paths.token_path.exists() {
        return Ok(None);
    }

    let token = std::fs::read_to_string(&paths.token_path)
        .map_err(|e| format!("Failed to read management token: {}", e))?;
    let token = token.trim().to_string();
    if token.is_empty() {
        return Ok(None);
    }

    Ok(Some(token))
}

pub fn validate_management_token(expected: &str, actual: Option<&str>) -> bool {
    actual.is_some_and(|value| value == expected)
}

#[cfg(unix)]
fn set_owner_only_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    let permissions = std::fs::Permissions::from_mode(0o600);
    std::fs::set_permissions(path, permissions)
        .map_err(|e| format!("Failed to set management token permissions: {}", e))
}

#[cfg(not(unix))]
fn set_owner_only_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}
