use crate::heuristic::{PostCompletionHeuristic, PreToolHeuristic};
use crate::types::{
    AgentCategory, EnforcementMode, PostCompletionContext, PreToolContext, TodoEntry, TodoStatus,
};
use std::collections::HashSet;

/// Maximum consecutive re-engagements where the agent made no progress on
/// `RepeatUntilResolved` heuristics. When exceeded, the supervisor accepts
/// completion to break what is presumed to be a stuck loop.
const MAX_STUCK_ITERATIONS: u32 = 3;

/// Absolute upper bound on total re-engagements per execution. Last-resort
/// guard against pathological loops where todos keep changing without ever
/// converging (e.g. agent renames or re-adds todos every iteration).
const ABSOLUTE_REENGAGEMENT_CAP: u32 = 30;

pub enum PostCompletionOutcome {
    Accept,
    /// Inject a nudge message into the next turn's context without triggering
    /// a full re-engagement loop. The caller should surface the message as a
    /// low-priority system reminder and then complete normally.
    InjectMessage {
        message: String,
    },
    ReEngage {
        message: String,
    },
}

pub struct Supervisor {
    post_heuristics: Vec<Box<dyn PostCompletionHeuristic>>,
    pre_heuristics: Vec<Box<dyn PreToolHeuristic>>,
    pub tool_calls_made: Vec<String>,
    pub nudged_about_todos: bool,
    fired_once: HashSet<String>,
    /// IDs of todos seen in a terminal state (`Done` or `Skipped`) on any
    /// previous post-completion check. Used to detect real progress.
    completed_todo_ids: HashSet<String>,
    /// Consecutive re-engagements driven by `RepeatUntilResolved` heuristics
    /// during which no new todo reached a terminal state.
    stuck_count: u32,
    /// Total re-engagements (or injections) this execution. Backstop only.
    total_reengagements: u32,
}

impl Supervisor {
    pub fn new(
        post_heuristics: Vec<Box<dyn PostCompletionHeuristic>>,
        pre_heuristics: Vec<Box<dyn PreToolHeuristic>>,
    ) -> Self {
        Self {
            post_heuristics,
            pre_heuristics,
            tool_calls_made: Vec::new(),
            nudged_about_todos: false,
            fired_once: HashSet::new(),
            completed_todo_ids: HashSet::new(),
            stuck_count: 0,
            total_reengagements: 0,
        }
    }

    pub fn record_tool_call(&mut self, tool_name: &str) {
        self.tool_calls_made.push(tool_name.to_string());
    }

    pub fn check_pre_tool(
        &self,
        tool_name: &str,
        todos: &[TodoEntry],
        category: &AgentCategory,
    ) -> Option<String> {
        let ctx = PreToolContext {
            tool_name,
            todos,
            agent_category: category,
        };
        for h in &self.pre_heuristics {
            if let Some(reason) = h.check(&ctx) {
                return Some(reason);
            }
        }
        None
    }

    pub fn check_post_completion(
        &mut self,
        todos: Vec<TodoEntry>,
        pending_delegation_count: usize,
        triggering_message: String,
    ) -> PostCompletionOutcome {
        if self.total_reengagements >= ABSOLUTE_REENGAGEMENT_CAP {
            return PostCompletionOutcome::Accept;
        }

        let current_completed: HashSet<String> = todos
            .iter()
            .filter(|t| matches!(t.status, TodoStatus::Done | TodoStatus::Skipped))
            .map(|t| t.id.clone())
            .collect();
        let made_progress = current_completed
            .iter()
            .any(|id| !self.completed_todo_ids.contains(id));
        if made_progress {
            self.stuck_count = 0;
        }
        self.completed_todo_ids.extend(current_completed);

        let ctx = PostCompletionContext {
            todos: &todos,
            tool_calls_made: &self.tool_calls_made,
            nudged_about_todos: self.nudged_about_todos,
            pending_delegation_count,
            triggering_message: &triggering_message,
        };

        for h in &self.post_heuristics {
            let Some(detection) = h.check(&ctx) else {
                continue;
            };

            match detection.enforcement {
                EnforcementMode::OncePerExecution => {
                    if self.fired_once.contains(detection.heuristic_name) {
                        continue;
                    }
                    self.fired_once.insert(detection.heuristic_name.to_string());
                    self.nudged_about_todos = true;
                }
                EnforcementMode::RepeatUntilResolved => {
                    if !made_progress {
                        self.stuck_count += 1;
                    }
                    if self.stuck_count >= MAX_STUCK_ITERATIONS {
                        return PostCompletionOutcome::Accept;
                    }
                }
            }

            self.total_reengagements += 1;

            if detection.re_engage {
                return PostCompletionOutcome::ReEngage {
                    message: detection.message,
                };
            }
            return PostCompletionOutcome::InjectMessage {
                message: detection.message,
            };
        }

        PostCompletionOutcome::Accept
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::heuristic::PostCompletionHeuristic;
    use crate::types::Detection;

    /// Test-only heuristic that fires `RepeatUntilResolved` whenever any todo
    /// is still in a non-terminal state. Mirrors `PendingTodosHeuristic` but
    /// keeps supervisor tests decoupled from heuristic internals.
    struct AlwaysPendingTodos;

    impl PostCompletionHeuristic for AlwaysPendingTodos {
        fn name(&self) -> &'static str {
            "always-pending-todos"
        }

        fn check(&self, ctx: &PostCompletionContext<'_>) -> Option<Detection> {
            let has_active = ctx.todos.iter().any(|t| {
                matches!(t.status, TodoStatus::Pending | TodoStatus::InProgress)
            });
            if !has_active {
                return None;
            }
            Some(Detection {
                heuristic_name: "always-pending-todos",
                message: "keep going".to_string(),
                enforcement: EnforcementMode::RepeatUntilResolved,
                re_engage: true,
            })
        }
    }

