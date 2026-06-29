mod support;

use cc_use_lib::models::{CreateProjectInput, UpdateProjectInput};
use support::TempDb;

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
