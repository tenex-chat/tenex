use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum TaskType {
    Cron,
    Oneoff,
}

/// Matches the TypeScript `ScheduledTask` interface exactly.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTask {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Cron expression (5-field) for cron tasks, or ISO 8601 timestamp for one-offs.
    pub schedule: String,
    pub prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_run: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_run: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    pub from_pubkey: String,
    pub target_agent_slug: String,
    pub project_id: String,
    /// NIP-33 address tag: "31933:<pubkey>:<dTag>".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_ref: Option<String>,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub task_type: Option<TaskType>,
    /// ISO 8601 timestamp for one-off tasks.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execute_at: Option<String>,
    /// Nostr event ID to use as the channel (e-tag) on the published event.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_channel: Option<String>,
}

impl ScheduledTask {
    pub fn is_oneoff(&self) -> bool {
        matches!(self.task_type, Some(TaskType::Oneoff))
    }

    pub fn is_cron(&self) -> bool {
        !self.is_oneoff()
    }
}

/// Top-level shape of a `schedules.json` file.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SchedulesFile {
    #[serde(default)]
    pub tasks: Vec<ScheduledTask>,
}
