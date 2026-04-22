use crate::ral_lock::{RalLockInfo, RalLockOwnerProcessStatus, RalLockStatus, classify_ral_lock};

pub trait ProcessLivenessProbe {
    fn process_status(&self, pid: u32) -> RalLockOwnerProcessStatus;
}

#[derive(Debug, Clone, Copy, Default)]
pub struct OsProcessLivenessProbe;

impl ProcessLivenessProbe for OsProcessLivenessProbe {
    fn process_status(&self, pid: u32) -> RalLockOwnerProcessStatus {
        owner_process_status(pid)
    }
}

pub fn owner_process_status(pid: u32) -> RalLockOwnerProcessStatus {
    os_process_status(pid)
}

pub fn classify_ral_lock_with_process_probe(
    existing: Option<&RalLockInfo>,
    requester: &RalLockInfo,
    probe: &impl ProcessLivenessProbe,
) -> RalLockStatus {
    let owner_process_status = existing
        .map(|owner| probe.process_status(owner.pid))
        .unwrap_or(RalLockOwnerProcessStatus::Unknown);
    classify_ral_lock(existing, requester, owner_process_status)
}

#[cfg(target_family = "unix")]
fn os_process_status(pid: u32) -> RalLockOwnerProcessStatus {
    if pid == 0 {
        return RalLockOwnerProcessStatus::Unknown;
    }

    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return RalLockOwnerProcessStatus::Unknown;
    };

    let result = unsafe { libc::kill(pid, 0) };
    process_status_from_unix_kill_result(result, std::io::Error::last_os_error().raw_os_error())
}

#[cfg(target_family = "unix")]
fn process_status_from_unix_kill_result(
    result: i32,
    raw_os_error: Option<i32>,
) -> RalLockOwnerProcessStatus {
    if result == 0 {
        return RalLockOwnerProcessStatus::Running;
    }

    match raw_os_error {
        Some(code) if code == libc::ESRCH => RalLockOwnerProcessStatus::Missing,
        Some(code) if code == libc::EPERM => RalLockOwnerProcessStatus::Running,
        _ => RalLockOwnerProcessStatus::Unknown,
    }
}

#[cfg(not(target_family = "unix"))]
fn os_process_status(_pid: u32) -> RalLockOwnerProcessStatus {
    RalLockOwnerProcessStatus::Unknown
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ral_lock::{RalLockStatus, build_ral_lock_info};

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
    fn process_probe_classification_delegates_to_lock_policy() {
        let requester = build_ral_lock_info(100, "host-a", 1_000);
        let owner = build_ral_lock_info(200, "host-a", 1_500);

        assert_eq!(
            classify_ral_lock_with_process_probe(
                Some(&owner),
                &requester,
                &FixedProbe {
                    status: RalLockOwnerProcessStatus::Running,
                }
            ),
            RalLockStatus::Busy {
                owner: owner.clone()
            }
        );
        assert_eq!(
            classify_ral_lock_with_process_probe(
                Some(&owner),
                &requester,
                &FixedProbe {
                    status: RalLockOwnerProcessStatus::Missing,
                }
            ),
            RalLockStatus::Stale {
                owner: owner.clone()
            }
        );
        assert_eq!(
            classify_ral_lock_with_process_probe(
                Some(&owner),
                &requester,
                &FixedProbe {
                    status: RalLockOwnerProcessStatus::Unknown,
                }
            ),
            RalLockStatus::Busy { owner }
        );
    }

    #[test]
    fn os_probe_reports_current_process_running_and_zero_unknown() {
        let probe = OsProcessLivenessProbe;

        assert_eq!(
            probe.process_status(std::process::id()),
            RalLockOwnerProcessStatus::Running
        );
        assert_eq!(probe.process_status(0), RalLockOwnerProcessStatus::Unknown);
    }

    #[cfg(target_family = "unix")]
    #[test]
    fn unix_kill_result_mapping_matches_node_lockfile_semantics() {
        assert_eq!(
            process_status_from_unix_kill_result(0, None),
            RalLockOwnerProcessStatus::Running
        );
        assert_eq!(
            process_status_from_unix_kill_result(-1, Some(libc::ESRCH)),
            RalLockOwnerProcessStatus::Missing
        );
        assert_eq!(
            process_status_from_unix_kill_result(-1, Some(libc::EPERM)),
            RalLockOwnerProcessStatus::Running
        );
        assert_eq!(
            process_status_from_unix_kill_result(-1, Some(libc::EINVAL)),
            RalLockOwnerProcessStatus::Unknown
        );
        assert_eq!(
            process_status_from_unix_kill_result(-1, None),
            RalLockOwnerProcessStatus::Unknown
        );
    }
}
