mod support;

use cc_use_lib::models::{CreateProjectInput, UpdateProjectInput, UpsertProjectBindingInput};
use support::{create_api_key, create_provider, TempDb};

#[test]
fn project_crud() {
    let fixture = TempDb::new();
    let project = fixture
        .db
        .project_create(&CreateProjectInput {
            name: "My Project".to_string(),
            path: "/home/user/project".to_string(),
            remark: None,
            provider_id: None,
            api_key_id: None,
            cli_type: None,
            terminal_type: None,
            prelaunch_command: None,
        })
        .unwrap();

    assert_eq!(project.name, "My Project");
    assert_eq!(project.path, "/home/user/project");
    assert_eq!(project.prelaunch_command, None);

    let by_path = fixture
        .db
        .project_get_by_path("/home/user/project")
        .unwrap()
        .unwrap();
    assert_eq!(by_path.id, project.id);

    fixture.db.project_delete(&project.id).unwrap();
    assert!(fixture.db.project_get(&project.id).unwrap().is_none());
}

#[test]
fn project_create_returns_proper_result() {
    let fixture = TempDb::new();
    let result = fixture.db.project_create(&CreateProjectInput {
        name: "Test".to_string(),
        path: "/tmp/test".to_string(),
        remark: None,
        provider_id: None,
        api_key_id: None,
        cli_type: None,
        terminal_type: None,
        prelaunch_command: Some("direnv allow".to_string()),
    });
    assert!(result.is_ok());
    assert_eq!(
        result.unwrap().prelaunch_command.as_deref(),
        Some("direnv allow")
    );
}

#[test]
fn project_update_no_changes() {
    let fixture = TempDb::new();
    let project = fixture
        .db
        .project_create(&CreateProjectInput {
            name: "Test".to_string(),
            path: "/tmp/test".to_string(),
            remark: None,
            provider_id: None,
            api_key_id: None,
            cli_type: None,
            terminal_type: None,
            prelaunch_command: None,
        })
        .unwrap();

    let result = fixture.db.project_update(&UpdateProjectInput {
        id: project.id.clone(),
        name: None,
        remark: None,
        provider_id: None,
        api_key_id: None,
        cli_type: None,
        terminal_type: None,
        prelaunch_command: None,
    });

    assert!(result.is_ok());
    assert_eq!(result.unwrap().name, "Test");
}

#[test]
fn project_update_prelaunch_command() {
    let fixture = TempDb::new();
    let project = fixture
        .db
        .project_create(&CreateProjectInput {
            name: "Test".to_string(),
            path: "/tmp/test-prelaunch".to_string(),
            remark: None,
            provider_id: None,
            api_key_id: None,
            cli_type: None,
            terminal_type: None,
            prelaunch_command: None,
        })
        .unwrap();

    let updated = fixture
        .db
        .project_update(&UpdateProjectInput {
            id: project.id,
            name: None,
            remark: None,
            provider_id: None,
            api_key_id: None,
            cli_type: None,
            terminal_type: None,
            prelaunch_command: Some("mise install".to_string()),
        })
        .unwrap();

    assert_eq!(updated.prelaunch_command.as_deref(), Some("mise install"));
}

#[test]
fn project_keeps_independent_bindings_for_each_cli() {
    let fixture = TempDb::new();
    let claude_provider = create_provider(&fixture.db, "Claude", "claude");
    let claude_key = create_api_key(&fixture.db, &claude_provider.id, "claude");
    let grok_provider = create_provider(&fixture.db, "Grok", "grok");
    let grok_key = create_api_key(&fixture.db, &grok_provider.id, "grok");
    let project = fixture
        .db
        .project_create(&CreateProjectInput {
            name: "Shared directory".to_string(),
            path: "/tmp/shared-directory".to_string(),
            remark: None,
            provider_id: Some(claude_provider.id.clone()),
            api_key_id: Some(claude_key.id.clone()),
            cli_type: Some("claude_code".to_string()),
            terminal_type: Some("terminal".to_string()),
            prelaunch_command: Some("source .env".to_string()),
        })
        .unwrap();

    fixture
        .db
        .project_binding_upsert(
            &project.id,
            &UpsertProjectBindingInput {
                cli_type: "grok".to_string(),
                provider_id: Some(grok_provider.id.clone()),
                api_key_id: Some(grok_key.id.clone()),
                terminal_type: Some("iterm2".to_string()),
                prelaunch_command: Some("mise activate".to_string()),
            },
        )
        .unwrap();

    let reloaded = fixture.db.project_get(&project.id).unwrap().unwrap();
    let claude = reloaded.bindings.get("claude_code").unwrap();
    let grok = reloaded.bindings.get("grok").unwrap();

    assert_eq!(
        claude.provider_id.as_deref(),
        Some(claude_provider.id.as_str())
    );
    assert_eq!(claude.api_key_id.as_deref(), Some(claude_key.id.as_str()));
    assert_eq!(claude.prelaunch_command.as_deref(), Some("source .env"));
    assert_eq!(grok.provider_id.as_deref(), Some(grok_provider.id.as_str()));
    assert_eq!(grok.api_key_id.as_deref(), Some(grok_key.id.as_str()));
    assert_eq!(grok.prelaunch_command.as_deref(), Some("mise activate"));
}
