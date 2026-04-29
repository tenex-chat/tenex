//! Runtime-local NDJSON control protocol.
//!
//! The project runtime owns process state that a one-shot `tenex-agent`
//! process cannot observe directly: active agent child processes and shell
//! command process groups. Agents use these frames over a Unix socket when
//! they need to run a shell task, list active shell tasks, or request a kill.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", content = "data", rename_all = "snake_case")]
pub enum RuntimeControlRequest {
    RunShell(RunShellRequest),
    ListShellTasks(ListShellTasksRequest),
    Kill(KillRequest),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunShellRequest {
    pub command: String,
    pub description: String,
    pub cwd: Option<String>,
    pub timeout_secs: Option<u64>,
    pub run_in_background: bool,
    pub working_dir: String,
    pub extra_env: Vec<(String, String)>,
    pub project_id: String,
    pub conversation_id: String,
    pub agent_pubkey: String,
    pub execution_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListShellTasksRequest {
    pub project_id: String,
    pub conversation_id: String,
    pub agent_pubkey: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KillRequest {
    pub target: String,
    pub reason: String,
    pub caller_conversation_id: String,
    pub caller_agent_pubkey: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum RuntimeControlResponse {
    ShellCompleted(ShellCompletedResponse),
    ShellBackground(ShellBackgroundResponse),
    ShellTasks(ShellTasksResponse),
    Kill(KillResponse),
    Error(ErrorResponse),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShellCompletedResponse {
    pub task_id: String,
    pub output: String,
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShellBackgroundResponse {
    pub task_id: String,
    pub command: String,
    pub description: String,
    pub output_file: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShellTasksResponse {
    pub tasks: Vec<ShellTaskSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShellTaskSummary {
    pub task_id: String,
    pub mode: ShellTaskMode,
    pub command: String,
    pub description: String,
    pub output_file: String,
    pub started_at_ms: i64,
    pub pid: u32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ShellTaskMode {
    Foreground,
    Background,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KillResponse {
    pub success: bool,
    pub target: String,
    pub target_type: KillTargetType,
    pub message: String,
    pub killed_count: usize,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum KillTargetType {
    Agent,
    Shell,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorResponse {
    pub message: String,
}
