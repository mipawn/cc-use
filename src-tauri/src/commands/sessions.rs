use crate::models::ClaudeSession;
use std::fs;
use std::path::PathBuf;

fn get_claude_dir() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|h| h.join(".claude"))
        .ok_or_else(|| "Cannot find home directory".to_string())
}

/// Scan all project directories and collect session info.
/// Priority: sessions-index.json > scan *.jsonl files
#[tauri::command]
pub async fn scan_sessions() -> Result<Vec<ClaudeSession>, String> {
    let claude_dir = get_claude_dir()?;
    let projects_dir = claude_dir.join("projects");

    if !projects_dir.exists() {
        return Ok(vec![]);
    }

    let mut sessions = Vec::new();

    for project_entry in fs::read_dir(&projects_dir).map_err(|e| e.to_string())? {
        let project_entry = project_entry.map_err(|e| e.to_string())?;
        let project_dir = project_entry.path();
        if !project_dir.is_dir() {
            continue;
        }

        let slug = project_dir
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();

        // Try sessions-index.json first (structured, reliable)
        let index_path = project_dir.join("sessions-index.json");
        if index_path.exists() {
            if let Ok(index_sessions) = scan_from_index(&project_dir, &slug, &index_path) {
                if !index_sessions.is_empty() {
                    sessions.extend(index_sessions);
                    // Also collect orphan files not in index
                    if let Ok(orphans) =
                        scan_orphan_files(&project_dir, &slug, Some(&index_path))
                    {
                        sessions.extend(orphans);
                    }
                    continue;
                }
            }
        }

        // Fallback: scan *.jsonl files directly
        if let Ok(file_sessions) = scan_from_files(&project_dir, &slug) {
            sessions.extend(file_sessions);
        }
    }

    sessions.sort_by(|a, b| b.last_modified.cmp(&a.last_modified));
    Ok(sessions)
}

/// Read sessions-index.json which has format:
/// `[[\"version\", 1], [\"entries\", [...]]]` (array of tuples)
/// or `{\"version\": 1, \"entries\": [...]}` (object)
fn scan_from_index(
    project_dir: &PathBuf,
    slug: &str,
    index_path: &PathBuf,
) -> Result<Vec<ClaudeSession>, String> {
    let content = fs::read_to_string(index_path).map_err(|e| e.to_string())?;
    let json: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    let entries = extract_entries(&json);
    let mut sessions = Vec::new();

    for entry in entries {
        let session_id = match entry.get("sessionId").and_then(|v| v.as_str()) {
            Some(id) if !id.is_empty() => id.to_string(),
            _ => continue,
        };

        let project_path = entry
            .get("projectPath")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let first_prompt = entry
            .get("firstPrompt")
            .and_then(|v| v.as_str())
            .map(|s| s.chars().take(120).collect::<String>());

        let message_count = entry
            .get("messageCount")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as usize;

        // Parse modified time from ISO string or mtime
        let last_modified = entry
            .get("modified")
            .and_then(|v| v.as_str())
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|dt| dt.timestamp())
            .or_else(|| {
                entry
                    .get("fileMtime")
                    .and_then(|v| v.as_i64())
                    .map(|ms| ms / 1000)
            })
            .unwrap_or(0);

        // Calculate actual file sizes
        let jsonl_path = project_dir.join(format!("{}.jsonl", session_id));
        let jsonl_size = fs::metadata(&jsonl_path).ok().map(|m| m.len()).unwrap_or(0);

        let dir_path = project_dir.join(&session_id);
        let dir_size = if dir_path.exists() {
            calc_dir_size(&dir_path).unwrap_or(0)
        } else {
            0
        };

        let display_project = if project_path.is_empty() {
            slug_to_path(slug)
        } else {
            project_path
        };

        sessions.push(ClaudeSession {
            session_id,
            project_path: display_project,
            jsonl_size,
            dir_size,
            total_size: jsonl_size + dir_size,
            last_modified,
            message_count,
            first_message: first_prompt,
        });
    }

    Ok(sessions)
}

/// Extract entries array from either tuple-array or object format
fn extract_entries(json: &serde_json::Value) -> Vec<&serde_json::Value> {
    // Object format: {"entries": [...]}
    if let Some(entries) = json.get("entries").and_then(|v| v.as_array()) {
        return entries.iter().collect();
    }

    // Tuple-array format: [["version", 1], ["entries", [...]]]
    if let Some(arr) = json.as_array() {
        for item in arr {
            if let Some(inner) = item.as_array() {
                if inner.len() == 2 {
                    if inner[0].as_str() == Some("entries") {
                        if let Some(entries) = inner[1].as_array() {
                            return entries.iter().collect();
                        }
                    }
                }
            }
        }
    }

    vec![]
}