    fn supervisor_with_pending_todos() -> Supervisor {
        Supervisor::new(vec![Box::new(AlwaysPendingTodos)], vec![])
    }

    fn todo(id: &str, status: TodoStatus) -> TodoEntry {
        TodoEntry {
            id: id.to_string(),
            status,
        }
    }

    fn assert_reengage(outcome: &PostCompletionOutcome) {
        assert!(
            matches!(outcome, PostCompletionOutcome::ReEngage { .. }),
            "expected ReEngage"
        );
    }

    fn assert_accept(outcome: &PostCompletionOutcome) {
        assert!(
            matches!(outcome, PostCompletionOutcome::Accept),
            "expected Accept"
        );
    }

    #[test]
    fn re_engages_indefinitely_while_todos_complete_one_per_turn() {
        let mut sup = supervisor_with_pending_todos();
        let ids: Vec<String> = (1..=10).map(|i| format!("t{i}")).collect();

        // Simulate: each turn marks one more todo Done and the rest stay Pending.
        // Reproduces the "10 colors, one per turn" pattern that previously hit
        // MAX_RETRIES=3 after only three iterations.
        for completed_through in 1..=10 {
            let todos: Vec<TodoEntry> = ids
                .iter()
                .enumerate()
                .map(|(idx, id)| {
                    let status = if idx < completed_through {
                        TodoStatus::Done
                    } else {
                        TodoStatus::Pending
                    };
                    todo(id, status)
                })
                .collect();
            let outcome = sup.check_post_completion(todos, 0, "do 10 things".to_string());
            if completed_through < 10 {
                assert_reengage(&outcome);
            } else {
                assert_accept(&outcome);
            }
        }
    }

    #[test]
    fn accepts_after_max_stuck_iterations_with_no_progress() {
        let mut sup = supervisor_with_pending_todos();
        let stuck_todos = || vec![todo("t1", TodoStatus::Pending)];

        // Three calls with identical state (no progress) → re-engages each time
        // up to the cap, then accepts.
        for _ in 0..MAX_STUCK_ITERATIONS - 1 {
            assert_reengage(&sup.check_post_completion(
                stuck_todos(),
                0,
                "do work".to_string(),
            ));
        }
        // The MAX_STUCK_ITERATIONS-th invocation hits the cap and accepts.
        assert_accept(&sup.check_post_completion(
            stuck_todos(),
            0,
            "do work".to_string(),
        ));
    }

    #[test]
    fn resets_stuck_count_when_progress_resumes() {
        let mut sup = supervisor_with_pending_todos();
        // Two no-progress iterations.
        for _ in 0..2 {
            assert_reengage(&sup.check_post_completion(
                vec![
                    todo("t1", TodoStatus::Pending),
                    todo("t2", TodoStatus::Pending),
                ],
                0,
                "do work".to_string(),
            ));
        }
        // Progress: t1 done. Stuck counter should reset.
        assert_reengage(&sup.check_post_completion(
            vec![
                todo("t1", TodoStatus::Done),
                todo("t2", TodoStatus::Pending),
            ],
            0,
            "do work".to_string(),
        ));
        // Two more no-progress iterations should still re-engage (counter reset).
        for _ in 0..2 {
            assert_reengage(&sup.check_post_completion(
                vec![
                    todo("t1", TodoStatus::Done),
                    todo("t2", TodoStatus::Pending),
                ],
                0,
                "do work".to_string(),
            ));
        }
    }

    #[test]
    fn skipped_todos_count_as_progress() {
        let mut sup = supervisor_with_pending_todos();
        for _ in 0..2 {
            assert_reengage(&sup.check_post_completion(
                vec![
                    todo("t1", TodoStatus::Pending),
                    todo("t2", TodoStatus::Pending),
                ],
                0,
                "do work".to_string(),
            ));
        }
        // Skipping a todo is real progress; stuck counter should reset.
        assert_reengage(&sup.check_post_completion(
            vec![
                todo("t1", TodoStatus::Skipped),
                todo("t2", TodoStatus::Pending),
            ],
            0,
            "do work".to_string(),
        ));
        // Now back to no-progress; we get one more re-engage before the cap.
        assert_reengage(&sup.check_post_completion(
            vec![
                todo("t1", TodoStatus::Skipped),
                todo("t2", TodoStatus::Pending),
            ],
            0,
            "do work".to_string(),
        ));
    }

    #[test]
    fn absolute_cap_terminates_pathological_loops() {
        let mut sup = supervisor_with_pending_todos();
        // Build a pathological pattern: each iteration completes a brand-new
        // todo while still leaving the same persistent one pending. This keeps
        // the stuck counter at 0 forever, but the absolute cap should fire.
        for i in 0..ABSOLUTE_REENGAGEMENT_CAP {
            let todos = vec![
                todo("persistent", TodoStatus::Pending),
                todo(&format!("ephemeral-{i}"), TodoStatus::Done),
            ];
            assert_reengage(&sup.check_post_completion(
                todos,
                0,
                "do work".to_string(),
            ));
        }
        let todos = vec![todo("persistent", TodoStatus::Pending)];
        assert_accept(&sup.check_post_completion(
            todos,
            0,
            "do work".to_string(),
        ));
    }
}
