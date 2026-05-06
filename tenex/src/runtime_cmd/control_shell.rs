use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use serde_json::json;
use tenex_protocol::{
    RunShellRequest, RuntimeControlResponse, ShellBackgroundResponse, ShellCompletedResponse,
    ShellTaskMode, ShellTaskSummary,
};
use tokio::fs::{self, OpenOptions};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;

use super::control::RuntimeControlState;
use super::control_process::{status_signal, terminate_process_group};

#[derive(Clone)]
pub(super) struct ShellTaskRecord {
    pub(super) task_id: String,
    pub(super) mode: ShellTaskMode,
    pub(super) command: String,
    pub(super) description: String,
    pub(super) output_file: String,
    pub(super) started_at_ms: i64,
    pub(super) pid: u32,
    pub(super) project_id: String,
    pub(super) conversation_id: String,
    pub(super) agent_pubkey: String,
}

pub(super) async fn run_shell(
    state: Arc<RuntimeControlState>,
    req: RunShellRequest,
) -> Result<RuntimeControlResponse> {
    let cwd = resolve_cwd(&req.working_dir, req.cwd.as_deref());
    let random_id = uuid::Uuid::new_v4().simple().to_string();
    let task_id = format!("shell-{}", &random_id[..12]);
    let output_dir = state
        .base_dir
        .join("projects")
        .join(&state.project_id)
        .join("shell-tasks");
    fs::create_dir_all(&output_dir).await?;
    let output_file = output_dir.join(format!("{task_id}.output"));

    let mut command = Command::new("sh");
    command
        .arg("-c")
        .arg(&req.command)
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(false);
    for (key, value) in &req.extra_env {
        command.env(key, value);
    }

    let mut child = command
        .spawn()
        .with_context(|| format!("failed to start shell command: {}", req.command))?;
    let pid = child.id().context("shell process started without pid")?;
    let record = ShellTaskRecord {
        task_id: task_id.clone(),
        mode: if req.run_in_background {
            ShellTaskMode::Background
        } else {
            ShellTaskMode::Foreground
        },
        command: req.command.clone(),
        description: req.description.clone(),
        output_file: output_file.display().to_string(),
        started_at_ms: now_ms(),
        pid,
        project_id: req.project_id.clone(),
        conversation_id: req.conversation_id.clone(),
        agent_pubkey: req.agent_pubkey.clone(),
    };
    state
        .shell_tasks
        .lock()
        .unwrap()
        .insert(task_id.clone(), record.clone());

    if req.run_in_background {
        if let Some(stdout) = child.stdout.take() {
            tokio::spawn(append_pipe_to_file(stdout, output_file.clone()));
        }
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(append_pipe_to_file(stderr, output_file.clone()));
        }
        let tasks = state.shell_tasks.clone();
        let task_id_for_wait = task_id.clone();
        tokio::spawn(async move {
            let _ = child.wait().await;
            tasks.lock().unwrap().remove(&task_id_for_wait);
        });
        return Ok(RuntimeControlResponse::ShellBackground(
            ShellBackgroundResponse {
                task_id: task_id.clone(),
                command: req.command,
                description: req.description,
                output_file: output_file.display().to_string(),
                message: format!(
                    "Command started in background. Task ID: {task_id}. Output is being written to: {}",
                    output_file.display()
                ),
            },
        ));
    }

    let stdout = child.stdout.take().context("shell stdout unavailable")?;
    let stderr = child.stderr.take().context("shell stderr unavailable")?;
    let stdout_task = tokio::spawn(read_pipe(stdout));
    let stderr_task = tokio::spawn(read_pipe(stderr));

    let timeout = req.timeout_secs.map(Duration::from_secs);
    let (status, timed_out) = if let Some(timeout) = timeout {
        tokio::select! {
            status = child.wait() => (status?, false),
            _ = tokio::time::sleep(timeout) => {
                terminate_process_group(pid);
                (child.wait().await?, true)
            }
        }
    } else {
        (child.wait().await?, false)
    };

    state.shell_tasks.lock().unwrap().remove(&task_id);

    let stdout = stdout_task.await.unwrap_or_default();
    let stderr = stderr_task.await.unwrap_or_default();
    let signal = status_signal(&status);
    let timed_out_after = if timed_out { req.timeout_secs } else { None };
    let output = format_shell_output(&req.command, status.code(), signal.clone(), stdout, stderr, timed_out_after);

    Ok(RuntimeControlResponse::ShellCompleted(
        ShellCompletedResponse {
            task_id,
            output,
            exit_code: status.code(),
            signal,
        },
    ))
}

impl From<&ShellTaskRecord> for ShellTaskSummary {
    fn from(record: &ShellTaskRecord) -> Self {
        Self {
            task_id: record.task_id.clone(),
            mode: record.mode,
            command: record.command.clone(),
            description: record.description.clone(),
            output_file: record.output_file.clone(),
            started_at_ms: record.started_at_ms,
            pid: record.pid,
        }
    }
}

async fn read_pipe(mut pipe: impl AsyncRead + Unpin) -> String {
    let mut bytes = Vec::new();
    let _ = pipe.read_to_end(&mut bytes).await;
    String::from_utf8_lossy(&bytes).to_string()
}

async fn append_pipe_to_file(mut pipe: impl AsyncRead + Unpin, path: PathBuf) {
    let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .await
    else {
        return;
    };
    let _ = tokio::io::copy(&mut pipe, &mut file).await;
}

fn resolve_cwd(working_dir: &str, cwd: Option<&str>) -> PathBuf {
    let raw = cwd.unwrap_or(working_dir);
    let path = Path::new(raw);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        Path::new(working_dir).join(path)
    }
}

fn format_shell_output(
    command: &str,
    exit_code: Option<i32>,
    signal: Option<String>,
    stdout: String,
    stderr: String,
    timed_out_after: Option<u64>,
) -> String {
    if exit_code == Some(0) {
        let mut output = stdout;
        if !stderr.is_empty() {
            output.push_str("\nSTDERR:\n");
            output.push_str(&stderr);
        }
        return output;
    }

    let expected_non_zero = matches!(
        command.split_whitespace().next().unwrap_or(""),
        "grep" | "rg" | "ripgrep" | "diff" | "cmp" | "test" | "[" | "[["
    ) && exit_code == Some(1);
    if expected_non_zero {
        return json!({
            "type": "expected-non-zero-exit",
            "command": command.chars().take(200).collect::<String>(),
            "exitCode": exit_code,
            "stdout": stdout,
            "stderr": stderr,
        })
        .to_string();
    }

    json!({
        "type": "shell-error",
        "command": command.chars().take(200).collect::<String>(),
        "exitCode": exit_code,
        "error": timed_out_after.map(|s| format!("Command timed out after {s}s (default: 30s, max: 600s — pass a longer 'timeout' argument if needed)")).unwrap_or_else(|| {
            signal.as_ref().map(|s| format!("Process killed by {s}")).unwrap_or_else(|| {
                format!("Command exited with code {}", exit_code.unwrap_or(-1))
            })
        }),
        "stdout": stdout,
        "stderr": stderr,
        "signal": signal,
    })
    .to_string()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl std::fmt::Debug for ShellTaskRecord {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ShellTaskRecord")
            .field("task_id", &self.task_id)
            .field("mode", &self.mode)
            .field("command", &self.command)
            .field("pid", &self.pid)
            .field("conversation_id", &self.conversation_id)
            .field("agent_pubkey", &self.agent_pubkey)
            .finish()
    }
}
