use crate::models::UpdateCheckResult;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

const GITHUB_LATEST_RELEASE_API: &str = "https://api.github.com/repos/mipawn/cc-use/releases/latest";

#[derive(Default)]
struct UpdateRuntimeState {
    download_url: Option<String>,
    release_url: Option<String>,
    downloaded_file: Option<PathBuf>,
}

static UPDATE_STATE: OnceLock<Mutex<UpdateRuntimeState>> = OnceLock::new();

fn updater_state() -> &'static Mutex<UpdateRuntimeState> {
    UPDATE_STATE.get_or_init(|| Mutex::new(UpdateRuntimeState::default()))
}

#[tauri::command]
pub fn app_get_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
pub async fn app_check_update(app: AppHandle) -> Result<UpdateCheckResult, String> {
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let client = reqwest::Client::new();
    let resp = client
        .get(GITHUB_LATEST_RELEASE_API)
        .header("User-Agent", "cc-use")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("GitHub API returned {}", resp.status().as_u16()));
    }

    let body: Value = resp.json().await.map_err(|e| e.to_string())?;
    let latest_version = body
        .get("tag_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim_start_matches('v')
        .to_string();

    if latest_version.is_empty() {
        return Err("Invalid update response: missing tag_name".to_string());
    }

    let has_update = compare_versions(&latest_version, &current_version) > 0;
    let release_url = body
        .get("html_url")
        .and_then(|v| v.as_str())
        .unwrap_or("https://github.com/mipawn/cc-use/releases")
        .to_string();
    let release_notes = body
        .get("body")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let download_url = if has_update {
        pick_download_url(&body)
    } else {
        None
    };

    {
        let mut state = updater_state().lock().unwrap();
        state.download_url = download_url.clone();
        state.release_url = Some(release_url.clone());
        state.downloaded_file = None;
    }

    let result = UpdateCheckResult {
        has_update,
        current_version,
        latest_version,
        release_url,
        release_notes,
        download_url,
    };

    if result.has_update {
        let _ = app.emit("app:updateAvailable", &result);
    }

    Ok(result)
}

#[tauri::command]
pub async fn app_download_update(app: AppHandle) -> Result<(), String> {
    let url = {
        let state = updater_state().lock().unwrap();
        state.download_url.clone()
    };

    let download_url = if let Some(url) = url {
        url
    } else {
        let check = app_check_update(app.clone()).await?;
        check
            .download_url
            .ok_or_else(|| "No download URL available".to_string())?
    };

    let file_path = download_file_with_progress(&app, &download_url).await?;
    {
        let mut state = updater_state().lock().unwrap();
        state.downloaded_file = Some(file_path);
    }
    let _ = app.emit("app:updateDownloaded", &serde_json::json!({}));
    Ok(())
}

#[tauri::command]
pub async fn app_install_update() -> Result<serde_json::Value, String> {
    let (downloaded_file, release_url) = {
        let state = updater_state().lock().unwrap();
        (state.downloaded_file.clone(), state.release_url.clone())
    };

    if let Some(path) = downloaded_file {
        if path.exists() {
            return Ok(match open::that(&path) {
                Ok(_) => serde_json::json!({ "success": true }),
                Err(e) => serde_json::json!({ "success": false, "error": e.to_string() }),
            });
        }
    }

    if let Some(url) = release_url {
        return Ok(match open::that(&url) {
            Ok(_) => serde_json::json!({ "success": true }),
            Err(e) => serde_json::json!({ "success": false, "error": e.to_string() }),
        });
    }

    Ok(serde_json::json!({
        "success": false,
        "error": "No downloaded update found",
    }))
}

#[tauri::command]
pub fn app_get_updates_cache_info() -> Result<serde_json::Value, String> {
    let cache_dir = get_updates_cache_dir()?;
    if !cache_dir.exists() {
        return Ok(serde_json::json!({ "size": 0u64, "files": Vec::<String>::new() }));
    }

    let mut total_size = 0u64;
    let mut files = Vec::new();
    for entry in std::fs::read_dir(&cache_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_file() {
            let md = entry.metadata().map_err(|e| e.to_string())?;
            total_size += md.len();
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                files.push(name.to_string());
            }
        }
    }

    Ok(serde_json::json!({
        "size": total_size,
        "files": files,
    }))
}

#[tauri::command]
pub fn app_clear_updates_cache() -> Result<u64, String> {
    let cache_dir = get_updates_cache_dir()?;
    if !cache_dir.exists() {
        return Ok(0);
    }

    let mut deleted_count = 0u64;
    for entry in std::fs::read_dir(&cache_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            std::fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
            deleted_count += 1;
        } else if path.is_file() {
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
            deleted_count += 1;
        }
    }

    {
        let mut state = updater_state().lock().unwrap();
        state.downloaded_file = None;
    }

    Ok(deleted_count)
}

