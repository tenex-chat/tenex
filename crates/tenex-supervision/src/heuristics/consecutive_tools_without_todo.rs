use crate::heuristic::PostCompletionHeuristic;
use crate::types::{Detection, EnforcementMode, PostCompletionContext};

const TOOL_CALL_THRESHOLD: usize = 5;

pub struct ConsecutiveToolsWithoutTodoHeuristic;

impl PostCompletionHeuristic for ConsecutiveToolsWithoutTodoHeuristic {
    fn name(&self) -> &'static str {
        "consecutive-tools-without-todo"
    }

    fn check(&self, ctx: &PostCompletionContext) -> Option<Detection> {
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

    fn ctx(tool_count: usize, has_todos: bool, nudged: bool) -> PostCompletionContext {
        PostCompletionContext {
            todos: if has_todos {
                vec![TodoEntry {
                    id: "t1".to_string(),
                    status: crate::types::TodoStatus::Pending,
                }]
            } else {
                vec![]
            },
            tool_calls_made: (0..tool_count).map(|i| format!("shell-{i}")).collect(),
            nudged_about_todos: nudged,
            pending_delegation_count: 0,
            triggering_message: "do work".to_string(),
        }
    }

    #[test]
    fn fires_after_threshold_with_no_todos() {
        let h = ConsecutiveToolsWithoutTodoHeuristic;
        assert!(h.check(&ctx(TOOL_CALL_THRESHOLD, false, false)).is_some());
        assert!(h.check(&ctx(TOOL_CALL_THRESHOLD + 5, false, false)).is_some());
    }

    #[test]
    fn does_not_fire_below_threshold() {
        let h = ConsecutiveToolsWithoutTodoHeuristic;
        assert!(h.check(&ctx(TOOL_CALL_THRESHOLD - 1, false, false)).is_none());
    }

    #[test]
    fn does_not_fire_when_todos_exist() {
        let h = ConsecutiveToolsWithoutTodoHeuristic;
        assert!(h.check(&ctx(TOOL_CALL_THRESHOLD + 2, true, false)).is_none());
    }

    #[test]
    fn does_not_fire_when_already_nudged() {
        let h = ConsecutiveToolsWithoutTodoHeuristic;
        assert!(h.check(&ctx(TOOL_CALL_THRESHOLD + 2, false, true)).is_none());
    }
}
