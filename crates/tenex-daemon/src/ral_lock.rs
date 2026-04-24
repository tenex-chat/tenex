use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use thiserror::Error;

use crate::filesystem_state::{LockInfo, build_lock_info};
use crate::ral_journal::ral_dir;
use crate::worker_lifecycle::launch::{RalAllocationLockScope, RalStateLockScope};

pub const RAL_LOCKS_DIR_NAME: &str = "locks";
pub const RAL_ALLOCATION_LOCK_PREFIX: &str = "alloc";
pub const RAL_STATE_LOCK_PREFIX: &str = "state";
pub const RAL_LOCK_EXTENSION: &str = "lock";

pub type RalLockInfo = LockInfo;

#[derive(Debug, Error)]
pub enum RalLockError {
    #[error("RAL lock io error: {0}")]
    Io(#[from] io::Error),
    #[error("RAL lock json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("RAL lock segment {field} cannot be empty")]
    EmptySegment { field: &'static str },
    #[error("RAL lock segment {field} contains a path separator")]
    InvalidSegment { field: &'static str },
    #[error("RAL state lock ral number cannot be zero")]
    InvalidRalNumber,
    #[error("RAL lock is already held at {path}")]
    AlreadyHeld {
        path: PathBuf,
        owner: Option<RalLockInfo>,
    },
    #[error("RAL lock is not held at {path}")]
    NotHeld { path: PathBuf },
    #[error("RAL lock owner mismatch at {path}")]
    OwnerMismatch {
        path: PathBuf,
        owner: Option<RalLockInfo>,
    },
}

pub type RalLockResult<T> = Result<T, RalLockError>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RalLockHandle {
    pub path: PathBuf,
    pub owner: RalLockInfo,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RalLockOwnerProcessStatus {
    Running,
    Missing,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RalLockStatus {
    Missing,
    Owned,
    Busy { owner: RalLockInfo },
    Stale { owner: RalLockInfo },
}

pub fn ral_locks_dir(daemon_dir: impl AsRef<Path>) -> PathBuf {
    ral_dir(daemon_dir).join(RAL_LOCKS_DIR_NAME)
}

pub fn build_ral_lock_info(pid: u32, hostname: impl Into<String>, started_at: u64) -> RalLockInfo {
    build_lock_info(pid, hostname, started_at)
}

pub fn ral_allocation_lock_file_name(scope: &RalAllocationLockScope) -> RalLockResult<String> {
    Ok(format!(
        "{RAL_ALLOCATION_LOCK_PREFIX}.{}.{}.{}.{RAL_LOCK_EXTENSION}",
        validate_lock_segment("projectId", &scope.project_id)?,
        validate_lock_segment("agentPubkey", &scope.agent_pubkey)?,
        validate_lock_segment("conversationId", &scope.conversation_id)?,
    ))
}

pub fn ral_state_lock_file_name(scope: &RalStateLockScope) -> RalLockResult<String> {
    if scope.ral_number == 0 {
        return Err(RalLockError::InvalidRalNumber);
    }

    Ok(format!(
        "{RAL_STATE_LOCK_PREFIX}.{}.{}.{}.{}.{RAL_LOCK_EXTENSION}",
        validate_lock_segment("projectId", &scope.project_id)?,
        validate_lock_segment("agentPubkey", &scope.agent_pubkey)?,
        validate_lock_segment("conversationId", &scope.conversation_id)?,
        scope.ral_number,
    ))
}

pub fn ral_allocation_lock_path(
    daemon_dir: impl AsRef<Path>,
    scope: &RalAllocationLockScope,
) -> RalLockResult<PathBuf> {
    Ok(ral_locks_dir(daemon_dir).join(ral_allocation_lock_file_name(scope)?))
}

pub fn ral_state_lock_path(
    daemon_dir: impl AsRef<Path>,
    scope: &RalStateLockScope,
) -> RalLockResult<PathBuf> {
    Ok(ral_locks_dir(daemon_dir).join(ral_state_lock_file_name(scope)?))
}

pub fn read_ral_lock_info(path: impl AsRef<Path>) -> RalLockResult<Option<RalLockInfo>> {
    match fs::read_to_string(path.as_ref()) {
        Ok(content) => Ok(Some(serde_json::from_str(&content)?)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub fn classify_ral_lock(
    existing: Option<&RalLockInfo>,
    requester: &RalLockInfo,
    owner_process_status: RalLockOwnerProcessStatus,
) -> RalLockStatus {
    let Some(owner) = existing else {
        return RalLockStatus::Missing;
    };

    if same_lock_owner(owner, requester) {
        return RalLockStatus::Owned;
    }

    if owner_process_status == RalLockOwnerProcessStatus::Missing {
        return RalLockStatus::Stale {
            owner: owner.clone(),
        };
    }

    RalLockStatus::Busy {
        owner: owner.clone(),
    }
}

pub fn try_acquire_ral_lock(
    path: impl AsRef<Path>,
    owner: &RalLockInfo,
) -> RalLockResult<RalLockHandle> {
    let path = path.as_ref();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(mut file) => {
            serde_json::to_writer_pretty(&mut file, owner)?;
            file.write_all(b"\n")?;
            file.sync_all()?;
            sync_parent_dir(path)?;
            Ok(RalLockHandle {
                path: path.to_path_buf(),
                owner: owner.clone(),
            })
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            Err(RalLockError::AlreadyHeld {
                path: path.to_path_buf(),
                owner: read_ral_lock_info(path)?,
            })
        }
        Err(error) => Err(error.into()),
    }
}

pub fn replace_stale_ral_lock(
    path: impl AsRef<Path>,
    stale_owner: &RalLockInfo,
    new_owner: &RalLockInfo,
) -> RalLockResult<RalLockHandle> {
    let path = path.as_ref();
    let current_owner = current_owner_or_error(path)?;
    if !same_lock_owner(&current_owner, stale_owner) {
        return Err(RalLockError::OwnerMismatch {
            path: path.to_path_buf(),
            owner: Some(current_owner),
        });
    }

    fs::remove_file(path)?;
    sync_parent_dir(path)?;
    try_acquire_ral_lock(path, new_owner)
}

pub fn release_ral_lock(handle: &RalLockHandle) -> RalLockResult<()> {
    let owner = current_owner_or_error(&handle.path)?;
    if !same_lock_owner(&owner, &handle.owner) {
        return Err(RalLockError::OwnerMismatch {
            path: handle.path.clone(),
            owner: Some(owner),
        });
    }

    fs::remove_file(&handle.path)?;
    sync_parent_dir(&handle.path)?;
    Ok(())
}

fn current_owner_or_error(path: &Path) -> RalLockResult<RalLockInfo> {
    read_ral_lock_info(path)?.ok_or_else(|| RalLockError::NotHeld {
        path: path.to_path_buf(),
    })
}

fn same_lock_owner(left: &RalLockInfo, right: &RalLockInfo) -> bool {
    left.pid == right.pid && left.hostname == right.hostname && left.started_at == right.started_at
}

fn validate_lock_segment<'a>(field: &'static str, value: &'a str) -> RalLockResult<&'a str> {
    if value.is_empty() {
        return Err(RalLockError::EmptySegment { field });
    }
    if value.contains('/') || value.contains('\\') {
        return Err(RalLockError::InvalidSegment { field });
    }
    Ok(value)
}

fn sync_parent_dir(path: &Path) -> RalLockResult<()> {
    if let Some(parent) = path.parent() {
        File::open(parent)?.sync_all()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn ral_lock_paths_match_documented_layout() {
        let daemon_dir = Path::new("/var/lib/tenex").join("daemon");
        let allocation_scope = RalAllocationLockScope {
            project_id: "project-alpha".to_string(),
            agent_pubkey: "a".repeat(64),
            conversation_id: "conversation-alpha".to_string(),
        };
        let state_scope = RalStateLockScope {
            project_id: allocation_scope.project_id.clone(),
            agent_pubkey: allocation_scope.agent_pubkey.clone(),
            conversation_id: allocation_scope.conversation_id.clone(),
            ral_number: 7,
        };

        assert_eq!(
            ral_allocation_lock_file_name(&allocation_scope).expect("file name must build"),
            format!(
                "alloc.project-alpha.{}.conversation-alpha.lock",
                "a".repeat(64)
            )
        );
        assert_eq!(
            ral_state_lock_file_name(&state_scope).expect("file name must build"),
            format!(
                "state.project-alpha.{}.conversation-alpha.7.lock",
                "a".repeat(64)
            )
        );
        assert_eq!(
            ral_allocation_lock_path(&daemon_dir, &allocation_scope).expect("path must build"),
            daemon_dir.join("ral").join("locks").join(format!(
                "alloc.project-alpha.{}.conversation-alpha.lock",
                "a".repeat(64)
            ))
        );
    }

    #[test]
    fn ral_lock_paths_reject_invalid_segments_and_zero_ral_number() {
        let empty_scope = RalAllocationLockScope {
            project_id: String::new(),
            agent_pubkey: "a".repeat(64),
            conversation_id: "conversation-a".to_string(),
        };
        assert!(matches!(
            ral_allocation_lock_file_name(&empty_scope),
            Err(RalLockError::EmptySegment { field: "projectId" })
        ));

        let separator_scope = RalAllocationLockScope {
            project_id: "project/a".to_string(),
            agent_pubkey: "a".repeat(64),
            conversation_id: "conversation-a".to_string(),
        };
        assert!(matches!(
            ral_allocation_lock_file_name(&separator_scope),
            Err(RalLockError::InvalidSegment { field: "projectId" })
        ));

        let state_scope = RalStateLockScope {
            project_id: "project-a".to_string(),
            agent_pubkey: "a".repeat(64),
            conversation_id: "conversation-a".to_string(),
            ral_number: 0,
        };
        assert!(matches!(
            ral_state_lock_file_name(&state_scope),
            Err(RalLockError::InvalidRalNumber)
        ));
    }

    #[test]
    fn ral_lock_info_reuses_daemon_lock_shape() {
        let lock_info = build_ral_lock_info(100, "host-a", 1_000);

        assert_eq!(lock_info, build_lock_info(100, "host-a", 1_000));
        assert_eq!(
            serde_json::to_value(&lock_info).expect("lock info must serialize"),
            serde_json::json!({
                "pid": 100,
                "hostname": "host-a",
                "startedAt": 1_000,
            })
        );
    }

    #[test]
    fn ral_lock_classification_uses_explicit_process_liveness() {
        let requester = build_ral_lock_info(100, "host-a", 1_000);
        let other_owner = build_ral_lock_info(200, "host-a", 1_500);

        assert_eq!(
            classify_ral_lock(None, &requester, RalLockOwnerProcessStatus::Running),
            RalLockStatus::Missing
        );
        assert_eq!(
            classify_ral_lock(
                Some(&requester),
                &requester,
                RalLockOwnerProcessStatus::Running
            ),
            RalLockStatus::Owned
        );
        assert_eq!(
            classify_ral_lock(
                Some(&other_owner),
                &requester,
                RalLockOwnerProcessStatus::Running
            ),
            RalLockStatus::Busy {
                owner: other_owner.clone()
            }
        );
        assert_eq!(
            classify_ral_lock(
                Some(&other_owner),
                &requester,
                RalLockOwnerProcessStatus::Unknown
            ),
            RalLockStatus::Busy {
                owner: other_owner.clone()
            }
        );
        assert_eq!(
            classify_ral_lock(
                Some(&other_owner),
                &requester,
                RalLockOwnerProcessStatus::Missing
            ),
            RalLockStatus::Stale { owner: other_owner }
        );
    }

    #[test]
    fn ral_lock_acquire_and_release_round_trip() {
        let daemon_dir = unique_temp_daemon_dir();
        let path = allocation_lock_path(&daemon_dir);
        let owner = build_ral_lock_info(100, "host-a", 1_000);

        let handle = try_acquire_ral_lock(&path, &owner).expect("lock must acquire");
        assert_eq!(
            read_ral_lock_info(&path).expect("lock read must succeed"),
            Some(owner.clone())
        );

        let duplicate = try_acquire_ral_lock(&path, &owner).expect_err("duplicate must fail");
        assert!(matches!(
            duplicate,
            RalLockError::AlreadyHeld { owner: Some(_), .. }
        ));

        release_ral_lock(&handle).expect("release must succeed");
        assert_eq!(
            read_ral_lock_info(&path).expect("lock read must succeed"),
            None
        );

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn ral_lock_stale_replacement_is_owner_checked() {
        let daemon_dir = unique_temp_daemon_dir();
        let path = allocation_lock_path(&daemon_dir);
        let stale_owner = build_ral_lock_info(100, "host-a", 1_000);
        let new_owner = build_ral_lock_info(200, "host-a", 2_000);

        let stale_handle = try_acquire_ral_lock(&path, &stale_owner).expect("lock must acquire");
        let new_handle = replace_stale_ral_lock(&path, &stale_owner, &new_owner)
            .expect("stale replacement must acquire");

        assert_eq!(
            read_ral_lock_info(&path).expect("lock read must succeed"),
            Some(new_owner.clone())
        );
        assert!(matches!(
            release_ral_lock(&stale_handle),
            Err(RalLockError::OwnerMismatch { owner: Some(_), .. })
        ));
        release_ral_lock(&new_handle).expect("new owner release must succeed");

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn ral_lock_corrupt_file_fails_closed() {
        let daemon_dir = unique_temp_daemon_dir();
        let path = allocation_lock_path(&daemon_dir);
        fs::create_dir_all(path.parent().expect("lock path must have parent"))
            .expect("lock dir must be created");
        fs::write(&path, "{not-json").expect("corrupt lock write must succeed");

        assert!(matches!(
            read_ral_lock_info(&path),
            Err(RalLockError::Json(_))
        ));
        assert!(matches!(
            try_acquire_ral_lock(&path, &build_ral_lock_info(100, "host-a", 1_000)),
            Err(RalLockError::Json(_))
        ));

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn ral_lock_release_rejects_owner_mismatch() {
        let daemon_dir = unique_temp_daemon_dir();
        let path = allocation_lock_path(&daemon_dir);
        let owner = build_ral_lock_info(100, "host-a", 1_000);
        let other_owner = build_ral_lock_info(200, "host-a", 1_000);

        let handle = try_acquire_ral_lock(&path, &owner).expect("lock must acquire");
        let wrong_handle = RalLockHandle {
            path: path.clone(),
            owner: other_owner,
        };

        assert!(matches!(
            release_ral_lock(&wrong_handle),
            Err(RalLockError::OwnerMismatch { owner: Some(_), .. })
        ));
        release_ral_lock(&handle).expect("original owner release must succeed");

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    fn allocation_lock_path(daemon_dir: &Path) -> PathBuf {
        let scope = RalAllocationLockScope {
            project_id: "project-a".to_string(),
            agent_pubkey: "a".repeat(64),
            conversation_id: "conversation-a".to_string(),
        };
        ral_allocation_lock_path(daemon_dir, &scope).expect("path must build")
    }

    fn unique_temp_daemon_dir() -> PathBuf {
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("tenex-ral-lock-test-{nanos}-{counter}"))
    }
}
