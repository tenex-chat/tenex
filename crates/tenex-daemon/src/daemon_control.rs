use crate::daemon_shell::{
    DaemonLockState, DaemonShell, DaemonShellResult, DaemonShellSession, DaemonShellStopMode,
};
use crate::daemon_status::DaemonStatusSnapshot;
use crate::filesystem_state::RestartStateData;
use crate::process_liveness::ProcessLivenessProbe;
use serde::Serialize;

pub type DaemonControlResult<T> = DaemonShellResult<T>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonControlInspection {
    pub status_snapshot: DaemonStatusSnapshot,
    pub lock_state: DaemonLockState,
    pub restart_state_compatibility: DaemonRestartStateCompatibility,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum DaemonRestartStateCompatibility {
    Missing,
    Present { restart_state: RestartStateData },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum DaemonControlStartPlan {
    Allowed {
        lock_state: DaemonLockState,
    },
    Refused {
        lock_state: DaemonLockState,
        reason: DaemonControlStartRefusalReason,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum DaemonControlStartRefusalReason {
    BusyLock {
        owner: crate::filesystem_state::LockInfo,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum DaemonControlStopPlan {
    Allowed {
        lock_state: DaemonLockState,
        status_snapshot: DaemonStatusSnapshot,
    },
    Refused {
        lock_state: DaemonLockState,
        status_snapshot: DaemonStatusSnapshot,
        reason: DaemonControlStopRefusalReason,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DaemonControlStopRefusalReason {
    MissingLock,
    StaleLock,
}

pub fn inspect_daemon_status<P>(shell: &DaemonShell<P>) -> DaemonStatusSnapshot
where
    P: ProcessLivenessProbe + Clone,
{
    shell.status_snapshot()
}

pub fn inspect_daemon_control<P>(
    shell: &DaemonShell<P>,
) -> DaemonControlResult<DaemonControlInspection>
where
    P: ProcessLivenessProbe + Clone,
{
    Ok(DaemonControlInspection {
        status_snapshot: inspect_daemon_status(shell),
        lock_state: shell.inspect_lock()?,
        restart_state_compatibility: read_daemon_restart_state_compatibility(shell)?,
    })
}

pub fn plan_daemon_start(lock_state: &DaemonLockState) -> DaemonControlStartPlan {
    match lock_state {
        DaemonLockState::Missing | DaemonLockState::Stale { .. } => {
            DaemonControlStartPlan::Allowed {
                lock_state: lock_state.clone(),
            }
        }
        DaemonLockState::Busy { owner } => DaemonControlStartPlan::Refused {
            lock_state: lock_state.clone(),
            reason: DaemonControlStartRefusalReason::BusyLock {
                owner: owner.clone(),
            },
        },
    }
}

pub fn plan_daemon_stop(
    lock_state: &DaemonLockState,
    status_snapshot: &DaemonStatusSnapshot,
) -> DaemonControlStopPlan {
    match lock_state {
        DaemonLockState::Missing => DaemonControlStopPlan::Refused {
            lock_state: lock_state.clone(),
            status_snapshot: status_snapshot.clone(),
            reason: DaemonControlStopRefusalReason::MissingLock,
        },
        DaemonLockState::Stale { .. } => DaemonControlStopPlan::Refused {
            lock_state: lock_state.clone(),
            status_snapshot: status_snapshot.clone(),
            reason: DaemonControlStopRefusalReason::StaleLock,
        },
        DaemonLockState::Busy { .. } => DaemonControlStopPlan::Allowed {
            lock_state: lock_state.clone(),
            status_snapshot: status_snapshot.clone(),
        },
    }
}

pub fn read_daemon_restart_state_compatibility<P>(
    shell: &DaemonShell<P>,
) -> DaemonControlResult<DaemonRestartStateCompatibility>
where
    P: ProcessLivenessProbe + Clone,
{
    Ok(match shell.read_restart_state()? {
        Some(restart_state) => DaemonRestartStateCompatibility::Present { restart_state },
        None => DaemonRestartStateCompatibility::Missing,
    })
}

pub fn start_daemon_foreground<P>(
    shell: &DaemonShell<P>,
    started_at_ms: u64,
) -> DaemonShellResult<DaemonShellSession<P>>
where
    P: ProcessLivenessProbe + Clone,
{
    shell.start_foreground(started_at_ms)
}

pub fn stop_daemon_session<P>(
    session: DaemonShellSession<P>,
    mode: DaemonShellStopMode,
) -> DaemonShellResult<()>
where
    P: ProcessLivenessProbe + Clone,
{
    session.stop(mode)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon_shell::{DaemonLockState, DaemonShell};
    use crate::filesystem_state::{
        FilesystemStateFixture, restart_state_file_path, save_restart_state_file, status_file_path,
        write_lock_info_file, write_status_file,
    };
    use crate::ral_lock::RalLockOwnerProcessStatus;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEST_DIR_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[derive(Debug, Clone)]
    struct FixedProbe {
        status: RalLockOwnerProcessStatus,
    }

    impl ProcessLivenessProbe for FixedProbe {
        fn process_status(&self, _pid: u32) -> RalLockOwnerProcessStatus {
            self.status
        }
    }

    #[test]
    fn start_planning_allows_missing_and_stale_locks_and_refuses_busy_locks() {
        let missing_shell = shell(unique_temp_daemon_dir(), RalLockOwnerProcessStatus::Running);
        assert!(matches!(
            plan_daemon_start(
                &missing_shell
                    .inspect_lock()
                    .expect("missing lock inspection must succeed")
            ),
            DaemonControlStartPlan::Allowed { .. }
        ));

        let fixture = fixture();
        let stale_dir = unique_temp_daemon_dir();
        write_lock_info_file(&stale_dir, &fixture.stale_lockfile)
            .expect("stale lock write must succeed");
        let stale_shell = shell(stale_dir, RalLockOwnerProcessStatus::Missing);
        assert!(matches!(
            plan_daemon_start(
                &stale_shell
                    .inspect_lock()
                    .expect("stale lock inspection must succeed")
            ),
            DaemonControlStartPlan::Allowed { .. }
        ));

        let busy_dir = unique_temp_daemon_dir();
        write_lock_info_file(&busy_dir, &fixture.lockfile).expect("busy lock write must succeed");
        let busy_shell = shell(busy_dir, RalLockOwnerProcessStatus::Running);
        assert_eq!(
            plan_daemon_start(
                &busy_shell
                    .inspect_lock()
                    .expect("busy lock inspection must succeed")
            ),
            DaemonControlStartPlan::Refused {
                lock_state: DaemonLockState::Busy {
                    owner: fixture.lockfile.clone(),
                },
                reason: DaemonControlStartRefusalReason::BusyLock {
                    owner: fixture.lockfile,
                },
            }
        );
    }

    #[test]
    fn inspect_daemon_status_passthroughs_shell_snapshot() {
        let fixture = fixture();
        let daemon_dir = unique_temp_daemon_dir();
        write_lock_info_file(&daemon_dir, &fixture.lockfile).expect("lock write must succeed");
        write_status_file(&daemon_dir, &fixture.status).expect("status write must succeed");
        save_restart_state_file(&daemon_dir, &fixture.restart_state)
            .expect("restart state write must succeed");

        let shell = shell(daemon_dir, RalLockOwnerProcessStatus::Running);
        assert_eq!(inspect_daemon_status(&shell), shell.status_snapshot());
    }

    #[test]
    fn stop_planning_refuses_missing_and_stale_locks_and_allows_running_daemon() {
        let fixture = fixture();

        let missing_shell = shell(unique_temp_daemon_dir(), RalLockOwnerProcessStatus::Running);
        let missing_status = inspect_daemon_status(&missing_shell);
        assert_eq!(
            plan_daemon_stop(
                &missing_shell
                    .inspect_lock()
                    .expect("missing lock inspection must succeed"),
                &missing_status,
            ),
            DaemonControlStopPlan::Refused {
                lock_state: DaemonLockState::Missing,
                status_snapshot: missing_status,
                reason: DaemonControlStopRefusalReason::MissingLock,
            }
        );

        let stale_dir = unique_temp_daemon_dir();
        write_lock_info_file(&stale_dir, &fixture.stale_lockfile)
            .expect("stale lock write must succeed");
        let stale_shell = shell(stale_dir, RalLockOwnerProcessStatus::Missing);
        let stale_status = inspect_daemon_status(&stale_shell);
        assert_eq!(
            plan_daemon_stop(
                &stale_shell
                    .inspect_lock()
                    .expect("stale lock inspection must succeed"),
                &stale_status,
            ),
            DaemonControlStopPlan::Refused {
                lock_state: DaemonLockState::Stale {
                    owner: fixture.stale_lockfile.clone(),
                },
                status_snapshot: stale_status,
                reason: DaemonControlStopRefusalReason::StaleLock,
            }
        );

        let running_dir = unique_temp_daemon_dir();
        write_lock_info_file(&running_dir, &fixture.lockfile)
            .expect("running lock write must succeed");
        write_status_file(&running_dir, &fixture.status)
            .expect("running status write must succeed");
        let running_shell = shell(running_dir, RalLockOwnerProcessStatus::Running);
        let running_status = inspect_daemon_status(&running_shell);
        assert_eq!(
            plan_daemon_stop(
                &running_shell
                    .inspect_lock()
                    .expect("running lock inspection must succeed"),
                &running_status,
            ),
            DaemonControlStopPlan::Allowed {
                lock_state: DaemonLockState::Busy {
                    owner: fixture.lockfile,
                },
                status_snapshot: running_status,
            }
        );
    }

    #[test]
    fn restart_state_compatibility_reads_restart_state_without_mutation() {
        let fixture = fixture();
        let daemon_dir = unique_temp_daemon_dir();
        save_restart_state_file(&daemon_dir, &fixture.restart_state)
            .expect("restart state write must succeed");
        let shell = shell(daemon_dir.clone(), RalLockOwnerProcessStatus::Running);
        let restart_path = restart_state_file_path(&daemon_dir);
        let before = fs::read(&restart_path).expect("restart state read must succeed");

        assert_eq!(
            read_daemon_restart_state_compatibility(&shell)
                .expect("restart state compatibility must read"),
            DaemonRestartStateCompatibility::Present {
                restart_state: fixture.restart_state
            }
        );
        assert_eq!(
            fs::read(&restart_path).expect("restart state must remain untouched"),
            before
        );
    }

    #[test]
    fn pure_planning_functions_do_not_mutate_files() {
        let fixture = fixture();
        let daemon_dir = unique_temp_daemon_dir();
        write_lock_info_file(&daemon_dir, &fixture.lockfile).expect("lock write must succeed");
        write_status_file(&daemon_dir, &fixture.status).expect("status write must succeed");
        save_restart_state_file(&daemon_dir, &fixture.restart_state)
            .expect("restart state write must succeed");

        let shell = shell(daemon_dir.clone(), RalLockOwnerProcessStatus::Running);
        let lock_state = shell.inspect_lock().expect("lock inspection must succeed");
        let status_snapshot = shell.status_snapshot();

        let lock_path = daemon_dir.join("tenex.lock");
        let status_path = status_file_path(&daemon_dir);
        let restart_path = restart_state_file_path(&daemon_dir);
        let lock_before = fs::read(&lock_path).expect("lock read must succeed");
        let status_before = fs::read(&status_path).expect("status read must succeed");
        let restart_before = fs::read(&restart_path).expect("restart state read must succeed");

        let _ = plan_daemon_start(&lock_state);
        let _ = plan_daemon_stop(&lock_state, &status_snapshot);

        assert_eq!(
            fs::read(&lock_path).expect("lock must remain untouched"),
            lock_before
        );
        assert_eq!(
            fs::read(&status_path).expect("status must remain untouched"),
            status_before
        );
        assert_eq!(
            fs::read(&restart_path).expect("restart state must remain untouched"),
            restart_before
        );
    }

    fn fixture() -> FilesystemStateFixture {
        serde_json::from_str(include_str!(
            "../../../src/test-utils/fixtures/daemon/filesystem-state.compat.json"
        ))
        .expect("fixture must parse")
    }

    fn shell(daemon_dir: PathBuf, status: RalLockOwnerProcessStatus) -> DaemonShell<FixedProbe> {
        DaemonShell::with_identity(daemon_dir, FixedProbe { status }, 4242, "tenex-host")
    }

    fn unique_temp_daemon_dir() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be after UNIX_EPOCH")
            .as_nanos();
        let counter = TEST_DIR_COUNTER.fetch_add(1, Ordering::Relaxed);
        let daemon_dir = std::env::temp_dir().join(format!(
            "tenex-daemon-control-test-{}-{unique}-{counter}",
            std::process::id()
        ));
        fs::create_dir_all(&daemon_dir).expect("temp daemon dir creation must succeed");
        daemon_dir
    }
}
