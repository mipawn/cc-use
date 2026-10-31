use crate::db::Database;
use base64::Engine;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IconUsageProvider {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IconDeleteResult {
    pub deleted: bool,
    pub used_by: Vec<IconUsageProvider>,
}

#[tauri::command]
pub fn icon_delete(
    db: tauri::State<'_, Arc<Mutex<Database>>>,
    filename: String,
) -> Result<IconDeleteResult, String> {
    let db = db.lock().map_err(|_| "Cannot access provider data")?;
    icon_delete_inner(&db, &get_icons_dir()?, &filename)
}

/// The library stores only filenames. Legacy provider records also store
/// absolute paths and file URLs; match those without treating a built-in mark
/// as an uploaded resource.
fn referenced_icon_filename(value: &str) -> Option<String> {
    let file_url = value.strip_prefix("file://");
    let decoded;
    let value = if let Some(path) = file_url {
        decoded = urlencoding::decode(path).ok()?;
        decoded.as_ref()
    } else {
        value
    };
    value
        .rsplit(['/', '\\'])
        .next()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn icon_delete_inner(
    db: &Database,
    directory: &std::path::Path,
    filename: &str,
) -> Result<IconDeleteResult, String> {
    if filename.is_empty()
        || filename.trim() != filename
        || filename.contains(['/', '\\', '\0'])
        || filename == "."
        || filename == ".."
        || icon_mime(filename).is_none()
    {
        return Err("Invalid uploaded icon name".into());
    }
    let directory = std::fs::canonicalize(directory).map_err(|_| "Cannot access icon library")?;
    let file = directory.join(filename);
    let metadata = std::fs::symlink_metadata(&file).map_err(|_| "Cannot access uploaded icon")?;
    if !metadata.file_type().is_file()
        || std::fs::canonicalize(&file)
            .map_err(|_| "Cannot access uploaded icon")?
            .parent()
            != Some(directory.as_path())
    {
        return Err("Invalid uploaded icon file".into());
    }

    // An immediate transaction prevents another connection from saving a new
    // reference between this check and removal. The app's DB mutex also keeps
    // the check atomic with ordinary provider edits on this connection.
    let transaction =
        rusqlite::Transaction::new_unchecked(&db.conn, rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| "Cannot check icon usage")?;
    let used_by = {
        let mut statement = transaction
            .prepare(
                "SELECT id, name, icon FROM providers WHERE icon IS NOT NULL ORDER BY name, id",
            )
            .map_err(|_| "Cannot check icon usage")?;
        let references = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|_| "Cannot check icon usage")?;
        let mut used_by = Vec::new();
        for reference in references {
            let (id, name, icon) = reference.map_err(|_| "Cannot check icon usage")?;
            if referenced_icon_filename(&icon).as_deref() == Some(filename) {
                used_by.push(IconUsageProvider { id, name });
            }
        }
        used_by
    };
    if !used_by.is_empty() {
        return Ok(IconDeleteResult {
            deleted: false,
            used_by,
        });
    }
    std::fs::remove_file(&file).map_err(|_| "Cannot delete uploaded icon")?;
    // No business data was changed. Drop the read-only transaction to release
    // its write reservation after the file has been removed.
    drop(transaction);
    Ok(IconDeleteResult {
        deleted: true,
        used_by: Vec::new(),
    })
}

/// Read through IPC so uploaded images also work in the development WebView.
/// Reuse the protocol's library-only path and file checks.
#[tauri::command]
pub fn icon_read(filename: String) -> Result<String, String> {
    icon_data_url(&get_icons_dir()?, &filename)
}

fn icon_data_url(directory: &std::path::Path, filename: &str) -> Result<String, String> {
    let (bytes, mime) = read_icon(directory, &urlencoding::encode(filename))?;
    Ok(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

#[tauri::command]
pub fn app_get_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
pub fn system_get_platform() -> String {
    std::env::consts::OS.to_string()
}

#[tauri::command]
pub async fn system_open_external(url: String) -> Result<(), String> {
    open::that(&url).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn icon_upload(buffer: Vec<u8>, filename: String) -> Result<String, String> {
    let icons_dir = get_icons_dir()?;
    std::fs::create_dir_all(&icons_dir).map_err(|e| e.to_string())?;

    save_icon(&icons_dir, &buffer, &filename)
}

fn icon_mime(filename: &str) -> Option<&'static str> {
    match std::path::Path::new(filename)
        .extension()?
        .to_str()?
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        "svg" => Some("image/svg+xml"),
        "ico" => Some("image/x-icon"),
        _ => None,
    }
}

fn save_icon(directory: &std::path::Path, buffer: &[u8], filename: &str) -> Result<String, String> {
    if buffer.is_empty() || buffer.len() > 5 * 1024 * 1024 {
        return Err("图标文件必须在 5 MB 以内且不能为空".into());
    }
    icon_mime(filename).ok_or("请选择 PNG、JPEG、WebP、GIF、SVG 或 ICO 图片")?;
    let extension = std::path::Path::new(filename)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap();
    // A new upload is a new library entry, even when the original names match.
    let name = format!(
        "{}.{}",
        uuid::Uuid::new_v4(),
        extension.to_ascii_lowercase()
    );
    std::fs::write(directory.join(&name), buffer).map_err(|e| e.to_string())?;
    Ok(name)
}

fn read_icon(directory: &std::path::Path, path: &str) -> Result<(Vec<u8>, &'static str), String> {
    let name = urlencoding::decode(path.trim_start_matches('/')).map_err(|e| e.to_string())?;
    if name.contains('/') || name.contains('\\') || name == "." || name == ".." {
        return Err("Invalid icon name".into());
    }
    let mime = icon_mime(&name).ok_or("Unsupported icon format")?;
    let file = directory.join(name.as_ref());
    // The protocol serves regular library files only, never symlinks elsewhere.
    let metadata = std::fs::symlink_metadata(&file).map_err(|e| e.to_string())?;
    if !metadata.file_type().is_file() || metadata.len() > 5 * 1024 * 1024 {
        return Err("Invalid icon file".into());
    }
    Ok((std::fs::read(file).map_err(|e| e.to_string())?, mime))
}

pub fn icon_response(path: &str) -> tauri::http::Response<Vec<u8>> {
    match get_icons_dir().and_then(|directory| read_icon(&directory, path)) {
        Ok((bytes, mime)) => tauri::http::Response::builder()
            .header("Content-Type", mime)
            .header(
                "Content-Security-Policy",
                "default-src 'none'; style-src 'unsafe-inline'",
            )
            .body(bytes)
            .unwrap(),
        Err(_) => tauri::http::Response::builder()
            .status(404)
            .body(Vec::new())
            .unwrap(),
    }
}

#[tauri::command]
pub fn icon_list() -> Result<serde_json::Value, String> {
    let preset = vec![
        "claude", "codex", "gemini", "zhipu", "minimax", "xiaomi", "deepseek", "custom",
    ];

    let icons_dir = get_icons_dir()?;
    let uploaded: Vec<String> = if icons_dir.exists() {
        std::fs::read_dir(&icons_dir)
            .map_err(|e| e.to_string())?
            .filter_map(|entry| {
                entry
                    .ok()
                    .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
                    .and_then(|e| e.file_name().to_str().map(|s| s.to_string()))
                    .filter(|name| icon_mime(name).is_some())
            })
            .collect()
    } else {
        vec![]
    };

    Ok(serde_json::json!({
        "preset": preset,
        "uploaded": uploaded,
    }))
}

fn get_icons_dir() -> Result<PathBuf, String> {
    let dir_name = if cfg!(debug_assertions) {
        "com.mipawn.cc-use.dev"
    } else {
        "com.mipawn.cc-use"
    };

    #[cfg(target_os = "macos")]
    let base = dirs::data_dir().ok_or("Cannot find data dir")?;
    #[cfg(not(target_os = "macos"))]
    let base = PathBuf::from(".");

    Ok(base.join(dir_name).join("icons"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ipc_icons_preserve_image_bytes_and_mime_and_reject_outside_files() {
        let dir = tempfile::tempdir().unwrap();
        let image = include_bytes!("../../icons/32x32.png");
        std::fs::write(dir.path().join("my logo.png"), image).unwrap();
        let data_url = icon_data_url(dir.path(), "my logo.png").unwrap();
        let encoded = data_url.strip_prefix("data:image/png;base64,").unwrap();
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .unwrap(),
            image
        );
        assert!(icon_data_url(dir.path(), "../outside.png").is_err());
        assert!(icon_data_url(dir.path(), "missing.png").is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.path().join("my logo.png"), dir.path().join("link.png"))
                .unwrap();
            assert!(icon_data_url(dir.path(), "link.png").is_err());
        }
    }

    #[test]
    fn uploads_are_distinct_library_entries_and_can_be_read() {
        let dir = tempfile::tempdir().unwrap();
        let first = save_icon(dir.path(), b"test image", "logo.png").unwrap();
        let second = save_icon(dir.path(), b"another image", "logo.png").unwrap();
        assert_ne!(first, second);
        let (data, mime) = read_icon(dir.path(), &format!("/{first}")).unwrap();
        assert_eq!(data, b"test image");
        assert_eq!(mime, "image/png");
    }

    #[test]
    fn library_rejects_traversal_and_non_images() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_icon(dir.path(), "/%2e%2e%2fsecret.png").is_err());
        assert!(save_icon(dir.path(), b"html", "logo.html").is_err());
        assert!(save_icon(dir.path(), b"", "logo.png").is_err());
    }

    #[test]
    fn delete_icon_removes_only_an_unreferenced_upload_and_preserves_provider_data() {
        let directory = tempfile::tempdir().unwrap();
        let db = Database::open_at(&directory.path().join("test.db")).unwrap();
        let icons = directory.path().join("icons");
        std::fs::create_dir(&icons).unwrap();
        let filename = save_icon(&icons, b"image", "uploaded.png").unwrap();
        let other = save_icon(&icons, b"other image", "other.png").unwrap();
        let result = icon_delete_inner(&db, &icons, &filename).unwrap();
        assert!(result.deleted);
        assert!(result.used_by.is_empty());
        assert!(!icons.join(&filename).exists());
        assert_eq!(std::fs::read(icons.join(other)).unwrap(), b"other image");
        assert!(db.provider_list().unwrap().is_empty());
        assert!(icon_delete_inner(&db, &icons, &filename).is_err());
    }

    #[test]
    fn delete_icon_checks_saved_and_legacy_references_without_modifying_them() {
        let directory = tempfile::tempdir().unwrap();
        let db = Database::open_at(&directory.path().join("test.db")).unwrap();
        let icons = directory.path().join("icons");
        std::fs::create_dir(&icons).unwrap();
        std::fs::write(icons.join("my icon.png"), b"image").unwrap();
        for (index, icon) in [
            "my icon.png",
            "/old/location/my icon.png",
            "file:///old/location/my%20icon.png",
        ]
        .into_iter()
        .enumerate()
        {
            let input = serde_json::from_value(serde_json::json!({
                "name": format!("provider-{index}"),
                "baseUrl": "https://example.test",
                "icon": icon,
            }))
            .unwrap();
            db.provider_create(&input).unwrap();
        }
        let before = serde_json::to_value(db.provider_list().unwrap()).unwrap();
        let result = icon_delete_inner(&db, &icons, "my icon.png").unwrap();
        assert!(!result.deleted);
        assert_eq!(result.used_by.len(), 3);
        assert_eq!(
            result
                .used_by
                .iter()
                .map(|p| p.name.as_str())
                .collect::<Vec<_>>(),
            vec!["provider-0", "provider-1", "provider-2"]
        );
        assert_eq!(std::fs::read(icons.join("my icon.png")).unwrap(), b"image");
        assert_eq!(
            serde_json::to_value(db.provider_list().unwrap()).unwrap(),
            before
        );
    }

    #[test]
    fn delete_icon_rejects_builtin_traversal_directories_and_symlinks() {
        let directory = tempfile::tempdir().unwrap();
        let db = Database::open_at(&directory.path().join("test.db")).unwrap();
        let icons = directory.path().join("icons");
        std::fs::create_dir(&icons).unwrap();
        std::fs::write(directory.path().join("outside.png"), b"outside").unwrap();
        std::fs::create_dir(icons.join("directory.png")).unwrap();
        for filename in [
            "",
            "claude",
            "custom",
            "..",
            "../outside.png",
            "/outside.png",
            "a\\outside.png",
            "file:///outside.png",
            "bad.html",
            "directory.png",
        ] {
            assert!(
                icon_delete_inner(&db, &icons, filename).is_err(),
                "{filename}"
            );
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(
                directory.path().join("outside.png"),
                icons.join("link.png"),
            )
            .unwrap();
            assert!(icon_delete_inner(&db, &icons, "link.png").is_err());
            assert!(std::fs::symlink_metadata(icons.join("link.png"))
                .unwrap()
                .file_type()
                .is_symlink());
        }
        assert_eq!(
            std::fs::read(directory.path().join("outside.png")).unwrap(),
            b"outside"
        );
    }
}
