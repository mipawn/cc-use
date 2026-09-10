//! Command implementations.
//!
//! The CLI is a launch entry, nothing more: prepare the same managed instance
//! a GUI launch would create, then exec the wrapper in the terminal we are in.
//! Management (hot switch, instance list, statistics) lives in the GUI.

use crate::format;
use cc_use_lib::db::Database;
use cc_use_lib::models::{ApiKey, ManagedInstance, Project, Provider};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub struct Ctx {
    pub db: Database,
    pub cwd: Option<PathBuf>,
    /// stdin is a TTY — route selection is always interactive.
    pub interactive: bool,
    /// Real CLI launches require the local proxy listener. Disabled for unit tests.
    pub verify_daemon: bool,
}

pub enum CliError {
    /// Something went wrong. Exit code 1.
    Failed(String),
    /// The input was ambiguous or matched nothing; the user has to narrow it
    /// down. Exit code 2, so scripts can tell this apart from a hard failure.
    NeedsChoice(String),
}

impl CliError {
    pub fn code(&self) -> i32 {
        match self {
            CliError::Failed(_) => 1,
            CliError::NeedsChoice(_) => 2,
        }
    }

    pub fn message(&self) -> &str {
        match self {
            CliError::Failed(msg) | CliError::NeedsChoice(msg) => msg,
        }
    }
}

type CmdResult = Result<(), CliError>;

fn db_err(e: impl std::fmt::Display) -> CliError {
    CliError::Failed(format!("读取数据库失败: {}", e))
}

fn normalize_cli_type(value: &str) -> &str {
    if value == "claude" {
        "claude_code"
    } else {
        value
    }
}

impl Ctx {
    pub fn open() -> Result<Self, CliError> {
        use std::io::IsTerminal;
        let db = Database::new()
            .map_err(|e| CliError::Failed(format!("无法打开 cc-use 数据库: {}", e)))?;
        Ok(Self {
            db,
            cwd: invocation_dir(),
            interactive: std::io::stdin().is_terminal(),
            verify_daemon: true,
        })
    }

    /// Build a context around an already-open database. Used by tests so the
    /// command bodies can run against a temp database instead of the real one.
    pub fn with_db(db: Database, cwd: Option<PathBuf>) -> Self {
        Self {
            db,
            cwd,
            interactive: false,
            verify_daemon: false,
        }
    }
}

/// Preserve the path spelling the user's shell exposes through `$PWD` (for
/// example `/tmp/project` or a symlinked workspace) while rejecting a stale or
/// forged value that does not point at the process' actual working directory.
fn invocation_dir() -> Option<PathBuf> {
    let physical = std::env::current_dir().ok()?;
    let logical = std::env::var_os("PWD").map(PathBuf::from);
    Some(prefer_logical_dir(physical, logical.as_deref()))
}

fn prefer_logical_dir(physical: PathBuf, logical: Option<&Path>) -> PathBuf {
    let Some(logical) = logical.filter(|path| path.is_absolute()) else {
        return physical;
    };
    let same_directory = logical
        .canonicalize()
        .ok()
        .zip(physical.canonicalize().ok())
        .is_some_and(|(logical, physical)| logical == physical);
    if same_directory {
        logical.to_path_buf()
    } else {
        physical
    }
}

fn ensure_daemon_available(ctx: &Ctx) -> Result<(), CliError> {
    if !ctx.verify_daemon {
        return Ok(());
    }
    let port = ctx.db.settings_get().map_err(db_err)?.proxy_port;
    let port = u16::try_from(port)
        .map_err(|_| CliError::Failed(format!("本地服务端口配置无效: {}", port)))?;
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    std::net::TcpStream::connect_timeout(&address, std::time::Duration::from_millis(500)).map_err(
        |_| {
            CliError::Failed(
                "CC Use 本地服务未运行。请先打开 CC Use，确认服务启动后再试。".to_string(),
            )
        },
    )?;
    Ok(())
}

fn key_label(key: &ApiKey) -> String {
    key.alias.clone().unwrap_or_else(|| key.id.clone())
}

/// Every active, non-exhausted key that enables `client`, with its provider.
fn compatible_keys(db: &Database, client: &str) -> Result<Vec<(Provider, ApiKey)>, CliError> {
    let providers = db.provider_list().map_err(db_err)?;
    let mut out = Vec::new();
    for provider in providers {
        if !provider.is_active {
            continue;
        }
        for key in db.api_key_list(&provider.id).map_err(db_err)? {
            if !key.is_active || key.is_exhausted {
                continue;
            }
            if key.types.iter().any(|t| normalize_cli_type(t) == client) {
                out.push((provider.clone(), key));
            }
        }
    }
    Ok(out)
}

/// cwd 反查项目：项目路径是 cwd 或其祖先时命中，最深者优先。
fn resolve_project(ctx: &Ctx) -> Option<Project> {
    let cwd = ctx.cwd.as_deref()?;
    let projects = ctx.db.project_list().ok()?;
    let mut best: Option<(usize, Project)> = None;
    for project in projects {
        let Some(depth) = path_depth_if_prefix(Path::new(&project.path), cwd) else {
            continue;
        };
        match &best {
            Some((current, _)) if depth <= *current => {}
            _ => best = Some((depth, project)),
        }
    }
    best.map(|(_, project)| project)
}

