use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const OPERATIONS_STATUS_ACTIVE_STATE_FILE_NAME: &str = "operations-status-active.json";
pub const OPERATIONS_STATUS_ACTIVE_STATE_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationsStatusActiveProject {
    pub project_id: String,
    pub conversation_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationsStatusActiveSnapshot {
    pub schema_version: u32,
    pub projects: Vec<OperationsStatusActiveProject>,
}

#[derive(Debug, Error)]
pub enum OperationsStatusStateError {
    #[error("operations-status state io error at {path:?}: {source}")]
    Io { path: PathBuf, source: io::Error },
    #[error("operations-status state json error at {path:?}: {source}")]
    Json {
        path: PathBuf,
        source: serde_json::Error,
    },
    #[error("operations-status state schema version {found} is unsupported; expected {expected}")]
    UnsupportedSchemaVersion { found: u32, expected: u32 },
}

pub fn operations_status_active_state_path(daemon_dir: impl AsRef<Path>) -> PathBuf {
    daemon_dir
        .as_ref()
        .join(OPERATIONS_STATUS_ACTIVE_STATE_FILE_NAME)
}

pub fn empty_operations_status_active_snapshot() -> OperationsStatusActiveSnapshot {
    OperationsStatusActiveSnapshot {
        schema_version: OPERATIONS_STATUS_ACTIVE_STATE_SCHEMA_VERSION,
        projects: Vec::new(),
    }
}

pub fn read_operations_status_active_snapshot(
    daemon_dir: impl AsRef<Path>,
) -> Result<OperationsStatusActiveSnapshot, OperationsStatusStateError> {
    let path = operations_status_active_state_path(daemon_dir);
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(source) if source.kind() == io::ErrorKind::NotFound => {
            return Ok(empty_operations_status_active_snapshot());
        }
        Err(source) => return Err(OperationsStatusStateError::Io { path, source }),
    };

    let snapshot: OperationsStatusActiveSnapshot =
        serde_json::from_str(&content).map_err(|source| OperationsStatusStateError::Json {
            path: path.clone(),
            source,
        })?;
    normalize_snapshot(snapshot)
}