async fn download_file_with_progress(app: &AppHandle, url: &str) -> Result<PathBuf, String> {
    let cache_dir = get_updates_cache_dir()?;
    std::fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;

    let file_name = file_name_from_url(url).unwrap_or_else(|| "update.bin".to_string());
    let file_path = cache_dir.join(file_name);

    let client = reqwest::Client::new();
    let mut resp = client
        .get(url)
        .header("User-Agent", "cc-use")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Download failed with status {}", resp.status().as_u16()));
    }

    let total = resp.content_length().unwrap_or(0);
    let mut file = tokio::fs::File::create(&file_path)
        .await
        .map_err(|e| e.to_string())?;

    let started_at = Instant::now();
    let mut transferred = 0u64;

    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        transferred += chunk.len() as u64;
        let percent = if total > 0 {
            ((transferred as f64 / total as f64) * 100.0).min(100.0)
        } else {
            0.0
        };
        let elapsed = started_at.elapsed().as_secs_f64().max(0.001);
        let bytes_per_second = transferred as f64 / elapsed;
        let progress = serde_json::json!({
            "percent": percent,
            "transferred": transferred,
            "total": total,
            "bytesPerSecond": bytes_per_second,
        });
        let _ = app.emit("app:updateProgress", &progress);
    }

    Ok(file_path)
}

fn file_name_from_url(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    let name = parsed.path_segments()?.next_back()?;
    if name.trim().is_empty() {
        return None;
    }
    Some(name.to_string())
}

fn get_updates_cache_dir() -> Result<PathBuf, String> {
    let base = dirs::data_dir().ok_or_else(|| "Cannot find data dir".to_string())?;
    Ok(base.join(app_data_dir_name()).join("updates"))
}

fn app_data_dir_name() -> &'static str {
    if cfg!(debug_assertions) {
        "com.mipawn.cc-use.dev"
    } else {
        "com.mipawn.cc-use"
    }
}

fn compare_versions(a: &str, b: &str) -> i32 {
    let pa: Vec<i32> = a
        .split('.')
        .map(|x| x.parse::<i32>().unwrap_or(0))
        .collect();
    let pb: Vec<i32> = b
        .split('.')
        .map(|x| x.parse::<i32>().unwrap_or(0))
        .collect();
    let len = pa.len().max(pb.len());
    for i in 0..len {
        let av = *pa.get(i).unwrap_or(&0);
        let bv = *pb.get(i).unwrap_or(&0);
        if av > bv {
            return 1;
        }
        if av < bv {
            return -1;
        }
    }
    0
}

fn pick_download_url(release: &Value) -> Option<String> {
    let assets = release.get("assets")?.as_array()?;
    let platform = std::env::consts::OS;
    let arch = std::env::consts::ARCH;

    let is_arch_match = |name: &str| match arch {
        "aarch64" => name.contains("arm64") || name.contains("aarch64"),
        "x86_64" => name.contains("x64") || name.contains("x86_64") || name.contains("amd64"),
        _ => true,
    };

    let mut fallback: Option<String> = None;
    for asset in assets {
        let Some(name) = asset.get("name").and_then(|v| v.as_str()) else {
            continue;
        };
        let name_lc = name.to_lowercase();
        let url = asset
            .get("browser_download_url")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let Some(url) = url else {
            continue;
        };

        match platform {
            "macos" => {
                if name_lc.ends_with(".zip")
                    && !name_lc.ends_with(".zip.blockmap")
                    && name_lc.contains("mac")
                {
                    if is_arch_match(&name_lc) {
                        return Some(url);
                    }
                    fallback = fallback.or(Some(url));
                } else if name_lc.ends_with(".dmg") && name_lc.contains("mac") {
                    if is_arch_match(&name_lc) {
                        fallback = Some(url);
                    } else if fallback.is_none() {
                        fallback = Some(url);
                    }
                }
            }
            "windows" => {
                if name_lc.ends_with(".exe") {
                    return Some(url);
                }
                if name_lc.ends_with(".msi") && fallback.is_none() {
                    fallback = Some(url);
                }
            }
            "linux" => {
                if name_lc.ends_with(".appimage")
                    || name_lc.ends_with(".deb")
                    || name_lc.ends_with(".rpm")
                {
                    return Some(url);
                }
            }
            _ => {}
        }
    }

    fallback.or_else(|| {
        release
            .get("html_url")
            .and_then(|v| v.as_str())
            .map(str::to_string)
    })
}

#[allow(dead_code)]
fn file_exists(path: &Path) -> bool {
    path.exists() && path.is_file()
}
