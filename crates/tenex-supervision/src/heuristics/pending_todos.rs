use crate::heuristic::PostCompletionHeuristic;
use crate::types::{Detection, EnforcementMode, PostCompletionContext, TodoStatus};

pub struct PendingTodosHeuristic;

fn is_explicit_todo_list_only_request(message: &str) -> bool {
    let lower = message.to_lowercase();
    let mentions_todos =
        lower.contains("todo") || lower.contains("to-do") || lower.contains("task list");
    if !mentions_todos {
        return false;
    }

    let asks_to_set_up = [
        "set up",
        "setup",
        "create",
        "make",
        "initialize",
        "init",
        "write",
        "draft",
        "prepare",
    ]
    .iter()
    .any(|phrase| lower.contains(phrase));
    if !asks_to_set_up {
        return false;
    }

    let asks_to_stop_after = [
        "and stop",
        "then stop",
        "stop after",
        "nothing else",
        "only",
        "just",
        "do not continue",
        "don't continue",
        "do not do",
        "don't do",
    ]
    .iter()
    .any(|phrase| lower.contains(phrase));

    let asks_to_execute_items = [
        "then do",
        "and do",
        "then complete",
        "and complete",
        "work through",
        "execute",
        "implement",
        "build",
        "fix",
    ]
    .iter()
    .any(|phrase| lower.contains(phrase));

    asks_to_stop_after && !asks_to_execute_items
}

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
        if is_explicit_todo_list_only_request(&ctx.triggering_message) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{TodoEntry, TodoStatus};

    fn ctx(todos: Vec<TodoEntry>, delegations: usize) -> PostCompletionContext {
        PostCompletionContext {
            todos,
            tool_calls_made: vec![],
            nudged_about_todos: false,
            pending_delegation_count: delegations,
            triggering_message: "do the thing".to_string(),
        }
    }

    #[test]
    fn fires_when_pending_todos_remain() {
        let h = PendingTodosHeuristic;
        let todos = vec![
            TodoEntry {
                id: "t1".to_string(),
                status: TodoStatus::Pending,
            },
            TodoEntry {
                id: "t2".to_string(),
                status: TodoStatus::Done,
            },
        ];
        let detection = h.check(&ctx(todos, 0));
        assert!(detection.is_some());
        let d = detection.unwrap();
        assert!(d.re_engage);
        assert!(d.message.contains("t1"));
        assert!(!d.message.contains("t2"), "done todos should not appear");
    }

    #[test]
    fn suppressed_when_delegation_pending() {
        let h = PendingTodosHeuristic;
        let todos = vec![TodoEntry {
            id: "t1".to_string(),
            status: TodoStatus::Pending,
        }];
        assert!(h.check(&ctx(todos, 1)).is_none());
    }

    #[test]
    fn suppressed_when_all_done() {
        let h = PendingTodosHeuristic;
        let todos = vec![
            TodoEntry {
                id: "t1".to_string(),
                status: TodoStatus::Done,
            },
            TodoEntry {
                id: "t2".to_string(),
                status: TodoStatus::Skipped,
            },
        ];
        assert!(h.check(&ctx(todos, 0)).is_none());
    }

    #[test]
    fn suppressed_when_no_todos() {
        let h = PendingTodosHeuristic;
        assert!(h.check(&ctx(vec![], 0)).is_none());
    }

    #[test]
    fn suppressed_when_user_requested_todo_setup_and_stop() {
        let h = PendingTodosHeuristic;
        let todos = vec![TodoEntry {
            id: "t1".to_string(),
            status: TodoStatus::Pending,
        }];
        let mut ctx = ctx(todos, 0);
        ctx.triggering_message = "setup a todo list with 3 items and stop".to_string();
        assert!(h.check(&ctx).is_none());
    }

    #[test]
    fn still_fires_when_user_requests_todo_setup_and_execution() {
        let h = PendingTodosHeuristic;
        let todos = vec![TodoEntry {
            id: "t1".to_string(),
            status: TodoStatus::Pending,
        }];
        let mut ctx = ctx(todos, 0);
        ctx.triggering_message = "setup a todo list and then complete the tasks".to_string();
        assert!(h.check(&ctx).is_some());
    }
}