fn path_depth_if_prefix(base: &Path, cwd: &Path) -> Option<usize> {
    let base_parts: Vec<_> = base.components().collect();
    if base_parts.is_empty() {
        return None;
    }
    let cwd_parts: Vec<_> = cwd.components().collect();
    if base_parts.len() > cwd_parts.len() {
        return None;
    }
    base_parts
        .iter()
        .zip(cwd_parts.iter())
        .all(|(a, b)| a == b)
        .then_some(base_parts.len())
}

/// The project's GUI-configured default route for this client, if any.
fn project_default_route(
    ctx: &Ctx,
    project: &Project,
    client: &str,
) -> Result<Option<(Provider, ApiKey)>, CliError> {
    let binding = project.bindings.get(client);
    let legacy_matches = normalize_cli_type(&project.cli_type) == client;
    let api_key_id = binding
        .and_then(|b| b.api_key_id.clone())
        .or_else(|| legacy_matches.then(|| project.api_key_id.clone()).flatten());
    let Some(api_key_id) = api_key_id else {
        return Ok(None);
    };
    let Some(key) = ctx.db.api_key_get(&api_key_id).map_err(db_err)? else {
        return Ok(None);
    };
    let Some(provider) = ctx.db.provider_get(&key.provider_id).map_err(db_err)? else {
        return Ok(None);
    };
    if !provider.is_active || !key.is_active || key.is_exhausted {
        return Ok(None);
    }
    Ok(Some((provider, key)))
}

struct RawTerminal {
    saved_mode: String,
    tty: File,
}

impl RawTerminal {
    fn enter() -> Result<Self, CliError> {
        // stdin can be reported as a TTY while child processes do not inherit a
        // usable controlling input (seen in zsh integrations and IDE shells).
        // Operate on /dev/tty explicitly so stty and the picker read the same
        // terminal the user is looking at.
        let tty = OpenOptions::new()
            .read(true)
            .write(true)
            .open("/dev/tty")
            .map_err(|e| CliError::Failed(format!("无法打开当前终端 /dev/tty: {}", e)))?;
        let saved = Command::new("stty")
            .arg("-g")
            .stdin(Stdio::from(tty.try_clone().map_err(|e| {
                CliError::Failed(format!("无法连接当前终端: {}", e))
            })?))
            .output()
            .map_err(|e| CliError::Failed(format!("无法读取终端模式: {}", e)))?;
        if !saved.status.success() {
            let detail = String::from_utf8_lossy(&saved.stderr).trim().to_string();
            return Err(CliError::Failed(if detail.is_empty() {
                "无法读取终端模式。".to_string()
            } else {
                format!("无法读取终端模式: {}", detail)
            }));
        }
        let saved_mode = String::from_utf8_lossy(&saved.stdout).trim().to_string();
        let raw = Command::new("stty")
            .args(["raw", "-echo"])
            .stdin(Stdio::from(tty.try_clone().map_err(|e| {
                CliError::Failed(format!("无法连接当前终端: {}", e))
            })?))
            .output()
            .map_err(|e| CliError::Failed(format!("无法进入交互选择模式: {}", e)))?;
        if !raw.status.success() {
            let detail = String::from_utf8_lossy(&raw.stderr).trim().to_string();
            return Err(CliError::Failed(if detail.is_empty() {
                "无法进入交互选择模式。".to_string()
            } else {
                format!("无法进入交互选择模式: {}", detail)
            }));
        }
        eprint!("\x1b[?25l");
        Ok(Self { saved_mode, tty })
    }
}

impl Drop for RawTerminal {
    fn drop(&mut self) {
        if let Ok(tty) = self.tty.try_clone() {
            let _ = Command::new("stty")
                .arg(&self.saved_mode)
                .stdin(Stdio::from(tty))
                .status();
        }
        eprint!("\x1b[?25h");
        let _ = std::io::stderr().flush();
    }
}

fn picker_color(code: &str, value: &str) -> String {
    if std::env::var_os("NO_COLOR").is_some() {
        value.to_string()
    } else {
        format!("\x1b[{}m{}\x1b[0m", code, value)
    }
}

const PICKER_DEFAULT_GREEN: &str = "32";

fn draw_key_picker(
    keys: &[(Provider, ApiKey)],
    default_index: usize,
    selected_index: usize,
    redraw_lines: usize,
) -> Result<usize, CliError> {
    let mut output = String::new();
    if redraw_lines > 0 {
        output.push_str(&format!("\x1b[{}A", redraw_lines));
    }
    output.push_str("\r\x1b[2K");
    output.push_str(&picker_color("1;36", "选择本次启动线路"));
    output.push_str("\r\n");

    for (index, (provider, key)) in keys.iter().enumerate() {
        output.push_str("\r\x1b[2K");
        if index == selected_index {
            output.push_str(&picker_color("1;36", "  ❯ "));
            output.push_str(&picker_color(
                "1;37",
                &format!(
                    "{}  {}",
                    format::ellipsize(&provider.name, 24),
                    format::ellipsize(&key_label(key), 28)
                ),
            ));
        } else {
            output.push_str("    ");
            output.push_str(&format!(
                "{}  {}",
                format::ellipsize(&provider.name, 24),
                format::ellipsize(&key_label(key), 28)
            ));
        }
        if index == default_index {
            output.push_str(&picker_color(PICKER_DEFAULT_GREEN, "  GUI 默认"));
        }
        output.push_str("\r\n");
    }

    output.push_str("\r\x1b[2K");
    output.push_str(&picker_color("2;37", "↑↓ 选择  Enter 启动  q 取消"));
    output.push_str("\r\n");
    eprint!("{}", output);
    std::io::stderr()
        .flush()
        .map_err(|e| CliError::Failed(format!("刷新选择列表失败: {}", e)))?;
    Ok(keys.len() + 2)
}

