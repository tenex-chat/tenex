use serde_json::Value;

use crate::worker_lifecycle::launch::WorkerLaunchPlan;
use crate::worker_process::AgentWorkerCommand;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerDispatchSpawnPlan {
    pub command: AgentWorkerCommand,
    pub execute_message: Value,
}

pub fn plan_worker_dispatch_spawn(
    launch: &WorkerLaunchPlan,
    command: AgentWorkerCommand,
) -> WorkerDispatchSpawnPlan {
    WorkerDispatchSpawnPlan {
        command,
        execute_message: launch.execute_message.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worker_lifecycle::launch::{RalAllocationLockScope, RalStateLockScope};
    use crate::worker_process::bun_agent_worker_command;
    use serde_json::json;
    use std::path::{Path, PathBuf};

    fn launch_plan() -> WorkerLaunchPlan {
        WorkerLaunchPlan {
            allocation_lock_scope: RalAllocationLockScope {
                project_id: "project-a".to_string(),
                agent_pubkey: "a".repeat(64),
                conversation_id: "conversation-a".to_string(),
            },
            state_lock_scope: RalStateLockScope {
                project_id: "project-a".to_string(),
                agent_pubkey: "a".repeat(64),
                conversation_id: "conversation-a".to_string(),
                ral_number: 1,
            },
            execute_message: json!({
                "version": 1,
                "type": "execute",
                "correlationId": "correlation-a",
            }),
        }
    }

    #[test]
    fn worker_dispatch_spawn_plan_preserves_command_and_execute_message() {
        let launch = launch_plan();
        let command = AgentWorkerCommand::new("bun")
            .arg("run")
            .arg("src/agents/execution/worker/agent-worker.ts")
            .current_dir("/repo")
            .env("TENEX_AGENT_WORKER_ENGINE", "agent");

        let plan = plan_worker_dispatch_spawn(&launch, command.clone());

        assert_eq!(plan.command, command);
        assert_eq!(plan.execute_message, launch.execute_message);
    }

    #[test]
    fn worker_dispatch_spawn_plan_accepts_bun_worker_command_without_spawning() {
        let launch = launch_plan();
        let command = bun_agent_worker_command(Path::new("/repo"), "bun");

        let plan = plan_worker_dispatch_spawn(&launch, command);

        assert_eq!(plan.command.program, PathBuf::from("bun"));
        assert_eq!(
            plan.command.args,
            vec![
                "run".to_string(),
                "src/agents/execution/worker/agent-worker.ts".to_string()
            ]
        );
        assert_eq!(plan.command.current_dir, Some(PathBuf::from("/repo")));
        assert_eq!(plan.execute_message, launch.execute_message);
    }
}
