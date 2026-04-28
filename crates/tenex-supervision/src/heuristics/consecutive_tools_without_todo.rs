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