fn clear_key_picker(lines: usize) {
    let mut output = format!("\x1b[{}A", lines);
    for _ in 0..lines {
        output.push_str("\r\x1b[2K\x1b[1B");
    }
    output.push_str(&format!("\x1b[{}A\r", lines));
    eprint!("{}", output);
}

/// Interactive pick from the compatible key list.
fn pick_key(
    interactive: bool,
    keys: &[(Provider, ApiKey)],
    default_key_id: Option<&str>,
) -> Result<usize, CliError> {
    let default_index = default_key_id
        .and_then(|id| keys.iter().position(|(_, key)| key.id == id))
        .unwrap_or(0);

    if !interactive {
        let mut msg = String::from("cc-use 需要在交互终端中选择线路：\n");
        for (index, (provider, key)) in keys.iter().enumerate() {
            let marker = if index == default_index {
                "  （GUI 默认）"
            } else {
                ""
            };
            msg.push_str(&format!(
                "  {}. {} · {}{}\n",
                index + 1,
                provider.name,
                key_label(key),
                marker
            ));
        }
        return Err(CliError::NeedsChoice(msg.trim_end().to_string()));
    }

    let mut terminal = RawTerminal::enter()?;
    let mut selected = default_index;
    let mut drawn_lines = draw_key_picker(keys, default_index, selected, 0)?;
    loop {
        let mut byte = [0u8; 1];
        terminal
            .tty
            .read_exact(&mut byte)
            .map_err(|e| CliError::Failed(format!("读取方向键失败: {}", e)))?;
        match byte[0] {
            b'\r' | b'\n' => {
                clear_key_picker(drawn_lines);
                drop(terminal);
                let (provider, key) = &keys[selected];
                eprintln!(
                    "{} {}  {}",
                    picker_color("1;32", "✓"),
                    provider.name,
                    key_label(key)
                );
                return Ok(selected);
            }
            27 => {
                let mut sequence = [0u8; 2];
                if terminal.tty.read_exact(&mut sequence).is_ok() && sequence[0] == b'[' {
                    match sequence[1] {
                        b'A' => selected = selected.checked_sub(1).unwrap_or(keys.len() - 1),
                        b'B' => selected = (selected + 1) % keys.len(),
                        _ => continue,
                    }
                    drawn_lines = draw_key_picker(keys, default_index, selected, drawn_lines)?;
                }
            }
            3 | b'q' => {
                clear_key_picker(drawn_lines);
                drop(terminal);
                return Err(CliError::NeedsChoice("已取消启动。".to_string()));
            }
            b'k' => {
                selected = selected.checked_sub(1).unwrap_or(keys.len() - 1);
                drawn_lines = draw_key_picker(keys, default_index, selected, drawn_lines)?;
            }
            b'j' => {
                selected = (selected + 1) % keys.len();
                drawn_lines = draw_key_picker(keys, default_index, selected, drawn_lines)?;
            }
            _ => {}
        }
    }
}

// ── launch (cc-use claude / cc-use grok) ──

struct CliLaunchContext {
    project_id: Option<String>,
    project_name: String,
    working_dir: String,
    prelaunch_command: Option<String>,
}

fn cli_launch_context(project: Option<&Project>, cwd: &Path, client: &str) -> CliLaunchContext {
    let (project_id, project_name, prelaunch_command) = match project {
        Some(project) => (
            Some(project.id.clone()),
            project.name.clone(),
            project
                .bindings
                .get(client)
                .and_then(|binding| binding.prelaunch_command.clone())
                .or_else(|| {
                    (normalize_cli_type(&project.cli_type) == client)
                        .then(|| project.prelaunch_command.clone())
                        .flatten()
                })
                .filter(|value| !value.trim().is_empty()),
        ),
        None => (
            None,
            cwd.file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| "terminal".to_string()),
            None,
        ),
    };
    CliLaunchContext {
        project_id,
        project_name,
        working_dir: cwd.to_string_lossy().to_string(),
        prelaunch_command,
    }
}

/// Launch a terminal CLI in the terminal we were invoked from.
///
/// Every launch shows the compatible route list. The project's GUI-configured
/// default is preselected, so pressing Enter is the shortest path while another
/// route remains one arrow-key press away.
pub fn launch(ctx: &Ctx, client: &str) -> CmdResult {
    ensure_daemon_available(ctx)?;
    let cwd = ctx
        .cwd
        .clone()
        .ok_or_else(|| CliError::Failed("无法获取当前目录".to_string()))?;
    let project = resolve_project(ctx);

    let default_route = match &project {
        Some(project) => project_default_route(ctx, project, client)?,
        None => None,
    };
    let keys = compatible_keys(&ctx.db, client)?;
    if keys.is_empty() {
        return Err(CliError::Failed(format!(
            "没有任何密钥启用了 {}。先在应用内的供应商密钥页配置。",
            client
        )));
    }
    let default_key_id = default_route.as_ref().map(|(_, key)| key.id.as_str());
    let index = pick_key(ctx.interactive, &keys, default_key_id)?;
    let (provider, key) = keys.into_iter().nth(index).expect("index validated");

    let launch_context = cli_launch_context(project.as_ref(), &cwd, client);

    let prepared = cc_use_lib::terminal::prepare_cli_terminal_launch(
        &ctx.db,
        client,
        &provider.id,
        &key.id,
        launch_context.project_id.as_deref(),
        &launch_context.project_name,
        &launch_context.working_dir,
        launch_context.prelaunch_command,
    )
    .map_err(CliError::Failed)?;

    println!(
        "实例 {}  {} · {}",
        prepared.instance_label,
        provider.name,
        key_label(&key)
    );

    // Hand the terminal to the wrapper. exec replaces this process so the CLI
    // (heartbeat, trap, stop reporting) runs exactly like a GUI-launched one.
    use std::os::unix::process::CommandExt;
    let error = std::process::Command::new("/bin/sh")
        .arg(&prepared.script_path)
        .exec();
    // exec only returns on failure.
    Err(CliError::Failed(format!("启动失败: {}", error)))
}

