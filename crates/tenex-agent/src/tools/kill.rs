use crate::runtime_control;
use rig_core::{completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tenex_protocol::{KillRequest, RuntimeControlRequest, RuntimeControlResponse};

#[derive(Debug, Deserialize, Serialize)]
pub struct KillArgs {
    pub target: Option<String>,
    pub conv: Option<String>,
    pub reason: String,
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct KillError(String);

#[derive(Clone)]
pub struct KillTool {
    d_tag: String,
    conversation_id: String,
    agent_pubkey: String,
}

impl KillTool {
    pub fn new(d_tag: String, conversation_id: String, agent_pubkey: String) -> Self {
        Self {
            d_tag,
            conversation_id,
            agent_pubkey,
        }
    }
}

impl Tool for KillTool {
    const NAME: &'static str = "kill";
    type Error = KillError;
    type Args = KillArgs;
    type Output = String;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Cancel a scheduled task, terminate a shell task, or kill an active agent execution. Scheduled task IDs use task-{timestamp}-{random}; shell tasks use shell-*; agent executions use a full or 10-character conversation/delegation event ID.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "target": {
                        "type": "string",
                        "description": "The target to kill: scheduled task ID, shell task ID, or conversation/delegation event ID."
                    },
                    "conv": {
                        "type": "string",
                        "description": "Alias for target when killing an agent conversation."
                    },
                    "reason": {
                        "type": "string",
                        "description": "Reason for cancellation or termination"
                    }
                },
                "required": ["reason"]
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<String, Self::Error> {
        let target = args
            .target
            .as_deref()
            .or(args.conv.as_deref())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| KillError("target or conv is required".to_string()))?
            .to_lowercase();

        // Validate it looks like a scheduled task ID.
        let is_task_id = {
            let parts: Vec<&str> = target.splitn(3, '-').collect();
            parts.len() == 3 && parts[0] == "task" && parts[1].parse::<u64>().is_ok()
        };

        if !is_task_id {
            let Some(socket) = runtime_control::socket_path() else {
                return Err(KillError(format!(
                    "Unsupported target '{}'. Shell and agent kills require the Rust project runtime control socket.",
                    target
                )));
            };
            let response = runtime_control::request(
                socket,
                RuntimeControlRequest::Kill(KillRequest {
                    target: target.clone(),
                    reason: args.reason,
                    caller_conversation_id: self.conversation_id.clone(),
                    caller_agent_pubkey: self.agent_pubkey.clone(),
                }),
            )
            .await
            .map_err(|e| KillError(format!("runtime kill request failed: {e}")))?;
            return match response {
                RuntimeControlResponse::Kill(result) => {
                    serde_json::to_string_pretty(&result).map_err(|e| KillError(e.to_string()))
                }
                RuntimeControlResponse::Error(error) => Err(KillError(error.message)),
                other => Err(KillError(format!(
                    "unexpected runtime kill response: {other:?}"
                ))),
            };
        }

        let found = tenex_scheduler::storage::remove_task(&self.d_tag, &target)
            .map_err(|e| KillError(format!("failed to cancel scheduled task: {e}")))?;

        if found {
            Ok(format!("Scheduled task '{target}' cancelled successfully."))
        } else {
            Err(KillError(format!("Scheduled task '{target}' not found.")))
        }
    }
}
