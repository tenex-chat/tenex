use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use thiserror::Error;

use crate::periodic_tick::{
    PERIODIC_TICK_SCHEDULER_SCHEMA_VERSION, PeriodicScheduler, PeriodicSchedulerSnapshot,
    PeriodicTickError,
};

pub const PERIODIC_SCHEDULER_STATE_FILE_NAME: &str = "periodic-scheduler.json";

#[derive(Debug, Error)]
pub enum PeriodicTickStateError {
    #[error("periodic scheduler state io error at {path:?}: {source}")]
    Io { path: PathBuf, source: io::Error },
    #[error("periodic scheduler state json error at {path:?}: {source}")]
    Json {
        path: PathBuf,
        source: serde_json::Error,
    },
    #[error("periodic scheduler state schema version {found} is unsupported; expected {expected}")]
    UnsupportedSchemaVersion { found: u32, expected: u32 },
    #[error("periodic scheduler state task is invalid: {0}")]
    InvalidTask(#[from] PeriodicTickError),
}

pub fn periodic_scheduler_state_path(daemon_dir: impl AsRef<Path>) -> PathBuf {
    daemon_dir.as_ref().join(PERIODIC_SCHEDULER_STATE_FILE_NAME)
}

pub fn read_periodic_scheduler_state(
    daemon_dir: impl AsRef<Path>,
) -> Result<PeriodicScheduler, PeriodicTickStateError> {
    let path = periodic_scheduler_state_path(daemon_dir);
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(source) if source.kind() == io::ErrorKind::NotFound => {
            return Ok(PeriodicScheduler::new());
        }
        Err(source) => return Err(PeriodicTickStateError::Io { path, source }),
    };

    let snapshot: PeriodicSchedulerSnapshot =
        serde_json::from_str(&content).map_err(|source| PeriodicTickStateError::Json {
            path: path.clone(),
            source,
        })?;
    scheduler_from_snapshot(snapshot)
}

pub fn write_periodic_scheduler_state(
    daemon_dir: impl AsRef<Path>,
    scheduler: &PeriodicScheduler,
) -> Result<PeriodicSchedulerSnapshot, PeriodicTickStateError> {
    let daemon_dir = daemon_dir.as_ref();
    fs::create_dir_all(daemon_dir).map_err(|source| PeriodicTickStateError::Io {
        path: daemon_dir.to_path_buf(),
        source,
    })?;

    let target_path = periodic_scheduler_state_path(daemon_dir);
    let tmp_path = daemon_dir.join(format!(
        "{}.tmp.{}.{}",
        PERIODIC_SCHEDULER_STATE_FILE_NAME,
        std::process::id(),
        now_nanos()
    ));
    let snapshot = scheduler.inspect();
    let outcome = (|| {
        write_snapshot_file(&tmp_path, &snapshot)?;
        fs::rename(&tmp_path, &target_path).map_err(|source| PeriodicTickStateError::Io {
            path: target_path.clone(),
            source,
        })?;
        sync_parent_dir(&target_path)?;
        Ok(snapshot)
    })();

    if outcome.is_err() {
        let _ = fs::remove_file(&tmp_path);
    }

    outcome
}

fn scheduler_from_snapshot(
    snapshot: PeriodicSchedulerSnapshot,
) -> Result<PeriodicScheduler, PeriodicTickStateError> {
    if snapshot.schema_version != PERIODIC_TICK_SCHEDULER_SCHEMA_VERSION {
        return Err(PeriodicTickStateError::UnsupportedSchemaVersion {
            found: snapshot.schema_version,
            expected: PERIODIC_TICK_SCHEDULER_SCHEMA_VERSION,
        });
    }

    let mut scheduler = PeriodicScheduler::new();
    for task in snapshot.tasks {
        scheduler.register_task(task.name, task.interval_seconds, task.next_due_at)?;
    }
    Ok(scheduler)
}