// ── statusline ──

struct StatuslineInput {
    model: String,
    /// `workspace.current_dir` — where the session is now.
    current_dir: Option<PathBuf>,
    /// Top-level `cwd`, sent by clients that omit the workspace block.
    top_cwd: Option<PathBuf>,
    /// `workspace.project_dir` — where the session was started.
    workspace_project_dir: Option<PathBuf>,
    context_percentage: Option<f64>,
}

impl Default for StatuslineInput {
    fn default() -> Self {
        Self {
            model: "Claude".to_string(),
            current_dir: None,
            top_cwd: None,
            workspace_project_dir: None,
            context_percentage: None,
        }
    }
}

fn safe_status_text(value: &str, max_chars: usize) -> String {
    let clean = value
        .chars()
        .filter(|ch| !ch.is_control())
        .collect::<String>();
    format::ellipsize(clean.trim(), max_chars)
}

fn parse_statusline_input(raw: &str) -> StatuslineInput {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return StatuslineInput::default();
    };
    let string_at = |pointer: &str| {
        value
            .pointer(pointer)
            .and_then(|v| v.as_str())
            .filter(|v| !v.trim().is_empty())
            .map(str::to_string)
    };
    StatuslineInput {
        model: string_at("/model/display_name").unwrap_or_else(|| "Claude".to_string()),
        current_dir: string_at("/workspace/current_dir").map(PathBuf::from),
        top_cwd: string_at("/cwd").map(PathBuf::from),
        workspace_project_dir: string_at("/workspace/project_dir").map(PathBuf::from),
        context_percentage: value
            .pointer("/context_window/used_percentage")
            .and_then(|v| v.as_f64()),
    }
}

fn git_status(project_dir: &Path) -> Option<(String, bool)> {
    let output = Command::new("git")
        .args([
            "status",
            "--porcelain=v1",
            "--branch",
            "--untracked-files=normal",
        ])
        .current_dir(project_dir)
        .env("LC_ALL", "C")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut lines = text.lines();
    let header = lines.next()?.strip_prefix("## ")?;
    let branch = if let Some(rest) = header.strip_prefix("No commits yet on ") {
        rest
    } else if header.starts_with("HEAD (no branch)") {
        "detached"
    } else {
        header.split("...").next().unwrap_or(header)
    };
    Some((
        safe_status_text(branch, 22),
        lines.any(|line| !line.is_empty()),
    ))
}

fn ansi(code: &str, value: &str) -> String {
    if std::env::var_os("NO_COLOR").is_some() {
        value.to_string()
    } else {
        format!("\x1b[{}m{}\x1b[0m", code, value)
    }
}

// Mid-tone ANSI 256 colors stay readable on dark terminals without the neon
// contrast of the bright palette. Avoid bold here: Claude Code already gives
// the statusline enough visual weight through its fixed position.
const STATUS_CYAN: &str = "38;5;44";
const STATUS_BLUE: &str = "38;2;46;132;206";
const STATUS_YELLOW: &str = "38;5;221";
const STATUS_GREEN: &str = "38;5;78";
const STATUS_RED: &str = "38;5;203";

fn context_meter(percentage: Option<f64>) -> String {
    let percentage = percentage.unwrap_or(0.0).clamp(0.0, 100.0);
    let filled = (percentage / 10.0).round() as usize;
    let bar = format!("{}{}", "█".repeat(filled), "░".repeat(10 - filled));
    let color = if percentage >= 90.0 {
        STATUS_RED
    } else if percentage >= 70.0 {
        STATUS_YELLOW
    } else {
        STATUS_GREEN
    };
    format!(
        "{} {} {}",
        ansi(STATUS_BLUE, "Context"),
        ansi(color, &bar),
        ansi(color, &format!("{:.0}%", percentage))
    )
}

fn instance_short_code(value: &str) -> String {
    let length = value.chars().count();
    value.chars().skip(length.saturating_sub(8)).collect()
}

fn directory_name(path: &Path) -> Option<String> {
    path.file_name()
        .map(|name| safe_status_text(&name.to_string_lossy(), 24))
        .filter(|name| !name.is_empty())
        .or_else(|| (path == Path::new("/")).then(|| safe_status_text(&path.to_string_lossy(), 24)))
}

