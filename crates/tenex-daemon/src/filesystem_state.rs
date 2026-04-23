use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use thiserror::Error;

pub const LOCKFILE_NAME: &str = "tenex.lock";
pub const STATUS_FILE_NAME: &str = "status.json";
pub const RESTART_STATE_FILE_NAME: &str = "restart-state.json";

#[derive(Debug, Error)]
pub enum FilesystemStateError {
    #[error("filesystem error: {0}")]
    Io(#[from] io::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

pub type FilesystemStateResult<T> = Result<T, FilesystemStateError>;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesystemStateFixture {
    pub name: String,
    pub description: String,
    pub daemon_dir_name: String,
    pub relative_paths: DaemonStateRelativePaths,
    pub lockfile: LockInfo,
    pub stale_lockfile: LockInfo,
    pub status: DaemonStatusData,
    pub restart_state: RestartStateData,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonStateRelativePaths {
    pub lockfile: String,
    pub status: String,
    pub restart_state: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockInfo {
    pub pid: u32,
    pub hostname: String,
    pub started_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonStatusData {
    pub pid: u32,
    pub started_at: String,
    pub known_projects: u32,
    pub runtimes: Vec<RuntimeStatusEntry>,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatusEntry {
    pub project_id: String,
    pub title: String,
    pub agent_count: u32,
    pub start_time: Option<String>,
    pub last_event_time: Option<String>,
    pub event_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestartStateData {
    pub requested_at: u64,
    pub pid: u32,
    pub hostname: String,
}

pub fn lockfile_path(daemon_dir: impl AsRef<Path>) -> PathBuf {
    daemon_dir.as_ref().join(LOCKFILE_NAME)
}

pub fn status_file_path(daemon_dir: impl AsRef<Path>) -> PathBuf {
    daemon_dir.as_ref().join(STATUS_FILE_NAME)
}

pub fn restart_state_file_path(daemon_dir: impl AsRef<Path>) -> PathBuf {
    daemon_dir.as_ref().join(RESTART_STATE_FILE_NAME)
}

pub fn build_lock_info(pid: u32, hostname: impl Into<String>, started_at: u64) -> LockInfo {
    LockInfo {
        pid,
        hostname: hostname.into(),
        started_at,
    }
}

pub fn build_restart_state(
    requested_at: u64,
    pid: u32,
    hostname: impl Into<String>,
) -> RestartStateData {
    RestartStateData {
        requested_at,
        pid,
        hostname: hostname.into(),
    }
}

pub fn read_lock_info_file(
    daemon_dir: impl AsRef<Path>,
) -> FilesystemStateResult<Option<LockInfo>> {
    read_optional_json(lockfile_path(daemon_dir))
}

pub fn write_lock_info_file(
    daemon_dir: impl AsRef<Path>,
    lock_info: &LockInfo,
) -> FilesystemStateResult<()> {
    write_json(lockfile_path(daemon_dir), lock_info)
}

pub fn remove_lock_info_file(daemon_dir: impl AsRef<Path>) -> FilesystemStateResult<()> {
    remove_optional_file(lockfile_path(daemon_dir))
}

pub fn read_status_file(
    daemon_dir: impl AsRef<Path>,
) -> FilesystemStateResult<Option<DaemonStatusData>> {
    read_optional_json(status_file_path(daemon_dir))
}

pub fn write_status_file(
    daemon_dir: impl AsRef<Path>,
    status: &DaemonStatusData,
) -> FilesystemStateResult<()> {
    write_json(status_file_path(daemon_dir), status)
}

pub fn remove_status_file(daemon_dir: impl AsRef<Path>) -> FilesystemStateResult<()> {
    remove_optional_file(status_file_path(daemon_dir))
}

pub fn read_restart_state_file(
    daemon_dir: impl AsRef<Path>,
) -> FilesystemStateResult<Option<RestartStateData>> {
    read_optional_json(restart_state_file_path(daemon_dir))
}

pub fn save_restart_state_file(
    daemon_dir: impl AsRef<Path>,
    restart_state: &RestartStateData,
) -> FilesystemStateResult<()> {
    let state_path = restart_state_file_path(daemon_dir);
    let temp_path = state_path.with_extension(format!("json.tmp.{}", std::process::id()));

    write_json(&temp_path, restart_state)?;
    fs::rename(temp_path, state_path)?;

    Ok(())
}

pub fn remove_restart_state_file(daemon_dir: impl AsRef<Path>) -> FilesystemStateResult<()> {
    remove_optional_file(restart_state_file_path(daemon_dir))
}

fn read_optional_json<T: DeserializeOwned>(
    path: impl AsRef<Path>,
) -> FilesystemStateResult<Option<T>> {
    let path = path.as_ref();
    match fs::read_to_string(path) {
        Ok(content) => Ok(Some(serde_json::from_str(&content)?)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn write_json(path: impl AsRef<Path>, value: &impl Serialize) -> FilesystemStateResult<()> {
    fs::write(path, serde_json::to_string_pretty(value)?)?;
    Ok(())
}

fn remove_optional_file(path: impl AsRef<Path>) -> FilesystemStateResult<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    const FILESYSTEM_STATE_FIXTURE: &str =
        include_str!("../../../src/test-utils/fixtures/daemon/filesystem-state.compat.json");

    #[test]
    fn filesystem_state_fixture_matches_rust_contract() {
        let fixture: FilesystemStateFixture =
            serde_json::from_str(FILESYSTEM_STATE_FIXTURE).expect("fixture must parse");

        assert_eq!(fixture.relative_paths.lockfile, LOCKFILE_NAME);
        assert_eq!(fixture.relative_paths.status, STATUS_FILE_NAME);
        assert_eq!(
            fixture.relative_paths.restart_state,
            RESTART_STATE_FILE_NAME
        );

        let daemon_dir = Path::new("/tmp").join(&fixture.daemon_dir_name);
        assert_eq!(lockfile_path(&daemon_dir), daemon_dir.join(LOCKFILE_NAME));
        assert_eq!(
            status_file_path(&daemon_dir),
            daemon_dir.join(STATUS_FILE_NAME)
        );
        assert_eq!(
            restart_state_file_path(&daemon_dir),
            daemon_dir.join(RESTART_STATE_FILE_NAME)
        );

        assert_eq!(
            build_lock_info(
                fixture.lockfile.pid,
                fixture.lockfile.hostname.clone(),
                fixture.lockfile.started_at
            ),
            fixture.lockfile
        );
        assert_eq!(
            build_restart_state(
                fixture.restart_state.requested_at,
                fixture.restart_state.pid,
                fixture.restart_state.hostname.clone()
            ),
            fixture.restart_state
        );

        let status_value =
            serde_json::to_value(&fixture.status).expect("status must serialize to JSON");
        let fixture_value: serde_json::Value =
            serde_json::from_str(FILESYSTEM_STATE_FIXTURE).expect("fixture must parse as value");
        assert_eq!(status_value, fixture_value["status"]);
    }

    #[test]
    fn filesystem_state_files_round_trip_through_rust_io() {
        let fixture: FilesystemStateFixture =
            serde_json::from_str(FILESYSTEM_STATE_FIXTURE).expect("fixture must parse");
        let daemon_dir = unique_temp_daemon_dir();

        write_lock_info_file(&daemon_dir, &fixture.lockfile).expect("lockfile write must succeed");
        assert_eq!(
            read_lock_info_file(&daemon_dir).expect("lockfile read must succeed"),
            Some(fixture.lockfile)
        );
        remove_lock_info_file(&daemon_dir).expect("lockfile remove must succeed");
        assert_eq!(
            read_lock_info_file(&daemon_dir).expect("missing lockfile read must succeed"),
            None
        );

        write_status_file(&daemon_dir, &fixture.status).expect("status write must succeed");
        assert_eq!(
            read_status_file(&daemon_dir).expect("status read must succeed"),
            Some(fixture.status)
        );
        remove_status_file(&daemon_dir).expect("status remove must succeed");
        assert_eq!(
            read_status_file(&daemon_dir).expect("missing status read must succeed"),
            None
        );

        save_restart_state_file(&daemon_dir, &fixture.restart_state)
            .expect("restart state save must succeed");
        assert_eq!(
            read_restart_state_file(&daemon_dir).expect("restart state read must succeed"),
            Some(fixture.restart_state)
        );
        remove_restart_state_file(&daemon_dir).expect("restart state remove must succeed");
        assert_eq!(
            read_restart_state_file(&daemon_dir).expect("missing restart state read must succeed"),
            None
        );

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    fn unique_temp_daemon_dir() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be after UNIX_EPOCH")
            .as_nanos();
        let daemon_dir = std::env::temp_dir().join(format!(
            "tenex-daemon-state-compat-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&daemon_dir).expect("temp daemon dir must be created");
        daemon_dir
    }
}
