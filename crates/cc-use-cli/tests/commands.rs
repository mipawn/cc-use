//! Launch-entry behavior tests: route selection must be explicit, and a
//! prepared launch must create the same instance state a GUI launch would.

use cc_use_cli::cmds::{self, Ctx};
use cc_use_lib::db::Database;
use cc_use_lib::models::{CreateApiKeyInput, CreateProjectInput, CreateProviderInput};
use std::path::PathBuf;

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
        })
        .expect("create provider");

    let make_key = |alias: &str| {
        db.api_key_create(&CreateApiKeyInput {
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