fn same_directory(left: &Path, right: &Path) -> bool {
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

/// Directory whose last segment titles the statusline.
///
/// Order: Claude's `workspace.current_dir`, the payload's top-level `cwd`, the
/// managed instance's saved launch directory, `workspace.project_dir`, then the
/// directory this invocation ran in. A bound project never overrides the title:
/// launching inside `work/smart/dsc/xxx` from a project bound to `work` reads
/// `xxx`, while the project still supplies the default route and prelaunch
/// command.
fn resolve_statusline_dir(
    instance: Option<&ManagedInstance>,
    input: &StatuslineInput,
    invocation_dir: Option<&Path>,
) -> Option<PathBuf> {
    let resolved = input
        .current_dir
        .clone()
        .or_else(|| input.top_cwd.clone())
        .or_else(|| instance.map(|item| PathBuf::from(&item.project_path)))
        .or_else(|| input.workspace_project_dir.clone())
        .or_else(|| invocation_dir.map(Path::to_path_buf))?;

    // The instance keeps the shell's logical spelling while the payload may
    // carry the canonical one for the same directory; show what the user typed.
    let logical = instance
        .map(|item| PathBuf::from(&item.project_path))
        .filter(|path| same_directory(path, &resolved));
    Some(logical.unwrap_or(resolved))
}

fn statusline_heading(display_dir: Option<&Path>) -> String {
    display_dir
        .and_then(directory_name)
        .unwrap_or_else(|| "CC USE".to_string())
}

/// Claude Code executes this on every status bar refresh and reads its JSON
/// payload from stdin. Multiple stdout lines and ANSI colors are supported.
/// Every error path degrades gracefully so statusline failures never interrupt
/// an interactive Claude Code session.
pub fn statusline() -> CmdResult {
    let mut raw = String::new();
    let _ = std::io::stdin().read_to_string(&mut raw);
    let input = parse_statusline_input(&raw);
    let db = Database::new().ok();

    // Never infer identity from cwd: another managed window may be running in
    // the same project. Only the ID injected into this process proves that the
    // current Claude Code session belongs to cc-use.
    let env_instance_id = std::env::var("CC_USE_INSTANCE_ID")
        .ok()
        .filter(|v| !v.is_empty());
    let instance = env_instance_id.and_then(|id| {
        db.as_ref()?
            .managed_instance_list_active()
            .ok()?
            .into_iter()
            .find(|instance| {
                instance.id == id
                    && matches!(instance.status.as_str(), "launching" | "running" | "stale")
            })
    });

    let route = instance.as_ref().map(|instance| {
        let provider = instance
            .provider_id
            .as_ref()
            .and_then(|id| db.as_ref()?.provider_get(id).ok().flatten())
            .map(|provider| safe_status_text(&provider.name, 18))
            .unwrap_or_else(|| "Unknown provider".to_string());
        let key = instance
            .api_key_id
            .as_ref()
            .and_then(|id| db.as_ref()?.api_key_get(id).ok().flatten())
            .map(|key| safe_status_text(&key_label(&key), 20))
            .unwrap_or_else(|| "Unknown key".to_string());
        (provider, key, instance_short_code(&instance.id))
    });

    // The title, the Git probe and the context meter all describe the one
    // directory this session is actually running in, so they share a source.
    let display_dir =
        resolve_statusline_dir(instance.as_ref(), &input, invocation_dir().as_deref());
    let heading = statusline_heading(display_dir.as_deref());
    let line_one = if let Some((provider, key, short_code)) = route {
        format!(
            "{} {} {} {} {} {} {}",
            ansi(STATUS_CYAN, &heading),
            ansi(STATUS_BLUE, "│"),
            ansi(STATUS_YELLOW, &provider),
            ansi(STATUS_BLUE, "/"),
            ansi(STATUS_GREEN, &key),
            ansi(STATUS_BLUE, "│"),
            ansi(STATUS_YELLOW, &short_code)
        )
    } else {
        format!(
            "{} {} {}",
            ansi(STATUS_CYAN, &heading),
            ansi(STATUS_BLUE, "│"),
            ansi(STATUS_YELLOW, "unmanaged")
        )
    };

    let mut line_two = vec![ansi(
        STATUS_CYAN,
        &format!("[{}]", safe_status_text(&input.model, 20)),
    )];
    if let Some((branch, dirty)) = display_dir
        .as_deref()
        .filter(|dir| dir.is_dir())
        .and_then(git_status)
    {
        line_two.push(format!(
            "{}{}{}",
            ansi(STATUS_BLUE, "git:("),
            ansi(
                STATUS_GREEN,
                &format!("{}{}", branch, if dirty { "*" } else { "" })
            ),
            ansi(STATUS_BLUE, ")")
        ));
    }
    line_two.push(context_meter(input.context_percentage));

    println!("{}", line_one);
    println!(
        "{}",
        line_two.join(&format!(" {} ", ansi(STATUS_BLUE, "│")))
    );
    Ok(())
}

// ── install ──

const INSTALL_PATH: &str = "/usr/local/bin/cc-use";

pub fn install() -> CmdResult {
    let exe = std::env::current_exe()
        .map_err(|e| CliError::Failed(format!("无法定位当前可执行文件: {}", e)))?;
    let target = Path::new(INSTALL_PATH);

    if let Ok(existing) = std::fs::read_link(target) {
        if existing == exe {
            println!("{} 已经指向当前版本。", INSTALL_PATH);
            return Ok(());
        }
    } else if target.exists() {
        return Err(CliError::Failed(format!(
            "{} 已存在且不是 cc-use 创建的符号链接，未做改动。",
            INSTALL_PATH
        )));
    }

    if let Some(parent) = target.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| CliError::Failed(format!("无法创建 {}: {}", parent.display(), e)))?;
        }
    }

    let _ = std::fs::remove_file(target);
    std::os::unix::fs::symlink(&exe, target).map_err(|e| {
        CliError::Failed(format!(
            "创建 {} 失败: {}。如果是权限问题，用 sudo cc-use install 重试。",
            INSTALL_PATH, e
        ))
    })?;

    println!("已安装 {} -> {}", INSTALL_PATH, exe.display());
    println!("状态栏一键配置：cc-use setup-statusline（或在应用的 Claude Code 页开启）");
    Ok(())
}

