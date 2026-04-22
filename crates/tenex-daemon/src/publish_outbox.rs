use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::nostr_event::{NostrEventError, SignedNostrEvent, verify_signed_event};
use crate::telegram::types::{ConversationVariant, RuntimeEventClass};
use crate::worker_protocol::{
    AgentWorkerPublishResultMessageInput, AgentWorkerPublishResultStatus, WorkerProtocolDirection,
    WorkerProtocolError, build_agent_worker_publish_result_message,
    validate_agent_worker_protocol_message,
};

pub const PUBLISH_OUTBOX_DIR_NAME: &str = "publish-outbox";
pub const PUBLISH_OUTBOX_PENDING_DIR_NAME: &str = "pending";
pub const PUBLISH_OUTBOX_PUBLISHED_DIR_NAME: &str = "published";
pub const PUBLISH_OUTBOX_FAILED_DIR_NAME: &str = "failed";
pub const PUBLISH_OUTBOX_TMP_DIR_NAME: &str = "tmp";
pub const PUBLISH_OUTBOX_RECORD_SCHEMA_VERSION: u32 = 1;
pub const PUBLISH_OUTBOX_DIAGNOSTICS_SCHEMA_VERSION: u32 = 1;
pub const DEFAULT_PUBLISH_OUTBOX_RETRY_INITIAL_DELAY_MS: u64 = 1_000;
pub const DEFAULT_PUBLISH_OUTBOX_RETRY_MAX_DELAY_MS: u64 = 60_000;

