use std::path::Path;
use thiserror::Error;

use crate::ral_lock::{
    RalLockError, RalLockHandle, RalLockInfo, ral_allocation_lock_path, ral_state_lock_path,
    release_ral_lock, try_acquire_ral_lock,
};
use crate::worker_lifecycle::launch::WorkerLaunchPlan;

#[derive(Debug, PartialEq, Eq)]
pub struct WorkerLaunchLocks {
    pub allocation: RalLockHandle,
    pub state: RalLockHandle,
}

#[derive(Debug, Error)]
pub enum WorkerLaunchLockError {
    #[error("worker launch lock error: {0}")]
    Lock(Box<RalLockError>),
    #[error("failed to release allocation lock after state lock acquisition failed")]
    AllocationRollbackFailed {
        state_error: Box<RalLockError>,
        release_error: Box<RalLockError>,
    },
}

pub type WorkerLaunchLockResult<T> = Result<T, WorkerLaunchLockError>;

impl From<RalLockError> for WorkerLaunchLockError {
    fn from(error: RalLockError) -> Self {
        Self::Lock(Box::new(error))
    }
}

pub fn acquire_worker_launch_locks(
    daemon_dir: impl AsRef<Path>,
    plan: &WorkerLaunchPlan,
    owner: &RalLockInfo,
) -> WorkerLaunchLockResult<WorkerLaunchLocks> {
    let daemon_dir = daemon_dir.as_ref();
    let allocation_path = ral_allocation_lock_path(daemon_dir, &plan.allocation_lock_scope)?;
    let state_path = ral_state_lock_path(daemon_dir, &plan.state_lock_scope)?;

    let allocation = try_acquire_ral_lock(&allocation_path, owner)?;
    let state = match try_acquire_ral_lock(&state_path, owner) {
        Ok(state) => state,
        Err(state_error) => {
            if let Err(release_error) = release_ral_lock(&allocation) {
                return Err(WorkerLaunchLockError::AllocationRollbackFailed {
                    state_error: Box::new(state_error),
                    release_error: Box::new(release_error),
                });
            }
            return Err(WorkerLaunchLockError::Lock(Box::new(state_error)));
        }
    };

    Ok(WorkerLaunchLocks { allocation, state })
}

pub fn release_worker_launch_locks(locks: WorkerLaunchLocks) -> WorkerLaunchLockResult<()> {
    let state_result = release_ral_lock(&locks.state);
    let allocation_result = release_ral_lock(&locks.allocation);

    state_result?;
    allocation_result?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ral_lock::{
        RalLockError, build_ral_lock_info, ral_allocation_lock_path, ral_state_lock_path,
        read_ral_lock_info,
    };
    use crate::worker_lifecycle::launch::{RalAllocationLockScope, RalStateLockScope, WorkerLaunchPlan};
    use serde_json::json;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn worker_launch_locks_acquire_and_release_all_scopes() {
        let daemon_dir = unique_temp_daemon_dir();
        let plan = launch_plan();
        let owner = build_ral_lock_info(100, "host-a", 1_000);

        let locks =
            acquire_worker_launch_locks(&daemon_dir, &plan, &owner).expect("locks must acquire");

        assert_eq!(
            read_ral_lock_info(&locks.allocation.path).expect("allocation lock read must succeed"),
            Some(owner.clone())
        );
        assert_eq!(
            read_ral_lock_info(&locks.state.path).expect("state lock read must succeed"),
            Some(owner)
        );

        release_worker_launch_locks(locks).expect("locks must release");
        assert_eq!(
            read_ral_lock_info(
                ral_allocation_lock_path(&daemon_dir, &plan.allocation_lock_scope)
                    .expect("allocation path must build")
            )
            .expect("allocation lock read must succeed"),
            None
        );
        assert_eq!(
            read_ral_lock_info(
                ral_state_lock_path(&daemon_dir, &plan.state_lock_scope)
                    .expect("state path must build")
            )
            .expect("state lock read must succeed"),
            None
        );

        std::fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn worker_launch_lock_acquisition_rolls_back_allocation_when_state_is_busy() {
        let daemon_dir = unique_temp_daemon_dir();
        let plan = launch_plan();
        let owner = build_ral_lock_info(100, "host-a", 1_000);
        let other_owner = build_ral_lock_info(200, "host-a", 1_000);
        let state_path =
            ral_state_lock_path(&daemon_dir, &plan.state_lock_scope).expect("state path builds");
        let busy_state =
            try_acquire_ral_lock(&state_path, &other_owner).expect("busy state lock acquired");

        let error = acquire_worker_launch_locks(&daemon_dir, &plan, &owner)
            .expect_err("state lock conflict must fail");

        match error {
            WorkerLaunchLockError::Lock(source) => {
                assert!(matches!(*source, RalLockError::AlreadyHeld { .. }));
            }
            other => panic!("expected state lock conflict, got {other:?}"),
        }
        assert_eq!(
            read_ral_lock_info(
                ral_allocation_lock_path(&daemon_dir, &plan.allocation_lock_scope)
                    .expect("allocation path must build")
            )
            .expect("allocation lock read must succeed"),
            None
        );
        assert_eq!(
            read_ral_lock_info(&state_path).expect("state lock read must succeed"),
            Some(other_owner)
        );

        release_ral_lock(&busy_state).expect("busy state release must succeed");
        std::fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

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
            execute_message: json!({ "type": "execute" }),
        }
    }

    fn unique_temp_daemon_dir() -> PathBuf {
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("tenex-worker-launch-lock-test-{nanos}-{counter}"))
    }
}
