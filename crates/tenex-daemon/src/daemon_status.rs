use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::filesystem_state::{
    DaemonStatusData, LockInfo, RestartStateData, read_lock_info_file, read_restart_state_file,
    read_status_file,
};
use crate::process_liveness::ProcessLivenessProbe;
use crate::ral_lock::RalLockOwnerProcessStatus;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DaemonPresence {
    MissingLock,
    Stale,
    Running,
    UnreadableOrCorrupt,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonStatusSnapshot {
    pub presence: DaemonPresence,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lockfile: Option<LockInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<DaemonStatusData>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restart_state: Option<RestartStateData>,
}

pub fn classify_daemon_presence(
    lockfile: &LockInfo,
    probe: &impl ProcessLivenessProbe,
) -> DaemonPresence {
    match probe.process_status(lockfile.pid) {
        RalLockOwnerProcessStatus::Missing => DaemonPresence::Stale,
        RalLockOwnerProcessStatus::Running | RalLockOwnerProcessStatus::Unknown => {
            DaemonPresence::Running
        }
    }
}

pub fn read_daemon_status_snapshot(
    daemon_dir: impl AsRef<Path>,
    probe: &impl ProcessLivenessProbe,
) -> DaemonStatusSnapshot {
    let daemon_dir = daemon_dir.as_ref();

    let Ok(lockfile) = read_lock_info_file(daemon_dir) else {
        return unreadable_snapshot(None, None, None);
    };

    let Some(lockfile) = lockfile else {
        return missing_lock_snapshot();
    };

    let presence = classify_daemon_presence(&lockfile, probe);
    if presence == DaemonPresence::Stale {
        return DaemonStatusSnapshot {
            presence,
            lockfile: Some(lockfile),
            status: None,
            restart_state: None,
        };
    }

    let status = match read_status_file(daemon_dir) {
        Ok(status) => status,
        Err(_) => return unreadable_snapshot(Some(lockfile), None, None),
    };
    let restart_state = match read_restart_state_file(daemon_dir) {
        Ok(restart_state) => restart_state,
        Err(_) => return unreadable_snapshot(Some(lockfile), status, None),
    };

    DaemonStatusSnapshot {
        presence,
        lockfile: Some(lockfile),
        status,
        restart_state,
    }
}

fn missing_lock_snapshot() -> DaemonStatusSnapshot {
    DaemonStatusSnapshot {
        presence: DaemonPresence::MissingLock,
        lockfile: None,
        status: None,
        restart_state: None,
    }
}

fn unreadable_snapshot(
    lockfile: Option<LockInfo>,
    status: Option<DaemonStatusData>,
    restart_state: Option<RestartStateData>,
) -> DaemonStatusSnapshot {
    DaemonStatusSnapshot {
        presence: DaemonPresence::UnreadableOrCorrupt,
        lockfile,
        status,
        restart_state,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::filesystem_state::{
        FilesystemStateFixture, build_lock_info, save_restart_state_file, status_file_path,
        write_lock_info_file, write_status_file,
    };
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    const FILESYSTEM_STATE_FIXTURE: &str =
        include_str!("../../../src/test-utils/fixtures/daemon/filesystem-state.compat.json");
    static TEST_DIR_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[derive(Debug)]
    struct FixedProbe {
        status: RalLockOwnerProcessStatus,
    }

    impl ProcessLivenessProbe for FixedProbe {
        fn process_status(&self, _pid: u32) -> RalLockOwnerProcessStatus {
            self.status
        }
    }

    #[test]
    fn classifies_missing_lock_as_missing_lock() {
        let daemon_dir = unique_temp_daemon_dir();

        let snapshot = read_daemon_status_snapshot(
            &daemon_dir,
            &FixedProbe {
                status: RalLockOwnerProcessStatus::Running,
            },
        );

        assert_eq!(snapshot.presence, DaemonPresence::MissingLock);
        assert_eq!(snapshot.lockfile, None);
        assert_eq!(snapshot.status, None);
        assert_eq!(snapshot.restart_state, None);

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn classifies_live_lock_as_running_and_reads_related_state() {
        let fixture: FilesystemStateFixture =
            serde_json::from_str(FILESYSTEM_STATE_FIXTURE).expect("fixture must parse");
        let daemon_dir = unique_temp_daemon_dir();

        write_lock_info_file(&daemon_dir, &fixture.lockfile).expect("lockfile write must succeed");
        write_status_file(&daemon_dir, &fixture.status).expect("status write must succeed");
        save_restart_state_file(&daemon_dir, &fixture.restart_state)
            .expect("restart state write must succeed");

        let snapshot = read_daemon_status_snapshot(
            &daemon_dir,
            &FixedProbe {
                status: RalLockOwnerProcessStatus::Running,
            },
        );

        assert_eq!(snapshot.presence, DaemonPresence::Running);
        assert_eq!(
            snapshot.lockfile,
            Some(build_lock_info(4242, "tenex-host", 1_710_000_000_000))
        );
        assert_eq!(snapshot.status, Some(fixture.status));
        assert_eq!(snapshot.restart_state, Some(fixture.restart_state));

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn classifies_missing_process_as_stale_and_skips_status_reads() {
        let fixture: FilesystemStateFixture =
            serde_json::from_str(FILESYSTEM_STATE_FIXTURE).expect("fixture must parse");
        let daemon_dir = unique_temp_daemon_dir();

        write_lock_info_file(&daemon_dir, &fixture.lockfile).expect("lockfile write must succeed");
        write_status_file(&daemon_dir, &fixture.status).expect("status write must succeed");

        let snapshot = read_daemon_status_snapshot(
            &daemon_dir,
            &FixedProbe {
                status: RalLockOwnerProcessStatus::Missing,
            },
        );

        assert_eq!(snapshot.presence, DaemonPresence::Stale);
        assert_eq!(snapshot.lockfile, Some(fixture.lockfile));
        assert_eq!(snapshot.status, None);
        assert_eq!(snapshot.restart_state, None);

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn treats_unknown_liveness_as_running() {
        let fixture: FilesystemStateFixture =
            serde_json::from_str(FILESYSTEM_STATE_FIXTURE).expect("fixture must parse");
        let daemon_dir = unique_temp_daemon_dir();

        write_lock_info_file(&daemon_dir, &fixture.lockfile).expect("lockfile write must succeed");

        let snapshot = read_daemon_status_snapshot(
            &daemon_dir,
            &FixedProbe {
                status: RalLockOwnerProcessStatus::Unknown,
            },
        );

        assert_eq!(snapshot.presence, DaemonPresence::Running);
        assert_eq!(snapshot.lockfile, Some(fixture.lockfile));

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn fails_closed_on_corrupt_status_files() {
        let fixture: FilesystemStateFixture =
            serde_json::from_str(FILESYSTEM_STATE_FIXTURE).expect("fixture must parse");
        let daemon_dir = unique_temp_daemon_dir();

        write_lock_info_file(&daemon_dir, &fixture.lockfile).expect("lockfile write must succeed");
        fs::write(status_file_path(&daemon_dir), "{").expect("corrupt status write must succeed");

        let snapshot = read_daemon_status_snapshot(
            &daemon_dir,
            &FixedProbe {
                status: RalLockOwnerProcessStatus::Running,
            },
        );

        assert_eq!(snapshot.presence, DaemonPresence::UnreadableOrCorrupt);
        assert_eq!(snapshot.lockfile, Some(fixture.lockfile));
        assert_eq!(snapshot.status, None);
        assert_eq!(snapshot.restart_state, None);

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    fn unique_temp_daemon_dir() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be after UNIX_EPOCH")
            .as_nanos();
        let counter = TEST_DIR_COUNTER.fetch_add(1, Ordering::Relaxed);
        let daemon_dir = std::env::temp_dir().join(format!(
            "tenex-daemon-status-test-{}-{unique}-{counter}",
            std::process::id()
        ));
        fs::create_dir_all(&daemon_dir).expect("temp daemon dir must be created");
        daemon_dir
    }
}
