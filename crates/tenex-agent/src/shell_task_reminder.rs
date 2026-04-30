use std::time::{SystemTime, UNIX_EPOCH};
use tenex_protocol::{ListShellTasksRequest, RuntimeControlRequest, RuntimeControlResponse};

use crate::runtime_control;

pub async fn render_active_shell_tasks_reminder(
    project_id: &str,
    conversation_id: &str,
    agent_pubkey: &str,
) -> Option<String> {
    let socket = runtime_control::socket_path()?;
    let request = RuntimeControlRequest::ListShellTasks(ListShellTasksRequest {
        project_id: project_id.to_string(),
        conversation_id: conversation_id.to_string(),
        agent_pubkey: agent_pubkey.to_string(),
    });
    let response = runtime_control::request(socket, request).await.ok()?;
    let RuntimeControlResponse::ShellTasks(tasks) = response else {
        return None;
    };
    if tasks.tasks.is_empty() {
        return None;
    }

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let lines = tasks
        .tasks
        .into_iter()
        .map(|task| {
            let age = ((now - task.started_at_ms).max(0) / 1000).to_string();
            format!(
                "- {} ({:?}) running {}s, pid {}, output {}, command: {}",
                task.task_id, task.mode, age, task.pid, task.output_file, task.command
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    Some(format!(
        "<system-reminder type=\"active-shell-tasks\">\nActive shell tasks from this agent in this conversation can be stopped with kill(target=<task id>, reason=<reason>).\n{lines}\n</system-reminder>"
    ))
}