#[derive(Debug, Error)]
pub enum PublishOutboxError {
    #[error("publish outbox io error: {0}")]
    Io(#[from] io::Error),
    #[error("publish outbox json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("worker protocol error: {0}")]
    Protocol(#[from] WorkerProtocolError),
    #[error("nostr event error: {0}")]
    Nostr(#[from] NostrEventError),
    #[error("expected publish_request, got {0}")]
    UnexpectedMessageType(String),
    #[error("publish_request had invalid direction {0:?}")]
    InvalidDirection(WorkerProtocolDirection),
    #[error("worker publish event pubkey {event_pubkey} does not match agent {agent_pubkey}")]
    AgentPubkeyMismatch {
        event_pubkey: String,
        agent_pubkey: String,
    },
    #[error(
        "publish outbox event pubkey {event_pubkey} does not match publisher {publisher_pubkey}"
    )]
    PublisherPubkeyMismatch {
        event_pubkey: String,
        publisher_pubkey: String,
    },
    #[error("publish outbox event id conflict at {path}")]
    EventIdConflict { path: PathBuf },
    #[error("publish outbox record has invalid status {status:?} for drain")]
    InvalidDrainStatus { status: PublishOutboxStatus },
    #[error("publish outbox record has invalid status {status:?} for requeue")]
    InvalidRequeueStatus { status: PublishOutboxStatus },
}

pub type PublishOutboxResult<T> = Result<T, PublishOutboxError>;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerPublishRequest {
    correlation_id: String,
    sequence: u64,
    timestamp: u64,
    project_id: String,
    agent_pubkey: String,
    conversation_id: String,
    ral_number: u64,
    request_id: String,
    requires_event_id: bool,
    timeout_ms: u64,
    runtime_event_class: RuntimeEventClass,
    conversation_variant: Option<ConversationVariant>,
    event: SignedNostrEvent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PublishOutboxStatus {
    Accepted,
    Published,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PublishRelayAttemptStatus {
    Published,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishRelayResult {
    pub relay_url: String,
    pub accepted: bool,
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishRelayReport {
    pub relay_results: Vec<PublishRelayResult>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublishRelayError {
    pub message: String,
    pub retryable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishRelayAttempt {
    pub attempted_at: u64,
    pub status: PublishRelayAttemptStatus,
    pub relay_results: Vec<PublishRelayResult>,
    pub error: Option<String>,
    pub retryable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_attempt_at: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishOutboxDrainOutcome {
    pub event_id: String,
    pub status: PublishOutboxStatus,
    pub source_path: PathBuf,
    pub target_path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishOutboxRequeueOutcome {
    pub event_id: String,
    pub status: PublishOutboxStatus,
    pub source_path: PathBuf,
    pub target_path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishOutboxMaintenanceReport {
    pub diagnostics_before: PublishOutboxDiagnostics,
    pub requeued: Vec<PublishOutboxRequeueOutcome>,
    pub drained: Vec<PublishOutboxDrainOutcome>,
    pub diagnostics_after: PublishOutboxDiagnostics,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishOutboxFailureDiagnostic {
    pub event_id: String,
    pub request_id: String,
    pub project_id: String,
    pub conversation_id: String,
    pub agent_pubkey: String,
    pub attempt_count: usize,
    pub attempted_at: u64,
    pub error: Option<String>,
    pub retryable: bool,
    pub next_attempt_at: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishOutboxPendingDiagnostic {
    pub event_id: String,
    pub accepted_at: u64,
    pub request_id: String,
    pub project_id: String,
    pub conversation_id: String,
    pub agent_pubkey: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishOutboxDiagnostics {
    pub schema_version: u32,
    pub inspected_at: u64,
    pub pending_count: usize,
    pub published_count: usize,
    pub failed_count: usize,
    pub retryable_failed_count: usize,
    pub retry_due_count: usize,
    pub permanent_failed_count: usize,
    pub tmp_file_count: usize,
    pub oldest_pending: Option<PublishOutboxPendingDiagnostic>,
    pub next_retry_at: Option<u64>,
    pub latest_failure: Option<PublishOutboxFailureDiagnostic>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PublishOutboxRetryPolicy {
    pub initial_delay_ms: u64,
    pub max_delay_ms: u64,
}

impl Default for PublishOutboxRetryPolicy {
    fn default() -> Self {
        Self {
            initial_delay_ms: DEFAULT_PUBLISH_OUTBOX_RETRY_INITIAL_DELAY_MS,
            max_delay_ms: DEFAULT_PUBLISH_OUTBOX_RETRY_MAX_DELAY_MS,
        }
    }
}

impl PublishOutboxRetryPolicy {
    pub fn delay_for_failure_count(self, previous_failed_attempts: usize) -> u64 {
        let mut delay = self.initial_delay_ms.max(1);
        let max_delay = self.max_delay_ms.max(delay);

        for _ in 0..previous_failed_attempts {
            delay = delay.saturating_mul(2).min(max_delay);
        }

        delay
    }
}

pub trait PublishOutboxRelayPublisher {
    fn publish_signed_event(
        &mut self,
        event: &SignedNostrEvent,
    ) -> Result<PublishRelayReport, PublishRelayError>;
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishOutboxRequestRef {
    pub request_id: String,
    pub request_sequence: u64,
    pub request_timestamp: u64,
    pub correlation_id: String,
    pub project_id: String,
    pub agent_pubkey: String,
    pub conversation_id: String,
    pub ral_number: u64,
    pub requires_event_id: bool,
    pub timeout_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_event_class: Option<RuntimeEventClass>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_variant: Option<ConversationVariant>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendPublishOutboxInput {
    pub request_id: String,
    pub request_sequence: u64,
    pub request_timestamp: u64,
    pub correlation_id: String,
    pub project_id: String,
    pub conversation_id: String,
    pub publisher_pubkey: String,
    pub ral_number: u64,
    pub requires_event_id: bool,
    pub timeout_ms: u64,
    pub event: SignedNostrEvent,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishOutboxRecord {
    pub schema_version: u32,
    pub status: PublishOutboxStatus,
    pub accepted_at: u64,
    pub request: PublishOutboxRequestRef,
    pub event: SignedNostrEvent,
    #[serde(default)]
    pub attempts: Vec<PublishRelayAttempt>,
}

pub fn publish_outbox_dir(daemon_dir: impl AsRef<Path>) -> PathBuf {
    daemon_dir.as_ref().join(PUBLISH_OUTBOX_DIR_NAME)
}

pub fn pending_publish_outbox_dir(daemon_dir: impl AsRef<Path>) -> PathBuf {
    publish_outbox_dir(daemon_dir).join(PUBLISH_OUTBOX_PENDING_DIR_NAME)
}

pub fn published_publish_outbox_dir(daemon_dir: impl AsRef<Path>) -> PathBuf {
    publish_outbox_dir(daemon_dir).join(PUBLISH_OUTBOX_PUBLISHED_DIR_NAME)
}

pub fn failed_publish_outbox_dir(daemon_dir: impl AsRef<Path>) -> PathBuf {
    publish_outbox_dir(daemon_dir).join(PUBLISH_OUTBOX_FAILED_DIR_NAME)
}

pub fn tmp_publish_outbox_dir(daemon_dir: impl AsRef<Path>) -> PathBuf {
    publish_outbox_dir(daemon_dir).join(PUBLISH_OUTBOX_TMP_DIR_NAME)
}

pub fn pending_publish_outbox_record_path(daemon_dir: impl AsRef<Path>, event_id: &str) -> PathBuf {
    pending_publish_outbox_dir(daemon_dir).join(format!("{event_id}.json"))
}

pub fn published_publish_outbox_record_path(
    daemon_dir: impl AsRef<Path>,
    event_id: &str,
) -> PathBuf {
    published_publish_outbox_dir(daemon_dir).join(format!("{event_id}.json"))
}

pub fn failed_publish_outbox_record_path(daemon_dir: impl AsRef<Path>, event_id: &str) -> PathBuf {
    failed_publish_outbox_dir(daemon_dir).join(format!("{event_id}.json"))
}

pub fn accept_worker_publish_request(
    daemon_dir: impl AsRef<Path>,
    message: &Value,
    accepted_at: u64,
) -> PublishOutboxResult<PublishOutboxRecord> {
    let direction = validate_agent_worker_protocol_message(message)?;
    if direction != WorkerProtocolDirection::WorkerToDaemon {
        return Err(PublishOutboxError::InvalidDirection(direction));
    }

    let message_type = message
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("<missing>");
    if message_type != "publish_request" {
        return Err(PublishOutboxError::UnexpectedMessageType(
            message_type.to_string(),
        ));
    }

    let request: WorkerPublishRequest = serde_json::from_value(message.clone())?;
    if request.event.pubkey != request.agent_pubkey {
        return Err(PublishOutboxError::AgentPubkeyMismatch {
            event_pubkey: request.event.pubkey,
            agent_pubkey: request.agent_pubkey,
        });
    }
    verify_signed_event(&request.event)?;

    let record = PublishOutboxRecord {
        schema_version: PUBLISH_OUTBOX_RECORD_SCHEMA_VERSION,
        status: PublishOutboxStatus::Accepted,
        accepted_at,
        request: PublishOutboxRequestRef {
            request_id: request.request_id,
            request_sequence: request.sequence,
            request_timestamp: request.timestamp,
            correlation_id: request.correlation_id,
            project_id: request.project_id,
            agent_pubkey: request.agent_pubkey,
            conversation_id: request.conversation_id,
            ral_number: request.ral_number,
            requires_event_id: request.requires_event_id,
            timeout_ms: request.timeout_ms,
            runtime_event_class: Some(request.runtime_event_class),
            conversation_variant: request.conversation_variant,
        },
        event: request.event,
        attempts: Vec::new(),
    };

    persist_pending_record(daemon_dir.as_ref(), &record)
}

pub fn accept_backend_signed_publish_event(
    daemon_dir: impl AsRef<Path>,
    input: BackendPublishOutboxInput,
    accepted_at: u64,
) -> PublishOutboxResult<PublishOutboxRecord> {
    if input.event.pubkey != input.publisher_pubkey {
        return Err(PublishOutboxError::PublisherPubkeyMismatch {
            event_pubkey: input.event.pubkey,
            publisher_pubkey: input.publisher_pubkey,
        });
    }
    verify_signed_event(&input.event)?;

    let record = PublishOutboxRecord {
        schema_version: PUBLISH_OUTBOX_RECORD_SCHEMA_VERSION,
        status: PublishOutboxStatus::Accepted,
        accepted_at,
        request: PublishOutboxRequestRef {
            request_id: input.request_id,
            request_sequence: input.request_sequence,
            request_timestamp: input.request_timestamp,
            correlation_id: input.correlation_id,
            project_id: input.project_id,
            agent_pubkey: input.publisher_pubkey,
            conversation_id: input.conversation_id,
            ral_number: input.ral_number,
            requires_event_id: input.requires_event_id,
            timeout_ms: input.timeout_ms,
            runtime_event_class: None,
            conversation_variant: None,
        },
        event: input.event,
        attempts: Vec::new(),
    };

    persist_pending_record(daemon_dir.as_ref(), &record)
}

pub fn read_pending_publish_outbox_record(
    daemon_dir: impl AsRef<Path>,
    event_id: &str,
) -> PublishOutboxResult<Option<PublishOutboxRecord>> {
    read_optional_record(pending_publish_outbox_record_path(daemon_dir, event_id))
}

pub fn read_published_publish_outbox_record(
    daemon_dir: impl AsRef<Path>,
    event_id: &str,
) -> PublishOutboxResult<Option<PublishOutboxRecord>> {
    read_optional_record(published_publish_outbox_record_path(daemon_dir, event_id))
}

pub fn read_failed_publish_outbox_record(
    daemon_dir: impl AsRef<Path>,
    event_id: &str,
) -> PublishOutboxResult<Option<PublishOutboxRecord>> {
    read_optional_record(failed_publish_outbox_record_path(daemon_dir, event_id))
}

pub fn build_accepted_publish_result(
    record: &PublishOutboxRecord,
    sequence: u64,
    timestamp: u64,
) -> Value {
    build_agent_worker_publish_result_message(AgentWorkerPublishResultMessageInput {
        correlation_id: record.request.correlation_id.clone(),
        sequence,
        timestamp,
        request_id: record.request.request_id.clone(),
        request_sequence: record.request.request_sequence,
        status: AgentWorkerPublishResultStatus::Accepted,
        event_ids: vec![record.event.id.clone()],
        error: None,
    })
    .expect("accepted publish_result from outbox record must satisfy worker protocol")
}

pub fn list_pending_publish_outbox_record_paths(
    daemon_dir: impl AsRef<Path>,
) -> PublishOutboxResult<Vec<PathBuf>> {
    list_record_paths(pending_publish_outbox_dir(daemon_dir))
}

pub fn list_failed_publish_outbox_record_paths(
    daemon_dir: impl AsRef<Path>,
) -> PublishOutboxResult<Vec<PathBuf>> {
    list_record_paths(failed_publish_outbox_dir(daemon_dir))
}

pub fn inspect_publish_outbox(
    daemon_dir: impl AsRef<Path>,
    now: u64,
) -> PublishOutboxResult<PublishOutboxDiagnostics> {
    let daemon_dir = daemon_dir.as_ref();
    let pending_records =
        read_records_from_paths(list_pending_publish_outbox_record_paths(daemon_dir)?)?;
    let published_records =
        read_records_from_paths(list_record_paths(published_publish_outbox_dir(daemon_dir))?)?;
    let failed_records =
        read_records_from_paths(list_failed_publish_outbox_record_paths(daemon_dir)?)?;

    let mut retryable_failed_count = 0;
    let mut retry_due_count = 0;
    let mut permanent_failed_count = 0;
    let mut next_retry_at: Option<u64> = None;
    let mut latest_failure: Option<PublishOutboxFailureDiagnostic> = None;

    for record in &failed_records {
        let Some(latest_attempt) = record.attempts.last() else {
            permanent_failed_count += 1;
            continue;
        };

        if latest_attempt.retryable {
            retryable_failed_count += 1;
            let retry_at = latest_attempt.next_attempt_at.unwrap_or(now);
            next_retry_at = Some(next_retry_at.map_or(retry_at, |current| current.min(retry_at)));
            if retry_at <= now {
                retry_due_count += 1;
            }
        } else {
            permanent_failed_count += 1;
        }

        let candidate = failure_diagnostic_from_record(record, latest_attempt);
        if latest_failure
            .as_ref()
            .is_none_or(|current| candidate.attempted_at > current.attempted_at)
        {
            latest_failure = Some(candidate);
        }
    }

    Ok(PublishOutboxDiagnostics {
        schema_version: PUBLISH_OUTBOX_DIAGNOSTICS_SCHEMA_VERSION,
        inspected_at: now,
        pending_count: pending_records.len(),
        published_count: published_records.len(),
        failed_count: failed_records.len(),
        retryable_failed_count,
        retry_due_count,
        permanent_failed_count,
        tmp_file_count: list_tmp_publish_outbox_paths(daemon_dir)?.len(),
        oldest_pending: pending_records
            .iter()
            .min_by_key(|record| record.accepted_at)
            .map(pending_diagnostic_from_record),
        next_retry_at,
        latest_failure,
    })
}

fn pending_diagnostic_from_record(record: &PublishOutboxRecord) -> PublishOutboxPendingDiagnostic {
    PublishOutboxPendingDiagnostic {
        event_id: record.event.id.clone(),
        accepted_at: record.accepted_at,
        request_id: record.request.request_id.clone(),
        project_id: record.request.project_id.clone(),
        conversation_id: record.request.conversation_id.clone(),
        agent_pubkey: record.request.agent_pubkey.clone(),
    }
}

fn failure_diagnostic_from_record(
    record: &PublishOutboxRecord,
    latest_attempt: &PublishRelayAttempt,
) -> PublishOutboxFailureDiagnostic {
    PublishOutboxFailureDiagnostic {
        event_id: record.event.id.clone(),
        request_id: record.request.request_id.clone(),
        project_id: record.request.project_id.clone(),
        conversation_id: record.request.conversation_id.clone(),
        agent_pubkey: record.request.agent_pubkey.clone(),
        attempt_count: record.attempts.len(),
        attempted_at: latest_attempt.attempted_at,
        error: latest_attempt.error.clone(),
        retryable: latest_attempt.retryable,
        next_attempt_at: latest_attempt.next_attempt_at,
    }
}

pub fn drain_pending_publish_outbox<P: PublishOutboxRelayPublisher>(
    daemon_dir: impl AsRef<Path>,
    publisher: &mut P,
    attempted_at: u64,
) -> PublishOutboxResult<Vec<PublishOutboxDrainOutcome>> {
    drain_pending_publish_outbox_with_retry_policy(
        daemon_dir,
        publisher,
        attempted_at,
        PublishOutboxRetryPolicy::default(),
    )
}

pub fn drain_pending_publish_outbox_with_retry_policy<P: PublishOutboxRelayPublisher>(
    daemon_dir: impl AsRef<Path>,
    publisher: &mut P,
    attempted_at: u64,
    retry_policy: PublishOutboxRetryPolicy,
) -> PublishOutboxResult<Vec<PublishOutboxDrainOutcome>> {
    let daemon_dir = daemon_dir.as_ref();
    let paths = list_pending_publish_outbox_record_paths(daemon_dir)?;
    let mut outcomes = Vec::with_capacity(paths.len());

    for source_path in paths {
        let Some(mut record) = read_optional_record(&source_path)? else {
            continue;
        };
        if record.status != PublishOutboxStatus::Accepted {
            return Err(PublishOutboxError::InvalidDrainStatus {
                status: record.status,
            });
        }
        verify_signed_event(&record.event)?;

        match publisher.publish_signed_event(&record.event) {
            Ok(report) if relay_report_indicates_published(&report) => {
                record.status = PublishOutboxStatus::Published;
                record.attempts.push(PublishRelayAttempt {
                    attempted_at,
                    status: PublishRelayAttemptStatus::Published,
                    relay_results: report.relay_results,
                    error: None,
                    retryable: false,
                    next_attempt_at: None,
                });
                outcomes.push(transition_pending_record(
                    daemon_dir,
                    &source_path,
                    published_publish_outbox_record_path(daemon_dir, &record.event.id),
                    &record,
                )?);
            }
            Ok(report) => {
                let retryable = relay_report_failure_is_retryable(&report);
                let next_attempt_at =
                    retryable.then(|| next_attempt_at(&record, attempted_at, retry_policy));
                record.status = PublishOutboxStatus::Failed;
                record.attempts.push(PublishRelayAttempt {
                    attempted_at,
                    status: PublishRelayAttemptStatus::Failed,
                    relay_results: report.relay_results,
                    error: Some("event was accepted by 0 relays".to_string()),
                    retryable,
                    next_attempt_at,
                });
                outcomes.push(transition_pending_record(
                    daemon_dir,
                    &source_path,
                    failed_publish_outbox_record_path(daemon_dir, &record.event.id),
                    &record,
                )?);
            }
            Err(error) => {
                let next_attempt_at = error
                    .retryable
                    .then(|| next_attempt_at(&record, attempted_at, retry_policy));
                record.status = PublishOutboxStatus::Failed;
                record.attempts.push(PublishRelayAttempt {
                    attempted_at,
                    status: PublishRelayAttemptStatus::Failed,
                    relay_results: Vec::new(),
                    error: Some(error.message),
                    retryable: error.retryable,
                    next_attempt_at,
                });
                outcomes.push(transition_pending_record(
                    daemon_dir,
                    &source_path,
                    failed_publish_outbox_record_path(daemon_dir, &record.event.id),
                    &record,
                )?);
            }
        }
    }

    Ok(outcomes)
}

pub fn requeue_due_failed_publish_outbox_records(
    daemon_dir: impl AsRef<Path>,
    now: u64,
) -> PublishOutboxResult<Vec<PublishOutboxRequeueOutcome>> {
    let daemon_dir = daemon_dir.as_ref();
    let paths = list_failed_publish_outbox_record_paths(daemon_dir)?;
    let mut outcomes = Vec::with_capacity(paths.len());

    for source_path in paths {
        let Some(mut record) = read_optional_record(&source_path)? else {
            continue;
        };
        if record.status != PublishOutboxStatus::Failed {
            return Err(PublishOutboxError::InvalidRequeueStatus {
                status: record.status,
            });
        }
        verify_signed_event(&record.event)?;

        if !is_retry_due(&record, now) {
            continue;
        }

        record.status = PublishOutboxStatus::Accepted;
        outcomes.push(transition_failed_record_to_pending(
            daemon_dir,
            &source_path,
            pending_publish_outbox_record_path(daemon_dir, &record.event.id),
            &record,
        )?);
    }

    Ok(outcomes)
}

pub fn run_publish_outbox_maintenance<P: PublishOutboxRelayPublisher>(
    daemon_dir: impl AsRef<Path>,
    publisher: &mut P,
    now: u64,
) -> PublishOutboxResult<PublishOutboxMaintenanceReport> {
    run_publish_outbox_maintenance_with_retry_policy(
        daemon_dir,
        publisher,
        now,
        PublishOutboxRetryPolicy::default(),
    )
}

pub fn run_publish_outbox_maintenance_with_retry_policy<P: PublishOutboxRelayPublisher>(
    daemon_dir: impl AsRef<Path>,
    publisher: &mut P,
    now: u64,
    retry_policy: PublishOutboxRetryPolicy,
) -> PublishOutboxResult<PublishOutboxMaintenanceReport> {
    let daemon_dir = daemon_dir.as_ref();
    let diagnostics_before = inspect_publish_outbox(daemon_dir, now)?;
    let requeued = requeue_due_failed_publish_outbox_records(daemon_dir, now)?;
    let drained =
        drain_pending_publish_outbox_with_retry_policy(daemon_dir, publisher, now, retry_policy)?;
    let diagnostics_after = inspect_publish_outbox(daemon_dir, now)?;

    Ok(PublishOutboxMaintenanceReport {
        diagnostics_before,
        requeued,
        drained,
        diagnostics_after,
    })
}

fn list_record_paths(dir: PathBuf) -> PublishOutboxResult<Vec<PathBuf>> {
    let mut paths = match fs::read_dir(&dir) {
        Ok(entries) => entries
            .map(|entry| entry.map(|entry| entry.path()))
            .collect::<Result<Vec<_>, _>>()?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(error.into()),
    };

    paths.retain(|path| {
        path.extension()
            .is_some_and(|extension| extension == "json")
    });
    paths.sort();
    Ok(paths)
}

fn read_records_from_paths(paths: Vec<PathBuf>) -> PublishOutboxResult<Vec<PublishOutboxRecord>> {
    paths
        .into_iter()
        .filter_map(|path| match read_optional_record(&path) {
            Ok(Some(record)) => Some(Ok(record)),
            Ok(None) => None,
            Err(error) => Some(Err(error)),
        })
        .collect()
}

fn list_tmp_publish_outbox_paths(daemon_dir: &Path) -> PublishOutboxResult<Vec<PathBuf>> {
    let tmp_dir = tmp_publish_outbox_dir(daemon_dir);
    let mut paths = match fs::read_dir(&tmp_dir) {
        Ok(entries) => entries
            .filter_map(|entry| match entry {
                Ok(entry) if entry.file_type().is_ok_and(|file_type| file_type.is_file()) => {
                    Some(Ok(entry.path()))
                }
                Ok(_) => None,
                Err(error) => Some(Err(error)),
            })
            .collect::<Result<Vec<_>, _>>()?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(error.into()),
    };

    paths.sort();
    Ok(paths)
}

fn next_attempt_at(
    record: &PublishOutboxRecord,
    attempted_at: u64,
    retry_policy: PublishOutboxRetryPolicy,
) -> u64 {
    let previous_failed_attempts = record
        .attempts
        .iter()
        .filter(|attempt| attempt.status == PublishRelayAttemptStatus::Failed)
        .count();
    attempted_at.saturating_add(retry_policy.delay_for_failure_count(previous_failed_attempts))
}

fn is_retry_due(record: &PublishOutboxRecord, now: u64) -> bool {
    let Some(latest_attempt) = record.attempts.last() else {
        return false;
    };

    latest_attempt.status == PublishRelayAttemptStatus::Failed
        && latest_attempt.retryable
        && latest_attempt
            .next_attempt_at
            .is_none_or(|next_attempt_at| next_attempt_at <= now)
}

fn relay_report_indicates_published(report: &PublishRelayReport) -> bool {
    report
        .relay_results
        .iter()
        .any(relay_result_indicates_published)
}

fn relay_result_indicates_published(result: &PublishRelayResult) -> bool {
    result.accepted || relay_result_message_has_prefix(result, "duplicate:")
}

fn relay_report_failure_is_retryable(report: &PublishRelayReport) -> bool {
    report
        .relay_results
        .iter()
        .any(relay_result_failure_is_retryable)
}

fn relay_result_failure_is_retryable(result: &PublishRelayResult) -> bool {
    if relay_result_indicates_published(result) {
        return false;
    }

    let Some(message) = result.message.as_deref() else {
        return true;
    };

    !["blocked:", "invalid:", "pow:"]
        .iter()
        .any(|prefix| message_has_prefix(message, prefix))
}

fn relay_result_message_has_prefix(result: &PublishRelayResult, prefix: &str) -> bool {
    result
        .message
        .as_deref()
        .is_some_and(|message| message_has_prefix(message, prefix))
}

fn message_has_prefix(message: &str, prefix: &str) -> bool {
    message
        .trim_start()
        .to_ascii_lowercase()
        .starts_with(prefix)
}

fn persist_pending_record(
    daemon_dir: &Path,
    record: &PublishOutboxRecord,
) -> PublishOutboxResult<PublishOutboxRecord> {
    let pending_dir = pending_publish_outbox_dir(daemon_dir);
    let tmp_dir = tmp_publish_outbox_dir(daemon_dir);
    fs::create_dir_all(&pending_dir)?;
    fs::create_dir_all(&tmp_dir)?;

    let record_path = pending_publish_outbox_record_path(daemon_dir, &record.event.id);
    if let Some((existing_path, existing)) =
        read_existing_publish_outbox_record(daemon_dir, &record.event.id)?
    {
        return existing_record_or_conflict(existing_path, existing, record);
    }

    let tmp_path = tmp_dir.join(format!(
        "{}.{}.{}.tmp",
        record.event.id,
        std::process::id(),
        now_nanos()
    ));

    let write_result = (|| {
        write_record_file(&tmp_path, record)?;
        if create_record_link_without_replacing(&tmp_path, &record_path)? {
            remove_optional_file(&tmp_path)?;
            sync_parent_dir(&record_path)?;
            return Ok(record.clone());
        }

        remove_optional_file(&tmp_path)?;
        if let Some((existing_path, existing)) =
            read_existing_publish_outbox_record(daemon_dir, &record.event.id)?
        {
            return existing_record_or_conflict(existing_path, existing, record);
        }
        Err(PublishOutboxError::EventIdConflict { path: record_path })
    })();

    if write_result.is_err() {
        let _ = fs::remove_file(&tmp_path);
    }
    write_result
}

fn transition_pending_record(
    daemon_dir: &Path,
    source_path: &Path,
    target_path: PathBuf,
    record: &PublishOutboxRecord,
) -> PublishOutboxResult<PublishOutboxDrainOutcome> {
    let target_dir = target_path
        .parent()
        .expect("publish outbox target record must have a parent");
    fs::create_dir_all(target_dir)?;
    fs::create_dir_all(tmp_publish_outbox_dir(daemon_dir))?;

    let existing = read_optional_record(&target_path)?;
    if let Some(existing) = existing {
        ensure_same_event_or_conflict(&target_path, &existing, record)?;
        remove_optional_file(source_path)?;
        sync_parent_dir(source_path)?;
        return Ok(PublishOutboxDrainOutcome {
            event_id: existing.event.id,
            status: existing.status,
            source_path: source_path.to_path_buf(),
            target_path,
        });
    }

    let tmp_path = tmp_publish_outbox_dir(daemon_dir).join(format!(
        "{}.{}.{}.tmp",
        record.event.id,
        std::process::id(),
        now_nanos()
    ));
    let write_result = (|| {
        write_record_file(&tmp_path, record)?;
        if create_record_link_without_replacing(&tmp_path, &target_path)? {
            remove_optional_file(&tmp_path)?;
            sync_parent_dir(&target_path)?;
            remove_optional_file(source_path)?;
            sync_parent_dir(source_path)?;
            return Ok(PublishOutboxDrainOutcome {
                event_id: record.event.id.clone(),
                status: record.status,
                source_path: source_path.to_path_buf(),
                target_path: target_path.clone(),
            });
        }

        remove_optional_file(&tmp_path)?;
        let existing = read_optional_record(&target_path)?.ok_or_else(|| {
            PublishOutboxError::EventIdConflict {
                path: target_path.clone(),
            }
        })?;
        ensure_same_event_or_conflict(&target_path, &existing, record)?;
        remove_optional_file(source_path)?;
        sync_parent_dir(source_path)?;
        Ok(PublishOutboxDrainOutcome {
            event_id: existing.event.id,
            status: existing.status,
            source_path: source_path.to_path_buf(),
            target_path: target_path.clone(),
        })
    })();

    if write_result.is_err() {
        let _ = fs::remove_file(&tmp_path);
    }

    write_result
}

fn transition_failed_record_to_pending(
    daemon_dir: &Path,
    source_path: &Path,
    target_path: PathBuf,
    record: &PublishOutboxRecord,
) -> PublishOutboxResult<PublishOutboxRequeueOutcome> {
    let target_dir = target_path
        .parent()
        .expect("publish outbox target record must have a parent");
    fs::create_dir_all(target_dir)?;
    fs::create_dir_all(tmp_publish_outbox_dir(daemon_dir))?;

    let published_path = published_publish_outbox_record_path(daemon_dir, &record.event.id);
    if let Some(existing) = read_optional_record(&published_path)? {
        ensure_same_event_or_conflict(&published_path, &existing, record)?;
        remove_optional_file(source_path)?;
        sync_parent_dir(source_path)?;
        return Ok(PublishOutboxRequeueOutcome {
            event_id: existing.event.id,
            status: existing.status,
            source_path: source_path.to_path_buf(),
            target_path: published_path,
        });
    }

    let existing = read_optional_record(&target_path)?;
    if let Some(existing) = existing {
        ensure_same_event_or_conflict(&target_path, &existing, record)?;
        remove_optional_file(source_path)?;
        sync_parent_dir(source_path)?;
        return Ok(PublishOutboxRequeueOutcome {
            event_id: existing.event.id,
            status: existing.status,
            source_path: source_path.to_path_buf(),
            target_path,
        });
    }

    let tmp_path = tmp_publish_outbox_dir(daemon_dir).join(format!(
        "{}.{}.{}.tmp",
        record.event.id,
        std::process::id(),
        now_nanos()
    ));
    let write_result = (|| {
        write_record_file(&tmp_path, record)?;
        if create_record_link_without_replacing(&tmp_path, &target_path)? {
            remove_optional_file(&tmp_path)?;
            sync_parent_dir(&target_path)?;
            if let Some(existing) = read_optional_record(&published_path)? {
                ensure_same_event_or_conflict(&published_path, &existing, record)?;
                remove_optional_file(&target_path)?;
                sync_parent_dir(&target_path)?;
                remove_optional_file(source_path)?;
                sync_parent_dir(source_path)?;
                return Ok(PublishOutboxRequeueOutcome {
                    event_id: existing.event.id,
                    status: existing.status,
                    source_path: source_path.to_path_buf(),
                    target_path: published_path,
                });
            }
            remove_optional_file(source_path)?;
            sync_parent_dir(source_path)?;
            return Ok(PublishOutboxRequeueOutcome {
                event_id: record.event.id.clone(),
                status: record.status,
                source_path: source_path.to_path_buf(),
                target_path: target_path.clone(),
            });
        }

        remove_optional_file(&tmp_path)?;
        let existing = read_optional_record(&target_path)?.ok_or_else(|| {
            PublishOutboxError::EventIdConflict {
                path: target_path.clone(),
            }
        })?;
        ensure_same_event_or_conflict(&target_path, &existing, record)?;
        remove_optional_file(source_path)?;
        sync_parent_dir(source_path)?;
        Ok(PublishOutboxRequeueOutcome {
            event_id: existing.event.id,
            status: existing.status,
            source_path: source_path.to_path_buf(),
            target_path: target_path.clone(),
        })
    })();

    if write_result.is_err() {
        let _ = fs::remove_file(&tmp_path);
    }

    write_result
}

fn read_existing_publish_outbox_record(
    daemon_dir: &Path,
    event_id: &str,
) -> PublishOutboxResult<Option<(PathBuf, PublishOutboxRecord)>> {
    for path in [
        pending_publish_outbox_record_path(daemon_dir, event_id),
        published_publish_outbox_record_path(daemon_dir, event_id),
        failed_publish_outbox_record_path(daemon_dir, event_id),
    ] {
        if let Some(record) = read_optional_record(&path)? {
            return Ok(Some((path, record)));
        }
    }

    Ok(None)
}

fn existing_record_or_conflict(
    existing_path: PathBuf,
    existing: PublishOutboxRecord,
    requested: &PublishOutboxRecord,
) -> PublishOutboxResult<PublishOutboxRecord> {
    ensure_same_event_or_conflict(&existing_path, &existing, requested)?;
    Ok(existing)
}

fn ensure_same_event_or_conflict(
    existing_path: &Path,
    existing: &PublishOutboxRecord,
    requested: &PublishOutboxRecord,
) -> PublishOutboxResult<()> {
    if existing.event == requested.event {
        return Ok(());
    }

    Err(PublishOutboxError::EventIdConflict {
        path: existing_path.to_path_buf(),
    })
}

fn create_record_link_without_replacing(
    source_path: &Path,
    target_path: &Path,
) -> PublishOutboxResult<bool> {
    match fs::hard_link(source_path, target_path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn remove_optional_file(path: impl AsRef<Path>) -> PublishOutboxResult<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn read_optional_record(
    path: impl AsRef<Path>,
) -> PublishOutboxResult<Option<PublishOutboxRecord>> {
    match fs::read_to_string(path) {
        Ok(content) => Ok(Some(serde_json::from_str(&content)?)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn write_record_file(path: &Path, record: &PublishOutboxRecord) -> PublishOutboxResult<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    serde_json::to_writer_pretty(&mut file, record)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    Ok(())
}

fn sync_parent_dir(path: &Path) -> PublishOutboxResult<()> {
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
    use crate::nostr_event::Nip01EventFixture;
    use crate::worker_protocol::AGENT_WORKER_PROTOCOL_VERSION;
    use serde_json::json;
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    const STREAM_TEXT_DELTA_FIXTURE: &str =
        include_str!("../../../src/test-utils/fixtures/nostr/stream-text-delta.compat.json");
    const PUBLISH_OUTBOX_FIXTURE: &str =
        include_str!("../../../src/test-utils/fixtures/daemon/publish-outbox.compat.json");
    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn publish_outbox_fixture_matches_rust_contract() {
        let fixture: Value =
            serde_json::from_str(PUBLISH_OUTBOX_FIXTURE).expect("fixture must parse");
        let daemon_dir = Path::new("/var/lib/tenex").join(
            fixture["daemonDirName"]
                .as_str()
                .expect("fixture must include daemonDirName"),
        );

        assert_eq!(
            fixture["relativePaths"]["outbox"].as_str(),
            Some(PUBLISH_OUTBOX_DIR_NAME)
        );
        assert_eq!(
            fixture["relativePaths"]["pending"].as_str(),
            Some("publish-outbox/pending")
        );
        assert_eq!(
            fixture["relativePaths"]["published"].as_str(),
            Some("publish-outbox/published")
        );
        assert_eq!(
            fixture["relativePaths"]["failed"].as_str(),
            Some("publish-outbox/failed")
        );
        assert_eq!(
            fixture["relativePaths"]["tmp"].as_str(),
            Some("publish-outbox/tmp")
        );
        assert_eq!(
            publish_outbox_dir(&daemon_dir),
            daemon_dir.join(PUBLISH_OUTBOX_DIR_NAME)
        );
        assert_eq!(
            pending_publish_outbox_dir(&daemon_dir),
            daemon_dir.join("publish-outbox").join("pending")
        );
        assert_eq!(
            published_publish_outbox_dir(&daemon_dir),
            daemon_dir.join("publish-outbox").join("published")
        );
        assert_eq!(
            failed_publish_outbox_dir(&daemon_dir),
            daemon_dir.join("publish-outbox").join("failed")
        );
        assert_eq!(
            tmp_publish_outbox_dir(&daemon_dir),
            daemon_dir.join("publish-outbox").join("tmp")
        );

        let accepted: PublishOutboxRecord =
            serde_json::from_value(fixture["records"]["accepted"].clone())
                .expect("accepted record must deserialize");
        let published: PublishOutboxRecord =
            serde_json::from_value(fixture["records"]["published"].clone())
                .expect("published record must deserialize");
        let failed: PublishOutboxRecord =
            serde_json::from_value(fixture["records"]["failed"].clone())
                .expect("failed record must deserialize");

        assert_eq!(accepted.status, PublishOutboxStatus::Accepted);
        assert!(accepted.attempts.is_empty());
        assert_eq!(published.status, PublishOutboxStatus::Published);
        assert_eq!(
            published.attempts[0].status,
            PublishRelayAttemptStatus::Published
        );
        assert_eq!(failed.status, PublishOutboxStatus::Failed);
        assert_eq!(failed.attempts[0].status, PublishRelayAttemptStatus::Failed);
        assert_eq!(failed.attempts[0].next_attempt_at, Some(1710001001300));

        let maintenance_report: PublishOutboxMaintenanceReport =
            serde_json::from_value(fixture["maintenanceReports"]["dueRetryPublished"].clone())
                .expect("maintenance report fixture must deserialize");
        assert_eq!(maintenance_report.diagnostics_before.failed_count, 1);
        assert_eq!(maintenance_report.diagnostics_before.retry_due_count, 1);
        assert_eq!(maintenance_report.requeued.len(), 1);
        assert_eq!(
            maintenance_report.requeued[0].target_path,
            daemon_dir
                .join("publish-outbox")
                .join("pending")
                .join("event-failed-01.json")
        );
        assert_eq!(maintenance_report.drained.len(), 1);
        assert_eq!(
            maintenance_report.drained[0].status,
            PublishOutboxStatus::Published
        );
        assert_eq!(maintenance_report.diagnostics_after.published_count, 1);
        assert_eq!(maintenance_report.diagnostics_after.failed_count, 0);
    }

    #[test]
    fn inspects_empty_publish_outbox_diagnostics() {
        let fixture: Value =
            serde_json::from_str(PUBLISH_OUTBOX_FIXTURE).expect("fixture must parse");
        let expected: PublishOutboxDiagnostics =
            serde_json::from_value(fixture["diagnostics"]["empty"].clone())
                .expect("empty diagnostics fixture must deserialize");
        let daemon_dir = unique_temp_daemon_dir();

        let diagnostics =
            inspect_publish_outbox(&daemon_dir, 1710001000000).expect("diagnostics must inspect");

        assert_eq!(diagnostics, expected);

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn inspects_publish_outbox_diagnostics_from_filesystem_records() {
        let fixture: Value =
            serde_json::from_str(PUBLISH_OUTBOX_FIXTURE).expect("fixture must parse");
        let daemon_dir = unique_temp_daemon_dir();
        let accepted: PublishOutboxRecord =
            serde_json::from_value(fixture["records"]["accepted"].clone())
                .expect("accepted record must deserialize");
        let published: PublishOutboxRecord =
            serde_json::from_value(fixture["records"]["published"].clone())
                .expect("published record must deserialize");
        let failed: PublishOutboxRecord =
            serde_json::from_value(fixture["records"]["failed"].clone())
                .expect("failed record must deserialize");
        let mut permanent_failed = failed.clone();
        permanent_failed.event.id = "event-permanent-failed-01".to_string();
        permanent_failed.attempts[0].attempted_at = 1710001000400;
        permanent_failed.attempts[0].error = Some("invalid: rejected permanently".to_string());
        permanent_failed.attempts[0].retryable = false;
        permanent_failed.attempts[0].next_attempt_at = None;

        write_test_record(
            pending_publish_outbox_record_path(&daemon_dir, &accepted.event.id),
            &accepted,
        );
        write_test_record(
            published_publish_outbox_record_path(&daemon_dir, &published.event.id),
            &published,
        );
        write_test_record(
            failed_publish_outbox_record_path(&daemon_dir, &failed.event.id),
            &failed,
        );
        let fixture_diagnostics: PublishOutboxDiagnostics =
            serde_json::from_value(fixture["diagnostics"]["fixtureRecordsBeforeRetry"].clone())
                .expect("fixture records diagnostics must deserialize");
        let actual_fixture_diagnostics =
            inspect_publish_outbox(&daemon_dir, 1710001001200).expect("diagnostics must inspect");
        assert_eq!(actual_fixture_diagnostics, fixture_diagnostics);

        write_test_record(
            failed_publish_outbox_record_path(&daemon_dir, &permanent_failed.event.id),
            &permanent_failed,
        );
        fs::create_dir_all(tmp_publish_outbox_dir(&daemon_dir))
            .expect("tmp outbox dir must be created");
        fs::write(
            tmp_publish_outbox_dir(&daemon_dir).join("orphan-write.tmp"),
            b"partial",
        )
        .expect("tmp file must be written");

        let diagnostics_before_retry =
            inspect_publish_outbox(&daemon_dir, 1710001001200).expect("diagnostics must inspect");

        assert_eq!(
            diagnostics_before_retry.schema_version,
            PUBLISH_OUTBOX_DIAGNOSTICS_SCHEMA_VERSION
        );
        assert_eq!(diagnostics_before_retry.inspected_at, 1710001001200);
        assert_eq!(diagnostics_before_retry.pending_count, 1);
        assert_eq!(diagnostics_before_retry.published_count, 1);
        assert_eq!(diagnostics_before_retry.failed_count, 2);
        assert_eq!(diagnostics_before_retry.retryable_failed_count, 1);
        assert_eq!(diagnostics_before_retry.retry_due_count, 0);
        assert_eq!(diagnostics_before_retry.permanent_failed_count, 1);
        assert_eq!(diagnostics_before_retry.tmp_file_count, 1);
        assert_eq!(
            diagnostics_before_retry.oldest_pending,
            Some(PublishOutboxPendingDiagnostic {
                event_id: "event-accepted-01".to_string(),
                accepted_at: 1710001000100,
                request_id: "publish-fixture-01".to_string(),
                project_id: "project-alpha".to_string(),
                conversation_id: "conversation-alpha".to_string(),
                agent_pubkey: "a".repeat(64),
            })
        );
        assert_eq!(diagnostics_before_retry.next_retry_at, Some(1710001001300));
        assert_eq!(
            diagnostics_before_retry.latest_failure,
            Some(PublishOutboxFailureDiagnostic {
                event_id: "event-permanent-failed-01".to_string(),
                request_id: "publish-fixture-01".to_string(),
                project_id: "project-alpha".to_string(),
                conversation_id: "conversation-alpha".to_string(),
                agent_pubkey: "a".repeat(64),
                attempt_count: 1,
                attempted_at: 1710001000400,
                error: Some("invalid: rejected permanently".to_string()),
                retryable: false,
                next_attempt_at: None,
            })
        );

        let diagnostics_when_due =
            inspect_publish_outbox(&daemon_dir, 1710001001300).expect("diagnostics must inspect");
        assert_eq!(diagnostics_when_due.retry_due_count, 1);

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn accepts_signed_worker_publish_request_into_pending_outbox() {
        let fixture = signed_event_fixture();
        let daemon_dir = unique_temp_daemon_dir();
        let message = publish_request_message(&fixture, 41, 1710001000000);

        let record = accept_worker_publish_request(&daemon_dir, &message, 1710001000100)
            .expect("publish request must be accepted");

        assert_eq!(record.schema_version, PUBLISH_OUTBOX_RECORD_SCHEMA_VERSION);
        assert_eq!(record.status, PublishOutboxStatus::Accepted);
        assert_eq!(record.accepted_at, 1710001000100);
        assert_eq!(record.request.request_id, "publish-fixture-01");
        assert_eq!(record.request.request_sequence, 41);
        assert_eq!(record.request.agent_pubkey, fixture.pubkey);
        assert_eq!(
            record.request.runtime_event_class,
            Some(RuntimeEventClass::Complete)
        );
        assert_eq!(record.request.conversation_variant, None);
        assert_eq!(record.event, fixture.signed);
        verify_signed_event(&record.event).expect("accepted event must still verify");

        let persisted =
            read_pending_publish_outbox_record(&daemon_dir, &record.event.id).expect("record read");
        assert_eq!(persisted, Some(record.clone()));

        let publish_result = build_accepted_publish_result(&record, 900, 1710001000200);
        assert_eq!(
            validate_agent_worker_protocol_message(&publish_result),
            Ok(WorkerProtocolDirection::DaemonToWorker)
        );
        assert_eq!(publish_result["eventIds"], json!([fixture.signed.id]));

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn preserves_worker_publish_classification_in_pending_outbox() {
        let fixture = signed_event_fixture();
        let daemon_dir = unique_temp_daemon_dir();
        let mut message = publish_request_message(&fixture, 41, 1710001000000);
        message["runtimeEventClass"] = json!("conversation");
        message["conversationVariant"] = json!("reasoning");

        let record = accept_worker_publish_request(&daemon_dir, &message, 1710001000100)
            .expect("publish request must be accepted");

        assert_eq!(
            record.request.runtime_event_class,
            Some(RuntimeEventClass::Conversation)
        );
        assert_eq!(
            record.request.conversation_variant,
            Some(ConversationVariant::Reasoning)
        );

        let persisted =
            read_pending_publish_outbox_record(&daemon_dir, &record.event.id).expect("record read");
        assert_eq!(
            persisted
                .expect("record must persist")
                .request
                .conversation_variant,
            Some(ConversationVariant::Reasoning)
        );

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn accepts_backend_signed_event_into_pending_outbox() {
        let fixture = signed_event_fixture();
        let daemon_dir = unique_temp_daemon_dir();
        let input = backend_publish_input(&fixture, 41, 1710001000000);

        let record = accept_backend_signed_publish_event(&daemon_dir, input, 1710001000100)
            .expect("backend signed event must be accepted");

        assert_eq!(record.schema_version, PUBLISH_OUTBOX_RECORD_SCHEMA_VERSION);
        assert_eq!(record.status, PublishOutboxStatus::Accepted);
        assert_eq!(record.accepted_at, 1710001000100);
        assert_eq!(record.request.request_id, "backend-publish-fixture-01");
        assert_eq!(record.request.request_sequence, 41);
        assert_eq!(record.request.correlation_id, "rust_backend_publish_outbox");
        assert_eq!(record.request.agent_pubkey, fixture.pubkey);
        assert_eq!(record.request.runtime_event_class, None);
        assert_eq!(record.request.conversation_variant, None);
        assert_eq!(record.event, fixture.signed);
        verify_signed_event(&record.event).expect("accepted backend event must still verify");

        let persisted =
            read_pending_publish_outbox_record(&daemon_dir, &record.event.id).expect("record read");
        assert_eq!(persisted, Some(record));

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn accepts_duplicate_backend_signed_event_idempotently() {
        let fixture = signed_event_fixture();
        let daemon_dir = unique_temp_daemon_dir();
        let first = backend_publish_input(&fixture, 41, 1710001000000);
        let second = backend_publish_input(&fixture, 42, 1710001000500);

        let first_record = accept_backend_signed_publish_event(&daemon_dir, first, 1710001000100)
            .expect("first backend event must be accepted");
        let second_record = accept_backend_signed_publish_event(&daemon_dir, second, 1710001000600)
            .expect("duplicate backend event must be idempotent");

        assert_eq!(second_record, first_record);
        assert_eq!(second_record.request.request_sequence, 41);
        assert_eq!(second_record.accepted_at, 1710001000100);

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn accepts_duplicate_backend_signed_event_from_published_outbox_without_republishing() {
        let fixture = signed_event_fixture();
        let daemon_dir = unique_temp_daemon_dir();
        let input = backend_publish_input(&fixture, 41, 1710001000000);
        accept_backend_signed_publish_event(&daemon_dir, input, 1710001000100)
            .expect("backend event must be accepted");
        let mut publisher = MockRelayPublisher::new(vec![Ok(PublishRelayReport {
            relay_results: vec![PublishRelayResult {
                relay_url: "wss://relay-one.test".to_string(),
                accepted: true,
                message: Some("ok".to_string()),
            }],
        })]);
        drain_pending_publish_outbox(&daemon_dir, &mut publisher, 1710001000200)
            .expect("pending outbox drain must publish");

        let duplicate = accept_backend_signed_publish_event(
            &daemon_dir,
            backend_publish_input(&fixture, 42, 1710001000500),
            1710001000600,
        )
        .expect("duplicate published backend event must be idempotent");

        assert_eq!(duplicate.status, PublishOutboxStatus::Published);
        assert_eq!(duplicate.event, fixture.signed);
        assert!(
            read_pending_publish_outbox_record(&daemon_dir, &fixture.signed.id)
                .expect("pending record read must succeed")
                .is_none()
        );
        assert!(
            read_published_publish_outbox_record(&daemon_dir, &fixture.signed.id)
                .expect("published record read must succeed")
                .is_some()
        );

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn accepts_duplicate_backend_signed_event_from_failed_outbox_without_requeueing() {
        let fixture = signed_event_fixture();
        let daemon_dir = unique_temp_daemon_dir();
        let input = backend_publish_input(&fixture, 41, 1710001000000);
        accept_backend_signed_publish_event(&daemon_dir, input, 1710001000100)
            .expect("backend event must be accepted");
        let mut publisher = MockRelayPublisher::new(vec![Err(PublishRelayError {
            message: "relay connection failed".to_string(),
            retryable: true,
        })]);
        drain_pending_publish_outbox(&daemon_dir, &mut publisher, 1710001000200)
            .expect("pending outbox drain must fail into failed dir");

        let duplicate = accept_backend_signed_publish_event(
            &daemon_dir,
            backend_publish_input(&fixture, 42, 1710001000500),
            1710001000600,
        )
        .expect("duplicate failed backend event must be idempotent");

        assert_eq!(duplicate.status, PublishOutboxStatus::Failed);
        assert_eq!(duplicate.event, fixture.signed);
        assert_eq!(duplicate.attempts[0].next_attempt_at, Some(1710001001200));
        assert!(
            read_pending_publish_outbox_record(&daemon_dir, &fixture.signed.id)
                .expect("pending record read must succeed")
                .is_none()
        );
        assert!(
            read_failed_publish_outbox_record(&daemon_dir, &fixture.signed.id)
                .expect("failed record read must succeed")
                .is_some()
        );

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn rejects_backend_signed_event_when_publisher_pubkey_does_not_match() {
        let fixture = signed_event_fixture();
        let daemon_dir = unique_temp_daemon_dir();
        let mut input = backend_publish_input(&fixture, 41, 1710001000000);
        input.publisher_pubkey = "a".repeat(64);

        let error = accept_backend_signed_publish_event(&daemon_dir, input, 1710001000100)
            .expect_err("wrong publisher pubkey must be rejected");

        assert!(matches!(
            error,
            PublishOutboxError::PublisherPubkeyMismatch { .. }
        ));
        assert!(
            read_pending_publish_outbox_record(&daemon_dir, &fixture.signed.id)
                .expect("outbox read must succeed")
                .is_none()
        );

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn rejects_mutated_backend_signed_event_before_persisting() {
        let fixture = signed_event_fixture();
        let daemon_dir = unique_temp_daemon_dir();
        let mut input = backend_publish_input(&fixture, 41, 1710001000000);
        input.event.content = "mutated after signing".to_string();

        let error = accept_backend_signed_publish_event(&daemon_dir, input, 1710001000100)
            .expect_err("mutated backend event must be rejected");

        assert!(matches!(
            error,
            PublishOutboxError::Nostr(NostrEventError::EventIdMismatch { .. })
        ));
        assert!(
            read_pending_publish_outbox_record(&daemon_dir, &fixture.signed.id)
                .expect("outbox read must succeed")
                .is_none()
        );

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn drains_backend_signed_event_exactly_to_relay_publisher() {
        let fixture = signed_event_fixture();
        let daemon_dir = unique_temp_daemon_dir();
        let input = backend_publish_input(&fixture, 41, 1710001000000);
        accept_backend_signed_publish_event(&daemon_dir, input, 1710001000100)
            .expect("backend event must be accepted");
        let mut publisher = MockRelayPublisher::new(vec![Ok(PublishRelayReport {
            relay_results: vec![PublishRelayResult {
                relay_url: "wss://relay-one.test".to_string(),
                accepted: true,
                message: Some("ok".to_string()),
            }],
        })]);

        let outcomes = drain_pending_publish_outbox(&daemon_dir, &mut publisher, 1710001000200)
            .expect("pending backend event must publish");

        assert_eq!(outcomes.len(), 1);
        assert_eq!(outcomes[0].event_id, fixture.signed.id);
        assert_eq!(outcomes[0].status, PublishOutboxStatus::Published);
        assert_eq!(publisher.published_events, vec![fixture.signed.clone()]);

        let published = read_published_publish_outbox_record(&daemon_dir, &fixture.signed.id)
            .expect("published record read must succeed")
            .expect("published record must exist");
        assert_eq!(published.event, fixture.signed);
        assert_eq!(published.request.agent_pubkey, fixture.pubkey);

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn accepts_duplicate_signed_event_idempotently() {
        let fixture = signed_event_fixture();
        let daemon_dir = unique_temp_daemon_dir();
        let first = publish_request_message(&fixture, 41, 1710001000000);
        let second = publish_request_message(&fixture, 42, 1710001000500);

        let first_record = accept_worker_publish_request(&daemon_dir, &first, 1710001000100)
            .expect("first publish request must be accepted");
        let second_record = accept_worker_publish_request(&daemon_dir, &second, 1710001000600)
            .expect("duplicate publish request must be idempotent");

        assert_eq!(second_record, first_record);
        assert_eq!(second_record.request.request_sequence, 41);
        assert_eq!(second_record.accepted_at, 1710001000100);

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn accepts_duplicate_signed_event_from_failed_outbox_without_requeueing() {
        let fixture = signed_event_fixture();
        let daemon_dir = unique_temp_daemon_dir();
        let message = publish_request_message(&fixture, 41, 1710001000000);
        accept_worker_publish_request(&daemon_dir, &message, 1710001000100)
            .expect("publish request must be accepted");
        let mut publisher = MockRelayPublisher::new(vec![Err(PublishRelayError {
            message: "relay connection failed".to_string(),
            retryable: true,
        })]);
        drain_pending_publish_outbox(&daemon_dir, &mut publisher, 1710001000200)
            .expect("pending outbox drain must fail into failed dir");

        let duplicate = accept_worker_publish_request(&daemon_dir, &message, 1710001000300)
            .expect("duplicate failed publish request must be idempotent");

        assert_eq!(duplicate.status, PublishOutboxStatus::Failed);
        assert_eq!(duplicate.event, fixture.signed);
        assert_eq!(duplicate.attempts[0].next_attempt_at, Some(1710001001200));
        assert!(
            read_pending_publish_outbox_record(&daemon_dir, &fixture.signed.id)
                .expect("pending record read must succeed")
                .is_none()
        );
        assert!(
            read_failed_publish_outbox_record(&daemon_dir, &fixture.signed.id)
                .expect("failed record read must succeed")
                .is_some()
        );

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn accepts_duplicate_signed_event_from_published_outbox_without_republishing() {
        let fixture = signed_event_fixture();
        let daemon_dir = unique_temp_daemon_dir();
        let message = publish_request_message(&fixture, 41, 1710001000000);
        accept_worker_publish_request(&daemon_dir, &message, 1710001000100)
            .expect("publish request must be accepted");
        let mut publisher = MockRelayPublisher::new(vec![Ok(PublishRelayReport {
            relay_results: vec![PublishRelayResult {
                relay_url: "wss://relay-one.test".to_string(),
                accepted: true,
                message: Some("ok".to_string()),
            }],
        })]);
        drain_pending_publish_outbox(&daemon_dir, &mut publisher, 1710001000200)
            .expect("pending outbox drain must publish");

        let duplicate = accept_worker_publish_request(&daemon_dir, &message, 1710001000300)
            .expect("duplicate published publish request must be idempotent");

        assert_eq!(duplicate.status, PublishOutboxStatus::Published);
        assert_eq!(duplicate.event, fixture.signed);
        assert!(
            read_pending_publish_outbox_record(&daemon_dir, &fixture.signed.id)
                .expect("pending record read must succeed")
                .is_none()
        );
        assert!(
            read_published_publish_outbox_record(&daemon_dir, &fixture.signed.id)
                .expect("published record read must succeed")
                .is_some()
        );

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn rejects_publish_request_when_agent_pubkey_does_not_match_signed_event() {
        let fixture = signed_event_fixture();
        let daemon_dir = unique_temp_daemon_dir();
        let mut message = publish_request_message(&fixture, 41, 1710001000000);
        message["agentPubkey"] = json!("a".repeat(64));

        let error = accept_worker_publish_request(&daemon_dir, &message, 1710001000100)
            .expect_err("wrong agent pubkey must be rejected");

        assert!(matches!(
            error,
            PublishOutboxError::AgentPubkeyMismatch { .. }
        ));
        assert!(
            read_pending_publish_outbox_record(&daemon_dir, &fixture.signed.id)
                .expect("outbox read must succeed")
                .is_none()
        );

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn rejects_mutated_signed_event_before_persisting() {
        let fixture = signed_event_fixture();
        let daemon_dir = unique_temp_daemon_dir();
        let mut message = publish_request_message(&fixture, 41, 1710001000000);
        message["event"]["content"] = json!("mutated after signing");

        let error = accept_worker_publish_request(&daemon_dir, &message, 1710001000100)
            .expect_err("mutated event must be rejected");

        assert!(matches!(error, PublishOutboxError::Nostr(_)));
        assert!(
            read_pending_publish_outbox_record(&daemon_dir, &fixture.signed.id)
                .expect("outbox read must succeed")
                .is_none()
        );

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn drains_pending_record_to_published_after_relay_acceptance() {
        let fixture = signed_event_fixture();
        let daemon_dir = unique_temp_daemon_dir();
        let message = publish_request_message(&fixture, 41, 1710001000000);
        accept_worker_publish_request(&daemon_dir, &message, 1710001000100)
            .expect("publish request must be accepted");
        let mut publisher = MockRelayPublisher::new(vec![Ok(PublishRelayReport {
            relay_results: vec![
                PublishRelayResult {
                    relay_url: "wss://relay-one.test".to_string(),
                    accepted: true,
                    message: Some("ok".to_string()),
                },
                PublishRelayResult {
                    relay_url: "wss://relay-two.test".to_string(),
                    accepted: false,
                    message: Some("duplicate".to_string()),
                },
            ],
        })]);

        let outcomes = drain_pending_publish_outbox(&daemon_dir, &mut publisher, 1710001000200)
            .expect("pending outbox drain must succeed");

        assert_eq!(outcomes.len(), 1);
        assert_eq!(outcomes[0].event_id, fixture.signed.id);
        assert_eq!(outcomes[0].status, PublishOutboxStatus::Published);
        assert_eq!(publisher.published_events, vec![fixture.signed.clone()]);
        assert!(
            read_pending_publish_outbox_record(&daemon_dir, &fixture.signed.id)
                .expect("pending record read must succeed")
                .is_none()
        );

        let published = read_published_publish_outbox_record(&daemon_dir, &fixture.signed.id)
            .expect("published record read must succeed")
            .expect("published record must exist");
        assert_eq!(published.status, PublishOutboxStatus::Published);
        assert_eq!(published.event, fixture.signed);
        assert_eq!(published.attempts.len(), 1);
        assert_eq!(
            published.attempts[0].status,
            PublishRelayAttemptStatus::Published
        );
        assert_eq!(published.attempts[0].attempted_at, 1710001000200);
        assert_eq!(published.attempts[0].relay_results.len(), 2);

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn drains_pending_record_to_failed_after_publish_error() {
        let fixture = signed_event_fixture();
        let daemon_dir = unique_temp_daemon_dir();
        let message = publish_request_message(&fixture, 41, 1710001000000);
        accept_worker_publish_request(&daemon_dir, &message, 1710001000100)
            .expect("publish request must be accepted");
        let mut publisher = MockRelayPublisher::new(vec![Err(PublishRelayError {
            message: "relay connection failed".to_string(),
            retryable: true,
        })]);

        let outcomes = drain_pending_publish_outbox(&daemon_dir, &mut publisher, 1710001000200)
            .expect("pending outbox drain must succeed");

        assert_eq!(outcomes.len(), 1);
        assert_eq!(outcomes[0].event_id, fixture.signed.id);
        assert_eq!(outcomes[0].status, PublishOutboxStatus::Failed);
        assert_eq!(publisher.published_events, vec![fixture.signed.clone()]);
        assert!(
            read_pending_publish_outbox_record(&daemon_dir, &fixture.signed.id)
                .expect("pending record read must succeed")
                .is_none()
        );

        let failed = read_failed_publish_outbox_record(&daemon_dir, &fixture.signed.id)
            .expect("failed record read must succeed")
            .expect("failed record must exist");
        assert_eq!(failed.status, PublishOutboxStatus::Failed);
        assert_eq!(failed.event, fixture.signed);
        assert_eq!(failed.attempts.len(), 1);
        assert_eq!(failed.attempts[0].status, PublishRelayAttemptStatus::Failed);
        assert_eq!(
            failed.attempts[0].error.as_deref(),
            Some("relay connection failed")
        );
        assert!(failed.attempts[0].retryable);
        assert_eq!(failed.attempts[0].next_attempt_at, Some(1710001001200));

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn treats_duplicate_relay_rejection_as_published() {
        let fixture = signed_event_fixture();
        let daemon_dir = unique_temp_daemon_dir();
        let message = publish_request_message(&fixture, 41, 1710001000000);
        accept_worker_publish_request(&daemon_dir, &message, 1710001000100)
            .expect("publish request must be accepted");
        let mut publisher = MockRelayPublisher::new(vec![Ok(PublishRelayReport {
            relay_results: vec![PublishRelayResult {
                relay_url: "wss://relay-one.test".to_string(),
                accepted: false,
                message: Some("duplicate: already have this event".to_string()),
            }],
        })]);

        let outcomes = drain_pending_publish_outbox(&daemon_dir, &mut publisher, 1710001000200)
            .expect("duplicate relay response must be treated as published");

        assert_eq!(outcomes.len(), 1);
        assert_eq!(outcomes[0].status, PublishOutboxStatus::Published);
        let published = read_published_publish_outbox_record(&daemon_dir, &fixture.signed.id)
            .expect("published record read must succeed")
            .expect("published record must exist");
        assert_eq!(
            published.attempts[0].status,
            PublishRelayAttemptStatus::Published
        );
        assert!(!published.attempts[0].relay_results[0].accepted);

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn does_not_retry_permanent_relay_rejections() {
        let fixture = signed_event_fixture();
        let daemon_dir = unique_temp_daemon_dir();
        let message = publish_request_message(&fixture, 41, 1710001000000);
        accept_worker_publish_request(&daemon_dir, &message, 1710001000100)
            .expect("publish request must be accepted");
        let mut publisher = MockRelayPublisher::new(vec![Ok(PublishRelayReport {
            relay_results: vec![PublishRelayResult {
                relay_url: "wss://relay-one.test".to_string(),
                accepted: false,
                message: Some("invalid: event policy rejected".to_string()),
            }],
        })]);

        let outcomes = drain_pending_publish_outbox(&daemon_dir, &mut publisher, 1710001000200)
            .expect("permanent relay rejection must move to failed dir");

        assert_eq!(outcomes.len(), 1);
        assert_eq!(outcomes[0].status, PublishOutboxStatus::Failed);
        let failed = read_failed_publish_outbox_record(&daemon_dir, &fixture.signed.id)
            .expect("failed record read must succeed")
            .expect("failed record must exist");
        assert!(!failed.attempts[0].retryable);
        assert_eq!(failed.attempts[0].next_attempt_at, None);

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn requeues_due_retryable_failed_record_to_pending_and_publishes_on_next_drain() {
        let fixture = signed_event_fixture();
        let daemon_dir = unique_temp_daemon_dir();
        let message = publish_request_message(&fixture, 41, 1710001000000);
        accept_worker_publish_request(&daemon_dir, &message, 1710001000100)
            .expect("publish request must be accepted");
        let mut failing_publisher = MockRelayPublisher::new(vec![Err(PublishRelayError {
            message: "relay connection failed".to_string(),
            retryable: true,
        })]);
        drain_pending_publish_outbox(&daemon_dir, &mut failing_publisher, 1710001000200)
            .expect("pending outbox drain must fail into failed dir");

        let not_due = requeue_due_failed_publish_outbox_records(&daemon_dir, 1710001001199)
            .expect("not-due requeue scan must succeed");

        assert!(not_due.is_empty());
        assert!(
            read_pending_publish_outbox_record(&daemon_dir, &fixture.signed.id)
                .expect("pending record read must succeed")
                .is_none()
        );
        assert!(
            read_failed_publish_outbox_record(&daemon_dir, &fixture.signed.id)
                .expect("failed record read must succeed")
                .is_some()
        );

        let requeued = requeue_due_failed_publish_outbox_records(&daemon_dir, 1710001001200)
            .expect("due requeue scan must succeed");

        assert_eq!(requeued.len(), 1);
        assert_eq!(requeued[0].event_id, fixture.signed.id);
        assert_eq!(requeued[0].status, PublishOutboxStatus::Accepted);
        assert!(
            read_failed_publish_outbox_record(&daemon_dir, &fixture.signed.id)
                .expect("failed record read must succeed")
                .is_none()
        );

        let pending = read_pending_publish_outbox_record(&daemon_dir, &fixture.signed.id)
            .expect("pending record read must succeed")
            .expect("pending record must exist after requeue");
        assert_eq!(pending.status, PublishOutboxStatus::Accepted);
        assert_eq!(pending.attempts.len(), 1);
        assert_eq!(pending.attempts[0].next_attempt_at, Some(1710001001200));

        let mut succeeding_publisher = MockRelayPublisher::new(vec![Ok(PublishRelayReport {
            relay_results: vec![PublishRelayResult {
                relay_url: "wss://relay-one.test".to_string(),
                accepted: true,
                message: Some("ok".to_string()),
            }],
        })]);
        drain_pending_publish_outbox(&daemon_dir, &mut succeeding_publisher, 1710001001300)
            .expect("requeued outbox drain must publish");

        let published = read_published_publish_outbox_record(&daemon_dir, &fixture.signed.id)
            .expect("published record read must succeed")
            .expect("published record must exist");
        assert_eq!(published.status, PublishOutboxStatus::Published);
        assert_eq!(published.attempts.len(), 2);
        assert_eq!(
            published.attempts[0].status,
            PublishRelayAttemptStatus::Failed
        );
        assert_eq!(
            published.attempts[1].status,
            PublishRelayAttemptStatus::Published
        );
        assert_eq!(published.attempts[1].next_attempt_at, None);

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn maintenance_requeues_due_failed_records_and_drains_pending() {
        let fixture = signed_event_fixture();
        let daemon_dir = unique_temp_daemon_dir();
        let message = publish_request_message(&fixture, 41, 1710001000000);
        accept_worker_publish_request(&daemon_dir, &message, 1710001000100)
            .expect("publish request must be accepted");
        let mut failing_publisher = MockRelayPublisher::new(vec![Err(PublishRelayError {
            message: "relay connection failed".to_string(),
            retryable: true,
        })]);
        drain_pending_publish_outbox(&daemon_dir, &mut failing_publisher, 1710001000200)
            .expect("pending outbox drain must fail into failed dir");

        let mut succeeding_publisher = MockRelayPublisher::new(vec![Ok(PublishRelayReport {
            relay_results: vec![PublishRelayResult {
                relay_url: "wss://relay-one.test".to_string(),
                accepted: true,
                message: Some("ok".to_string()),
            }],
        })]);

        let report =
            run_publish_outbox_maintenance(&daemon_dir, &mut succeeding_publisher, 1710001001200)
                .expect("maintenance pass must succeed");

        assert_eq!(report.diagnostics_before.pending_count, 0);
        assert_eq!(report.diagnostics_before.failed_count, 1);
        assert_eq!(report.diagnostics_before.retry_due_count, 1);
        assert_eq!(report.requeued.len(), 1);
        assert_eq!(report.requeued[0].event_id, fixture.signed.id);
        assert_eq!(report.requeued[0].status, PublishOutboxStatus::Accepted);
        assert_eq!(report.drained.len(), 1);
        assert_eq!(report.drained[0].event_id, fixture.signed.id);
        assert_eq!(report.drained[0].status, PublishOutboxStatus::Published);
        assert_eq!(report.diagnostics_after.pending_count, 0);
        assert_eq!(report.diagnostics_after.failed_count, 0);
        assert_eq!(report.diagnostics_after.published_count, 1);
        assert_eq!(report.diagnostics_after.retry_due_count, 0);
        assert_eq!(report.diagnostics_after.latest_failure, None);
        assert_eq!(succeeding_publisher.published_events.len(), 1);
        assert_eq!(succeeding_publisher.published_events[0], fixture.signed);

        let published = read_published_publish_outbox_record(&daemon_dir, &fixture.signed.id)
            .expect("published record read must succeed")
            .expect("published record must exist");
        assert_eq!(published.status, PublishOutboxStatus::Published);
        assert_eq!(published.attempts.len(), 2);
        assert_eq!(
            published.attempts[0].status,
            PublishRelayAttemptStatus::Failed
        );
        assert_eq!(
            published.attempts[1].status,
            PublishRelayAttemptStatus::Published
        );

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn maintenance_leaves_future_retry_failed_records_in_place() {
        let fixture = signed_event_fixture();
        let daemon_dir = unique_temp_daemon_dir();
        let message = publish_request_message(&fixture, 41, 1710001000000);
        accept_worker_publish_request(&daemon_dir, &message, 1710001000100)
            .expect("publish request must be accepted");
        let mut failing_publisher = MockRelayPublisher::new(vec![Err(PublishRelayError {
            message: "relay connection failed".to_string(),
            retryable: true,
        })]);
        drain_pending_publish_outbox(&daemon_dir, &mut failing_publisher, 1710001000200)
            .expect("pending outbox drain must fail into failed dir");

        let mut unused_publisher = MockRelayPublisher::new(vec![]);
        let report =
            run_publish_outbox_maintenance(&daemon_dir, &mut unused_publisher, 1710001001199)
                .expect("maintenance pass must succeed");

        assert_eq!(report.diagnostics_before.failed_count, 1);
        assert_eq!(report.diagnostics_before.retry_due_count, 0);
        assert_eq!(report.diagnostics_before.next_retry_at, Some(1710001001200));
        assert!(report.requeued.is_empty());
        assert!(report.drained.is_empty());
        assert_eq!(report.diagnostics_after.failed_count, 1);
        assert_eq!(report.diagnostics_after.retry_due_count, 0);
        assert_eq!(unused_publisher.published_events.len(), 0);
        assert!(
            read_failed_publish_outbox_record(&daemon_dir, &fixture.signed.id)
                .expect("failed record read must succeed")
                .is_some()
        );

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn maintenance_removes_stale_failed_record_when_event_is_already_published() {
        let fixture = signed_event_fixture();
        let daemon_dir = unique_temp_daemon_dir();
        let message = publish_request_message(&fixture, 41, 1710001000000);
        accept_worker_publish_request(&daemon_dir, &message, 1710001000100)
            .expect("publish request must be accepted");
        let mut publisher = MockRelayPublisher::new(vec![Ok(PublishRelayReport {
            relay_results: vec![PublishRelayResult {
                relay_url: "wss://relay-one.test".to_string(),
                accepted: true,
                message: Some("ok".to_string()),
            }],
        })]);
        drain_pending_publish_outbox(&daemon_dir, &mut publisher, 1710001000200)
            .expect("pending outbox drain must publish");

        let mut stale_failed =
            read_published_publish_outbox_record(&daemon_dir, &fixture.signed.id)
                .expect("published record read must succeed")
                .expect("published record must exist");
        stale_failed.status = PublishOutboxStatus::Failed;
        stale_failed.attempts.push(PublishRelayAttempt {
            attempted_at: 1710001000300,
            status: PublishRelayAttemptStatus::Failed,
            relay_results: Vec::new(),
            error: Some("stale retry marker".to_string()),
            retryable: true,
            next_attempt_at: Some(1710001001200),
        });
        write_test_record(
            failed_publish_outbox_record_path(&daemon_dir, &fixture.signed.id),
            &stale_failed,
        );

        let mut unused_publisher = MockRelayPublisher::new(vec![]);
        let report =
            run_publish_outbox_maintenance(&daemon_dir, &mut unused_publisher, 1710001001200)
                .expect("maintenance pass must clean stale failed source");

        assert_eq!(report.diagnostics_before.published_count, 1);
        assert_eq!(report.diagnostics_before.failed_count, 1);
        assert_eq!(report.diagnostics_before.retry_due_count, 1);
        assert_eq!(report.requeued.len(), 1);
        assert_eq!(report.requeued[0].event_id, fixture.signed.id);
        assert_eq!(report.requeued[0].status, PublishOutboxStatus::Published);
        assert!(report.drained.is_empty());
        assert_eq!(report.diagnostics_after.published_count, 1);
        assert_eq!(report.diagnostics_after.failed_count, 0);
        assert_eq!(report.diagnostics_after.retry_due_count, 0);
        assert_eq!(unused_publisher.published_events.len(), 0);
        assert!(
            read_failed_publish_outbox_record(&daemon_dir, &fixture.signed.id)
                .expect("failed record read must succeed")
                .is_none()
        );

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn does_not_requeue_non_retryable_failed_record() {
        let fixture = signed_event_fixture();
        let daemon_dir = unique_temp_daemon_dir();
        let message = publish_request_message(&fixture, 41, 1710001000000);
        accept_worker_publish_request(&daemon_dir, &message, 1710001000100)
            .expect("publish request must be accepted");
        let mut publisher = MockRelayPublisher::new(vec![Err(PublishRelayError {
            message: "relay rejected permanently".to_string(),
            retryable: false,
        })]);
        drain_pending_publish_outbox(&daemon_dir, &mut publisher, 1710001000200)
            .expect("pending outbox drain must fail into failed dir");

        let requeued = requeue_due_failed_publish_outbox_records(&daemon_dir, 1710009999999)
            .expect("requeue scan must succeed");

        assert!(requeued.is_empty());
        let failed = read_failed_publish_outbox_record(&daemon_dir, &fixture.signed.id)
            .expect("failed record read must succeed")
            .expect("failed record must stay in failed dir");
        assert!(!failed.attempts[0].retryable);
        assert_eq!(failed.attempts[0].next_attempt_at, None);

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    fn publish_request_message(
        fixture: &Nip01EventFixture,
        sequence: u64,
        timestamp: u64,
    ) -> Value {
        json!({
            "version": AGENT_WORKER_PROTOCOL_VERSION,
            "type": "publish_request",
            "correlationId": "rust_publish_outbox",
            "sequence": sequence,
            "timestamp": timestamp,
            "projectId": "project-alpha",
            "agentPubkey": fixture.pubkey,
            "conversationId": "conversation-alpha",
            "ralNumber": 7,
            "requestId": "publish-fixture-01",
            "requiresEventId": true,
            "timeoutMs": 30000,
            "runtimeEventClass": "complete",
            "event": fixture.signed,
        })
    }

    fn backend_publish_input(
        fixture: &Nip01EventFixture,
        request_sequence: u64,
        request_timestamp: u64,
    ) -> BackendPublishOutboxInput {
        BackendPublishOutboxInput {
            request_id: "backend-publish-fixture-01".to_string(),
            request_sequence,
            request_timestamp,
            correlation_id: "rust_backend_publish_outbox".to_string(),
            project_id: "project-alpha".to_string(),
            conversation_id: "conversation-alpha".to_string(),
            publisher_pubkey: fixture.pubkey.clone(),
            ral_number: 0,
            requires_event_id: true,
            timeout_ms: 30000,
            event: fixture.signed.clone(),
        }
    }

    fn signed_event_fixture() -> Nip01EventFixture {
        serde_json::from_str(STREAM_TEXT_DELTA_FIXTURE).expect("fixture must parse")
    }

    struct MockRelayPublisher {
        outcomes: VecDeque<Result<PublishRelayReport, PublishRelayError>>,
        published_events: Vec<SignedNostrEvent>,
    }

    impl MockRelayPublisher {
        fn new(outcomes: Vec<Result<PublishRelayReport, PublishRelayError>>) -> Self {
            Self {
                outcomes: outcomes.into(),
                published_events: Vec::new(),
            }
        }
    }

    impl PublishOutboxRelayPublisher for MockRelayPublisher {
        fn publish_signed_event(
            &mut self,
            event: &SignedNostrEvent,
        ) -> Result<PublishRelayReport, PublishRelayError> {
            self.published_events.push(event.clone());
            self.outcomes
                .pop_front()
                .expect("mock publisher outcome must exist")
        }
    }

    fn write_test_record(path: PathBuf, record: &PublishOutboxRecord) {
        fs::create_dir_all(
            path.parent()
                .expect("test publish outbox record path must have parent"),
        )
        .expect("test publish outbox record dir must be created");
        write_record_file(&path, record).expect("test publish outbox record must be written");
    }

    fn unique_temp_daemon_dir() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be after UNIX_EPOCH")
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let daemon_dir = std::env::temp_dir().join(format!(
            "tenex-publish-outbox-{}-{counter}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&daemon_dir).expect("temp daemon dir must be created");
        daemon_dir
    }
}