/// Scan *.jsonl files directly (fallback when no index exists)
fn scan_from_files(project_dir: &PathBuf, slug: &str) -> Result<Vec<ClaudeSession>, String> {
    let mut sessions = Vec::new();
    let display_project = slug_to_path(slug);

    for entry in fs::read_dir(project_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();

        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }

        let session_id = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();

        if session_id.is_empty() {
            continue;
        }

        let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
        let jsonl_size = metadata.len();
        let last_modified = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        let dir_path = project_dir.join(&session_id);
        let dir_size = if dir_path.exists() {
            calc_dir_size(&dir_path).unwrap_or(0)
        } else {
            0
        };

        // Read first user message from jsonl as summary (lightweight - only first few lines)
        let first_message = read_first_user_message(&path);

        sessions.push(ClaudeSession {
            session_id,
            project_path: display_project.clone(),
            jsonl_size,
            dir_size,
            total_size: jsonl_size + dir_size,
            last_modified,
            message_count: 0, // Unknown without index
            first_message,
        });
    }

    Ok(sessions)
}

/// Find files not tracked by index (orphan directories or jsonl)
fn scan_orphan_files(
    project_dir: &PathBuf,
    slug: &str,
    index_path: Option<&PathBuf>,
) -> Result<Vec<ClaudeSession>, String> {
    let mut indexed_ids = std::collections::HashSet::new();

    if let Some(idx_path) = index_path {
        if let Ok(content) = fs::read_to_string(idx_path) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                for entry in extract_entries(&json) {
                    if let Some(id) = entry.get("sessionId").and_then(|v| v.as_str()) {
                        indexed_ids.insert(id.to_string());
                    }
                }
            }
        }
    }

    let mut sessions = Vec::new();
    let display_project = slug_to_path(slug);

    for entry in fs::read_dir(project_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();

        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }

        let session_id = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();

        if session_id.is_empty() || indexed_ids.contains(&session_id) {
            continue;
        }

        let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
        let jsonl_size = metadata.len();
        let last_modified = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        let dir_path = project_dir.join(&session_id);
        let dir_size = if dir_path.exists() {
            calc_dir_size(&dir_path).unwrap_or(0)
        } else {
            0
        };

        sessions.push(ClaudeSession {
            session_id,
            project_path: display_project.clone(),
            jsonl_size,
            dir_size,
            total_size: jsonl_size + dir_size,
            last_modified,
            message_count: 0,
            first_message: read_first_user_message(&path),
        });
    }

    Ok(sessions)
}

