//! Launch-entry behavior tests: route selection must be explicit, and a
//! prepared launch must create the same instance state a GUI launch would.

use cc_use_cli::cmds::{self, Ctx};
use cc_use_lib::db::Database;
use cc_use_lib::models::{CreateApiKeyInput, CreateProjectInput, CreateProviderInput};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

#[test]
fn statusline_refreshes_cache_rate_from_each_payload() {
    // Child processes use a temporary home, never the user's application DB.
    let task_home = tempfile::tempdir().unwrap();
    for (usage, expected) in [
        (
            serde_json::json!({"input_tokens": 100, "cache_read_input_tokens": 850, "cache_creation_input_tokens": 50, "output_tokens": 5000}),
            "Cache 85.0%",
        ),
        (
            serde_json::json!({"input_tokens": 100, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 900}),
            "Cache 0.0%",
        ),
        (
            serde_json::json!({"input_tokens": 0, "cache_read_input_tokens": 1000, "cache_creation_input_tokens": 0}),
            "Cache 100.0%",
        ),
        (serde_json::Value::Null, "Cache —"),
        (serde_json::json!({"input_tokens": 1000}), "Cache —"),
        (
            serde_json::json!({"input_tokens": 0, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}),
            "Cache —",
        ),
    ] {
        let payload = serde_json::json!({
            "model": {"display_name": "Sonnet"},
            "context_window": {"used_percentage": 42, "current_usage": usage}
        });
        let mut child = Command::new(env!("CARGO_BIN_EXE_cc-use-cli"))
            .arg("statusline")
            .env("HOME", task_home.path())
            .env("NO_COLOR", "1")
            .env_remove("CC_USE_INSTANCE_ID")
            .current_dir(task_home.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("run statusline");
        child
            .stdin
            .take()
            .unwrap()
            .write_all(payload.to_string().as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success());
        assert!(output.stderr.is_empty());
        let text = String::from_utf8(output.stdout).unwrap();
        assert_eq!(text.lines().count(), 2, "{text}");
        assert!(text.lines().next().unwrap().ends_with("│ unmanaged"));
        let details = text.lines().nth(1).unwrap();
        assert!(details.starts_with("[Sonnet] │ Context "), "{text}");
        assert!(details.contains("42%"), "{text}");
        assert!(details.ends_with(expected), "{text}");
        assert!(!text.contains('\x1b'), "NO_COLOR must be respected");
    }
}

#[test]
fn statusline_shows_only_the_current_instances_last_request() {
    let task_home = tempfile::tempdir().unwrap();
    let app_dir = if cfg!(debug_assertions) {
        "com.mipawn.cc-use.dev"
    } else {
        "com.mipawn.cc-use"
    };
    let db = Database::open_at(
        &task_home
            .path()
            .join("Library/Application Support")
            .join(app_dir)
            .join("data/cc-use.db"),
    )
    .unwrap();
    let fixture = seed(&db, "claude_code");
    let now = chrono::Utc::now().to_rfc3339();
    for (instance, session) in [("i-current", "s-current"), ("i-other", "s-other")] {
        db.conn
            .execute(
            "INSERT INTO proxy_sessions (session_token, provider_id, api_key_id, created_at, last_seen_at)
             VALUES (?1, ?2, ?3, ?4, ?4)",
                [session, &fixture.provider_id, &fixture.key_a, &now],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO managed_instances (id, session_token, provider_id, api_key_id,
                cli_type, terminal_type, project_path, last_seen_at, launched_at, status)
             VALUES (?1, ?2, ?3, ?4, 'claude_code', 'terminal', ?5, ?6, ?6, 'running')",
                [
                    instance,
                    session,
                    &fixture.provider_id,
                    &fixture.key_a,
                    &fixture.project_path,
                    &now,
                ],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO request_logs (id, session_id, provider_id, api_key_id, created_at,
                output_tokens, first_token_ms, last_token_ms, latency_ms, outcome, is_streaming)
             VALUES (?1, ?2, ?3, ?4, ?5, CASE WHEN ?2 = 's-current' THEN 1000 ELSE 9000 END,
                2000, 12000, 50000, 'success', 1)",
                [
                    instance,
                    session,
                    &fixture.provider_id,
                    &fixture.key_a,
                    &now,
                ],
            )
            .unwrap();
    }
    let render = |instance: &str| {
        let mut child = Command::new(env!("CARGO_BIN_EXE_cc-use-cli"))
            .arg("statusline")
            .env("HOME", task_home.path())
            .env("NO_COLOR", "1")
            .env("CC_USE_INSTANCE_ID", instance)
            .current_dir(task_home.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(b"{}").unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success());
        assert!(output.stderr.is_empty());
        let text = String::from_utf8(output.stdout).unwrap();
        assert_eq!(text.lines().count(), 2);
        assert!(!text.contains('\x1b'));
        text
    };
    assert!(render("i-current").ends_with("Last 100.0 tok/s │ TTFT 2.00s\n"));
    assert!(render("i-other").contains("Last 900.0 tok/s"));
    let unmanaged = render("unknown");
    assert!(unmanaged.contains("unmanaged"));
    assert!(!unmanaged.contains("tok/s"));
    db.conn
        .execute(
            "UPDATE request_logs SET last_token_ms = first_token_ms WHERE id = 'i-current'",
            [],
        )
        .unwrap();
    assert!(render("i-current").ends_with("Last — tok/s │ TTFT 2.00s\n"));
}

#[test]
fn public_help_only_exposes_launch_commands() {
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_cc-use-cli"))
        .arg("--help")
        .output()
        .expect("run CLI help");
    assert!(output.status.success());
    let help = String::from_utf8(output.stdout).expect("utf-8 help");
    assert!(help.contains("claude"));
    assert!(help.contains("grok"));
    for hidden in [
        "statusline",
        "setup-statusline",
        "install",
        "switch",
        "usage",
        "ls",
    ] {
        assert!(
            !help.contains(hidden),
            "unexpected public command: {hidden}\n{help}"
        );
    }
}

struct TempDb {
    db: Option<Database>,
    path: PathBuf,
}

impl TempDb {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("cc-use-cli-test-{}.db", nanoid::nanoid!(8)));
        let db = Database::open_at(&path).expect("create temp database");
        Self { db: Some(db), path }
    }

    fn take(&mut self) -> Database {
        self.db.take().expect("database already taken")
    }
}

