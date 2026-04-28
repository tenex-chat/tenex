use rig::{completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Debug, Deserialize, Serialize)]
pub struct KillArgs {
    pub target: String,
    pub reason: String,
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct KillError(String);

#[derive(Clone)]
pub struct KillTool {
    d_tag: String,
}

impl KillTool {
    pub fn new(d_tag: String) -> Self {
        Self { d_tag }
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
            description: "Cancel a scheduled task by its task ID (format: task-{timestamp}-{random}). Agent conversation kills and shell task kills are not available in this context — use the TENEX web interface or TypeScript runtime for those.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "target": {
                        "type": "string",
                        "description": "The scheduled task ID to cancel (format: task-{timestamp}-{random})"
                    },
                    "reason": {
                        "type": "string",
                        "description": "Reason for cancellation"
                    }
                },
                "required": ["target", "reason"]
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<String, Self::Error> {
        let target = args.target.trim().to_lowercase();

        // Validate it looks like a scheduled task ID.
        let is_task_id = {
            let parts: Vec<&str> = target.splitn(3, '-').collect();
            parts.len() == 3 && parts[0] == "task" && parts[1].parse::<u64>().is_ok()
        };

        if !is_task_id {
            return Err(KillError(format!(
                "Unsupported target '{}'. This tool only cancels scheduled tasks (format: task-{{timestamp}}-{{random}}). \
                 Agent conversation kills and shell task kills require the TypeScript runtime.",
                args.target
            )));
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
