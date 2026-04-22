use crate::daemon_status::{DaemonStatusSnapshot, read_daemon_status_snapshot};
use crate::filesystem_state::{
    DaemonStatusData, FilesystemStateError, LockInfo, RestartStateData, build_lock_info,
    build_restart_state, lockfile_path, read_lock_info_file, read_restart_state_file,
    read_status_file, remove_lock_info_file, remove_restart_state_file, remove_status_file,
    restart_state_file_path, status_file_path,
};
use crate::process_liveness::{OsProcessLivenessProbe, ProcessLivenessProbe};
use serde::Serialize;
use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::process;
use thiserror::Error;
use time::OffsetDateTime;
use time::format_description::FormatItem;
use time::macros::format_description;

const UTC_MILLIS_FORMAT: &[FormatItem<'static>] =
    format_description!("[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z");

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum DaemonLockState {
    Missing,
    Busy { owner: LockInfo },
    Stale { owner: LockInfo },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DaemonShellStopMode {
    Shutdown,
    Restart {
        requested_at_ms: u64,
        booted_projects: Vec<String>,
    },
}

#[derive(Debug, Error)]
pub enum DaemonShellError {
    #[error("daemon filesystem error: {0}")]
    Filesystem(#[from] FilesystemStateError),
    #[error("daemon io error: {0}")]
    Io(#[from] io::Error),
    #[error("daemon JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("daemon timestamp is out of range: {0}")]
    TimestampRange(#[from] time::error::ComponentRange),
    #[error("daemon timestamp format error: {0}")]
    TimestampFormat(#[from] time::error::Format),
    #[error("daemon lock is already held by pid {owner_pid} on {owner_hostname}")]
    Busy {
        owner_pid: u32,
        owner_hostname: String,
    },
    #[error("daemon lock ownership mismatch: expected {expected:?}, actual {actual:?}")]
    LockOwnershipMismatch {
        expected: LockInfo,
        actual: Option<LockInfo>,
    },
}

pub type DaemonShellResult<T> = Result<T, DaemonShellError>;

#[derive(Debug, Clone)]
pub struct DaemonShell<P = OsProcessLivenessProbe> {
    daemon_dir: PathBuf,
    probe: P,
    pid: u32,
    hostname: String,
}

#[derive(Debug, Clone)]
pub struct DaemonShellSession<P = OsProcessLivenessProbe> {
    shell: DaemonShell<P>,
    lock_info: LockInfo,
}

impl DaemonShell<OsProcessLivenessProbe> {
    pub fn new(daemon_dir: impl Into<PathBuf>) -> Self {
        Self::with_identity(
            daemon_dir,
            OsProcessLivenessProbe,
            process::id(),
            current_hostname(),
        )
    }
}

impl<P: ProcessLivenessProbe + Clone> DaemonShell<P> {
    pub fn with_identity(
        daemon_dir: impl Into<PathBuf>,
        probe: P,
        pid: u32,
        hostname: impl Into<String>,
    ) -> Self {
        Self {
            daemon_dir: daemon_dir.into(),
            probe,
            pid,
            hostname: hostname.into(),
        }
    }

    pub fn daemon_dir(&self) -> &Path {
        &self.daemon_dir
    }

    pub fn status_snapshot(&self) -> DaemonStatusSnapshot {
        read_daemon_status_snapshot(&self.daemon_dir, &self.probe)
    }

    pub fn inspect_lock(&self) -> DaemonShellResult<DaemonLockState> {
        let Some(lock_info) = read_lock_info_file(&self.daemon_dir)? else {
            return Ok(DaemonLockState::Missing);
        };

        Ok(match self.probe.process_status(lock_info.pid) {
            crate::ral_lock::RalLockOwnerProcessStatus::Missing => {
                DaemonLockState::Stale { owner: lock_info }
            }
            crate::ral_lock::RalLockOwnerProcessStatus::Running
            | crate::ral_lock::RalLockOwnerProcessStatus::Unknown => {
                DaemonLockState::Busy { owner: lock_info }
            }
        })
    }

    pub fn read_status(&self) -> DaemonShellResult<Option<DaemonStatusData>> {
        Ok(read_status_file(&self.daemon_dir)?)
    }

    pub fn read_restart_state(&self) -> DaemonShellResult<Option<RestartStateData>> {
        Ok(read_restart_state_file(&self.daemon_dir)?)
    }

    pub fn clear_restart_state(&self) -> DaemonShellResult<()> {
        remove_restart_state_file(&self.daemon_dir)?;
        Ok(())
    }

    pub fn write_restart_state(
        &self,
        requested_at_ms: u64,
        booted_projects: Vec<String>,
    ) -> DaemonShellResult<RestartStateData> {
        let restart_state = build_restart_state(
            requested_at_ms,
            booted_projects,
            self.pid,
            self.hostname.clone(),
        );
        write_json_atomic(&restart_state_file_path(&self.daemon_dir), &restart_state)?;
        Ok(restart_state)
    }

    pub fn start_foreground(&self, started_at_ms: u64) -> DaemonShellResult<DaemonShellSession<P>> {
        ensure_daemon_dir(&self.daemon_dir)?;

        let lock_info = build_lock_info(self.pid, self.hostname.clone(), started_at_ms);
        self.acquire_lock(&lock_info)?;

        if let Err(error) = self.write_initial_status(started_at_ms) {
            let _ = self.release_lock(&lock_info);
            return Err(error);
        }

        Ok(DaemonShellSession {
            shell: self.clone(),
            lock_info,
        })
    }

    fn acquire_lock(&self, lock_info: &LockInfo) -> DaemonShellResult<()> {
        for _ in 0..2 {
            match self.inspect_lock()? {
                DaemonLockState::Missing => {
                    match write_lock_file(&lockfile_path(&self.daemon_dir), lock_info) {
                        Ok(()) => return Ok(()),
                        Err(DaemonShellError::Io(error))
                            if error.kind() == io::ErrorKind::AlreadyExists =>
                        {
                            continue;
                        }
                        Err(error) => return Err(error),
                    }
                }
                DaemonLockState::Stale { .. } => {
                    remove_lock_info_file(&self.daemon_dir)?;
                    match write_lock_file(&lockfile_path(&self.daemon_dir), lock_info) {
                        Ok(()) => return Ok(()),
                        Err(DaemonShellError::Io(error))
                            if error.kind() == io::ErrorKind::AlreadyExists =>
                        {
                            continue;
                        }
                        Err(error) => return Err(error),
                    }
                }
                DaemonLockState::Busy { owner } => {
                    return Err(DaemonShellError::Busy {
                        owner_pid: owner.pid,
                        owner_hostname: owner.hostname,
                    });
                }
            }
        }

        match self.inspect_lock()? {
            DaemonLockState::Missing => {
                write_lock_file(&lockfile_path(&self.daemon_dir), lock_info)
            }
            DaemonLockState::Stale { .. } => {
                remove_lock_info_file(&self.daemon_dir)?;
                write_lock_file(&lockfile_path(&self.daemon_dir), lock_info)
            }
            DaemonLockState::Busy { owner } => Err(DaemonShellError::Busy {
                owner_pid: owner.pid,
                owner_hostname: owner.hostname,
            }),
        }
    }

    fn write_initial_status(&self, started_at_ms: u64) -> DaemonShellResult<()> {
        let started_at = format_unix_timestamp_ms(started_at_ms)?;
        let status = DaemonStatusData {
            pid: self.pid,
            started_at: started_at.clone(),
            known_projects: 0,
            runtimes: Vec::new(),
            updated_at: started_at,
        };
        write_json_atomic(&status_file_path(&self.daemon_dir), &status)?;
        Ok(())
    }

    fn release_lock(&self, expected: &LockInfo) -> DaemonShellResult<()> {
        match read_lock_info_file(&self.daemon_dir)? {
            None => Ok(()),
            Some(current) if same_lock_info(&current, expected) => {
                remove_lock_info_file(&self.daemon_dir)?;
                Ok(())
            }
            Some(actual) => Err(DaemonShellError::LockOwnershipMismatch {
                expected: expected.clone(),
                actual: Some(actual),
            }),
        }
    }
}

impl<P: ProcessLivenessProbe + Clone> DaemonShellSession<P> {
    pub fn lock_info(&self) -> &LockInfo {
        &self.lock_info
    }

    pub fn status_snapshot(&self) -> DaemonStatusSnapshot {
        self.shell.status_snapshot()
    }

    pub fn stop(self, mode: DaemonShellStopMode) -> DaemonShellResult<()> {
        match mode {
            DaemonShellStopMode::Shutdown => self.stop_shutdown(),
            DaemonShellStopMode::Restart {
                requested_at_ms,
                booted_projects,
            } => self.stop_restart(requested_at_ms, booted_projects),
        }
    }

    fn stop_shutdown(self) -> DaemonShellResult<()> {
        let mut first_error = None;

        if let Err(error) = self.shell.clear_restart_state() {
            first_error = Some(error);
        }
        if first_error.is_none()
            && let Err(error) = remove_status_file(&self.shell.daemon_dir)
        {
            first_error = Some(error.into());
        }
        if first_error.is_none()
            && let Err(error) = self.shell.release_lock(&self.lock_info)
        {
            first_error = Some(error);
        }

        match first_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    fn stop_restart(
        self,
        requested_at_ms: u64,
        booted_projects: Vec<String>,
    ) -> DaemonShellResult<()> {
        self.shell
            .write_restart_state(requested_at_ms, booted_projects)?;

        let mut first_error = None;
        if let Err(error) = remove_status_file(&self.shell.daemon_dir) {
            first_error = Some(error.into());
        }
        if first_error.is_none()
            && let Err(error) = self.shell.release_lock(&self.lock_info)
        {
            first_error = Some(error);
        }

        match first_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

fn same_lock_info(left: &LockInfo, right: &LockInfo) -> bool {
    left.pid == right.pid && left.hostname == right.hostname && left.started_at == right.started_at
}

fn ensure_daemon_dir(path: &Path) -> DaemonShellResult<()> {
    fs::create_dir_all(path)?;
    Ok(())
}

fn write_lock_file(path: &Path, lock_info: &LockInfo) -> DaemonShellResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let result = (|| -> DaemonShellResult<()> {
        let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
        serde_json::to_writer_pretty(&mut file, lock_info)?;
        file.sync_all()?;
        sync_parent_dir(path)?;
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(path);
    }

    result
}

fn write_json_atomic(path: &Path, value: &impl Serialize) -> DaemonShellResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let temp_path = temp_path_for(path);
    let result = (|| -> DaemonShellResult<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)?;
        serde_json::to_writer_pretty(&mut file, value)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp_path, path)?;
        sync_parent_dir(path)?;
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }

    result
}

fn sync_parent_dir(path: &Path) -> DaemonShellResult<()> {
    if let Some(parent) = path.parent() {
        File::open(parent)?.sync_all()?;
    }
    Ok(())
}

fn temp_path_for(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "daemon-state".to_string());
    path.with_file_name(format!("{file_name}.tmp.{}", process::id()))
}

fn format_unix_timestamp_ms(timestamp_ms: u64) -> DaemonShellResult<String> {
    let timestamp_ns = i128::from(timestamp_ms) * 1_000_000;
    let datetime = OffsetDateTime::from_unix_timestamp_nanos(timestamp_ns)?;
    Ok(datetime.format(UTC_MILLIS_FORMAT)?)
}

fn current_hostname() -> String {
    #[cfg(target_family = "unix")]
    {
        let mut buffer = [0u8; 256];
        let result = unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) };
        if result == 0 {
            let len = buffer
                .iter()
                .position(|byte| *byte == 0)
                .unwrap_or(buffer.len());
            return String::from_utf8_lossy(&buffer[..len]).into_owned();
        }
    }

    std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .unwrap_or_else(|_| "unknown-host".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon_status::DaemonPresence;
    use crate::filesystem_state::{
        FilesystemStateFixture, build_lock_info, read_restart_state_file,
    };
    use crate::process_liveness::ProcessLivenessProbe;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    const FILESYSTEM_STATE_FIXTURE: &str =
        include_str!("../../../src/test-utils/fixtures/daemon/filesystem-state.compat.json");
    const TEST_PID: u32 = 4242;
    const TEST_HOSTNAME: &str = "tenex-host";
    static TEST_DIR_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[derive(Debug, Clone)]
    struct FixedProbe {
        status: crate::ral_lock::RalLockOwnerProcessStatus,
    }

    impl ProcessLivenessProbe for FixedProbe {
        fn process_status(&self, _pid: u32) -> crate::ral_lock::RalLockOwnerProcessStatus {
            self.status
        }
    }

    #[test]
    fn start_foreground_writes_initial_lock_and_status() {
        let daemon_dir = unique_temp_daemon_dir();
        let shell = test_shell(
            &daemon_dir,
            crate::ral_lock::RalLockOwnerProcessStatus::Running,
        );

        let session = shell
            .start_foreground(1_710_000_000_000)
            .expect("foreground start must succeed");

        assert_eq!(
            read_lock_info_file(&daemon_dir).expect("lockfile read must succeed"),
            Some(build_lock_info(TEST_PID, TEST_HOSTNAME, 1_710_000_000_000))
        );
        assert_eq!(
            read_status_file(&daemon_dir).expect("status read must succeed"),
            Some(DaemonStatusData {
                pid: TEST_PID,
                started_at: "2024-03-09T16:00:00.000Z".to_string(),
                known_projects: 0,
                runtimes: Vec::new(),
                updated_at: "2024-03-09T16:00:00.000Z".to_string(),
            })
        );
        assert_eq!(session.status_snapshot().presence, DaemonPresence::Running);

        session
            .stop(DaemonShellStopMode::Shutdown)
            .expect("shutdown stop must succeed");
        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn start_foreground_replaces_stale_lockfile() {
        let fixture = filesystem_state_fixture();
        let daemon_dir = unique_temp_daemon_dir();
        let shell = test_shell(
            &daemon_dir,
            crate::ral_lock::RalLockOwnerProcessStatus::Missing,
        );

        write_lock_file(&lockfile_path(&daemon_dir), &fixture.stale_lockfile)
            .expect("stale lockfile write must succeed");

        let session = shell
            .start_foreground(1_710_000_000_000)
            .expect("stale lockfile must be replaced");

        assert_eq!(
            read_lock_info_file(&daemon_dir).expect("lockfile read must succeed"),
            Some(build_lock_info(TEST_PID, TEST_HOSTNAME, 1_710_000_000_000))
        );

        session
            .stop(DaemonShellStopMode::Shutdown)
            .expect("shutdown stop must succeed");
        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn start_foreground_refuses_busy_lockfile() {
        let fixture = filesystem_state_fixture();
        let daemon_dir = unique_temp_daemon_dir();
        let shell = test_shell(
            &daemon_dir,
            crate::ral_lock::RalLockOwnerProcessStatus::Running,
        );

        write_lock_file(&lockfile_path(&daemon_dir), &fixture.lockfile)
            .expect("busy lockfile write must succeed");

        let error = shell
            .start_foreground(1_710_000_000_000)
            .expect_err("busy lockfile must fail");

        assert_eq!(
            error.to_string(),
            "daemon lock is already held by pid 4242 on tenex-host"
        );
        assert_eq!(
            read_lock_info_file(&daemon_dir).expect("lockfile read must succeed"),
            Some(fixture.lockfile)
        );
        assert_eq!(
            read_status_file(&daemon_dir).expect("status read must succeed"),
            None
        );

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn stop_restart_writes_restart_state_and_clears_foreground_files() {
        let fixture = filesystem_state_fixture();
        let daemon_dir = unique_temp_daemon_dir();
        let shell = test_shell(
            &daemon_dir,
            crate::ral_lock::RalLockOwnerProcessStatus::Missing,
        );

        let session = shell
            .start_foreground(1_710_000_000_000)
            .expect("foreground start must succeed");

        session
            .stop(DaemonShellStopMode::Restart {
                requested_at_ms: fixture.restart_state.requested_at,
                booted_projects: fixture.restart_state.booted_projects.clone(),
            })
            .expect("restart stop must succeed");

        assert_eq!(
            read_restart_state_file(&daemon_dir).expect("restart state read must succeed"),
            Some(fixture.restart_state)
        );
        assert_eq!(
            read_lock_info_file(&daemon_dir).expect("lockfile read must succeed"),
            None
        );
        assert_eq!(
            read_status_file(&daemon_dir).expect("status read must succeed"),
            None
        );

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn stop_shutdown_clears_restart_state_and_foreground_files() {
        let fixture = filesystem_state_fixture();
        let daemon_dir = unique_temp_daemon_dir();
        let shell = test_shell(
            &daemon_dir,
            crate::ral_lock::RalLockOwnerProcessStatus::Missing,
        );

        let session = shell
            .start_foreground(1_710_000_000_000)
            .expect("foreground start must succeed");
        shell
            .write_restart_state(
                fixture.restart_state.requested_at,
                fixture.restart_state.booted_projects.clone(),
            )
            .expect("restart state write must succeed");

        session
            .stop(DaemonShellStopMode::Shutdown)
            .expect("shutdown stop must succeed");

        assert_eq!(
            read_restart_state_file(&daemon_dir).expect("restart state read must succeed"),
            None
        );
        assert_eq!(
            read_lock_info_file(&daemon_dir).expect("lockfile read must succeed"),
            None
        );
        assert_eq!(
            read_status_file(&daemon_dir).expect("status read must succeed"),
            None
        );

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    fn test_shell(
        daemon_dir: &Path,
        status: crate::ral_lock::RalLockOwnerProcessStatus,
    ) -> DaemonShell<FixedProbe> {
        DaemonShell::with_identity(
            daemon_dir.to_path_buf(),
            FixedProbe { status },
            TEST_PID,
            TEST_HOSTNAME,
        )
    }

    fn filesystem_state_fixture() -> FilesystemStateFixture {
        serde_json::from_str(FILESYSTEM_STATE_FIXTURE).expect("fixture must parse")
    }

    fn write_lock_file(path: &Path, lock_info: &LockInfo) -> DaemonShellResult<()> {
        let result = (|| -> DaemonShellResult<()> {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
            serde_json::to_writer_pretty(&mut file, lock_info)?;
            file.sync_all()?;
            sync_parent_dir(path)?;
            Ok(())
        })();

        if result.is_err() {
            let _ = fs::remove_file(path);
        }

        result
    }

    fn unique_temp_daemon_dir() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be after UNIX_EPOCH")
            .as_nanos();
        let counter = TEST_DIR_COUNTER.fetch_add(1, Ordering::Relaxed);
        let daemon_dir = std::env::temp_dir().join(format!(
            "tenex-daemon-shell-test-{}-{unique}-{counter}",
            std::process::id()
        ));
        fs::create_dir_all(&daemon_dir).expect("temp daemon dir must be created");
        daemon_dir
    }
}
