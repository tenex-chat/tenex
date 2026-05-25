use crate::runtime_control;
use rig_core::{completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::time::Duration;
use tenex_protocol::{
    RunShellRequest, RuntimeControlRequest, RuntimeControlResponse, ShellBackgroundResponse,
};

#[derive(Debug, Deserialize, Serialize)]
pub struct ShellArgs {
    pub command: String,
    pub description: String,
    pub cwd: Option<String>,
    pub timeout: Option<u64>,
    pub run_in_background: Option<bool>,
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct ShellError(String);

pub struct ShellTool {
    working_dir: String,
    extra_env: Vec<(String, String)>,
    project_id: String,
    conversation_id: String,
    agent_pubkey: String,
    execution_id: String,
}

impl ShellTool {
    pub fn new(
        working_dir: String,
        extra_env: Vec<(String, String)>,
        project_id: String,
        conversation_id: String,
        agent_pubkey: String,
        execution_id: String,
    ) -> Self {
        Self {
            working_dir,
            extra_env,
            project_id,
            conversation_id,
            agent_pubkey,
            execution_id,
        }
    }
}

impl Tool for ShellTool {
    const NAME: &'static str = "shell";
    type Error = ShellError;
    type Args = ShellArgs;
    type Output = String;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Execute shell commands in the project directory.

IMPORTANT ESCAPING & STRING HANDLING:
- For complex/multi-line strings, ALWAYS use HEREDOC pattern:
  command -m \"$(cat <<'EOF'
  Your multi-line content here
  EOF
  )\"
- Always quote file paths with spaces

COMMAND CHAINING:
- For independent commands: make multiple shell() calls in parallel
- For dependent sequential: use && to chain

WHEN NOT TO USE SHELL:
- Reading files: use fs_read
- Writing/creating files: use fs_write
- Editing files: use fs_edit
- File search: use fs_glob
- Content search: use fs_grep

Commands run with a timeout in seconds (default 30, max 600)."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "The shell command to execute"
                    },
                    "description": {
                        "type": "string",
                        "description": "What this command does (5-10 words)"
                    },
                    "cwd": {
                        "type": "string",
                        "description": "Working directory override (optional)"
                    },
                    "timeout": {
                        "type": "integer",
                        "description": "Timeout in seconds (default: 30, max: 600)"
                    },
                    "run_in_background": {
                        "type": "boolean",
                        "description": "Set true to start the command and return immediately with a shell task ID."
                    }
                },
                "required": ["command", "description"]
            }),
        }
    }

    async fn call(&self, args: ShellArgs) -> Result<Self::Output, ShellError> {
        if let Some(socket) = runtime_control::socket_path() {
            let request = RuntimeControlRequest::RunShell(RunShellRequest {
                command: args.command.clone(),
                description: args.description.clone(),
                cwd: args.cwd.clone(),
                timeout_secs: Some(args.timeout.unwrap_or(30).min(600)),
                run_in_background: args.run_in_background.unwrap_or(false),
                working_dir: self.working_dir.clone(),
                extra_env: self.extra_env.clone(),
                project_id: self.project_id.clone(),
                conversation_id: self.conversation_id.clone(),
                agent_pubkey: self.agent_pubkey.clone(),
                execution_id: self.execution_id.clone(),
            });
            return match runtime_control::request(socket, request).await {
                Ok(RuntimeControlResponse::ShellCompleted(response)) => Ok(response.output),
                Ok(RuntimeControlResponse::ShellBackground(response)) => {
                    Ok(format_background_response(response))
                }
                Ok(RuntimeControlResponse::Error(error)) => Ok(format!("Error: {}", error.message)),
                Ok(other) => Ok(format!("Error: unexpected runtime response: {other:?}")),
                Err(error) => Ok(format!("Error: runtime control request failed: {error}")),
            };
        }

        if args.run_in_background.unwrap_or(false) {
            return Ok(
                "Error: background shell commands require the Rust project runtime control socket."
                    .to_string(),
            );
        }

        let cwd = args.cwd.as_deref().unwrap_or(&self.working_dir);
        let timeout_secs = args.timeout.unwrap_or(30).min(600);

        let mut cmd = tokio::process::Command::new("sh");
        cmd.arg("-c")
            .arg(&args.command)
            .current_dir(cwd)
            .stdin(std::process::Stdio::null());
        for (k, v) in &self.extra_env {
            cmd.env(k, v);
        }

        let result = tokio::time::timeout(Duration::from_secs(timeout_secs), cmd.output()).await;

        match result {
            Err(_) => Ok(format!(
                "Error: command timed out after {timeout_secs}s\ncommand: {}",
                args.command
            )),
            Ok(Err(e)) => Ok(format!(
                "Error: failed to spawn command: {e}\ncommand: {}",
                args.command
            )),
            Ok(Ok(output)) => {
                let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                let exit_code = output.status.code().unwrap_or(-1);

                // Commands where non-zero exit is expected
                let expected_non_zero = matches!(
                    args.command.split_whitespace().next().unwrap_or(""),
                    "grep" | "rg" | "diff" | "test"
                );

                if output.status.success() || (expected_non_zero && exit_code == 1) {
                    let mut result = stdout;
                    if !stderr.is_empty() {
                        result.push_str("\nSTDERR:\n");
                        result.push_str(&stderr);
                    }
                    Ok(result)
                } else {
                    Ok(format!(
                        "Command failed (exit code {exit_code})\nSTDOUT:\n{stdout}\nSTDERR:\n{stderr}"
                    ))
                }
            }
        }
    }
}

fn format_background_response(response: ShellBackgroundResponse) -> String {
    json!({
        "type": "background-task",
        "taskId": response.task_id,
        "command": response.command,
        "description": response.description,
        "outputFile": response.output_file,
        "message": response.message,
    })
    .to_string()
}
