use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::worker_dispatch_input::{
    WORKER_DISPATCH_INPUTS_DIR_NAME, WorkerDispatchExecuteFields, WorkerDispatchInput,
    WorkerDispatchInputError, WorkerDispatchInputFromExecuteFields, WorkerDispatchInputSourceType,
    WorkerDispatchInputValidationError, WorkerDispatchInputWriterMetadata,
    read_optional as read_optional_worker_dispatch_input, worker_dispatch_input_path,
    worker_dispatch_inputs_dir, write_create_or_compare_equal as write_worker_dispatch_input,
};
use crate::worker_protocol::AgentWorkerExecutionFlags;

pub const SCHEDULED_TASK_DISPATCH_INPUTS_DIR_NAME: &str = WORKER_DISPATCH_INPUTS_DIR_NAME;
pub const SCHEDULED_TASK_DISPATCH_INPUT_WRITER: &str = "scheduled_task_dispatch_input";
pub const SCHEDULED_TASK_DISPATCH_INPUT_WRITER_VERSION: &str = "1";

#[derive(Debug, Error)]
pub enum ScheduledTaskDispatchInputError {
    #[error("scheduled task dispatch input io error: {0}")]
    Io(#[from] io::Error),
    #[error("scheduled task dispatch input json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("scheduled task dispatch input conflict at {path}")]
    DispatchInputConflict { path: PathBuf },
    #[error("scheduled task dispatch input worker dispatch input error: {0}")]
    WorkerDispatchInput(WorkerDispatchInputError),
    #[error(
        "scheduled task dispatch input {dispatch_id} has source type {source_type:?}, expected scheduled_task"
    )]
    UnexpectedSourceType {
        dispatch_id: String,
        source_type: WorkerDispatchInputSourceType,
    },
    #[error("scheduled task dispatch input {dispatch_id} is missing task diagnostic metadata")]
    MissingTaskDiagnosticMetadata { dispatch_id: String },
    #[error("scheduled task dispatch input {dispatch_id} is missing worker id")]
    MissingWorkerId { dispatch_id: String },
    #[error("scheduled task dispatch input {dispatch_id} is invalid: {source}")]
    InvalidWorkerDispatchInput {
        dispatch_id: String,
        #[source]
        source: WorkerDispatchInputValidationError,
    },
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduledTaskDispatchInputWriteMetadata {
    pub writer: String,
    pub writer_version: String,
    pub timestamp: u64,
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
    #[serde(default)]
    pending_delegation_ids: Vec<String>,
    debug: bool,
}

impl Default for ScheduledTaskDispatchInputWriteMetadata {
    fn default() -> Self {
        Self {
            writer: SCHEDULED_TASK_DISPATCH_INPUT_WRITER.to_string(),
            writer_version: SCHEDULED_TASK_DISPATCH_INPUT_WRITER_VERSION.to_string(),
            timestamp: 0,
        }
    }
}

