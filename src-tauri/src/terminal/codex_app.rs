//! Codex App 启动支持
//!
//! 采用单实例方案：通过 launchctl setenv 设置全局环境变量，然后打开 Codex App。

use crate::db::Database;
use crate::models::ProxySession;
use crate::shared_runtime::new_session_token;
use std::process::Command;
use std::sync::{Arc, Mutex};

/// 启动 Codex App（单实例方案）
///
/// 工作流程：
/// 1. 创建 proxy session
/// 2. 通过 launchctl setenv 设置环境变量
/// 3. Kill 已有的 Codex App 进程（确保环境变量生效）
/// 4. 打开 Codex App
/// 5. 记录当前生效的项目 ID
pub fn launch_codex_app(
    db: Arc<Mutex<Database>>,
    project_id: &str,
    proxy_port: i32,
) -> Result<String, String> {
    let db_guard = db.lock().map_err(|e| e.to_string())?;

    // 1. 查询项目配置
    let project = db_guard
        .project_get(project_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Project not found: {}", project_id))?;

    let provider_id = project
        .provider_id
        .as_ref()
        .ok_or("Project has no provider configured")?;

    let api_key_id = project
        .api_key_id
        .as_ref()
        .ok_or("Project has no API key configured")?;

    // 2. 创建 proxy session
    let session_token = new_session_token();
    let proxy_url = format!("http://127.0.0.1:{}", proxy_port);

    let session = ProxySession {
        session_token: session_token.clone(),
        provider_id: provider_id.clone(),
        api_key_id: api_key_id.clone(),
        project_id: Some(project.id.clone()),
        created_at: chrono::Utc::now().to_rfc3339(),
        cli_type: Some("codex-app".to_string()),
    };

    db_guard
        .proxy_session_create(&session)
        .map_err(|e| format!("Failed to create proxy session: {}", e))?;

    // 3. 通过 launchctl 设置环境变量
    set_launchctl_env("OPENAI_BASE_URL", &proxy_url)?;
    set_launchctl_env("OPENAI_API_KEY", &session_token)?;

    // 4. Kill 已有的 Codex App 进程
    let _ = Command::new("pkill")
        .arg("-9")
        .arg("Codex")
        .output();

    // 等待进程退出
    std::thread::sleep(std::time::Duration::from_millis(500));

    // 5. 打开 Codex App
    Command::new("open")
        .arg("-a")
        .arg("Codex")
        .spawn()
        .map_err(|e| format!("Failed to open Codex App: {}", e))?;

    // 6. 记录当前生效的项目
    db_guard
        .settings_set_value("codex_app_active_project", &project.id)
        .map_err(|e| format!("Failed to save active project: {}", e))?;

    Ok(session_token)
}

/// 停止 Codex App
pub fn stop_codex_app(db: Arc<Mutex<Database>>) -> Result<(), String> {
    let db_guard = db.lock().map_err(|e| e.to_string())?;

    // 1. 清除环境变量
    unset_launchctl_env("OPENAI_BASE_URL")?;
    unset_launchctl_env("OPENAI_API_KEY")?;

    // 2. 清除记录（使用 settings_set_value 设置为空字符串）
    db_guard
        .settings_set_value("codex_app_active_project", "")
        .map_err(|e| format!("Failed to clear active project: {}", e))?;

    // 3. 提示用户手动关闭 Codex App（我们不强制 kill）
    Ok(())
}

/// 获取当前 Codex App 绑定的项目 ID
pub fn get_active_project(db: Arc<Mutex<Database>>) -> Result<Option<String>, String> {
    let db_guard = db.lock().map_err(|e| e.to_string())?;
    db_guard
        .settings_get_value("codex_app_active_project")
        .map_err(|e| format!("Failed to get active project: {}", e))
}

/// 通过 launchctl setenv 设置环境变量
fn set_launchctl_env(key: &str, value: &str) -> Result<(), String> {
    let output = Command::new("launchctl")
        .arg("setenv")
        .arg(key)
        .arg(value)
        .output()
        .map_err(|e| format!("Failed to execute launchctl: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("launchctl setenv failed: {}", stderr));
    }

    Ok(())
}

/// 通过 launchctl unsetenv 清除环境变量
fn unset_launchctl_env(key: &str) -> Result<(), String> {
    let output = Command::new("launchctl")
        .arg("unsetenv")
        .arg(key)
        .output()
        .map_err(|e| format!("Failed to execute launchctl: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("launchctl unsetenv failed: {}", stderr));
    }

    Ok(())
}
