//! System-reminder overlays.
//!
//! Appends a `<system-reminder>` block containing the agent's current todo
//! list to the most recent visible non-system message, so it rides at the
//! tail of the prompt where the model is most likely to attend to it.
//! Mirrors the TS pipeline's "overlay onto last visible" placement.

use crate::strategies::{ProjectionContext, Strategy};
use crate::types::Message;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

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

#[derive(Default)]
struct TodoStatusCounts {
    pending: usize,
    in_progress: usize,
    done: usize,
    skipped: usize,
}

impl TodoStatusCounts {
    fn from_todos(todos: &[TodoItem]) -> Self {
        let mut counts = Self::default();
        for todo in todos {
            match todo.status {
                TodoStatus::Pending => counts.pending += 1,
                TodoStatus::InProgress => counts.in_progress += 1,
                TodoStatus::Done => counts.done += 1,
                TodoStatus::Skipped => counts.skipped += 1,
            }
        }
        counts
    }
}

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

    let counts = TodoStatusCounts::from_todos(&todos);

    let mut lines = vec![
        "<system-reminder>".to_string(),
        "<agent-todos>".to_string(),
        String::new(),
        format!(
            "Status: {} pending, {} in progress, {} done, {} skipped",
            counts.pending, counts.in_progress, counts.done, counts.skipped
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

    if counts.pending > 0 {
        lines.push(String::new());
        lines.push(format!(
            "**ATTENTION:** You have {} pending todo item(s) that need to be addressed.",
            counts.pending
        ));
    }

    lines.push("</agent-todos>".to_string());
    lines.push("</system-reminder>".to_string());

    lines.join("\n")
}

#[derive(Default)]
pub struct RemindersStrategy;

#[async_trait]
impl Strategy for RemindersStrategy {
    fn name(&self) -> &'static str {
        NAME
    }

    async fn apply(&self, ctx: &mut ProjectionContext<'_>) -> anyhow::Result<()> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{ModelProfile, ProjectionTelemetry};
    use serde_json::json;

    fn profile() -> ModelProfile {
        ModelProfile {
            provider: "test".into(),
            model_id: "model".into(),
            prompt_cache: false,
            ephemeral_reminders: false,
            image_support: false,
            max_context_tokens: 200_000,
        }
    }

    fn ctx_with_todos<'a>(
        messages: Vec<Message>,
        todos: Option<serde_json::Value>,
        p: &'a ModelProfile,
    ) -> ProjectionContext<'a> {
        ProjectionContext {
            messages,
            telemetry: ProjectionTelemetry::default(),
            model_profile: p,
            tool_defs: &[],
            agent_todos: todos,
        }
    }

    fn pending_todo(id: &str, title: &str) -> serde_json::Value {
        json!({"id": id, "title": title, "status": "pending"})
    }

    fn done_todo(id: &str, title: &str) -> serde_json::Value {
        json!({"id": id, "title": title, "status": "done"})
    }

    #[tokio::test]
    async fn no_reminder_when_todos_absent() {
        let p = profile();
        let mut ctx = ctx_with_todos(
            vec![
                Message::System {
                    content: "sys".into(),
                },
                Message::User {
                    content: "hello".into(),
                },
            ],
            None,
            &p,
        );
        RemindersStrategy.apply(&mut ctx).await.unwrap();
        assert_eq!(ctx.telemetry.reminders_overlayed, 0);
        assert_eq!(
            ctx.messages[1],
            Message::User {
                content: "hello".into()
            }
        );
    }

    #[tokio::test]
    async fn reminder_injected_for_done_todos_but_no_attention_block() {
        // When todos exist but all are done, the reminder block is still injected
        // (it shows the todo state) but the ATTENTION header is omitted because
        // there are no pending items.
        let p = profile();
        let todos = json!([done_todo("t1", "Task 1"), done_todo("t2", "Task 2")]);
        let mut ctx = ctx_with_todos(
            vec![
                Message::System {
                    content: "sys".into(),
                },
                Message::User {
                    content: "hello".into(),
                },
            ],
            Some(todos),
            &p,
        );
        RemindersStrategy.apply(&mut ctx).await.unwrap();
        assert_eq!(ctx.telemetry.reminders_overlayed, 1);
        let last = match &ctx.messages[1] {
            Message::User { content } => content.clone(),
            other => panic!("expected user message, got {other:?}"),
        };
        assert!(last.contains("<system-reminder>"), "reminder block present");
        assert!(
            !last.contains("ATTENTION"),
            "no ATTENTION block when no pending todos"
        );
    }

    #[tokio::test]
    async fn reminder_appended_to_last_user_message() {
        let p = profile();
        let todos = json!([pending_todo("t1", "Write tests")]);
        let mut ctx = ctx_with_todos(
            vec![
                Message::System {
                    content: "sys".into(),
                },
                Message::User {
                    content: "first".into(),
                },
                Message::User {
                    content: "last".into(),
                },
            ],
            Some(todos),
            &p,
        );
        RemindersStrategy.apply(&mut ctx).await.unwrap();
        assert_eq!(ctx.telemetry.reminders_overlayed, 1);
        // Reminder was appended to the LAST message (index 2), not index 1
        let last = match &ctx.messages[2] {
            Message::User { content } => content.clone(),
            _ => panic!("expected user message"),
        };
        assert!(
            last.contains("<system-reminder>"),
            "reminder block must be present"
        );
        assert!(
            last.contains("Write tests"),
            "todo title must appear in reminder"
        );
        assert!(
            last.starts_with("last\n\n"),
            "original content must be preserved"
        );
    }

    #[tokio::test]
    async fn reminder_not_appended_to_system_only_context() {
        let p = profile();
        let todos = json!([pending_todo("t1", "Do something")]);
        let mut ctx = ctx_with_todos(
            vec![Message::System {
                content: "sys only".into(),
            }],
            Some(todos),
            &p,
        );
        RemindersStrategy.apply(&mut ctx).await.unwrap();
        // No non-system target: reminders_overlayed stays 0
        assert_eq!(ctx.telemetry.reminders_overlayed, 0);
    }

    #[tokio::test]
    async fn reminder_counts_status_breakdown_correctly() {
        let p = profile();
        let todos = json!([
            pending_todo("t1", "pending one"),
            pending_todo("t2", "pending two"),
            json!({"id": "t3", "title": "in progress", "status": "in_progress"}),
            done_todo("t4", "done one"),
        ]);
        let mut ctx = ctx_with_todos(
            vec![
                Message::System {
                    content: "sys".into(),
                },
                Message::User {
                    content: "msg".into(),
                },
            ],
            Some(todos),
            &p,
        );
        RemindersStrategy.apply(&mut ctx).await.unwrap();
        assert_eq!(ctx.telemetry.reminders_overlayed, 1);
        let last = match &ctx.messages[1] {
            Message::User { content } => content.clone(),
            other => panic!("expected user message, got {other:?}"),
        };
        assert!(last.contains("2 pending"), "should show 2 pending");
        assert!(last.contains("1 in progress"), "should show 1 in_progress");
        assert!(last.contains("1 done"), "should show 1 done");
        assert!(
            last.contains("ATTENTION"),
            "ATTENTION block appears when pending > 0"
        );
    }

    #[tokio::test]
    async fn reminder_appended_to_tool_result_when_last() {
        let p = profile();
        let todos = json!([pending_todo("t1", "task")]);
        let mut ctx = ctx_with_todos(
            vec![
                Message::System {
                    content: "sys".into(),
                },
                Message::User {
                    content: "user".into(),
                },
                Message::ToolResult {
                    tool_call_id: "call-1".into(),
                    tool_name: "shell".into(),
                    content: "output".into(),
                    is_error: false,
                },
            ],
            Some(todos),
            &p,
        );
        RemindersStrategy.apply(&mut ctx).await.unwrap();
        assert_eq!(ctx.telemetry.reminders_overlayed, 1);
        let last_content = match &ctx.messages[2] {
            Message::ToolResult { content, .. } => content.clone(),
            other => panic!("expected tool result message, got {other:?}"),
        };
        assert!(last_content.contains("<system-reminder>"));
    }
}
