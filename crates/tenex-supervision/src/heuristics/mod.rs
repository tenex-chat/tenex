mod consecutive_tools_without_todo;
mod pending_todos;
mod worker_todo;

use crate::heuristic::{PostCompletionHeuristic, PreToolHeuristic};
use crate::supervisor::Supervisor;
use consecutive_tools_without_todo::ConsecutiveToolsWithoutTodoHeuristic;
use pending_todos::PendingTodosHeuristic;
use worker_todo::WorkerTodoHeuristic;

pub fn default_supervisor() -> Supervisor {
    let post: Vec<Box<dyn PostCompletionHeuristic>> = vec![
        Box::new(PendingTodosHeuristic),
        Box::new(ConsecutiveToolsWithoutTodoHeuristic),
    ];
    let pre: Vec<Box<dyn PreToolHeuristic>> = vec![Box::new(WorkerTodoHeuristic)];
    Supervisor::new(post, pre)
}