// ── setup-statusline ──

/// One-click Claude Code statusLine setup. Writes the absolute path of this
/// binary into ~/.claude/settings.json so the status bar works even without
/// `cc-use install` / PATH. Backs settings.json up on first write and refuses
/// to clobber a third-party statusLine without --force.
pub fn setup_statusline(force: bool) -> CmdResult {
    let exe = std::env::current_exe()
        .map_err(|e| CliError::Failed(format!("无法定位当前可执行文件: {}", e)))?;
    match cc_use_lib::statusline_config::enable(&exe, force).map_err(CliError::Failed)? {
        cc_use_lib::statusline_config::EnableOutcome::Enabled { backup_path } => {
            println!("已写入 ~/.claude/settings.json 的 statusLine。");
            if let Some(backup) = backup_path {
                println!("原配置已备份到 {}", backup.display());
            }
            println!("Claude Code 会在下一次交互时刷新。恢复：cc-use setup-statusline --restore");
        }
        cc_use_lib::statusline_config::EnableOutcome::AlreadyEnabled => {
            println!("statusLine 已指向当前版本，无需改动。");
        }
        cc_use_lib::statusline_config::EnableOutcome::ThirdPartyPresent { command } => {
            return Err(CliError::NeedsChoice(format!(
                "settings.json 已配置第三方 statusLine：\n  {}\n用 --force 覆盖（原文件会先备份）。",
                command
            )));
        }
    }
    Ok(())
}

