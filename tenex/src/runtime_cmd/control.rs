use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use super::control_process::terminate_process_group;
use super::control_shell::{self, ShellTaskRecord};
use anyhow::{Context, Result};
use tenex_protocol::{
    ErrorResponse, KillResponse, KillTargetType, RuntimeControlRequest, RuntimeControlResponse,
    ShellTaskSummary, ShellTasksResponse,
};
use tokio::fs;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tracing::{info, warn};

#[derive(Clone)]
pub struct RuntimeControlState {
    pub(super) base_dir: PathBuf,
    pub(super) project_id: String,
    active_runs: Arc<Mutex<HashMap<String, ActiveAgentRun>>>,
    pub(super) shell_tasks: Arc<Mutex<HashMap<String, ShellTaskRecord>>>,
}

#[derive(Clone)]
struct ActiveAgentRun {
    conversation_id: String,
    agent_pubkey: String,
    pid: u32,
}

pub struct ActiveAgentRunGuard {
    state: RuntimeControlState,
    key: String,
}

impl Drop for ActiveAgentRunGuard {
    fn drop(&mut self) {
        self.state.active_runs.lock().unwrap().remove(&self.key);
    }
}

impl RuntimeControlState {
    pub fn new(base_dir: PathBuf, project_id: String) -> Self {
        Self {
            base_dir,
            project_id,
            active_runs: Arc::new(Mutex::new(HashMap::new())),
            shell_tasks: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn socket_path(&self) -> PathBuf {
        self.base_dir
            .join("projects")
            .join(&self.project_id)
            .join("runtime-control.sock")
    }

    pub fn register_agent_run(
        &self,
        conversation_id: String,
        agent_pubkey: String,
        execution_id: String,
        pid: u32,
    ) -> ActiveAgentRunGuard {
        let key = format!("{conversation_id}:{agent_pubkey}:{execution_id}");
        self.active_runs.lock().unwrap().insert(
            key.clone(),
            ActiveAgentRun {
                conversation_id,
                agent_pubkey,
                pid,
            },
        );
        ActiveAgentRunGuard {
            state: self.clone(),
            key,
        }
    }

    pub fn list_shell_tasks(
        &self,
        project_id: &str,
        conversation_id: &str,
        agent_pubkey: &str,
    ) -> Vec<ShellTaskSummary> {
        let mut tasks: Vec<ShellTaskSummary> = self
            .shell_tasks
            .lock()
            .unwrap()
            .values()
            .filter(|task| {
                task.project_id == project_id
                    && task.conversation_id == conversation_id
                    && task.agent_pubkey == agent_pubkey
            })
            .map(ShellTaskSummary::from)
            .collect();
        tasks.sort_by_key(|task| task.started_at_ms);
        tasks
    }

    pub fn has_shell_tasks(
        &self,
        project_id: &str,
        conversation_id: &str,
        agent_pubkey: &str,
    ) -> bool {
        self.shell_tasks.lock().unwrap().values().any(|task| {
            task.project_id == project_id
                && task.conversation_id == conversation_id
                && task.agent_pubkey == agent_pubkey
        })
    }

    pub async fn handle_request(
        self: Arc<Self>,
        request: RuntimeControlRequest,
    ) -> RuntimeControlResponse {
        match request {
            RuntimeControlRequest::RunShell(req) => match control_shell::run_shell(self, req).await
            {
                Ok(response) => response,
                Err(error) => RuntimeControlResponse::Error(ErrorResponse {
                    message: error.to_string(),
                }),
            },
            RuntimeControlRequest::ListShellTasks(req) => {
                RuntimeControlResponse::ShellTasks(ShellTasksResponse {
                    tasks: self.list_shell_tasks(
                        &req.project_id,
                        &req.conversation_id,
                        &req.agent_pubkey,
                    ),
                })
            }
            RuntimeControlRequest::Kill(req) => {
                RuntimeControlResponse::Kill(self.kill_target(&req.target, &req.reason))
            }
        }
    }

    fn kill_target(&self, target: &str, reason: &str) -> KillResponse {
        let target = target.trim().to_lowercase();
        if target.starts_with("shell-") {
            return self.kill_shell_task(&target, reason);
        }

        self.kill_agent_conversation(&target, None, reason)
    }

    pub fn kill_agent_conversation(
        &self,
        conversation_id_or_prefix: &str,
        agent_pubkey: Option<&str>,
        reason: &str,
    ) -> KillResponse {
        let matching_runs: Vec<ActiveAgentRun> = self
            .active_runs
            .lock()
            .unwrap()
            .values()
            .filter(|run| conversation_matches(&run.conversation_id, conversation_id_or_prefix))
            .filter(|run| agent_pubkey.is_none_or(|pk| run.agent_pubkey == pk))
            .cloned()
            .collect();

        let mut killed_count = 0;
        for run in &matching_runs {
            if terminate_process_group(run.pid) {
                killed_count += 1;
            }
        }

        let matching_shells: Vec<ShellTaskRecord> = self
            .shell_tasks
            .lock()
            .unwrap()
            .values()
            .filter(|task| conversation_matches(&task.conversation_id, conversation_id_or_prefix))
            .filter(|task| agent_pubkey.is_none_or(|pk| task.agent_pubkey == pk))
            .cloned()
            .collect();
        for task in matching_shells {
            if terminate_process_group(task.pid) {
                killed_count += 1;
            }
            self.shell_tasks.lock().unwrap().remove(&task.task_id);
        }

        let success = killed_count > 0;
        KillResponse {
            success,
            target: conversation_id_or_prefix.to_string(),
            target_type: KillTargetType::Agent,
            message: if success {
                format!("Killed {killed_count} runtime process group(s). Reason: {reason}")
            } else {
                format!("No active agent execution found for target {conversation_id_or_prefix}")
            },
            killed_count,
        }
    }

    fn kill_shell_task(&self, task_id: &str, reason: &str) -> KillResponse {
        let task = self.shell_tasks.lock().unwrap().remove(task_id);
        let Some(task) = task else {
            return KillResponse {
                success: false,
                target: task_id.to_string(),
                target_type: KillTargetType::Shell,
                message: format!("No active shell task found for target {task_id}"),
                killed_count: 0,
            };
        };

        let success = terminate_process_group(task.pid);
        KillResponse {
            success,
            target: task_id.to_string(),
            target_type: KillTargetType::Shell,
            message: if success {
                format!("Killed shell task {task_id}. Reason: {reason}")
            } else {
                format!("Shell task {task_id} was already stopped")
            },
            killed_count: usize::from(success),
        }
    }
}

pub async fn serve_control_socket(
    state: Arc<RuntimeControlState>,
    socket_path: PathBuf,
) -> Result<()> {
    if let Some(parent) = socket_path.parent() {
        fs::create_dir_all(parent).await?;
    }
    if socket_path.exists() {
        fs::remove_file(&socket_path).await?;
    }
    let listener = UnixListener::bind(&socket_path)
        .with_context(|| format!("binding runtime control socket {}", socket_path.display()))?;
    info!(path = %socket_path.display(), "runtime control socket listening");

    loop {
        let (stream, _) = listener.accept().await?;
        let state = state.clone();
        tokio::spawn(async move {
            if let Err(error) = handle_connection(state, stream).await {
                warn!(error = %error, "runtime control request failed");
            }
        });
    }
}

async fn handle_connection(state: Arc<RuntimeControlState>, stream: UnixStream) -> Result<()> {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).await?;
    let request: RuntimeControlRequest =
        serde_json::from_str(line.trim()).context("decoding runtime control request")?;
    let response = state.handle_request(request).await;
    let mut stream = reader.into_inner();
    stream
        .write_all(serde_json::to_string(&response)?.as_bytes())
        .await?;
    stream.write_all(b"\n").await?;
    stream.flush().await?;
    Ok(())
}

fn conversation_matches(conversation_id: &str, target: &str) -> bool {
    conversation_id == target || (target.len() >= 10 && conversation_id.starts_with(target))
}
