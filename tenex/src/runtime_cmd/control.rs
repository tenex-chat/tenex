use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use super::control_process::terminate_process_group;
use super::control_shell::{self, ShellTaskRecord};
use super::mcp_subscriptions::McpControlCommand;
use super::transport::TransportTee;
use anyhow::{Context, Result};
use tenex_protocol::{
    DispatchTransportFrame, ErrorResponse, KillResponse, KillTargetType, RuntimeControlRequest,
    RuntimeControlResponse, ShellTaskSummary, ShellTasksResponse,
};
use tokio::fs;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::mpsc;
use tracing::{info, warn};

/// Sent from the control socket into the runtime's main loop when a transport
/// bridge opens a streaming `DispatchTransport` connection. The runtime parses
/// the event, runs `select_dispatch_target`, and either fires terminal frames
/// on `tee` (error path) or attaches `tee` to the resulting `DispatchJob` so
/// events stream back as the agent runs.
pub struct TransportDispatchRequest {
    pub event_json: String,
    pub tee: TransportTee,
}

#[derive(Clone)]
pub struct RuntimeControlState {
    pub(super) base_dir: PathBuf,
    pub(super) project_id: String,
    active_runs: Arc<Mutex<HashMap<String, ActiveAgentRun>>>,
    pub(super) shell_tasks: Arc<Mutex<HashMap<String, ShellTaskRecord>>>,
    transport_tx: mpsc::UnboundedSender<TransportDispatchRequest>,
    mcp_tx: mpsc::UnboundedSender<McpControlCommand>,
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
    pub fn new(
        base_dir: PathBuf,
        project_id: String,
        transport_tx: mpsc::UnboundedSender<TransportDispatchRequest>,
        mcp_tx: mpsc::UnboundedSender<McpControlCommand>,
    ) -> Self {
        Self {
            base_dir,
            project_id,
            active_runs: Arc::new(Mutex::new(HashMap::new())),
            shell_tasks: Arc::new(Mutex::new(HashMap::new())),
            transport_tx,
            mcp_tx,
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

    /// One-shot RPC handler. `DispatchTransport` is intentionally not handled
    /// here: it requires a streaming response and is dispatched directly from
    /// [`handle_connection`].
    pub async fn handle_one_shot_request(
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
            RuntimeControlRequest::Mcp(req) => {
                let (respond_to, response_rx) = tokio::sync::oneshot::channel();
                if self
                    .mcp_tx
                    .send(McpControlCommand {
                        request: req,
                        respond_to,
                    })
                    .is_err()
                {
                    return RuntimeControlResponse::Error(ErrorResponse {
                        message: "runtime MCP control handler is unavailable".to_string(),
                    });
                }
                match response_rx.await {
                    Ok(response) => response,
                    Err(_) => RuntimeControlResponse::Error(ErrorResponse {
                        message: "runtime MCP control response channel closed".to_string(),
                    }),
                }
            }
            RuntimeControlRequest::DispatchTransport(_) => {
                // Unreachable in practice — handle_connection routes this to
                // the streaming path before calling handle_one_shot_request.
                RuntimeControlResponse::Error(ErrorResponse {
                    message: "dispatch_transport requires a streaming control connection"
                        .to_string(),
                })
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

    match request {
        RuntimeControlRequest::DispatchTransport(req) => {
            let stream = reader.into_inner();
            handle_dispatch_transport_stream(&state, stream, req.event_json).await
        }
        other => {
            let response = state.handle_one_shot_request(other).await;
            let mut stream = reader.into_inner();
            stream
                .write_all(serde_json::to_string(&response)?.as_bytes())
                .await?;
            stream.write_all(b"\n").await?;
            stream.flush().await?;
            Ok(())
        }
    }
}

/// Streaming handler for `DispatchTransport`.
///
/// Sends a `TransportDispatchRequest` into the runtime's main loop, then
/// drains frames from the per-connection unbounded receiver and writes each
/// as one JSON line. Returns when a terminal frame (`Done`/`Superseded`/
/// `Error`) has been written or when the channel closes (last tee dropped).
async fn handle_dispatch_transport_stream(
    state: &RuntimeControlState,
    mut stream: UnixStream,
    event_json: String,
) -> Result<()> {
    let (frame_tx, mut frame_rx) = mpsc::unbounded_channel::<DispatchTransportFrame>();
    let tee = TransportTee::new(frame_tx);
    let request = TransportDispatchRequest {
        event_json,
        tee: tee.clone(),
    };

    if state.transport_tx.send(request).is_err() {
        // Runtime main loop has shut down; return an Error frame on the wire
        // and bail out cleanly.
        let frame = DispatchTransportFrame::Error(ErrorResponse {
            message: "runtime is shutting down".to_string(),
        });
        write_frame(&mut stream, &frame).await?;
        return Ok(());
    }
    // The local `tee` clone is what would otherwise hold the channel open if
    // every other clone was dropped. We don't want that here — drop it so the
    // receiver only stays alive while the dispatch path's clones live.
    drop(tee);

    while let Some(frame) = frame_rx.recv().await {
        write_frame(&mut stream, &frame).await?;
        if matches!(
            frame,
            DispatchTransportFrame::Done
                | DispatchTransportFrame::Superseded
                | DispatchTransportFrame::Error(_)
        ) {
            break;
        }
    }
    Ok(())
}

async fn write_frame(stream: &mut UnixStream, frame: &DispatchTransportFrame) -> Result<()> {
    let line = serde_json::to_string(frame)?;
    stream.write_all(line.as_bytes()).await?;
    stream.write_all(b"\n").await?;
    stream.flush().await?;
    Ok(())
}

fn conversation_matches(conversation_id: &str, target: &str) -> bool {
    conversation_id == target || (target.len() >= 10 && conversation_id.starts_with(target))
}
