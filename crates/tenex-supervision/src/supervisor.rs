use crate::heuristic::{PostCompletionHeuristic, PreToolHeuristic};
use crate::types::{AgentCategory, EnforcementMode, PostCompletionContext, PreToolContext, TodoEntry};
use std::collections::HashSet;

const MAX_RETRIES: u32 = 3;

pub enum PostCompletionOutcome {
    Accept,
    ReEngage { message: String },
}

pub struct Supervisor {
    post_heuristics: Vec<Box<dyn PostCompletionHeuristic>>,
    pre_heuristics: Vec<Box<dyn PreToolHeuristic>>,
    pub tool_calls_made: Vec<String>,
    pub nudged_about_todos: bool,
    fired_once: HashSet<String>,
    retry_count: u32,
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
            retry_count: 0,
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
        let ctx = PreToolContext { tool_name, todos, agent_category: category };
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
        if self.retry_count >= MAX_RETRIES {
            return PostCompletionOutcome::Accept;
        }

        let ctx = PostCompletionContext {
            todos,
            tool_calls_made: self.tool_calls_made.clone(),
            nudged_about_todos: self.nudged_about_todos,
            pending_delegation_count,
            triggering_message,
        };

        for h in &self.post_heuristics {
            let detection = match h.check(&ctx) {
                Some(d) => d,
                None => continue,
            };

            if detection.enforcement == EnforcementMode::OncePerExecution {
                if self.fired_once.contains(detection.heuristic_name) {
                    continue;
                }
                self.fired_once.insert(detection.heuristic_name.to_string());
                self.nudged_about_todos = true;
            }

            self.retry_count += 1;

            if detection.re_engage {
                return PostCompletionOutcome::ReEngage { message: detection.message };
            }
            return PostCompletionOutcome::Accept;
        }

        PostCompletionOutcome::Accept
    }
}
