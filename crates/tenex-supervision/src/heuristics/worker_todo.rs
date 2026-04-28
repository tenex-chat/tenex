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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::TodoEntry;

    fn ctx<'a>(
        tool: &'a str,
        todos: &'a [TodoEntry],
        category: &'a AgentCategory,
    ) -> PreToolContext<'a> {
        PreToolContext { tool_name: tool, todos, agent_category: category }
    }

    #[test]
    fn blocks_worker_with_no_todos_on_shell() {
        let h = WorkerTodoHeuristic;
        let result = h.check(&ctx("shell", &[], &AgentCategory::Worker));
        assert!(result.is_some(), "should block shell when worker has no todos");
        assert!(result.unwrap().contains("shell"));
    }

    #[test]
    fn blocks_all_protected_tools() {
        let h = WorkerTodoHeuristic;
        for tool in PROTECTED_TOOLS {
            let result = h.check(&ctx(tool, &[], &AgentCategory::Worker));
            assert!(result.is_some(), "should block {tool}");
        }
    }

    #[test]
    fn does_not_block_non_worker() {
        let h = WorkerTodoHeuristic;
        for cat in [
            AgentCategory::Generalist,
            AgentCategory::Orchestrator,
            AgentCategory::Principal,
        ] {
            let result = h.check(&ctx("shell", &[], &cat));
            assert!(result.is_none(), "should not block category {cat:?}");
        }
    }

    #[test]
    fn does_not_block_worker_with_todos() {
        let h = WorkerTodoHeuristic;
        let todos = vec![TodoEntry {
            id: "task-1".to_string(),
            status: crate::types::TodoStatus::Pending,
        }];
        let result = h.check(&ctx("shell", &todos, &AgentCategory::Worker));
        assert!(result.is_none(), "should not block worker that already has todos");
    }

    #[test]
    fn does_not_block_unprotected_tool() {
        let h = WorkerTodoHeuristic;
        let result = h.check(&ctx("todo_write", &[], &AgentCategory::Worker));
        assert!(result.is_none(), "todo_write itself should not be blocked");
    }
}
