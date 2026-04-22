use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::dispatch_queue::workers_dir;
use crate::worker_protocol::AgentWorkerExecutionFlags;

pub const SCHEDULED_TASK_DISPATCH_INPUTS_DIR_NAME: &str = "dispatch-inputs";

#[derive(Debug, Error)]
pub enum ScheduledTaskDispatchInputError {
    #[error("scheduled task dispatch input io error: {0}")]
    Io(#[from] io::Error),
    #[error("scheduled task dispatch input json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("scheduled task dispatch input conflict at {path}")]
    DispatchInputConflict { path: PathBuf },
}

pub type ScheduledTaskDispatchInputResult<T> = Result<T, ScheduledTaskDispatchInputError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ScheduledTaskDispatchTaskKind {
    Cron,
    Oneoff,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTaskDispatchTaskDiagnosticMetadata {
    pub project_d_tag: String,
    pub project_ref: String,
    pub task_id: String,
    pub title: String,
    pub from_pubkey: String,
    pub target_agent: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_channel: Option<String>,
    pub schedule: String,
    pub kind: ScheduledTaskDispatchTaskKind,
    pub due_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTaskDispatchInput {
    pub dispatch_id: String,
    pub triggering_event_id: String,
    pub worker_id: String,
    pub project_base_path: String,
    pub metadata_path: String,
    pub triggering_envelope: serde_json::Value,
    pub execution_flags: AgentWorkerExecutionFlags,
    pub task_diagnostic_metadata: ScheduledTaskDispatchTaskDiagnosticMetadata,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScheduledTaskDispatchInputRaw {
    dispatch_id: String,
    triggering_event_id: String,
    worker_id: String,
    project_base_path: String,
    metadata_path: String,
    triggering_envelope: serde_json::Value,
    execution_flags: AgentWorkerExecutionFlagsRaw,
    task_diagnostic_metadata: ScheduledTaskDispatchTaskDiagnosticMetadata,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentWorkerExecutionFlagsRaw {
    is_delegation_completion: bool,
    has_pending_delegations: bool,
    debug: bool,
}

impl From<AgentWorkerExecutionFlagsRaw> for AgentWorkerExecutionFlags {
    fn from(raw: AgentWorkerExecutionFlagsRaw) -> Self {
        Self {
            is_delegation_completion: raw.is_delegation_completion,
            has_pending_delegations: raw.has_pending_delegations,
            debug: raw.debug,
        }
    }
}

impl<'de> Deserialize<'de> for ScheduledTaskDispatchInput {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let raw = ScheduledTaskDispatchInputRaw::deserialize(deserializer)?;
        Ok(Self {
            dispatch_id: raw.dispatch_id,
            triggering_event_id: raw.triggering_event_id,
            worker_id: raw.worker_id,
            project_base_path: raw.project_base_path,
            metadata_path: raw.metadata_path,
            triggering_envelope: raw.triggering_envelope,
            execution_flags: raw.execution_flags.into(),
            task_diagnostic_metadata: raw.task_diagnostic_metadata,
        })
    }
}

pub fn scheduled_task_dispatch_inputs_dir(daemon_dir: impl AsRef<Path>) -> PathBuf {
    workers_dir(daemon_dir).join(SCHEDULED_TASK_DISPATCH_INPUTS_DIR_NAME)
}

pub fn scheduled_task_dispatch_input_path(
    daemon_dir: impl AsRef<Path>,
    dispatch_id: &str,
) -> PathBuf {
    scheduled_task_dispatch_inputs_dir(daemon_dir).join(format!("{dispatch_id}.json"))
}

pub fn read_optional(
    daemon_dir: impl AsRef<Path>,
    dispatch_id: &str,
) -> ScheduledTaskDispatchInputResult<Option<ScheduledTaskDispatchInput>> {
    let path = scheduled_task_dispatch_input_path(daemon_dir, dispatch_id);
    read_optional_path(path)
}

pub fn write_create_or_compare_equal(
    daemon_dir: impl AsRef<Path>,
    input: &ScheduledTaskDispatchInput,
) -> ScheduledTaskDispatchInputResult<ScheduledTaskDispatchInput> {
    let daemon_dir = daemon_dir.as_ref();
    let inputs_dir = scheduled_task_dispatch_inputs_dir(daemon_dir);
    fs::create_dir_all(&inputs_dir)?;
    let target_path = scheduled_task_dispatch_input_path(daemon_dir, &input.dispatch_id);

    if let Some(existing) = read_optional_path(&target_path)? {
        return existing_input_or_conflict(target_path, existing, input);
    }

    let tmp_path = inputs_dir.join(format!(
        "{}.{}.{}.tmp",
        input.dispatch_id,
        std::process::id(),
        now_nanos()
    ));
    let write_result = (|| {
        write_input_file(&tmp_path, input)?;
        match fs::hard_link(&tmp_path, &target_path) {
            Ok(()) => {
                remove_optional_file(&tmp_path)?;
                sync_parent_dir(&target_path)?;
                Ok(input.clone())
            }
            Err(source) if source.kind() == io::ErrorKind::AlreadyExists => {
                remove_optional_file(&tmp_path)?;
                let Some(existing) = read_optional_path(&target_path)? else {
                    return Err(ScheduledTaskDispatchInputError::DispatchInputConflict {
                        path: target_path,
                    });
                };
                existing_input_or_conflict(target_path, existing, input)
            }
            Err(source) => Err(source.into()),
        }
    })();

    if write_result.is_err() {
        let _ = fs::remove_file(&tmp_path);
    }
    write_result
}

fn existing_input_or_conflict(
    path: PathBuf,
    existing: ScheduledTaskDispatchInput,
    requested: &ScheduledTaskDispatchInput,
) -> ScheduledTaskDispatchInputResult<ScheduledTaskDispatchInput> {
    if existing == *requested {
        return Ok(existing);
    }
    Err(ScheduledTaskDispatchInputError::DispatchInputConflict { path })
}

fn read_optional_path(
    path: impl AsRef<Path>,
) -> ScheduledTaskDispatchInputResult<Option<ScheduledTaskDispatchInput>> {
    match fs::read_to_string(path) {
        Ok(content) => Ok(Some(serde_json::from_str(&content)?)),
        Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(source) => Err(source.into()),
    }
}

fn write_input_file(
    path: &Path,
    input: &ScheduledTaskDispatchInput,
) -> ScheduledTaskDispatchInputResult<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    serde_json::to_writer_pretty(&mut file, input)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    Ok(())
}

fn remove_optional_file(path: impl AsRef<Path>) -> ScheduledTaskDispatchInputResult<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(source.into()),
    }
}

fn sync_parent_dir(path: &Path) -> ScheduledTaskDispatchInputResult<()> {
    if let Some(parent) = path.parent() {
        File::open(parent)?.sync_all()?;
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
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn write_then_read_dispatch_input() {
        let daemon_dir = unique_temp_daemon_dir();
        let input = dispatch_input("dispatch-a");

        let written = write_create_or_compare_equal(&daemon_dir, &input)
            .expect("dispatch input write must succeed");
        let read = read_optional(&daemon_dir, "dispatch-a")
            .expect("dispatch input read must succeed")
            .expect("dispatch input must exist");

        assert_eq!(written, input);
        assert_eq!(read, input);
        assert_eq!(
            scheduled_task_dispatch_input_path(&daemon_dir, "dispatch-a"),
            daemon_dir
                .join("workers")
                .join("dispatch-inputs")
                .join("dispatch-a.json")
        );

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn equal_rewrite_is_idempotent() {
        let daemon_dir = unique_temp_daemon_dir();
        let input = dispatch_input("dispatch-idempotent");

        write_create_or_compare_equal(&daemon_dir, &input)
            .expect("initial dispatch input write must succeed");
        let rewritten = write_create_or_compare_equal(&daemon_dir, &input)
            .expect("equal dispatch input rewrite must succeed");

        assert_eq!(rewritten, input);
        assert_eq!(
            read_optional(&daemon_dir, "dispatch-idempotent")
                .expect("dispatch input read must succeed"),
            Some(input)
        );

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn different_payload_for_existing_dispatch_conflicts() {
        let daemon_dir = unique_temp_daemon_dir();
        let input = dispatch_input("dispatch-conflict");
        let mut conflicting = input.clone();
        conflicting.task_diagnostic_metadata.title = "Different task".to_string();

        write_create_or_compare_equal(&daemon_dir, &input)
            .expect("initial dispatch input write must succeed");
        let error = write_create_or_compare_equal(&daemon_dir, &conflicting)
            .expect_err("different dispatch input payload must conflict");

        match error {
            ScheduledTaskDispatchInputError::DispatchInputConflict { path } => {
                assert_eq!(
                    path,
                    scheduled_task_dispatch_input_path(&daemon_dir, "dispatch-conflict")
                );
            }
            other => panic!("unexpected error: {other:?}"),
        }
        assert_eq!(
            read_optional(&daemon_dir, "dispatch-conflict")
                .expect("dispatch input read must succeed"),
            Some(input)
        );

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    fn dispatch_input(dispatch_id: &str) -> ScheduledTaskDispatchInput {
        ScheduledTaskDispatchInput {
            dispatch_id: dispatch_id.to_string(),
            triggering_event_id: "event-scheduled-task-a".to_string(),
            worker_id: "scheduled-task-worker-a".to_string(),
            project_base_path: "/projects/example".to_string(),
            metadata_path: "/projects/example/.tenex/metadata.json".to_string(),
            triggering_envelope: json!({
                "id": "event-scheduled-task-a",
                "kind": 24100,
                "content": "Run scheduled task",
                "tags": [["p", "agent-pubkey-a"]]
            }),
            execution_flags: AgentWorkerExecutionFlags {
                is_delegation_completion: false,
                has_pending_delegations: false,
                debug: true,
            },
            task_diagnostic_metadata: ScheduledTaskDispatchTaskDiagnosticMetadata {
                project_d_tag: "project-d-tag-a".to_string(),
                project_ref: "project-ref-a".to_string(),
                task_id: "task-a".to_string(),
                title: "Nightly check".to_string(),
                from_pubkey: "owner-pubkey-a".to_string(),
                target_agent: "agent-slug-a".to_string(),
                target_channel: Some("telegram:chat-a".to_string()),
                schedule: "0 0 * * *".to_string(),
                kind: ScheduledTaskDispatchTaskKind::Cron,
                due_at: 1_710_001_000,
                last_run: Some(1_710_000_000),
            },
        }
    }

    fn unique_temp_daemon_dir() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after Unix epoch")
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let daemon_dir = std::env::temp_dir().join(format!(
            "tenex-scheduled-task-dispatch-input-{unique}-{counter}"
        ));
        fs::create_dir_all(&daemon_dir).expect("temp daemon dir must be created");
        daemon_dir
    }
}
