use std::path::Path;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::backend_config::{BackendConfigSnapshot, read_backend_config};
use crate::filesystem_state::{self, FilesystemStateError};
use crate::process_liveness::owner_process_status;
use crate::ral_lock::RalLockOwnerProcessStatus;

pub const DAEMON_READINESS_SCHEMA_VERSION: u32 = 1;

pub const CHECK_BASE_DIRECTORY: &str = "base-directory";
pub const CHECK_CONFIG_FILE: &str = "config-file";
pub const CHECK_BACKEND_SIGNER: &str = "backend-signer";
pub const CHECK_RELAYS: &str = "relays";
pub const CHECK_IDENTITY_RELAYS: &str = "identity-relays";
pub const CHECK_DAEMON_DIRECTORY: &str = "daemon-directory";
pub const CHECK_LOCKFILE: &str = "lockfile";

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadinessStatus {
    Ok,
    Missing,
    Invalid,
    Blocked,
}

impl ReadinessStatus {
    pub fn is_ok(&self) -> bool {
        matches!(self, ReadinessStatus::Ok)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadinessCheck {
    pub name: String,
    pub status: ReadinessStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonReadinessReport {
    pub schema_version: u32,
    pub ready: bool,
    pub checks: Vec<ReadinessCheck>,
}

#[derive(Debug, Error)]
pub enum DaemonReadinessError {
    #[error("failed to inspect lockfile: {0}")]
    Lockfile(#[from] FilesystemStateError),
}

pub fn inspect_daemon_readiness(
    base_dir: impl AsRef<Path>,
) -> Result<DaemonReadinessReport, DaemonReadinessError> {
    let base_dir = base_dir.as_ref();
    let mut checks = Vec::new();

    let base_ok = check_base_directory(base_dir, &mut checks);
    let config = check_config_file(base_dir, base_ok, &mut checks);
    check_backend_signer(config.as_ref(), &mut checks);
    check_relay_list(
        config.as_ref(),
        &mut checks,
        CHECK_RELAYS,
        relay_list_extractor,
    );
    check_relay_list(
        config.as_ref(),
        &mut checks,
        CHECK_IDENTITY_RELAYS,
        identity_relay_list_extractor,
    );
    check_daemon_directory(base_dir, base_ok, &mut checks);
    check_lockfile(base_dir, base_ok, &mut checks)?;

    let ready = checks.iter().all(|check| check.status.is_ok());
    Ok(DaemonReadinessReport {
        schema_version: DAEMON_READINESS_SCHEMA_VERSION,
        ready,
        checks,
    })
}

fn check_base_directory(base_dir: &Path, checks: &mut Vec<ReadinessCheck>) -> bool {
    match std::fs::metadata(base_dir) {
        Ok(metadata) if metadata.is_dir() => {
            checks.push(ok_check(CHECK_BASE_DIRECTORY));
            true
        }
        Ok(_) => {
            checks.push(invalid_check(
                CHECK_BASE_DIRECTORY,
                format!("{} is not a directory", base_dir.display()),
            ));
            false
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            checks.push(missing_check(
                CHECK_BASE_DIRECTORY,
                format!("{} does not exist", base_dir.display()),
            ));
            false
        }
        Err(error) => {
            checks.push(invalid_check(
                CHECK_BASE_DIRECTORY,
                format!("failed to read {}: {error}", base_dir.display()),
            ));
            false
        }
    }
}

fn check_config_file(
    base_dir: &Path,
    base_ok: bool,
    checks: &mut Vec<ReadinessCheck>,
) -> Option<BackendConfigSnapshot> {
    if !base_ok {
        checks.push(missing_check(
            CHECK_CONFIG_FILE,
            "depends on base-directory".to_string(),
        ));
        return None;
    }
    match read_backend_config(base_dir) {
        Ok(snapshot) => {
            checks.push(ok_check(CHECK_CONFIG_FILE));
            Some(snapshot)
        }
        Err(error) => {
            checks.push(invalid_check(CHECK_CONFIG_FILE, error.to_string()));
            None
        }
    }
}

fn check_backend_signer(config: Option<&BackendConfigSnapshot>, checks: &mut Vec<ReadinessCheck>) {
    let Some(config) = config else {
        checks.push(missing_check(
            CHECK_BACKEND_SIGNER,
            "depends on config-file".to_string(),
        ));
        return;
    };
    match config.backend_signer() {
        Ok(_) => checks.push(ok_check(CHECK_BACKEND_SIGNER)),
        Err(error) => checks.push(invalid_check(CHECK_BACKEND_SIGNER, error.to_string())),
    }
}

fn relay_list_extractor(config: &BackendConfigSnapshot) -> Vec<String> {
    config.effective_relay_urls()
}

fn identity_relay_list_extractor(config: &BackendConfigSnapshot) -> Vec<String> {
    config.effective_identity_relay_urls()
}

fn check_relay_list(
    config: Option<&BackendConfigSnapshot>,
    checks: &mut Vec<ReadinessCheck>,
    name: &str,
    extractor: fn(&BackendConfigSnapshot) -> Vec<String>,
) {
    let Some(config) = config else {
        checks.push(missing_check(name, "depends on config-file".to_string()));
        return;
    };
    let relays = extractor(config);
    if relays.is_empty() {
        checks.push(missing_check(
            name,
            "effective relay list is empty after defaulting".to_string(),
        ));
    } else {
        checks.push(ok_check_with_detail(
            name,
            format!("{} relay(s)", relays.len()),
        ));
    }
}

fn check_daemon_directory(base_dir: &Path, base_ok: bool, checks: &mut Vec<ReadinessCheck>) {
    if !base_ok {
        checks.push(missing_check(
            CHECK_DAEMON_DIRECTORY,
            "depends on base-directory".to_string(),
        ));
        return;
    }
    let daemon_dir = base_dir.join("daemon");
    match std::fs::metadata(&daemon_dir) {
        Ok(metadata) if metadata.is_dir() => checks.push(ok_check(CHECK_DAEMON_DIRECTORY)),
        Ok(_) => checks.push(invalid_check(
            CHECK_DAEMON_DIRECTORY,
            format!("{} is not a directory", daemon_dir.display()),
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            checks.push(ok_check_with_detail(
                CHECK_DAEMON_DIRECTORY,
                "daemon subdirectory absent; will be created on startup".to_string(),
            ));
        }
        Err(error) => checks.push(invalid_check(
            CHECK_DAEMON_DIRECTORY,
            format!("failed to read {}: {error}", daemon_dir.display()),
        )),
    }
}

fn check_lockfile(
    base_dir: &Path,
    base_ok: bool,
    checks: &mut Vec<ReadinessCheck>,
) -> Result<(), DaemonReadinessError> {
    if !base_ok {
        checks.push(missing_check(
            CHECK_LOCKFILE,
            "depends on base-directory".to_string(),
        ));
        return Ok(());
    }
    let daemon_dir = base_dir.join("daemon");
    match filesystem_state::read_lock_info_file(&daemon_dir) {
        Ok(None) => checks.push(ok_check_with_detail(
            CHECK_LOCKFILE,
            "no existing lockfile".to_string(),
        )),
        Ok(Some(lock)) => classify_live_lock(lock.pid, checks),
        Err(error) => return Err(DaemonReadinessError::Lockfile(error)),
    }
    Ok(())
}

fn classify_live_lock(pid: u32, checks: &mut Vec<ReadinessCheck>) {
    match owner_process_status(pid) {
        RalLockOwnerProcessStatus::Running => checks.push(ReadinessCheck {
            name: CHECK_LOCKFILE.to_string(),
            status: ReadinessStatus::Blocked,
            detail: Some(format!("daemon pid {pid} is alive")),
        }),
        RalLockOwnerProcessStatus::Missing => checks.push(ok_check_with_detail(
            CHECK_LOCKFILE,
            format!("stale lockfile for pid {pid}; recoverable on startup"),
        )),
        RalLockOwnerProcessStatus::Unknown => checks.push(ReadinessCheck {
            name: CHECK_LOCKFILE.to_string(),
            status: ReadinessStatus::Blocked,
            detail: Some(format!(
                "cannot determine liveness of lockfile pid {pid}; refusing to auto-reclaim"
            )),
        }),
    }
}

fn ok_check(name: &str) -> ReadinessCheck {
    ReadinessCheck {
        name: name.to_string(),
        status: ReadinessStatus::Ok,
        detail: None,
    }
}

fn ok_check_with_detail(name: &str, detail: String) -> ReadinessCheck {
    ReadinessCheck {
        name: name.to_string(),
        status: ReadinessStatus::Ok,
        detail: Some(detail),
    }
}

fn missing_check(name: &str, detail: String) -> ReadinessCheck {
    ReadinessCheck {
        name: name.to_string(),
        status: ReadinessStatus::Missing,
        detail: Some(detail),
    }
}

fn invalid_check(name: &str, detail: String) -> ReadinessCheck {
    ReadinessCheck {
        name: name.to_string(),
        status: ReadinessStatus::Invalid,
        detail: Some(detail),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn unique_temp_base_dir() -> PathBuf {
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::SeqCst);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before UNIX_EPOCH")
            .as_nanos();
        let dir = std::env::temp_dir()
            .join("tenex-daemon-readiness-tests")
            .join(format!("{}-{}-{}", std::process::id(), counter, nanos));
        fs::create_dir_all(&dir).expect("create temp base dir");
        dir
    }

    fn cleanup(dir: &Path) {
        let _ = fs::remove_dir_all(dir);
    }

    fn write_minimal_config(base_dir: &Path, relays: &[&str], identity_relays: &[&str]) {
        let relays_json = serde_json::to_string(relays).unwrap();
        let identity_json = serde_json::to_string(identity_relays).unwrap();
        let body = format!(
            "{{\n  \"tenexPrivateKey\": \"0101010101010101010101010101010101010101010101010101010101010101\",\n  \"relays\": {relays_json},\n  \"identityRelays\": {identity_json}\n}}\n"
        );
        fs::write(base_dir.join("config.json"), body).unwrap();
    }

    fn pick(report: &DaemonReadinessReport, name: &str) -> ReadinessCheck {
        report
            .checks
            .iter()
            .find(|check| check.name == name)
            .unwrap_or_else(|| panic!("missing readiness check {name}"))
            .clone()
    }

    #[test]
    fn missing_base_dir_marks_every_dependent_check_missing() {
        let dir = unique_temp_base_dir();
        let ghost = dir.join("does-not-exist");
        let report = inspect_daemon_readiness(&ghost).unwrap();
        assert!(!report.ready);
        assert_eq!(
            pick(&report, CHECK_BASE_DIRECTORY).status,
            ReadinessStatus::Missing
        );
        for dependent in [
            CHECK_CONFIG_FILE,
            CHECK_BACKEND_SIGNER,
            CHECK_RELAYS,
            CHECK_IDENTITY_RELAYS,
            CHECK_DAEMON_DIRECTORY,
            CHECK_LOCKFILE,
        ] {
            assert_eq!(
                pick(&report, dependent).status,
                ReadinessStatus::Missing,
                "dependent {dependent} must be Missing when base-directory is Missing"
            );
        }
        cleanup(&dir);
    }

    #[test]
    fn base_dir_exists_but_not_a_directory_is_invalid() {
        let dir = unique_temp_base_dir();
        let file = dir.join("not-a-dir");
        fs::write(&file, "hello").unwrap();
        let report = inspect_daemon_readiness(&file).unwrap();
        assert_eq!(
            pick(&report, CHECK_BASE_DIRECTORY).status,
            ReadinessStatus::Invalid
        );
        assert!(!report.ready);
        cleanup(&dir);
    }

    #[test]
    fn missing_config_file_is_invalid_and_blocks_dependents() {
        let dir = unique_temp_base_dir();
        let report = inspect_daemon_readiness(&dir).unwrap();
        assert!(!report.ready);
        assert_eq!(
            pick(&report, CHECK_BASE_DIRECTORY).status,
            ReadinessStatus::Ok
        );
        assert_eq!(
            pick(&report, CHECK_CONFIG_FILE).status,
            ReadinessStatus::Invalid
        );
        assert_eq!(
            pick(&report, CHECK_BACKEND_SIGNER).status,
            ReadinessStatus::Missing
        );
        assert_eq!(pick(&report, CHECK_RELAYS).status, ReadinessStatus::Missing);
        cleanup(&dir);
    }

    #[test]
    fn full_healthy_config_reports_ready() {
        let dir = unique_temp_base_dir();
        write_minimal_config(&dir, &["wss://a.example.com"], &["wss://b.example.com"]);
        let report = inspect_daemon_readiness(&dir).unwrap();
        for check in &report.checks {
            assert_eq!(
                check.status,
                ReadinessStatus::Ok,
                "check {} expected Ok, got {:?} ({:?})",
                check.name,
                check.status,
                check.detail
            );
        }
        assert!(report.ready);
        assert_eq!(report.schema_version, DAEMON_READINESS_SCHEMA_VERSION);
        cleanup(&dir);
    }

    #[test]
    fn empty_relays_fall_back_to_defaults_and_stay_ok() {
        let dir = unique_temp_base_dir();
        write_minimal_config(&dir, &[], &[]);
        let report = inspect_daemon_readiness(&dir).unwrap();
        assert_eq!(pick(&report, CHECK_RELAYS).status, ReadinessStatus::Ok);
        assert_eq!(
            pick(&report, CHECK_IDENTITY_RELAYS).status,
            ReadinessStatus::Ok
        );
        cleanup(&dir);
    }

    #[test]
    fn invalid_backend_secret_makes_signer_invalid() {
        let dir = unique_temp_base_dir();
        let body = "{\"tenexPrivateKey\": \"not-valid-hex\", \"relays\": [\"wss://a.example.com\"], \"identityRelays\": [\"wss://b.example.com\"]}";
        fs::write(dir.join("config.json"), body).unwrap();
        let report = inspect_daemon_readiness(&dir).unwrap();
        assert_eq!(
            pick(&report, CHECK_BACKEND_SIGNER).status,
            ReadinessStatus::Invalid
        );
        assert!(!report.ready);
        cleanup(&dir);
    }

    #[test]
    fn absent_daemon_subdir_is_ok_because_it_is_created_on_startup() {
        let dir = unique_temp_base_dir();
        write_minimal_config(&dir, &["wss://a.example.com"], &["wss://b.example.com"]);
        let check = inspect_daemon_readiness(&dir).unwrap();
        assert_eq!(
            pick(&check, CHECK_DAEMON_DIRECTORY).status,
            ReadinessStatus::Ok
        );
        assert!(
            pick(&check, CHECK_DAEMON_DIRECTORY)
                .detail
                .unwrap()
                .contains("absent")
        );
        cleanup(&dir);
    }

    #[test]
    fn existing_daemon_subdir_is_ok_without_detail() {
        let dir = unique_temp_base_dir();
        write_minimal_config(&dir, &["wss://a.example.com"], &["wss://b.example.com"]);
        fs::create_dir_all(dir.join("daemon")).unwrap();
        let report = inspect_daemon_readiness(&dir).unwrap();
        let check = pick(&report, CHECK_DAEMON_DIRECTORY);
        assert_eq!(check.status, ReadinessStatus::Ok);
        assert!(check.detail.is_none());
        cleanup(&dir);
    }

    #[test]
    fn live_lockfile_blocks_readiness() {
        let dir = unique_temp_base_dir();
        write_minimal_config(&dir, &["wss://a.example.com"], &["wss://b.example.com"]);
        let daemon_dir = dir.join("daemon");
        fs::create_dir_all(&daemon_dir).unwrap();
        let pid = std::process::id();
        let lock = filesystem_state::build_lock_info(pid, "test-host", 1);
        filesystem_state::write_lock_info_file(&daemon_dir, &lock).unwrap();
        let report = inspect_daemon_readiness(&dir).unwrap();
        let check = pick(&report, CHECK_LOCKFILE);
        assert_eq!(check.status, ReadinessStatus::Blocked);
        assert!(check.detail.unwrap().contains(&pid.to_string()));
        assert!(!report.ready);
        cleanup(&dir);
    }

    #[test]
    fn stale_lockfile_is_ok_with_recoverable_detail() {
        let dir = unique_temp_base_dir();
        write_minimal_config(&dir, &["wss://a.example.com"], &["wss://b.example.com"]);
        let daemon_dir = dir.join("daemon");
        fs::create_dir_all(&daemon_dir).unwrap();
        let stale_pid: u32 = 2;
        let lock = filesystem_state::build_lock_info(stale_pid, "test-host", 1);
        filesystem_state::write_lock_info_file(&daemon_dir, &lock).unwrap();
        let report = inspect_daemon_readiness(&dir).unwrap();
        let check = pick(&report, CHECK_LOCKFILE);
        match owner_process_status(stale_pid) {
            RalLockOwnerProcessStatus::Running => {
                assert_eq!(check.status, ReadinessStatus::Blocked);
            }
            RalLockOwnerProcessStatus::Missing => {
                assert_eq!(check.status, ReadinessStatus::Ok);
                assert!(check.detail.unwrap().contains("stale"));
            }
            RalLockOwnerProcessStatus::Unknown => {
                assert_eq!(check.status, ReadinessStatus::Blocked);
            }
        }
        cleanup(&dir);
    }

    #[test]
    fn schema_version_is_pinned() {
        let dir = unique_temp_base_dir();
        let report = inspect_daemon_readiness(&dir).unwrap();
        assert_eq!(report.schema_version, DAEMON_READINESS_SCHEMA_VERSION);
        assert_eq!(DAEMON_READINESS_SCHEMA_VERSION, 1);
        cleanup(&dir);
    }

    #[test]
    fn readiness_check_names_are_stable_constants() {
        let dir = unique_temp_base_dir();
        let report = inspect_daemon_readiness(&dir).unwrap();
        let names: Vec<&str> = report.checks.iter().map(|c| c.name.as_str()).collect();
        assert!(names.contains(&CHECK_BASE_DIRECTORY));
        assert!(names.contains(&CHECK_CONFIG_FILE));
        assert!(names.contains(&CHECK_BACKEND_SIGNER));
        assert!(names.contains(&CHECK_RELAYS));
        assert!(names.contains(&CHECK_IDENTITY_RELAYS));
        assert!(names.contains(&CHECK_DAEMON_DIRECTORY));
        assert!(names.contains(&CHECK_LOCKFILE));
        cleanup(&dir);
    }

    #[test]
    fn report_round_trips_through_json_with_stable_field_names() {
        let dir = unique_temp_base_dir();
        write_minimal_config(&dir, &["wss://a.example.com"], &["wss://b.example.com"]);
        let original = inspect_daemon_readiness(&dir).unwrap();

        let encoded = serde_json::to_string(&original).expect("serialize readiness report");
        let parsed: serde_json::Value =
            serde_json::from_str(&encoded).expect("re-parse readiness report");

        assert_eq!(parsed["schemaVersion"], DAEMON_READINESS_SCHEMA_VERSION);
        assert_eq!(parsed["ready"], true);
        let first_check = &parsed["checks"][0];
        assert!(first_check["name"].is_string());
        assert!(first_check["status"].is_string());

        let decoded: DaemonReadinessReport =
            serde_json::from_str(&encoded).expect("round-trip readiness report");
        assert_eq!(decoded, original);
        cleanup(&dir);
    }

    #[test]
    fn status_enum_serializes_as_lowercase_snake_case() {
        let ok = serde_json::to_string(&ReadinessStatus::Ok).unwrap();
        let missing = serde_json::to_string(&ReadinessStatus::Missing).unwrap();
        let invalid = serde_json::to_string(&ReadinessStatus::Invalid).unwrap();
        let blocked = serde_json::to_string(&ReadinessStatus::Blocked).unwrap();
        assert_eq!(ok, "\"ok\"");
        assert_eq!(missing, "\"missing\"");
        assert_eq!(invalid, "\"invalid\"");
        assert_eq!(blocked, "\"blocked\"");
    }

    #[test]
    fn check_detail_is_omitted_when_none() {
        let check = ReadinessCheck {
            name: "x".to_string(),
            status: ReadinessStatus::Ok,
            detail: None,
        };
        let encoded = serde_json::to_string(&check).unwrap();
        assert!(
            !encoded.contains("detail"),
            "detail None must be omitted, got {encoded}"
        );
    }
}
