use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use thiserror::Error;

use crate::dispatch_queue::workers_dir;
use crate::worker_protocol::{
    AgentWorkerExecutionFlags, WorkerProtocolError, validate_agent_worker_protocol_message,
};

pub const WORKER_DISPATCH_INPUT_SCHEMA_VERSION: u32 = 1;
pub const WORKER_DISPATCH_INPUTS_DIR_NAME: &str = "dispatch-inputs";

#[derive(Debug, Error)]
pub enum WorkerDispatchInputError {
    #[error("worker dispatch input io error: {0}")]
    Io(#[from] io::Error),
    #[error("worker dispatch input json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("worker dispatch input conflict at {path}")]
    DispatchInputConflict { path: PathBuf },
    #[error("worker dispatch input missing schemaVersion")]
    MissingSchemaVersion,
    #[error("worker dispatch input schemaVersion must be an unsigned integer")]
    InvalidSchemaVersion,
    #[error("worker dispatch input schemaVersion {schema_version} is not supported")]
    UnsupportedSchemaVersion { schema_version: u32 },
    #[error("worker dispatch input validation failed: {0}")]
    Validation(#[from] WorkerDispatchInputValidationError),
}

pub type WorkerDispatchInputResult<T> = Result<T, WorkerDispatchInputError>;

#[derive(Debug, Error)]
pub enum WorkerDispatchInputValidationError {
    #[error("schemaVersion {schema_version} is not supported")]
    UnsupportedSchemaVersion { schema_version: u32 },
    #[error("dispatchId must not be empty")]
    EmptyDispatchId,
    #[error("writer must not be empty")]
    EmptyWriter,
    #[error("writerVersion must not be empty")]
    EmptyWriterVersion,
    #[error("executeMessage and executeFields cannot both be present")]
    ConflictingExecuteInputs,
    #[error("one of executeMessage or executeFields is required")]
    MissingExecuteInput,
    #[error("executeMessage is invalid: {source}")]
    InvalidExecuteMessage {
        #[source]
        source: WorkerProtocolError,
    },
    #[error("executeMessage must have type execute, got {actual}")]
    UnexpectedExecuteMessageType { actual: String },
    #[error("execute field {field} must not be empty")]
    EmptyExecuteField { field: &'static str },
    #[error("triggeringEnvelope must be an object")]
    InvalidTriggeringEnvelope,
    #[error("triggeringEnvelope.message must be an object")]
    InvalidTriggeringEnvelopeMessage,
    #[error("triggeringEnvelope.message.nativeId must be a string")]
    InvalidTriggeringEnvelopeNativeId,
    #[error(
        "execute field triggeringEventId {triggering_event_id} does not match triggeringEnvelope.message.nativeId {native_id}"
    )]
    TriggeringEnvelopeMismatch {
        triggering_event_id: String,
        native_id: String,
    },
    #[error("executeMessage field {field} is missing or invalid")]
    InvalidExecuteMessageField { field: &'static str },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerDispatchInputSourceType {
    ScheduledTask,
    Nostr,
    Telegram,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerDispatchInputWriterMetadata {
    pub writer: String,
    pub writer_version: String,
    pub timestamp: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerDispatchExecuteFields {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker_id: Option<String>,
    pub triggering_event_id: String,
    pub project_base_path: String,
    pub metadata_path: String,
    pub triggering_envelope: Value,
    pub execution_flags: AgentWorkerExecutionFlags,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerDispatchInput {
    pub schema_version: u32,
    pub dispatch_id: String,
    pub source_type: WorkerDispatchInputSourceType,
    pub writer: WorkerDispatchInputWriterMetadata,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execute_message: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execute_fields: Option<WorkerDispatchExecuteFields>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_metadata: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerDispatchInputRaw {
    schema_version: u32,
    dispatch_id: String,
    source_type: WorkerDispatchInputSourceType,
    writer: WorkerDispatchInputWriterMetadata,
    #[serde(default)]
    execute_message: Option<Value>,
    #[serde(default)]
    execute_fields: Option<WorkerDispatchExecuteFields>,
    #[serde(default)]
    source_metadata: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerDispatchInputFromExecuteFields {
    pub dispatch_id: String,
    pub source_type: WorkerDispatchInputSourceType,
    pub writer: WorkerDispatchInputWriterMetadata,
    pub execute_fields: WorkerDispatchExecuteFields,
    pub source_metadata: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerDispatchInputFromExecuteMessage {
    pub dispatch_id: String,
    pub source_type: WorkerDispatchInputSourceType,
    pub writer: WorkerDispatchInputWriterMetadata,
    pub execute_message: Value,
    pub source_metadata: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerDispatchExecuteFieldsRaw {
    #[serde(default)]
    worker_id: Option<String>,
    triggering_event_id: String,
    project_base_path: String,
    metadata_path: String,
    triggering_envelope: Value,
    execution_flags: AgentWorkerExecutionFlagsRaw,
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

impl From<WorkerDispatchExecuteFieldsRaw> for WorkerDispatchExecuteFields {
    fn from(raw: WorkerDispatchExecuteFieldsRaw) -> Self {
        Self {
            worker_id: raw.worker_id,
            triggering_event_id: raw.triggering_event_id,
            project_base_path: raw.project_base_path,
            metadata_path: raw.metadata_path,
            triggering_envelope: raw.triggering_envelope,
            execution_flags: raw.execution_flags.into(),
        }
    }
}

impl<'de> Deserialize<'de> for WorkerDispatchExecuteFields {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Ok(WorkerDispatchExecuteFieldsRaw::deserialize(deserializer)?.into())
    }
}

impl From<WorkerDispatchInputRaw> for WorkerDispatchInput {
    fn from(raw: WorkerDispatchInputRaw) -> Self {
        Self {
            schema_version: raw.schema_version,
            dispatch_id: raw.dispatch_id,
            source_type: raw.source_type,
            writer: raw.writer,
            execute_message: raw.execute_message,
            execute_fields: raw.execute_fields,
            source_metadata: raw.source_metadata,
        }
    }
}

impl<'de> Deserialize<'de> for WorkerDispatchInput {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Ok(WorkerDispatchInputRaw::deserialize(deserializer)?.into())
    }
}

impl WorkerDispatchInput {
    pub fn from_execute_fields(params: WorkerDispatchInputFromExecuteFields) -> Self {
        Self {
            schema_version: WORKER_DISPATCH_INPUT_SCHEMA_VERSION,
            dispatch_id: params.dispatch_id,
            source_type: params.source_type,
            writer: params.writer,
            execute_message: None,
            execute_fields: Some(params.execute_fields),
            source_metadata: params.source_metadata,
        }
    }

    pub fn from_execute_message(params: WorkerDispatchInputFromExecuteMessage) -> Self {
        Self {
            schema_version: WORKER_DISPATCH_INPUT_SCHEMA_VERSION,
            dispatch_id: params.dispatch_id,
            source_type: params.source_type,
            writer: params.writer,
            execute_message: Some(params.execute_message),
            execute_fields: None,
            source_metadata: params.source_metadata,
        }
    }

    pub fn resolved_execute_fields(
        &self,
    ) -> Result<WorkerDispatchExecuteFields, WorkerDispatchInputValidationError> {
        match (&self.execute_message, &self.execute_fields) {
            (None, Some(fields)) => Ok(fields.clone()),
            (Some(message), None) => execute_fields_from_execute_message(message),
            (Some(_), Some(_)) => Err(WorkerDispatchInputValidationError::ConflictingExecuteInputs),
            (None, None) => Err(WorkerDispatchInputValidationError::MissingExecuteInput),
        }
    }

    fn has_same_dispatch_contract(&self, other: &Self) -> bool {
        self.schema_version == other.schema_version
            && self.dispatch_id == other.dispatch_id
            && self.source_type == other.source_type
            && self.execute_message == other.execute_message
            && self.execute_fields == other.execute_fields
            && self.source_metadata == other.source_metadata
    }
}

pub fn worker_dispatch_inputs_dir(daemon_dir: impl AsRef<Path>) -> PathBuf {
    workers_dir(daemon_dir).join(WORKER_DISPATCH_INPUTS_DIR_NAME)
}

pub fn worker_dispatch_input_path(daemon_dir: impl AsRef<Path>, dispatch_id: &str) -> PathBuf {
    worker_dispatch_inputs_dir(daemon_dir).join(format!("{dispatch_id}.json"))
}

pub fn read_optional(
    daemon_dir: impl AsRef<Path>,
    dispatch_id: &str,
) -> WorkerDispatchInputResult<Option<WorkerDispatchInput>> {
    read_optional_path(worker_dispatch_input_path(daemon_dir, dispatch_id))
}

pub fn write_create_or_compare_equal(
    daemon_dir: impl AsRef<Path>,
    input: &WorkerDispatchInput,
) -> WorkerDispatchInputResult<WorkerDispatchInput> {
    validate_worker_dispatch_input(input)?;

    let daemon_dir = daemon_dir.as_ref();
    let inputs_dir = worker_dispatch_inputs_dir(daemon_dir);
    fs::create_dir_all(&inputs_dir)?;
    let target_path = worker_dispatch_input_path(daemon_dir, &input.dispatch_id);

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
                    return Err(WorkerDispatchInputError::DispatchInputConflict {
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

pub fn validate_worker_dispatch_input(
    input: &WorkerDispatchInput,
) -> Result<(), WorkerDispatchInputValidationError> {
    if input.schema_version != WORKER_DISPATCH_INPUT_SCHEMA_VERSION {
        return Err(
            WorkerDispatchInputValidationError::UnsupportedSchemaVersion {
                schema_version: input.schema_version,
            },
        );
    }
    if input.dispatch_id.trim().is_empty() {
        return Err(WorkerDispatchInputValidationError::EmptyDispatchId);
    }
    if input.writer.writer.trim().is_empty() {
        return Err(WorkerDispatchInputValidationError::EmptyWriter);
    }
    if input.writer.writer_version.trim().is_empty() {
        return Err(WorkerDispatchInputValidationError::EmptyWriterVersion);
    }

    match (&input.execute_message, &input.execute_fields) {
        (Some(message), None) => validate_execute_message(message),
        (None, Some(fields)) => validate_execute_fields(fields),
        (Some(_), Some(_)) => Err(WorkerDispatchInputValidationError::ConflictingExecuteInputs),
        (None, None) => Err(WorkerDispatchInputValidationError::MissingExecuteInput),
    }
}

fn existing_input_or_conflict(
    path: PathBuf,
    existing: WorkerDispatchInput,
    requested: &WorkerDispatchInput,
) -> WorkerDispatchInputResult<WorkerDispatchInput> {
    if existing.has_same_dispatch_contract(requested) {
        return Ok(existing);
    }
    Err(WorkerDispatchInputError::DispatchInputConflict { path })
}

fn read_optional_path(
    path: impl AsRef<Path>,
) -> WorkerDispatchInputResult<Option<WorkerDispatchInput>> {
    match fs::read_to_string(path) {
        Ok(content) => {
            let value: Value = serde_json::from_str(&content)?;
            validate_schema_version(&value)?;
            let input: WorkerDispatchInput = serde_json::from_value(value)?;
            validate_worker_dispatch_input(&input)?;
            Ok(Some(input))
        }
        Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(source) => Err(source.into()),
    }
}

fn validate_schema_version(value: &Value) -> WorkerDispatchInputResult<()> {
    let schema_version = value
        .get("schemaVersion")
        .ok_or(WorkerDispatchInputError::MissingSchemaVersion)?;
    let schema_version = schema_version
        .as_u64()
        .ok_or(WorkerDispatchInputError::InvalidSchemaVersion)?;
    let schema_version = u32::try_from(schema_version)
        .map_err(|_| WorkerDispatchInputError::InvalidSchemaVersion)?;

    if schema_version == WORKER_DISPATCH_INPUT_SCHEMA_VERSION {
        return Ok(());
    }
    Err(WorkerDispatchInputError::UnsupportedSchemaVersion { schema_version })
}

fn write_input_file(path: &Path, input: &WorkerDispatchInput) -> WorkerDispatchInputResult<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    serde_json::to_writer_pretty(&mut file, input)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    Ok(())
}

fn validate_execute_message(message: &Value) -> Result<(), WorkerDispatchInputValidationError> {
    validate_agent_worker_protocol_message(message)
        .map_err(|source| WorkerDispatchInputValidationError::InvalidExecuteMessage { source })?;
    let actual = message
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("<missing>");
    if actual != "execute" {
        return Err(
            WorkerDispatchInputValidationError::UnexpectedExecuteMessageType {
                actual: actual.to_string(),
            },
        );
    }
    Ok(())
}

fn validate_execute_fields(
    fields: &WorkerDispatchExecuteFields,
) -> Result<(), WorkerDispatchInputValidationError> {
    require_nonempty(&fields.triggering_event_id, "triggeringEventId")?;
    require_nonempty(&fields.project_base_path, "projectBasePath")?;
    require_nonempty(&fields.metadata_path, "metadataPath")?;

    if let Some(worker_id) = fields.worker_id.as_deref() {
        require_nonempty(worker_id, "workerId")?;
    }

    let native_id = triggering_envelope_native_id(&fields.triggering_envelope)?;
    if fields.triggering_event_id != native_id {
        return Err(
            WorkerDispatchInputValidationError::TriggeringEnvelopeMismatch {
                triggering_event_id: fields.triggering_event_id.clone(),
                native_id,
            },
        );
    }

    Ok(())
}

fn execute_fields_from_execute_message(
    message: &Value,
) -> Result<WorkerDispatchExecuteFields, WorkerDispatchInputValidationError> {
    validate_execute_message(message)?;
    let object = message.as_object().ok_or(
        WorkerDispatchInputValidationError::InvalidExecuteMessageField { field: "message" },
    )?;
    let triggering_envelope =
        require_value(object, "triggeringEnvelope", "triggeringEnvelope")?.clone();
    let triggering_event_id = triggering_envelope_native_id(&triggering_envelope)?;
    let flags = require_object(object, "executionFlags", "executionFlags")?;

    Ok(WorkerDispatchExecuteFields {
        worker_id: None,
        triggering_event_id,
        project_base_path: require_string(object, "projectBasePath")?.to_string(),
        metadata_path: require_string(object, "metadataPath")?.to_string(),
        triggering_envelope,
        execution_flags: AgentWorkerExecutionFlags {
            is_delegation_completion: require_bool(flags, "isDelegationCompletion")?,
            has_pending_delegations: require_bool(flags, "hasPendingDelegations")?,
            debug: require_bool(flags, "debug")?,
        },
    })
}

fn triggering_envelope_native_id(
    envelope: &Value,
) -> Result<String, WorkerDispatchInputValidationError> {
    let envelope = envelope
        .as_object()
        .ok_or(WorkerDispatchInputValidationError::InvalidTriggeringEnvelope)?;
    let message = envelope
        .get("message")
        .and_then(Value::as_object)
        .ok_or(WorkerDispatchInputValidationError::InvalidTriggeringEnvelopeMessage)?;
    let native_id = message
        .get("nativeId")
        .and_then(Value::as_str)
        .ok_or(WorkerDispatchInputValidationError::InvalidTriggeringEnvelopeNativeId)?;
    Ok(native_id.to_string())
}

fn require_nonempty(
    value: &str,
    field: &'static str,
) -> Result<(), WorkerDispatchInputValidationError> {
    if value.trim().is_empty() {
        return Err(WorkerDispatchInputValidationError::EmptyExecuteField { field });
    }
    Ok(())
}

fn require_value<'a>(
    object: &'a Map<String, Value>,
    key: &'static str,
    field: &'static str,
) -> Result<&'a Value, WorkerDispatchInputValidationError> {
    object
        .get(key)
        .ok_or(WorkerDispatchInputValidationError::InvalidExecuteMessageField { field })
}

fn require_object<'a>(
    object: &'a Map<String, Value>,
    key: &'static str,
    field: &'static str,
) -> Result<&'a Map<String, Value>, WorkerDispatchInputValidationError> {
    require_value(object, key, field)?
        .as_object()
        .ok_or(WorkerDispatchInputValidationError::InvalidExecuteMessageField { field })
}

fn require_string<'a>(
    object: &'a Map<String, Value>,
    key: &'static str,
) -> Result<&'a str, WorkerDispatchInputValidationError> {
    object
        .get(key)
        .and_then(Value::as_str)
        .ok_or(WorkerDispatchInputValidationError::InvalidExecuteMessageField { field: key })
}

fn require_bool(
    object: &Map<String, Value>,
    key: &'static str,
) -> Result<bool, WorkerDispatchInputValidationError> {
    object
        .get(key)
        .and_then(Value::as_bool)
        .ok_or(WorkerDispatchInputValidationError::InvalidExecuteMessageField { field: key })
}

fn remove_optional_file(path: impl AsRef<Path>) -> WorkerDispatchInputResult<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(source.into()),
    }
}

fn sync_parent_dir(path: &Path) -> WorkerDispatchInputResult<()> {
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
    fn write_then_read_execute_fields_dispatch_input() {
        let daemon_dir = unique_temp_daemon_dir();
        let input = dispatch_input_from_fields("dispatch-a");

        let written = write_create_or_compare_equal(&daemon_dir, &input)
            .expect("dispatch input write must succeed");
        let read = read_optional(&daemon_dir, "dispatch-a")
            .expect("dispatch input read must succeed")
            .expect("dispatch input must exist");

        assert_eq!(written, input);
        assert_eq!(read, input);
        assert_eq!(
            worker_dispatch_input_path(&daemon_dir, "dispatch-a"),
            daemon_dir
                .join("workers")
                .join("dispatch-inputs")
                .join("dispatch-a.json")
        );
        let file = fs::read_to_string(worker_dispatch_input_path(&daemon_dir, "dispatch-a"))
            .expect("dispatch input file must read");
        assert!(file.contains("\"schemaVersion\": 1"));
        assert!(file.contains("\"sourceType\": \"scheduled_task\""));
        assert!(file.contains("\"writerVersion\": \"test-writer\""));

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn equal_dispatch_contract_rewrite_keeps_existing_writer_metadata() {
        let daemon_dir = unique_temp_daemon_dir();
        let input = dispatch_input_from_fields("dispatch-idempotent");
        let mut later_writer = input.clone();
        later_writer.writer.timestamp = 1_710_001_111;
        later_writer.writer.writer_version = "newer-writer".to_string();

        write_create_or_compare_equal(&daemon_dir, &input)
            .expect("initial dispatch input write must succeed");
        let rewritten = write_create_or_compare_equal(&daemon_dir, &later_writer)
            .expect("equal dispatch contract rewrite must succeed");

        assert_eq!(rewritten, input);
        assert_eq!(
            read_optional(&daemon_dir, "dispatch-idempotent")
                .expect("dispatch input read must succeed"),
            Some(input)
        );

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn different_dispatch_contract_for_existing_dispatch_conflicts() {
        let daemon_dir = unique_temp_daemon_dir();
        let input = dispatch_input_from_fields("dispatch-conflict");
        let mut conflicting = input.clone();
        conflicting.source_metadata = Some(json!({ "taskId": "different-task" }));

        write_create_or_compare_equal(&daemon_dir, &input)
            .expect("initial dispatch input write must succeed");
        let error = write_create_or_compare_equal(&daemon_dir, &conflicting)
            .expect_err("different dispatch input payload must conflict");

        match error {
            WorkerDispatchInputError::DispatchInputConflict { path } => {
                assert_eq!(
                    path,
                    worker_dispatch_input_path(&daemon_dir, "dispatch-conflict")
                );
            }
            other => panic!("unexpected error: {other:?}"),
        }

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn unsupported_schema_version_is_rejected_on_read() {
        let daemon_dir = unique_temp_daemon_dir();
        let path = worker_dispatch_input_path(&daemon_dir, "dispatch-schema");
        fs::create_dir_all(path.parent().expect("path must have parent"))
            .expect("dispatch input dir must be created");
        fs::write(
            &path,
            serde_json::to_string_pretty(&json!({
                "schemaVersion": 2,
                "dispatchId": "dispatch-schema"
            }))
            .expect("fixture json must serialize"),
        )
        .expect("fixture must write");

        let error = read_optional(&daemon_dir, "dispatch-schema")
            .expect_err("unsupported schema version must fail");
        assert!(matches!(
            error,
            WorkerDispatchInputError::UnsupportedSchemaVersion { schema_version: 2 }
        ));

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn execute_fields_triggering_event_must_match_envelope_native_id() {
        let mut input = dispatch_input_from_fields("dispatch-mismatch");
        input
            .execute_fields
            .as_mut()
            .expect("fixture must use execute fields")
            .triggering_event_id = "event-other".to_string();

        let error = validate_worker_dispatch_input(&input)
            .expect_err("triggering event mismatch must fail validation");
        assert!(matches!(
            error,
            WorkerDispatchInputValidationError::TriggeringEnvelopeMismatch {
                triggering_event_id,
                native_id,
            } if triggering_event_id == "event-other" && native_id == "event-a"
        ));
    }

    #[test]
    fn execute_message_input_resolves_execute_compatible_fields() {
        let input =
            WorkerDispatchInput::from_execute_message(WorkerDispatchInputFromExecuteMessage {
                dispatch_id: "dispatch-execute-message".to_string(),
                source_type: WorkerDispatchInputSourceType::Nostr,
                writer: writer_metadata(),
                execute_message: execute_message(),
                source_metadata: Some(json!({ "eventId": "event-a" })),
            });

        validate_worker_dispatch_input(&input).expect("execute message input must validate");
        let fields = input
            .resolved_execute_fields()
            .expect("execute message must resolve to execute-compatible fields");

        assert_eq!(fields.worker_id, None);
        assert_eq!(fields.triggering_event_id, "event-a");
        assert_eq!(fields.project_base_path, "/repo");
        assert_eq!(fields.metadata_path, "/repo/.tenex/project.json");
        assert!(fields.execution_flags.has_pending_delegations);
    }

    #[test]
    fn input_requires_exactly_one_execute_input_shape() {
        let mut input = dispatch_input_from_fields("dispatch-shape");
        input.execute_message = Some(execute_message());

        let error = validate_worker_dispatch_input(&input)
            .expect_err("two execute input shapes must fail validation");
        assert!(matches!(
            error,
            WorkerDispatchInputValidationError::ConflictingExecuteInputs
        ));

        input.execute_message = None;
        input.execute_fields = None;
        let error = validate_worker_dispatch_input(&input)
            .expect_err("missing execute input shape must fail validation");
        assert!(matches!(
            error,
            WorkerDispatchInputValidationError::MissingExecuteInput
        ));
    }

    fn dispatch_input_from_fields(dispatch_id: &str) -> WorkerDispatchInput {
        WorkerDispatchInput::from_execute_fields(WorkerDispatchInputFromExecuteFields {
            dispatch_id: dispatch_id.to_string(),
            source_type: WorkerDispatchInputSourceType::ScheduledTask,
            writer: writer_metadata(),
            execute_fields: WorkerDispatchExecuteFields {
                worker_id: Some("worker-a".to_string()),
                triggering_event_id: "event-a".to_string(),
                project_base_path: "/repo".to_string(),
                metadata_path: "/repo/.tenex/project.json".to_string(),
                triggering_envelope: triggering_envelope("event-a"),
                execution_flags: AgentWorkerExecutionFlags {
                    is_delegation_completion: false,
                    has_pending_delegations: true,
                    debug: true,
                },
            },
            source_metadata: Some(json!({ "taskId": "task-a" })),
        })
    }

    fn writer_metadata() -> WorkerDispatchInputWriterMetadata {
        WorkerDispatchInputWriterMetadata {
            writer: "worker_dispatch_input_test".to_string(),
            writer_version: "test-writer".to_string(),
            timestamp: 1_710_001_000,
        }
    }

    fn execute_message() -> Value {
        json!({
            "version": 1,
            "type": "execute",
            "correlationId": "correlation-a",
            "sequence": 3,
            "timestamp": 1_710_001_001,
            "projectId": "project-a",
            "projectBasePath": "/repo",
            "metadataPath": "/repo/.tenex/project.json",
            "agentPubkey": "a".repeat(64),
            "conversationId": "conversation-a",
            "ralNumber": 1,
            "ralClaimToken": "claim-a",
            "triggeringEnvelope": triggering_envelope("event-a"),
            "executionFlags": {
                "isDelegationCompletion": false,
                "hasPendingDelegations": true,
                "debug": false
            }
        })
    }

    fn triggering_envelope(native_id: &str) -> Value {
        json!({
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
                "id": native_id,
                "transport": "nostr",
                "nativeId": native_id
            },
            "recipients": [
                {
                    "id": "nostr:agent-a",
                    "transport": "nostr",
                    "kind": "agent"
                }
            ],
            "content": "Run the task",
            "occurredAt": 1_710_001_000_000u64,
            "capabilities": ["reply"],
            "metadata": {}
        })
    }

    fn unique_temp_daemon_dir() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after Unix epoch")
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let daemon_dir =
            std::env::temp_dir().join(format!("tenex-worker-dispatch-input-{unique}-{counter}"));
        fs::create_dir_all(&daemon_dir).expect("temp daemon dir must be created");
        daemon_dir
    }

    fn cleanup_temp_dir(path: PathBuf) {
        fs::remove_dir_all(path).expect("temp daemon dir cleanup must succeed");
    }
}