impl From<AgentWorkerExecutionFlagsRaw> for AgentWorkerExecutionFlags {
    fn from(raw: AgentWorkerExecutionFlagsRaw) -> Self {
        Self {
            is_delegation_completion: raw.is_delegation_completion,
            has_pending_delegations: raw.has_pending_delegations,
            pending_delegation_ids: raw.pending_delegation_ids,
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
    worker_dispatch_inputs_dir(daemon_dir)
}

pub fn scheduled_task_dispatch_input_path(
    daemon_dir: impl AsRef<Path>,
    dispatch_id: &str,
) -> PathBuf {
    worker_dispatch_input_path(daemon_dir, dispatch_id)
}

pub fn read_optional(
    daemon_dir: impl AsRef<Path>,
    dispatch_id: &str,
) -> ScheduledTaskDispatchInputResult<Option<ScheduledTaskDispatchInput>> {
    read_optional_worker_dispatch_input(daemon_dir, dispatch_id)
        .map_err(map_worker_dispatch_input_error)?
        .map(scheduled_task_input_from_worker_dispatch_input)
        .transpose()
}

pub fn write_create_or_compare_equal(
    daemon_dir: impl AsRef<Path>,
    input: &ScheduledTaskDispatchInput,
) -> ScheduledTaskDispatchInputResult<ScheduledTaskDispatchInput> {
    write_create_or_compare_equal_with_metadata(
        daemon_dir,
        input,
        ScheduledTaskDispatchInputWriteMetadata::default(),
    )
}

pub fn write_create_or_compare_equal_with_metadata(
    daemon_dir: impl AsRef<Path>,
    input: &ScheduledTaskDispatchInput,
    metadata: ScheduledTaskDispatchInputWriteMetadata,
) -> ScheduledTaskDispatchInputResult<ScheduledTaskDispatchInput> {
    let worker_input = worker_dispatch_input_from_scheduled_task_input(input, metadata)?;
    let written = write_worker_dispatch_input(daemon_dir, &worker_input)
        .map_err(map_worker_dispatch_input_error)?;
    scheduled_task_input_from_worker_dispatch_input(written)
}

fn worker_dispatch_input_from_scheduled_task_input(
    input: &ScheduledTaskDispatchInput,
    metadata: ScheduledTaskDispatchInputWriteMetadata,
) -> ScheduledTaskDispatchInputResult<WorkerDispatchInput> {
    Ok(WorkerDispatchInput::from_execute_fields(
        WorkerDispatchInputFromExecuteFields {
            dispatch_id: input.dispatch_id.clone(),
            source_type: WorkerDispatchInputSourceType::ScheduledTask,
            writer: WorkerDispatchInputWriterMetadata {
                writer: metadata.writer,
                writer_version: metadata.writer_version,
                timestamp: metadata.timestamp,
            },
            execute_fields: WorkerDispatchExecuteFields {
                worker_id: Some(input.worker_id.clone()),
                triggering_event_id: input.triggering_event_id.clone(),
                project_base_path: input.project_base_path.clone(),
                metadata_path: input.metadata_path.clone(),
                triggering_envelope: input.triggering_envelope.clone(),
                execution_flags: input.execution_flags.clone(),
            },
            source_metadata: Some(serde_json::to_value(&input.task_diagnostic_metadata)?),
        },
    ))
}

fn scheduled_task_input_from_worker_dispatch_input(
    input: WorkerDispatchInput,
) -> ScheduledTaskDispatchInputResult<ScheduledTaskDispatchInput> {
    if input.source_type != WorkerDispatchInputSourceType::ScheduledTask {
        return Err(ScheduledTaskDispatchInputError::UnexpectedSourceType {
            dispatch_id: input.dispatch_id,
            source_type: input.source_type,
        });
    }

    let fields = input.resolved_execute_fields().map_err(|source| {
        ScheduledTaskDispatchInputError::InvalidWorkerDispatchInput {
            dispatch_id: input.dispatch_id.clone(),
            source,
        }
    })?;
    let worker_id =
        fields
            .worker_id
            .ok_or_else(|| ScheduledTaskDispatchInputError::MissingWorkerId {
                dispatch_id: input.dispatch_id.clone(),
            })?;
    let source_metadata = input.source_metadata.ok_or_else(|| {
        ScheduledTaskDispatchInputError::MissingTaskDiagnosticMetadata {
            dispatch_id: input.dispatch_id.clone(),
        }
    })?;
    let task_diagnostic_metadata = serde_json::from_value(source_metadata)?;

    Ok(ScheduledTaskDispatchInput {
        dispatch_id: input.dispatch_id,
        triggering_event_id: fields.triggering_event_id,
        worker_id,
        project_base_path: fields.project_base_path,
        metadata_path: fields.metadata_path,
        triggering_envelope: fields.triggering_envelope,
        execution_flags: fields.execution_flags,
        task_diagnostic_metadata,
    })
}

fn map_worker_dispatch_input_error(
    error: WorkerDispatchInputError,
) -> ScheduledTaskDispatchInputError {
    match error {
        WorkerDispatchInputError::Io(source) => ScheduledTaskDispatchInputError::Io(source),
        WorkerDispatchInputError::DispatchInputConflict { path } => {
            ScheduledTaskDispatchInputError::DispatchInputConflict { path }
        }
        other => ScheduledTaskDispatchInputError::WorkerDispatchInput(other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

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

        let raw: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(scheduled_task_dispatch_input_path(
                &daemon_dir,
                "dispatch-a",
            ))
            .expect("dispatch input file must read"),
        )
        .expect("dispatch input json must parse");
        assert_eq!(raw["schemaVersion"], json!(1));
        assert_eq!(raw["sourceType"], json!("scheduled_task"));
        assert_eq!(
            raw["writer"]["writer"],
            json!(SCHEDULED_TASK_DISPATCH_INPUT_WRITER)
        );

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn equal_rewrite_is_idempotent() {
        let daemon_dir = unique_temp_daemon_dir();
        let input = dispatch_input("dispatch-idempotent");

        write_create_or_compare_equal(&daemon_dir, &input)
            .expect("initial dispatch input write must succeed");
        let rewritten = write_create_or_compare_equal_with_metadata(
            &daemon_dir,
            &input,
            ScheduledTaskDispatchInputWriteMetadata {
                writer: SCHEDULED_TASK_DISPATCH_INPUT_WRITER.to_string(),
                writer_version: "newer-writer".to_string(),
                timestamp: 1_710_001_500,
            },
        )
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
                "transport": "nostr",
                "principal": {
                    "id": "nostr:owner-a",
                    "transport": "nostr",
                    "kind": "human"
                },
                "channel": {
                    "id": "conversation:conversation-a",
                    "transport": "nostr",
                    "kind": "conversation"
                },
                "message": {
                    "id": "event-scheduled-task-a",
                    "transport": "nostr",
                    "nativeId": "event-scheduled-task-a"
                },
                "recipients": [
                    {
                        "id": "nostr:agent-pubkey-a",
                        "transport": "nostr",
                        "kind": "agent"
                    }
                ],
                "content": "Run scheduled task",
                "occurredAt": 1_710_001_000_000u64,
                "capabilities": ["reply"],
                "metadata": {}
            }),
            execution_flags: AgentWorkerExecutionFlags {
                is_delegation_completion: false,
                has_pending_delegations: false,
                pending_delegation_ids: Vec::new(),
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