fn write_snapshot_file(
    path: &Path,
    snapshot: &PeriodicSchedulerSnapshot,
) -> Result<(), PeriodicTickStateError> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|source| PeriodicTickStateError::Io {
            path: path.to_path_buf(),
            source,
        })?;
    serde_json::to_writer_pretty(&mut file, snapshot).map_err(|source| {
        PeriodicTickStateError::Json {
            path: path.to_path_buf(),
            source,
        }
    })?;
    file.write_all(b"\n")
        .and_then(|_| file.sync_all())
        .map_err(|source| PeriodicTickStateError::Io {
            path: path.to_path_buf(),
            source,
        })?;
    Ok(())
}

fn sync_parent_dir(path: &Path) -> Result<(), PeriodicTickStateError> {
    if let Some(parent) = path.parent() {
        File::open(parent)
            .and_then(|file| file.sync_all())
            .map_err(|source| PeriodicTickStateError::Io {
                path: parent.to_path_buf(),
                source,
            })?;
    }
    Ok(())
}

fn now_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn missing_state_file_returns_empty_scheduler() {
        let daemon_dir = unique_temp_dir("periodic-state-missing");

        let scheduler = read_periodic_scheduler_state(&daemon_dir)
            .expect("missing state file must return empty scheduler");

        assert!(scheduler.inspect().tasks.is_empty());
    }

    #[test]
    fn writes_and_reads_scheduler_state_round_trip() {
        let daemon_dir = unique_temp_dir("periodic-state-round-trip");
        let mut scheduler = PeriodicScheduler::new();
        scheduler
            .register_task("backend-status", 30, 1_710_001_330)
            .expect("backend-status must register");
        scheduler
            .register_task("project-status:owner:demo", 30, 1_710_001_330)
            .expect("project status must register");

        let written = write_periodic_scheduler_state(&daemon_dir, &scheduler)
            .expect("scheduler state must write");
        let read = read_periodic_scheduler_state(&daemon_dir).expect("scheduler state must read");

        assert_eq!(written, scheduler.inspect());
        assert_eq!(read.inspect(), scheduler.inspect());
        assert!(periodic_scheduler_state_path(&daemon_dir).is_file());
        assert_no_tmp_files(&daemon_dir);
    }

    #[test]
    fn read_fails_closed_on_corrupt_json() {
        let daemon_dir = unique_temp_dir("periodic-state-corrupt");
        fs::create_dir_all(&daemon_dir).expect("daemon dir must create");
        fs::write(periodic_scheduler_state_path(&daemon_dir), "{not-json")
            .expect("corrupt state must write");

        let err = read_periodic_scheduler_state(&daemon_dir).unwrap_err();

        assert!(matches!(err, PeriodicTickStateError::Json { .. }));
    }

    #[test]
    fn read_fails_closed_on_unsupported_schema_version() {
        let daemon_dir = unique_temp_dir("periodic-state-schema");
        fs::create_dir_all(&daemon_dir).expect("daemon dir must create");
        fs::write(
            periodic_scheduler_state_path(&daemon_dir),
            r#"{"schemaVersion":999,"tasks":[]}"#,
        )
        .expect("unsupported state must write");

        let err = read_periodic_scheduler_state(&daemon_dir).unwrap_err();

        assert!(matches!(
            err,
            PeriodicTickStateError::UnsupportedSchemaVersion {
                found: 999,
                expected: PERIODIC_TICK_SCHEDULER_SCHEMA_VERSION,
            }
        ));
    }

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be after UNIX_EPOCH")
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("{prefix}-{unique}-{counter}"))
    }

    fn assert_no_tmp_files(daemon_dir: &Path) {
        for entry in fs::read_dir(daemon_dir).expect("daemon dir must list") {
            let entry = entry.expect("daemon dir entry must read");
            let name = entry.file_name();
            let name = name.to_string_lossy();
            assert!(
                !name.starts_with(&format!("{PERIODIC_SCHEDULER_STATE_FILE_NAME}.tmp.")),
                "unexpected tmp file: {name}"
            );
        }
    }
}
