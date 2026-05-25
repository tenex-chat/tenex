use chrono::Utc;
use rig_core::{completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::time::{SystemTime, UNIX_EPOCH};
use tenex_scheduler::model::{ScheduledTask, TaskType};

#[derive(Debug, Deserialize, Serialize)]
pub struct ScheduleTaskArgs {
    pub prompt: String,
    pub when: String,
    pub title: Option<String>,
    pub target_agent: Option<String>,
    pub target_channel: Option<String>,
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct ScheduleTaskError(String);

#[derive(Clone)]
pub struct ScheduleTaskTool {
    project_d_tag: String,
    agent_pubkey: String,
    agent_slug: String,
    project_id: String,
}

impl ScheduleTaskTool {
    pub fn new(
        project_d_tag: String,
        agent_pubkey: String,
        agent_slug: String,
        project_id: String,
    ) -> Self {
        Self {
            project_d_tag,
            agent_pubkey,
            agent_slug,
            project_id,
        }
    }
}

/// Parse a relative delay string into milliseconds.
/// Supports: 30s, 5m, 2h, 1d
fn parse_relative_delay(s: &str) -> Option<u64> {
    let s = s.trim();
    let (num_part, unit) = s.split_at(s.len().saturating_sub(1));
    let multiplier: u64 = match unit {
        "s" => 1_000,
        "m" => 60_000,
        "h" => 3_600_000,
        "d" => 86_400_000,
        _ => return None,
    };
    let n: u64 = num_part.parse().ok()?;
    if n == 0 {
        return None;
    }
    Some(n * multiplier)
}

/// Validate a 5-field cron expression (field count check only).
fn is_valid_cron(s: &str) -> bool {
    s.split_whitespace().count() == 5
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

fn random_hex6() -> String {
    let mut buf = [0u8; 3];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        use std::io::Read;
        let _ = f.read_exact(&mut buf);
    }
    format!("{:02x}{:02x}{:02x}", buf[0], buf[1], buf[2])
}

fn generate_task_id() -> String {
    let ts = now_ms();
    let suffix = random_hex6();
    format!("task-{ts}-{suffix}")
}

fn ms_to_iso(ms: u64) -> String {
    let secs = (ms / 1000) as i64;
    chrono::DateTime::from_timestamp(secs, 0).map_or_else(
        || format!("{secs}"),
        |dt| dt.with_timezone(&Utc).to_rfc3339(),
    )
}

impl Tool for ScheduleTaskTool {
    const NAME: &'static str = "schedule_task";
    type Error = ScheduleTaskError;
    type Args = ScheduleTaskArgs;
    type Output = String;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Schedule a task to run in the future. For recurring tasks, use a 5-field cron expression (e.g. '0 9 * * *' for daily at 9am UTC). For one-off tasks, use a relative delay (e.g. '5m', '2h', '1d'). The task will be picked up by the TENEX scheduler daemon.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "prompt": {
                        "type": "string",
                        "description": "The prompt to send to the agent when the task runs"
                    },
                    "when": {
                        "type": "string",
                        "description": "When to run: a 5-field cron expression for recurring tasks (e.g. '0 9 * * *'), or a relative delay for one-off tasks (e.g. '5m', '2h', '1d', '30s')"
                    },
                    "title": {
                        "type": "string",
                        "description": "Human-readable title for the task (optional)"
                    },
                    "target_agent": {
                        "type": "string",
                        "description": "Target agent slug (e.g. 'architect'). Defaults to this agent."
                    },
                    "target_channel": {
                        "type": "string",
                        "description": "Conversation ID or channel where the task output should be delivered"
                    }
                },
                "required": ["prompt", "when"]
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<String, Self::Error> {
        let target_slug = args
            .target_agent
            .as_deref()
            .unwrap_or(&self.agent_slug)
            .to_string();
        let task_id = generate_task_id();
        let created_at = Utc::now().to_rfc3339();

        let task = if let Some(delay_ms) = parse_relative_delay(&args.when) {
            let execute_at = ms_to_iso(now_ms() + delay_ms);
            ScheduledTask {
                id: task_id.clone(),
                title: args.title,
                schedule: String::new(),
                prompt: args.prompt,
                last_run: None,
                next_run: None,
                created_at: Some(created_at),
                from_pubkey: Some(self.agent_pubkey.clone()),
                target_agent_slug: target_slug,
                project_id: self.project_id.clone(),
                project_ref: None,
                task_type: Some(TaskType::Oneoff),
                execute_at: Some(execute_at),
                target_channel: args.target_channel,
            }
        } else if is_valid_cron(&args.when) {
            ScheduledTask {
                id: task_id.clone(),
                title: args.title,
                schedule: args.when.clone(),
                prompt: args.prompt,
                last_run: None,
                next_run: None,
                created_at: Some(created_at),
                from_pubkey: Some(self.agent_pubkey.clone()),
                target_agent_slug: target_slug,
                project_id: self.project_id.clone(),
                project_ref: None,
                task_type: Some(TaskType::Cron),
                execute_at: None,
                target_channel: args.target_channel,
            }
        } else {
            return Err(ScheduleTaskError(format!(
                "Invalid 'when' value: \"{}\". Use a 5-field cron expression (e.g. '0 9 * * *') or a relative delay (e.g. '5m', '2h', '1d').",
                args.when
            )));
        };

        let summary = match task.task_type {
            Some(TaskType::Oneoff) => format!(
                "One-off task scheduled (ID: {task_id}), executes at: {}",
                task.execute_at.as_deref().unwrap_or("unknown")
            ),
            _ => format!(
                "Recurring task scheduled (ID: {task_id}), cron: {}",
                task.schedule
            ),
        };

        tenex_scheduler::storage::add_task(&self.project_d_tag, task)
            .map_err(|e| ScheduleTaskError(format!("failed to write scheduled task: {e}")))?;

        Ok(summary)
    }
}
