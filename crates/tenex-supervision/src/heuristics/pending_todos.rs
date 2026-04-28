use crate::heuristic::PostCompletionHeuristic;
use crate::types::{Detection, EnforcementMode, PostCompletionContext, TodoStatus};

pub struct PendingTodosHeuristic;

impl PostCompletionHeuristic for PendingTodosHeuristic {
    fn name(&self) -> &'static str {
        "pending-todos"
    }

    fn check(&self, ctx: &PostCompletionContext) -> Option<Detection> {
        if ctx.todos.is_empty() {
            return None;
        }
        if ctx.pending_delegation_count > 0 {
            return None;
        }
        let active: Vec<&str> = ctx
            .todos
            .iter()
            .filter(|t| t.status == TodoStatus::Pending || t.status == TodoStatus::InProgress)
            .map(|t| t.id.as_str())
            .collect();
        if active.is_empty() {
            return None;
        }

        let message = format!(
            "Your original task was: {}\n\n\
             You have unfinished todo items: {}. \
             Please continue working on them. \
             Mark each item in_progress when you start it and done when complete.",
            ctx.triggering_message,
            active.join(", ")
        );

        Some(Detection {
            heuristic_name: self.name(),
            message,
            enforcement: EnforcementMode::RepeatUntilResolved,
            re_engage: true,
        })
    }
}
