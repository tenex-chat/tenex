use crate::heuristic::PreToolHeuristic;
use crate::types::{AgentCategory, PreToolContext};

const PROTECTED_TOOLS: &[&str] = &["shell", "fs_read", "fs_write", "fs_edit", "fs_glob", "fs_grep"];

pub struct WorkerTodoHeuristic;

impl PreToolHeuristic for WorkerTodoHeuristic {
    fn name(&self) -> &'static str {
        "worker-todo-before-file-or-shell"
    }

    fn check<'a>(&self, ctx: &PreToolContext<'a>) -> Option<String> {
        if *ctx.agent_category != AgentCategory::Worker {
            return None;
        }
        if !ctx.todos.is_empty() {
            return None;
        }
        if !PROTECTED_TOOLS.contains(&ctx.tool_name) {
            return None;
        }

        Some(format!(
            "You must create a todo list before using '{}'. \
             Use todo_write to plan your tasks first, \
             then proceed with file and shell operations.",
            ctx.tool_name
        ))
    }
}