impl Drop for TempDb {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        let _ = std::fs::remove_file(self.path.with_extension("db-wal"));
        let _ = std::fs::remove_file(self.path.with_extension("db-shm"));
    }
}

struct Fixture {
    provider_id: String,
    key_a: String,
    project_path: String,
}

fn seed(db: &Database, cli_type: &str) -> Fixture {
    let provider = db
        .provider_create(&CreateProviderInput {
            request_headers: None,
            wallet_balance_script: None,
            name: "Example".to_string(),
            base_url: "https://example.com".to_string(),
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
            preset_id: None,
            default_key_config: None,
            request_adapter: None,
        })
        .expect("create provider");

    let make_key = |alias: &str| {
        db.api_key_create(&CreateApiKeyInput {
            usage_script: None,
            provider_id: provider.id.clone(),
            alias: Some(alias.to_string()),
            value: format!("sk-{}", alias),
            types: Some(vec![cli_type.to_string()]),
            priority: Some(0),
            is_active: Some(true),
            config: None,
            usage_type: None,
            usage_url: None,
            usage_path: None,
            usage_headers: None,
            model_mapping: None,
            client_configs: None,
        })
        .expect("create api key")
    };
    let key_a = make_key("alpha");
    let _key_b = make_key("bravo");

    let project_path = std::env::temp_dir()
        .join(format!("cc-use-cli-project-{}", nanoid::nanoid!(6)))
        .to_string_lossy()
        .to_string();
    db.project_create(&CreateProjectInput {
        name: "Demo".to_string(),
        path: project_path.clone(),
        group_name: None,
        remark: None,
        provider_id: Some(provider.id.clone()),
        api_key_id: Some(key_a.id.clone()),
        cli_type: Some(cli_type.to_string()),
        terminal_type: Some("terminal".to_string()),
        prelaunch_command: None,
    })
    .expect("create project");

    Fixture {
        provider_id: provider.id,
        key_a: key_a.id,
        project_path,
    }
}

#[test]
fn launch_without_tty_lists_routes_and_exits_two() {
    // Every launch is an explicit choice. Tests have no TTY, so the command
    // must list the routes and stop before creating instance state.
    let mut temp = TempDb::new();
    let _fixture = seed(temp.db.as_ref().unwrap(), "claude_code");
    let ctx = Ctx::with_db(
        temp.take(),
        Some(std::env::temp_dir().join("cc-use-cli-no-project")),
    );

    let error = cmds::launch(&ctx, "claude_code").expect_err("must require an interactive choice");
    assert_eq!(error.code(), 2);
    assert!(error.message().contains("Example · alpha"));

    let instances = ctx.db.managed_instance_list_active().unwrap();
    assert!(instances.is_empty());
}

#[test]
fn launch_with_no_compatible_keys_fails_with_guidance() {
    let mut temp = TempDb::new();
    let fixture = seed(temp.db.as_ref().unwrap(), "claude_code");
    let ctx = Ctx::with_db(temp.take(), Some(PathBuf::from(&fixture.project_path)));

    // No key enables grok in this fixture.
    let error = cmds::launch(&ctx, "grok").expect_err("nothing to launch with");
    assert_eq!(error.code(), 1);
    assert!(error.message().contains("grok"), "got: {}", error.message());
    let _ = fixture.provider_id;
    let _ = fixture.key_a;
}
