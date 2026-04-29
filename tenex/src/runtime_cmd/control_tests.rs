use std::path::PathBuf;
use std::sync::Arc;

use tenex_protocol::{
    KillRequest, ListShellTasksRequest, RunShellRequest, RuntimeControlRequest,
    RuntimeControlResponse, ShellTaskMode,
};

use super::control::RuntimeControlState;

#[tokio::test]
async fn foreground_shell_runs_through_runtime_control() {
    let (state, base_dir) = test_state();

    let response = state
        .clone()
        .handle_one_shot_request(RuntimeControlRequest::RunShell(RunShellRequest {
            command: "printf runtime-ok".to_string(),
            run_in_background: false,
            timeout_secs: Some(5),
            ..shell_request_defaults(&base_dir)
        }))
        .await;

    match response {
        RuntimeControlResponse::ShellCompleted(completed) => {
            assert_eq!(completed.output, "runtime-ok");
            assert_eq!(completed.exit_code, Some(0));
        }
        other => panic!("expected shell completion, got {other:?}"),
    }

    let _ = std::fs::remove_dir_all(base_dir);
}

#[tokio::test]
async fn background_shell_can_be_listed_and_killed() {
    let (state, base_dir) = test_state();

    let task_id = match state
        .clone()
        .handle_one_shot_request(RuntimeControlRequest::RunShell(RunShellRequest {
            command: "sleep 30".to_string(),
            run_in_background: true,
            timeout_secs: Some(5),
            ..shell_request_defaults(&base_dir)
        }))
        .await
    {
        RuntimeControlResponse::ShellBackground(background) => background.task_id,
        other => panic!("expected background shell, got {other:?}"),
    };

    let listed = state
        .clone()
        .handle_one_shot_request(RuntimeControlRequest::ListShellTasks(
            ListShellTasksRequest {
                project_id: "proj".to_string(),
                conversation_id: "conversation123456".to_string(),
                agent_pubkey: "agent-pubkey".to_string(),
            },
        ))
        .await;
    match listed {
        RuntimeControlResponse::ShellTasks(tasks) => {
            assert_eq!(tasks.tasks.len(), 1);
            assert_eq!(tasks.tasks[0].task_id, task_id);
            assert_eq!(tasks.tasks[0].mode, ShellTaskMode::Background);
        }
        other => panic!("expected shell task listing, got {other:?}"),
    }

    let killed = state
        .handle_one_shot_request(RuntimeControlRequest::Kill(KillRequest {
            target: task_id,
            reason: "test cleanup".to_string(),
            caller_conversation_id: "conversation123456".to_string(),
            caller_agent_pubkey: "agent-pubkey".to_string(),
        }))
        .await;
    match killed {
        RuntimeControlResponse::Kill(response) => {
            assert!(response.success);
            assert_eq!(response.killed_count, 1);
        }
        other => panic!("expected kill response, got {other:?}"),
    }

    let _ = std::fs::remove_dir_all(base_dir);
}

fn test_state() -> (Arc<RuntimeControlState>, PathBuf) {
    let base_dir = std::env::temp_dir().join(format!(
        "tenex-runtime-control-test-{}",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&base_dir).unwrap();
    let (transport_tx, _transport_rx) = tokio::sync::mpsc::unbounded_channel();
    (
        Arc::new(RuntimeControlState::new(
            base_dir.clone(),
            "proj".to_string(),
            transport_tx,
        )),
        base_dir,
    )
}

fn shell_request_defaults(base_dir: &std::path::Path) -> RunShellRequest {
    RunShellRequest {
        command: String::new(),
        description: String::new(),
        cwd: None,
        working_dir: base_dir.display().to_string(),
        extra_env: Vec::new(),
        timeout_secs: Some(5),
        run_in_background: false,
        project_id: "proj".to_string(),
        conversation_id: "conversation123456".to_string(),
        agent_pubkey: "agent-pubkey".to_string(),
        execution_id: "exec-1".to_string(),
    }
}
