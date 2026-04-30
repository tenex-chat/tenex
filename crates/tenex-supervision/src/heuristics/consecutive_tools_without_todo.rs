use crate::heuristic::PostCompletionHeuristic;
use crate::types::{Detection, EnforcementMode, PostCompletionContext};

const TOOL_CALL_THRESHOLD: usize = 5;

pub struct ConsecutiveToolsWithoutTodoHeuristic;

impl PostCompletionHeuristic for ConsecutiveToolsWithoutTodoHeuristic {
    fn name(&self) -> &'static str {
        "consecutive-tools-without-todo"
    }

    fn check(&self, ctx: &PostCompletionContext<'_>) -> Option<Detection> {
        if !ctx.todos.is_empty() {
            return None;
        }
        if ctx.nudged_about_todos {
            return None;
        }
        if ctx.tool_calls_made.len() < TOOL_CALL_THRESHOLD {
            return None;
        }

        let message = format!(
            "You have made {} tool calls without creating a todo list. \
             For complex tasks, please use todo_write to track your progress. \
             Create a todo list before continuing.",
            ctx.tool_calls_made.len()
        );

        Some(Detection {
            heuristic_name: self.name(),
            message,
            enforcement: EnforcementMode::OncePerExecution,
            re_engage: false,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::TodoEntry;

    fn ctx<'a>(
        todos: &'a [TodoEntry],
        tool_calls_made: &'a [String],
        nudged: bool,
    ) -> PostCompletionContext<'a> {
        PostCompletionContext {
            todos,
            tool_calls_made,
            nudged_about_todos: nudged,
            pending_delegation_count: 0,
            triggering_message: "do work",
        }
    }

    fn tool_calls(count: usize) -> Vec<String> {
        (0..count).map(|i| format!("shell-{i}")).collect()
    }

    #[test]
    fn fires_after_threshold_with_no_todos() {
        let h = ConsecutiveToolsWithoutTodoHeuristic;
        let threshold_calls = tool_calls(TOOL_CALL_THRESHOLD);
        assert!(h.check(&ctx(&[], &threshold_calls, false)).is_some());

        let extra_calls = tool_calls(TOOL_CALL_THRESHOLD + 5);
        assert!(h.check(&ctx(&[], &extra_calls, false)).is_some());
    }

    #[test]
    fn does_not_fire_below_threshold() {
        let h = ConsecutiveToolsWithoutTodoHeuristic;
        let calls = tool_calls(TOOL_CALL_THRESHOLD - 1);
        assert!(h.check(&ctx(&[], &calls, false)).is_none());
    }

    #[test]
    fn does_not_fire_when_todos_exist() {
        let h = ConsecutiveToolsWithoutTodoHeuristic;
        let todos = vec![TodoEntry {
            id: "t1".to_string(),
            status: crate::types::TodoStatus::Pending,
        }];
        let calls = tool_calls(TOOL_CALL_THRESHOLD + 2);
        assert!(h.check(&ctx(&todos, &calls, false)).is_none());
    }

    #[test]
    fn does_not_fire_when_already_nudged() {
        let h = ConsecutiveToolsWithoutTodoHeuristic;
        let calls = tool_calls(TOOL_CALL_THRESHOLD + 2);
        assert!(h.check(&ctx(&[], &calls, true)).is_none());
    }
}