pub fn restore_statusline() -> CmdResult {
    if cc_use_lib::statusline_config::restore().map_err(CliError::Failed)? {
        println!("已移除 cc-use 的 statusLine 配置。");
    } else {
        println!("settings.json 中没有 cc-use 的 statusLine 配置，未做改动。");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn managed_instance(project_id: Option<String>, project_path: &str) -> ManagedInstance {
        ManagedInstance {
            id: "inst-1".to_string(),
            session_token: "token-1".to_string(),
            project_id,
            provider_id: None,
            api_key_id: None,
            cli_type: "claude_code".to_string(),
            terminal_type: "cli".to_string(),
            project_path: project_path.to_string(),
            shell_pid: None,
            process_pid: None,
            status: "running".to_string(),
            assignment_source: None,
            last_seen_at: "".to_string(),
            launched_at: "".to_string(),
            stopped_at: None,
            stop_reason: None,
            exit_code: None,
        }
    }

    #[cfg(unix)]
    #[test]
    fn invocation_dir_preserves_a_verified_logical_path() {
        let dir = tempfile::tempdir().unwrap();
        let physical = dir.path().join("physical");
        let logical = dir.path().join("logical");
        std::fs::create_dir(&physical).unwrap();
        std::os::unix::fs::symlink(&physical, &logical).unwrap();

        assert_eq!(
            prefer_logical_dir(physical.clone(), Some(&logical)),
            logical
        );
        assert_eq!(
            prefer_logical_dir(physical.clone(), Some(&dir.path().join("missing"))),
            physical
        );
    }

    #[test]
    fn raw_terminal_uses_controlling_tty_when_available() {
        use std::io::IsTerminal;
        if !std::io::stdin().is_terminal() {
            return;
        }
        let terminal = match RawTerminal::enter() {
            Ok(terminal) => terminal,
            Err(error) => panic!(
                "open /dev/tty and switch terminal mode: {}",
                error.message()
            ),
        };
        drop(terminal);
    }

    #[test]
    fn picker_default_marker_uses_non_dim_green() {
        assert_eq!(PICKER_DEFAULT_GREEN, "32");
        assert!(!PICKER_DEFAULT_GREEN.starts_with("2;"));
    }

    #[test]
    fn statusline_input_reads_claude_code_payload() {
        let input = parse_statusline_input(
            r#"{
                "model": {"display_name": "Opus 4.1"},
                "cwd": "/tmp/from-cwd",
                "workspace": {
                    "current_dir": "/tmp/cc-use",
                    "project_dir": "/tmp/cc-use-start"
                },
                "context_window": {"used_percentage": 42.4}
            }"#,
        );
        assert_eq!(input.model, "Opus 4.1");
        assert_eq!(input.current_dir, Some(PathBuf::from("/tmp/cc-use")));
        assert_eq!(input.top_cwd, Some(PathBuf::from("/tmp/from-cwd")));
        assert_eq!(
            input.workspace_project_dir,
            Some(PathBuf::from("/tmp/cc-use-start"))
        );
        assert_eq!(input.context_percentage, Some(42.4));
    }

    #[test]
    fn statusline_text_strips_terminal_control_characters() {
        assert_eq!(safe_status_text("main\n\x1b[31m", 20), "main[31m");
    }

    #[test]
    fn context_meter_changes_at_thresholds() {
        let ready = context_meter(None);
        let normal = context_meter(Some(42.0));
        let warning = context_meter(Some(78.0));
        let danger = context_meter(Some(94.0));
        assert!(ready.contains("0%"));
        assert!(ready.contains("░░░░░░░░░░"));
        assert!(normal.contains("42%"));
        assert!(warning.contains("78%"));
        assert!(danger.contains("94%"));
        assert!(normal.contains("████"));
    }

    #[test]
    fn statusline_palette_uses_muted_non_bold_colors() {
        assert_eq!(STATUS_CYAN, "38;5;44");
        assert_eq!(STATUS_BLUE, "38;2;46;132;206");
        assert_eq!(STATUS_YELLOW, "38;5;221");
        assert_eq!(STATUS_GREEN, "38;5;78");
        assert_eq!(STATUS_RED, "38;5;203");
        assert!([
            STATUS_CYAN,
            STATUS_BLUE,
            STATUS_YELLOW,
            STATUS_GREEN,
            STATUS_RED
        ]
        .iter()
        .all(|color| !color.starts_with("1;")));
    }

    #[test]
    fn instance_short_code_keeps_the_tail_of_the_instance_id() {
        assert_eq!(instance_short_code("instance-8f32ac91"), "8f32ac91");
        assert_eq!(instance_short_code("short"), "short");
    }

    #[test]
    fn cli_project_context_keeps_the_invocation_subdirectory() {
        let project = Project {
            id: "project-1".to_string(),
            name: "Demo Project".to_string(),
            path: "/tmp/demo".to_string(),
            group_name: None,
            remark: None,
            provider_id: None,
            api_key_id: None,
            cli_type: "claude_code".to_string(),
            terminal_type: "cli".to_string(),
            prelaunch_command: None,
            last_opened_at: None,
            bindings: Default::default(),
        };
        let launch = cli_launch_context(
            Some(&project),
            Path::new("/tmp/demo/packages/web"),
            "claude_code",
        );
        assert_eq!(launch.project_id.as_deref(), Some(project.id.as_str()));
        assert_eq!(launch.project_name, "Demo Project");
        assert_eq!(launch.working_dir, "/tmp/demo/packages/web");
    }

    #[test]
    fn cli_project_context_resolves_prelaunch_command_like_gui() {
        use cc_use_lib::models::{CreateProjectInput, ProjectClientBinding};

        let dir = tempfile::tempdir().unwrap();
        let db = Database::open_at(&dir.path().join("test.db")).unwrap();
        let mut project = db
            .project_create(&CreateProjectInput {
                name: "Demo".to_string(),
                path: "/tmp/demo".to_string(),
                group_name: None,
                remark: None,
                provider_id: None,
                api_key_id: None,
                cli_type: Some("claude_code".to_string()),
                terminal_type: None,
                prelaunch_command: Some("export DEMO_READY=1".to_string()),
            })
            .unwrap();

        // A project can retain its command in the legacy fields while the
        // client binding is missing or has no command.
        for (legacy_client, client, binding_command, expected) in [
            (
                "claude_code",
                "claude_code",
                None,
                Some("export DEMO_READY=1"),
            ),
            ("claude", "claude_code", None, Some("export DEMO_READY=1")),
            ("grok", "grok", None, Some("export DEMO_READY=1")),
            ("claude_code", "grok", None, None),
            ("grok", "claude_code", None, None),
            (
                "claude_code",
                "claude_code",
                Some("binding-init"),
                Some("binding-init"),
            ),
            ("claude_code", "grok", Some("grok-init"), Some("grok-init")),
            ("claude_code", "claude_code", Some(" \n "), None),
        ] {
            project.cli_type = legacy_client.to_string();
            project.bindings.clear();
            if binding_command.is_none() {
                let launch = cli_launch_context(Some(&project), Path::new("/tmp/demo/sub"), client);
                assert_eq!(
                    launch.prelaunch_command.as_deref(),
                    expected,
                    "missing binding: {legacy_client}/{client}"
                );
            }
            project.bindings.insert(
                client.to_string(),
                ProjectClientBinding {
                    cli_type: client.to_string(),
                    provider_id: None,
                    api_key_id: None,
                    terminal_type: "terminal".to_string(),
                    prelaunch_command: binding_command.map(str::to_string),
                },
            );
            let launch = cli_launch_context(Some(&project), Path::new("/tmp/demo/sub"), client);
            assert_eq!(
                launch.prelaunch_command.as_deref(),
                expected,
                "{legacy_client}/{client}/{binding_command:?}"
            );
            assert_eq!(launch.working_dir, "/tmp/demo/sub");
        }
        assert!(
            cli_launch_context(None, Path::new("/tmp/other"), "claude_code")
                .prelaunch_command
                .is_none()
        );
    }

    #[test]
    fn statusline_uses_the_invocation_directory_without_a_bound_project() {
        let instance = managed_instance(None, "/tmp/logical-workspace");
        let input = StatuslineInput::default();
        assert_eq!(
            statusline_heading(
                resolve_statusline_dir(
                    Some(&instance),
                    &input,
                    Some(Path::new("/private/tmp/elsewhere"))
                )
                .as_deref()
            ),
            "logical-workspace"
        );
        assert_eq!(
            statusline_heading(
                resolve_statusline_dir(None, &input, Some(Path::new("/tmp/plain-workspace")))
                    .as_deref()
            ),
            "plain-workspace"
        );
        assert_eq!(statusline_heading(None), "CC USE");
    }

    #[test]
    fn statusline_directory_follows_the_documented_precedence() {
        let instance = managed_instance(None, "/tmp/launched-here");

        let input = parse_statusline_input(
            r#"{
                "cwd": "/tmp/top-level",
                "workspace": {
                    "current_dir": "/tmp/current",
                    "project_dir": "/tmp/started-here"
                }
            }"#,
        );
        assert_eq!(
            statusline_heading(resolve_statusline_dir(Some(&instance), &input, None).as_deref()),
            "current"
        );

        let input = parse_statusline_input(r#"{"cwd": "/tmp/top-level"}"#);
        assert_eq!(
            statusline_heading(resolve_statusline_dir(Some(&instance), &input, None).as_deref()),
            "top-level"
        );

        let input = StatuslineInput::default();
        assert_eq!(
            statusline_heading(resolve_statusline_dir(Some(&instance), &input, None).as_deref()),
            "launched-here"
        );

        // `workspace.project_dir` is the start directory, so it outranks only
        // the directory this statusline invocation happened to run in.
        let input =
            parse_statusline_input(r#"{"workspace": {"project_dir": "/tmp/started-here"}}"#);
        assert_eq!(
            statusline_heading(
                resolve_statusline_dir(None, &input, Some(Path::new("/tmp/invoked-here")))
                    .as_deref()
            ),
            "started-here"
        );
    }

    #[test]
    fn statusline_heading_keeps_the_root_directory() {
        assert_eq!(statusline_heading(Some(Path::new("/"))), "/");
    }

    #[cfg(unix)]
    #[test]
    fn statusline_heading_keeps_the_logical_spelling_for_the_same_directory() {
        let temp = tempfile::tempdir().unwrap();
        let physical = temp.path().join("physical");
        let logical = temp.path().join("logical");
        std::fs::create_dir(&physical).unwrap();
        std::os::unix::fs::symlink(&physical, &logical).unwrap();

        let instance = managed_instance(None, &logical.to_string_lossy());
        let input = parse_statusline_input(&format!(
            r#"{{"workspace": {{"current_dir": "{}"}}}}"#,
            physical.display()
        ));
        assert_eq!(
            statusline_heading(resolve_statusline_dir(Some(&instance), &input, None).as_deref()),
            "logical"
        );
    }

    /// Regression for the reported case: only the ancestor `work` has a GUI
    /// project, yet launching inside `work/smart/dsc/xxx` titles the statusline
    /// `xxx` — while the matched project still supplies the default route and
    /// the prelaunch command.
    #[test]
    fn statusline_heading_shows_the_actual_directory_under_an_ancestor_project() {
        use cc_use_lib::models::{
            CreateApiKeyInput, CreateProjectInput, CreateProviderInput, UpsertProjectBindingInput,
        };

        let temp = tempfile::tempdir().unwrap();
        let db = Database::open_at(&temp.path().join("test.db")).unwrap();
        let workspace = temp.path().join("work");
        let session_dir = workspace.join("smart/dsc/xxx");
        std::fs::create_dir_all(&session_dir).unwrap();

        let provider = db
            .provider_create(&CreateProviderInput {
                name: "Example".to_string(),
                base_url: "https://api.example.com".to_string(),
                http_proxy: None,
                website: None,
                remark: None,
                token: None,
                icon: None,
                wallet_balance_type: None,
                wallet_balance_url: None,
                wallet_balance_path: None,
                wallet_balance_headers: None,
                wallet_balance_user_id: None,
                usage_type: None,
                usage_url: None,
                usage_path: None,
                usage_headers: None,
            })
            .unwrap();
        let key = db
            .api_key_create(&CreateApiKeyInput {
                provider_id: provider.id.clone(),
                alias: Some("alpha".to_string()),
                value: "test-value".to_string(),
                types: Some(vec!["claude_code".to_string()]),
                priority: None,
                is_active: None,
                config: None,
                usage_type: None,
                usage_url: None,
                usage_path: None,
                usage_headers: None,
                model_mapping: None,
                client_configs: None,
            })
            .unwrap();

        let project = db
            .project_create(&CreateProjectInput {
                name: "工作区".to_string(),
                path: workspace.to_string_lossy().to_string(),
                group_name: None,
                remark: None,
                provider_id: None,
                api_key_id: None,
                cli_type: Some("claude_code".to_string()),
                terminal_type: Some("iterm2".to_string()),
                prelaunch_command: None,
            })
            .unwrap();
        let project = db
            .project_binding_upsert(
                &project.id,
                &UpsertProjectBindingInput {
                    cli_type: "claude_code".to_string(),
                    provider_id: Some(provider.id.clone()),
                    api_key_id: Some(key.id.clone()),
                    terminal_type: None,
                    prelaunch_command: Some("export DEMO_READY=1".to_string()),
                },
            )
            .unwrap();

        let instance = managed_instance(Some(project.id.clone()), &session_dir.to_string_lossy());
        let input = parse_statusline_input(&format!(
            r#"{{"workspace": {{"current_dir": "{}"}}}}"#,
            session_dir.display()
        ));

        assert_eq!(
            statusline_heading(resolve_statusline_dir(Some(&instance), &input, None).as_deref()),
            "xxx"
        );

        let ctx = Ctx::with_db(db, Some(session_dir.clone()));
        let matched = resolve_project(&ctx).expect("the ancestor project matches");
        assert_eq!(matched.id, project.id);
        assert_eq!(
            cli_launch_context(Some(&matched), &session_dir, "claude_code")
                .prelaunch_command
                .as_deref(),
            Some("export DEMO_READY=1")
        );
        let (route_provider, route_key) = project_default_route(&ctx, &matched, "claude_code")
            .unwrap_or_else(|error| panic!("{}", error.message()))
            .expect("the project default route resolves");
        assert_eq!(route_provider.id, provider.id);
        assert_eq!(route_key.id, key.id);
    }
}