/// Read just the first user message from a JSONL file for display
fn read_first_user_message(path: &PathBuf) -> Option<String> {
    use std::io::{BufRead, BufReader};
    let file = fs::File::open(path).ok()?;
    let reader = BufReader::new(file);

    for line in reader.lines().take(50) {
        let line = line.ok()?;
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
            if json.get("type").and_then(|v| v.as_str()) != Some("user") {
                continue;
            }
            if let Some(msg) = json.get("message") {
                if let Some(content) = msg.get("content") {
                    if let Some(text) = content.as_str() {
                        let trimmed = text.trim();
                        if !trimmed.is_empty() {
                            return Some(trimmed.chars().take(120).collect());
                        }
                    }
                    if let Some(arr) = content.as_array() {
                        for item in arr {
                            let t = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
                            if t == "text" || t == "input_text" {
                                if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                                    let trimmed = text.trim();
                                    if !trimmed.is_empty() {
                                        return Some(trimmed.chars().take(120).collect());
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    None
}

/// Convert slug back to a readable path
/// Convert slug back to real filesystem path.
///
/// Slug encoding rule (from Claude Code source):
///   path.replace(/[^a-zA-Z0-9]/g, "-")
/// On Windows, paths are first normalized: C:\Users\x → /c/Users/x
/// So Windows slug looks like: -c-Users-john-project
///
/// Since encoding is lossy (hyphens, underscores, spaces, dots all become `-`),
/// we use greedy filesystem probing to recover the real path.
fn slug_to_path(slug: &str) -> String {
    let raw = match slug.strip_prefix('-') {
        Some(r) => r,
        None => return slug.to_string(),
    };

    let parts: Vec<&str> = raw.split('-').collect();
    if parts.is_empty() {
        return slug.to_string();
    }

    let mut i = 0;

    // Detect Windows-style slug: first part is a single lowercase letter (drive letter)
    // e.g., slug "-c-Users-john-project" → parts ["c", "Users", "john", "project"]
    // Normalized Windows path was "/c/Users/john/project"
    let mut path = if cfg!(windows) && parts[0].len() == 1 && parts[0].chars().all(|c| c.is_ascii_lowercase()) {
        // Reconstruct Windows drive path: "c" → "C:\"
        let drive = parts[0].to_uppercase();
        i = 1;
        std::path::PathBuf::from(format!("{}:\\", drive))
    } else {
        std::path::PathBuf::from("/")
    };

    while i < parts.len() {
        let mut found = false;
        // Try longest possible segment first (greedy)
        for end in (i + 1..=parts.len()).rev() {
            let segment = parts[i..end].join("-");
            // Try the segment as-is (covers names that actually contain hyphens)
            let candidate = path.join(&segment);
            if candidate.exists() {
                path = candidate;
                i = end;
                found = true;
                break;
            }
            // Also try common substitutions: hyphen → underscore, hyphen → dot, hyphen → space
            for sep in &["_", ".", " "] {
                let alt_segment = parts[i..end].join(sep);
                let alt_candidate = path.join(&alt_segment);
                if alt_candidate.exists() {
                    path = alt_candidate;
                    i = end;
                    found = true;
                    break;
                }
            }
            if found {
                break;
            }
        }
        if !found {
            // No match on filesystem, append remaining as individual segments
            for j in i..parts.len() {
                path = path.join(parts[j]);
            }
            break;
        }
    }

    path.to_string_lossy().to_string()
}

/// Delete session files (.jsonl + directory). Does NOT touch history.jsonl.
#[tauri::command]
pub async fn delete_sessions(session_ids: Vec<String>) -> Result<usize, String> {
    let claude_dir = get_claude_dir()?;
    let projects_dir = claude_dir.join("projects");

    if !projects_dir.exists() {
        return Ok(0);
    }

    let mut deleted = 0;

    for project_entry in fs::read_dir(&projects_dir).map_err(|e| e.to_string())? {
        let project_entry = project_entry.map_err(|e| e.to_string())?;
        let project_dir = project_entry.path();
        if !project_dir.is_dir() {
            continue;
        }

        for session_id in &session_ids {
            let jsonl_path = project_dir.join(format!("{}.jsonl", session_id));
            let dir_path = project_dir.join(session_id);

            if jsonl_path.exists() {
                fs::remove_file(&jsonl_path).map_err(|e| e.to_string())?;
                deleted += 1;
            }

            if dir_path.exists() {
                fs::remove_dir_all(&dir_path).map_err(|e| e.to_string())?;
            }
        }
    }

    Ok(deleted)
}

#[tauri::command]
pub async fn clean_old_sessions(days: i64) -> Result<usize, String> {
    let sessions = scan_sessions().await?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs() as i64;
    let cutoff = now - (days * 86400);

    let to_delete: Vec<String> = sessions
        .into_iter()
        .filter(|s| s.last_modified < cutoff && s.last_modified > 0)
        .map(|s| s.session_id)
        .collect();

    if to_delete.is_empty() {
        return Ok(0);
    }

    delete_sessions(to_delete).await
}

#[tauri::command]
pub async fn keep_recent_sessions(keep_count: usize) -> Result<usize, String> {
    let sessions = scan_sessions().await?;

    // Group by project
    let mut by_project: std::collections::HashMap<String, Vec<ClaudeSession>> =
        std::collections::HashMap::new();
    for session in sessions {
        by_project
            .entry(session.project_path.clone())
            .or_default()
            .push(session);
    }

    let mut to_delete = Vec::new();

    for (_project, mut project_sessions) in by_project {
        project_sessions.sort_by(|a, b| b.last_modified.cmp(&a.last_modified));
        for session in project_sessions.into_iter().skip(keep_count) {
            to_delete.push(session.session_id);
        }
    }

    if to_delete.is_empty() {
        return Ok(0);
    }

    delete_sessions(to_delete).await
}

fn calc_dir_size(path: &PathBuf) -> Result<u64, std::io::Error> {
    let mut total = 0;
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let metadata = entry.metadata()?;
        if metadata.is_dir() {
            total += calc_dir_size(&entry.path())?;
        } else {
            total += metadata.len();
        }
    }
    Ok(total)
}