pub fn write_operations_status_active_snapshot(
    daemon_dir: impl AsRef<Path>,
    snapshot: OperationsStatusActiveSnapshot,
) -> Result<OperationsStatusActiveSnapshot, OperationsStatusStateError> {
    let daemon_dir = daemon_dir.as_ref();
    fs::create_dir_all(daemon_dir).map_err(|source| OperationsStatusStateError::Io {
        path: daemon_dir.to_path_buf(),
        source,
    })?;

    let snapshot = normalize_snapshot(snapshot)?;
    let target_path = operations_status_active_state_path(daemon_dir);
    let tmp_path = daemon_dir.join(format!(
        "{}.tmp.{}.{}",
        OPERATIONS_STATUS_ACTIVE_STATE_FILE_NAME,
        std::process::id(),
        now_nanos()
    ));

    let outcome = (|| {
        write_snapshot_file(&tmp_path, &snapshot)?;
        fs::rename(&tmp_path, &target_path).map_err(|source| OperationsStatusStateError::Io {
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

pub fn operations_status_active_snapshot_from_projects<I>(
    projects: I,
) -> OperationsStatusActiveSnapshot
where
    I: IntoIterator<Item = (String, Vec<String>)>,
{
    OperationsStatusActiveSnapshot {
        schema_version: OPERATIONS_STATUS_ACTIVE_STATE_SCHEMA_VERSION,
        projects: projects
            .into_iter()
            .map(
                |(project_id, conversation_ids)| OperationsStatusActiveProject {
                    project_id,
                    conversation_ids,
                },
            )
            .collect(),
    }
}

fn normalize_snapshot(
    snapshot: OperationsStatusActiveSnapshot,
) -> Result<OperationsStatusActiveSnapshot, OperationsStatusStateError> {
    if snapshot.schema_version != OPERATIONS_STATUS_ACTIVE_STATE_SCHEMA_VERSION {
        return Err(OperationsStatusStateError::UnsupportedSchemaVersion {
            found: snapshot.schema_version,
            expected: OPERATIONS_STATUS_ACTIVE_STATE_SCHEMA_VERSION,
        });
    }

    let mut projects_by_id = BTreeMap::<String, Vec<String>>::new();
    for mut project in snapshot.projects {
        if project.project_id.is_empty() {
            continue;
        }
        project.conversation_ids.sort();
        project.conversation_ids.dedup();
        if project.conversation_ids.is_empty() {
            continue;
        }
        projects_by_id
            .entry(project.project_id)
            .or_default()
            .extend(project.conversation_ids);
    }

    let projects = projects_by_id
        .into_iter()
        .map(|(project_id, mut conversation_ids)| {
            conversation_ids.sort();
            conversation_ids.dedup();
            OperationsStatusActiveProject {
                project_id,
                conversation_ids,
            }
        })
        .collect();

    Ok(OperationsStatusActiveSnapshot {
        schema_version: OPERATIONS_STATUS_ACTIVE_STATE_SCHEMA_VERSION,
        projects,
    })
}

fn write_snapshot_file(
    path: &Path,
    snapshot: &OperationsStatusActiveSnapshot,
) -> Result<(), OperationsStatusStateError> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|source| OperationsStatusStateError::Io {
            path: path.to_path_buf(),
            source,
        })?;
    serde_json::to_writer_pretty(&mut file, snapshot).map_err(|source| {
        OperationsStatusStateError::Json {
            path: path.to_path_buf(),
            source,
        }
    })?;
    file.write_all(b"\n")
        .and_then(|_| file.sync_all())
        .map_err(|source| OperationsStatusStateError::Io {
            path: path.to_path_buf(),
            source,
        })?;
    Ok(())
}

fn sync_parent_dir(path: &Path) -> Result<(), OperationsStatusStateError> {
    if let Some(parent) = path.parent() {
        File::open(parent)
            .and_then(|file| file.sync_all())
            .map_err(|source| OperationsStatusStateError::Io {
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
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn missing_state_reads_as_empty_snapshot() {
        let daemon_dir = unique_temp_daemon_dir();
        let snapshot = read_operations_status_active_snapshot(&daemon_dir)
            .expect("missing state must read as empty");

        assert_eq!(snapshot, empty_operations_status_active_snapshot());
        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn write_and_read_normalizes_active_conversations() {
        let daemon_dir = unique_temp_daemon_dir();
        let written = write_operations_status_active_snapshot(
            &daemon_dir,
            operations_status_active_snapshot_from_projects([
                (
                    "project-b".to_string(),
                    vec!["conversation-2".to_string(), "conversation-2".to_string()],
                ),
                ("project-empty".to_string(), Vec::new()),
                (
                    "project-a".to_string(),
                    vec!["conversation-3".to_string(), "conversation-1".to_string()],
                ),
            ]),
        )
        .expect("state write must succeed");

        assert_eq!(
            written.projects,
            vec![
                OperationsStatusActiveProject {
                    project_id: "project-a".to_string(),
                    conversation_ids: vec![
                        "conversation-1".to_string(),
                        "conversation-3".to_string()
                    ],
                },
                OperationsStatusActiveProject {
                    project_id: "project-b".to_string(),
                    conversation_ids: vec!["conversation-2".to_string()],
                },
            ]
        );
        assert_eq!(
            read_operations_status_active_snapshot(&daemon_dir).expect("state read must succeed"),
            written
        );

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn unsupported_schema_version_fails_closed() {
        let daemon_dir = unique_temp_daemon_dir();
        fs::create_dir_all(&daemon_dir).expect("daemon dir must create");
        fs::write(
            operations_status_active_state_path(&daemon_dir),
            r#"{"schemaVersion":999,"projects":[]}"#,
        )
        .expect("state must write");

        let error = read_operations_status_active_snapshot(&daemon_dir)
            .expect_err("unsupported schema must fail");
        assert!(matches!(
            error,
            OperationsStatusStateError::UnsupportedSchemaVersion {
                found: 999,
                expected: OPERATIONS_STATUS_ACTIVE_STATE_SCHEMA_VERSION
            }
        ));

        cleanup_temp_dir(daemon_dir);
    }

    fn unique_temp_daemon_dir() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be after UNIX_EPOCH")
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("tenex-operations-status-state-{unique}-{counter}"))
    }

    fn cleanup_temp_dir(path: PathBuf) {
        if path.exists() {
            fs::remove_dir_all(path).expect("temp dir cleanup must succeed");
        }
    }
}
