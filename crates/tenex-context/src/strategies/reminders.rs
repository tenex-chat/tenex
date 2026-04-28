//! System-reminder overlays.
//!
//! Appends a `<system-reminder>` block containing the agent's current todo
//! list to the most recent visible non-system message, so it rides at the
//! tail of the prompt where the model is most likely to attend to it.
//! Mirrors the TS pipeline's "overlay onto last visible" placement.

use crate::strategies::{ProjectionContext, Strategy};
use crate::types::Message;

const NAME: &str = "reminders";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum TodoStatus {
    Pending,
    InProgress,
    Done,
    Skipped,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TodoItem {
    id: String,
    title: String,
    status: TodoStatus,
}

use serde::{Deserialize, Serialize};

fn build_todos_reminder(todos_json: Option<&serde_json::Value>) -> String {
    let Some(val) = todos_json else {
        return String::new();
    };
    let todos: Vec<TodoItem> = match serde_json::from_value(val.clone()) {
        Ok(v) => v,
        Err(_) => return String::new(),
    };
    if todos.is_empty() {
        return String::new();
    }

    let pending = todos.iter().filter(|t| t.status == TodoStatus::Pending).count();
    let in_progress = todos.iter().filter(|t| t.status == TodoStatus::InProgress).count();
    let done = todos.iter().filter(|t| t.status == TodoStatus::Done).count();
    let skipped = todos.iter().filter(|t| t.status == TodoStatus::Skipped).count();

    let mut lines = vec![
        "<system-reminder>".to_string(),
        "<agent-todos>".to_string(),
        String::new(),
        format!(
            "Status: {} pending, {} in progress, {} done, {} skipped",
            pending, in_progress, done, skipped
        ),
        String::new(),
    ];

    for t in &todos {
        let marker = match t.status {
            TodoStatus::Pending => "[ ]",
            TodoStatus::InProgress => "[~]",
            TodoStatus::Done => "[x]",
            TodoStatus::Skipped => "[-]",
        };
        lines.push(format!("{} {} (id: {})", marker, t.title, t.id));
    }

    lines.push(String::new());
    lines.push(
        "Use `todo_write` to update statuses. Mark items in_progress when starting, done when complete."
            .to_string(),
    );

    if pending > 0 {
        lines.push(String::new());
        lines.push(format!(
            "**ATTENTION:** You have {} pending todo item(s) that need to be addressed.",
            pending
        ));
    }

    lines.push("</agent-todos>".to_string());
    lines.push("</system-reminder>".to_string());

    lines.join("\n")
}

#[derive(Default)]
pub struct RemindersStrategy;

impl Strategy for RemindersStrategy {
    fn name(&self) -> &'static str {
        NAME
    }

    fn apply(&self, ctx: &mut ProjectionContext<'_>) -> anyhow::Result<()> {
        let reminder = build_todos_reminder(ctx.agent_todos.as_ref());
        if reminder.is_empty() {
            return Ok(());
        }

        // Walk from the tail, find the last non-system message, append.
        let target = ctx
            .messages
            .iter_mut()
            .enumerate()
            .rev()
            .find(|(_, m)| !matches!(m, Message::System { .. }));

        let Some((_, msg)) = target else {
            return Ok(());
        };

        match msg {
            Message::User { content } | Message::Assistant { content, .. } => {
                content.push_str("\n\n");
                content.push_str(&reminder);
            }
            Message::ToolResult { content, .. } => {
                content.push_str("\n\n");
                content.push_str(&reminder);
            }
            Message::System { .. } => return Ok(()),
        }

        ctx.telemetry.reminders_overlayed += 1;
        ctx.telemetry.strategies_applied.push(NAME.to_string());
        Ok(())
    }
}
