use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

pub const TELEGRAM_OUTBOX_DIR_NAME: &str = "transport-outbox/telegram";
pub const TELEGRAM_OUTBOX_PENDING_DIR_NAME: &str = "pending";
pub const TELEGRAM_OUTBOX_DELIVERED_DIR_NAME: &str = "delivered";
pub const TELEGRAM_OUTBOX_FAILED_DIR_NAME: &str = "failed";
pub const TELEGRAM_OUTBOX_TMP_DIR_NAME: &str = "tmp";
pub const TELEGRAM_OUTBOX_WRITER: &str = "rust-daemon";
pub const TELEGRAM_OUTBOX_RECORD_SCHEMA_VERSION: u32 = 1;
pub const TELEGRAM_OUTBOX_DIAGNOSTICS_SCHEMA_VERSION: u32 = 1;
pub const DEFAULT_TELEGRAM_OUTBOX_RETRY_INITIAL_DELAY_MS: u64 = 1_000;
pub const DEFAULT_TELEGRAM_OUTBOX_RETRY_MAX_DELAY_MS: u64 = 60_000;

#[derive(Debug, Error)]
pub enum TelegramOutboxError {
    #[error("telegram outbox io error: {0}")]
    Io(#[from] io::Error),
    #[error("telegram outbox json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("telegram outbox record id conflict at {path}")]
    RecordIdConflict { path: PathBuf },
    #[error("telegram outbox record has invalid status {status:?} for drain")]
    InvalidDrainStatus { status: TelegramOutboxStatus },
    #[error("telegram outbox record has invalid status {status:?} for requeue")]
    InvalidRequeueStatus { status: TelegramOutboxStatus },
    #[error("telegram outbox record schema version {found} is not supported (expected {expected})")]
    UnsupportedSchemaVersion { found: u32, expected: u32 },
    #[error("telegram outbox record is missing required field: {field}")]
    MissingField { field: &'static str },
}

pub type TelegramOutboxResult<T> = Result<T, TelegramOutboxError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TelegramOutboxStatus {
    Pending,
    Delivered,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TelegramDeliveryAttemptStatus {
    Delivered,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramProjectBinding {
    pub project_d_tag: String,
    pub backend_pubkey: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramChannelBinding {
    pub chat_id: i64,
    pub message_thread_id: Option<i64>,
    pub channel_label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramSenderIdentity {
    pub agent_pubkey: String,
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum TelegramDeliveryPayload {
    HtmlText { html: String },
    PlainText { text: String },
    AskError { html: String },
    ReservedVoice { marker: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TelegramDeliveryReason {
    FinalReply,
    ConversationMirror,
    ReasoningMirror,
    AskError,
    ToolPublicationMirror,
    Voice,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramDeliveryRequest {
    pub nostr_event_id: String,
    pub correlation_id: String,
    pub project_binding: TelegramProjectBinding,
    pub channel_binding: TelegramChannelBinding,
    pub sender_identity: TelegramSenderIdentity,
    pub delivery_reason: TelegramDeliveryReason,
    pub reply_to_telegram_message_id: Option<i64>,
    pub payload: TelegramDeliveryPayload,
    pub writer_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TelegramErrorClass {
    Network,
    Timeout,
    RateLimited,
    ServerError,
    BadRequest,
    Unauthorized,
    BotBlocked,
    ChatNotFound,
    Unknown,
}

impl TelegramErrorClass {
    pub fn is_retryable(self) -> bool {
        matches!(
            self,
            TelegramErrorClass::Network
                | TelegramErrorClass::Timeout
                | TelegramErrorClass::RateLimited
                | TelegramErrorClass::ServerError
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramDeliveryAttempt {
    pub attempted_at: u64,
    pub status: TelegramDeliveryAttemptStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub telegram_message_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_class: Option<TelegramErrorClass>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_after: Option<u64>,
    pub retryable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_attempt_at: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramOutboxRecord {
    pub schema_version: u32,
    pub writer: String,
    pub writer_version: String,
    pub record_id: String,
    pub status: TelegramOutboxStatus,
    pub created_at: u64,
    pub updated_at: u64,
    pub nostr_event_id: String,
    pub correlation_id: String,
    pub project_binding: TelegramProjectBinding,
    pub channel_binding: TelegramChannelBinding,
    pub sender_identity: TelegramSenderIdentity,
    pub delivery_reason: TelegramDeliveryReason,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to_telegram_message_id: Option<i64>,
    pub payload: TelegramDeliveryPayload,
    #[serde(default)]
    pub attempts: Vec<TelegramDeliveryAttempt>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramOutboxDrainOutcome {
    pub record_id: String,
    pub nostr_event_id: String,
    pub status: TelegramOutboxStatus,
    pub source_path: PathBuf,
    pub target_path: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub telegram_message_id: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramOutboxRequeueOutcome {
    pub record_id: String,
    pub nostr_event_id: String,
    pub status: TelegramOutboxStatus,
    pub source_path: PathBuf,
    pub target_path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramOutboxPendingDiagnostic {
    pub record_id: String,
    pub nostr_event_id: String,
    pub created_at: u64,
    pub correlation_id: String,
    pub project_d_tag: String,
    pub chat_id: i64,
    pub delivery_reason: TelegramDeliveryReason,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramOutboxFailureDiagnostic {
    pub record_id: String,
    pub nostr_event_id: String,
    pub correlation_id: String,
    pub project_d_tag: String,
    pub chat_id: i64,
    pub attempt_count: usize,
    pub attempted_at: u64,
    pub error_class: Option<TelegramErrorClass>,
    pub error_detail: Option<String>,
    pub retryable: bool,
    pub next_attempt_at: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramOutboxDiagnostics {
    pub schema_version: u32,
    pub inspected_at: u64,
    pub pending_count: usize,
    pub delivered_count: usize,
    pub failed_count: usize,
    pub retryable_failed_count: usize,
    pub retry_due_count: usize,
    pub permanent_failed_count: usize,
    pub tmp_file_count: usize,
    pub oldest_pending: Option<TelegramOutboxPendingDiagnostic>,
    pub next_retry_at: Option<u64>,
    pub latest_failure: Option<TelegramOutboxFailureDiagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramOutboxMaintenanceReport {
    pub diagnostics_before: TelegramOutboxDiagnostics,
    pub requeued: Vec<TelegramOutboxRequeueOutcome>,
    pub drained: Vec<TelegramOutboxDrainOutcome>,
    pub diagnostics_after: TelegramOutboxDiagnostics,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TelegramOutboxRetryPolicy {
    pub initial_delay_ms: u64,
    pub max_delay_ms: u64,
}

impl Default for TelegramOutboxRetryPolicy {
    fn default() -> Self {
        Self {
            initial_delay_ms: DEFAULT_TELEGRAM_OUTBOX_RETRY_INITIAL_DELAY_MS,
            max_delay_ms: DEFAULT_TELEGRAM_OUTBOX_RETRY_MAX_DELAY_MS,
        }
    }
}

impl TelegramOutboxRetryPolicy {
    pub fn delay_for_failure_count(self, previous_failed_attempts: usize) -> u64 {
        let mut delay = self.initial_delay_ms.max(1);
        let max_delay = self.max_delay_ms.max(delay);

        for _ in 0..previous_failed_attempts {
            delay = delay.saturating_mul(2).min(max_delay);
        }

        delay
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TelegramDeliveryResult {
    Delivered {
        telegram_message_id: i64,
        delivered_at: u64,
    },
    RetryableFailure {
        error_class: TelegramErrorClass,
        error_detail: String,
        retry_after: Option<u64>,
    },
    PermanentFailure {
        error_class: TelegramErrorClass,
        error_detail: String,
    },
}

pub trait TelegramDeliveryPublisher {
    fn deliver(&mut self, record: &TelegramOutboxRecord) -> TelegramDeliveryResult;
}

pub fn telegram_outbox_dir(daemon_dir: impl AsRef<Path>) -> PathBuf {
    daemon_dir.as_ref().join(TELEGRAM_OUTBOX_DIR_NAME)
}

pub fn pending_telegram_outbox_dir(daemon_dir: impl AsRef<Path>) -> PathBuf {
    telegram_outbox_dir(daemon_dir).join(TELEGRAM_OUTBOX_PENDING_DIR_NAME)
}

pub fn delivered_telegram_outbox_dir(daemon_dir: impl AsRef<Path>) -> PathBuf {
    telegram_outbox_dir(daemon_dir).join(TELEGRAM_OUTBOX_DELIVERED_DIR_NAME)
}

pub fn failed_telegram_outbox_dir(daemon_dir: impl AsRef<Path>) -> PathBuf {
    telegram_outbox_dir(daemon_dir).join(TELEGRAM_OUTBOX_FAILED_DIR_NAME)
}

pub fn tmp_telegram_outbox_dir(daemon_dir: impl AsRef<Path>) -> PathBuf {
    telegram_outbox_dir(daemon_dir).join(TELEGRAM_OUTBOX_TMP_DIR_NAME)
}

pub fn pending_telegram_outbox_record_path(
    daemon_dir: impl AsRef<Path>,
    record_id: &str,
) -> PathBuf {
    pending_telegram_outbox_dir(daemon_dir).join(format!("{record_id}.json"))
}

pub fn delivered_telegram_outbox_record_path(
    daemon_dir: impl AsRef<Path>,
    record_id: &str,
) -> PathBuf {
    delivered_telegram_outbox_dir(daemon_dir).join(format!("{record_id}.json"))
}

pub fn failed_telegram_outbox_record_path(
    daemon_dir: impl AsRef<Path>,
    record_id: &str,
) -> PathBuf {
    failed_telegram_outbox_dir(daemon_dir).join(format!("{record_id}.json"))
}

pub fn derive_telegram_outbox_record_id(
    nostr_event_id: &str,
    chat_id: i64,
    reply_to_telegram_message_id: Option<i64>,
) -> String {
    let reply_component = match reply_to_telegram_message_id {
        Some(id) => id.to_string(),
        None => String::from("none"),
    };
    let mut hasher = Sha256::new();
    hasher.update(b"telegram-outbox/v1\n");
    hasher.update(nostr_event_id.as_bytes());
    hasher.update(b"\n");
    hasher.update(chat_id.to_string().as_bytes());
    hasher.update(b"\n");
    hasher.update(reply_component.as_bytes());
    hex::encode(hasher.finalize())
}

pub fn accept_telegram_delivery_request(
    daemon_dir: impl AsRef<Path>,
    request: TelegramDeliveryRequest,
    accepted_at: u64,
) -> TelegramOutboxResult<TelegramOutboxRecord> {
    validate_delivery_request(&request)?;

    let record_id = derive_telegram_outbox_record_id(
        &request.nostr_event_id,
        request.channel_binding.chat_id,
        request.reply_to_telegram_message_id,
    );

    let record = TelegramOutboxRecord {
        schema_version: TELEGRAM_OUTBOX_RECORD_SCHEMA_VERSION,
        writer: TELEGRAM_OUTBOX_WRITER.to_string(),
        writer_version: request.writer_version,
        record_id,
        status: TelegramOutboxStatus::Pending,
        created_at: accepted_at,
        updated_at: accepted_at,
        nostr_event_id: request.nostr_event_id,
        correlation_id: request.correlation_id,
        project_binding: request.project_binding,
        channel_binding: request.channel_binding,
        sender_identity: request.sender_identity,
        delivery_reason: request.delivery_reason,
        reply_to_telegram_message_id: request.reply_to_telegram_message_id,
        payload: request.payload,
        attempts: Vec::new(),
    };

    persist_pending_record(daemon_dir.as_ref(), &record)
}

pub fn read_pending_telegram_outbox_record(
    daemon_dir: impl AsRef<Path>,
    record_id: &str,
) -> TelegramOutboxResult<Option<TelegramOutboxRecord>> {
    read_optional_record(pending_telegram_outbox_record_path(daemon_dir, record_id))
}

pub fn read_delivered_telegram_outbox_record(
    daemon_dir: impl AsRef<Path>,
    record_id: &str,
) -> TelegramOutboxResult<Option<TelegramOutboxRecord>> {
    read_optional_record(delivered_telegram_outbox_record_path(daemon_dir, record_id))
}

pub fn read_failed_telegram_outbox_record(
    daemon_dir: impl AsRef<Path>,
    record_id: &str,
) -> TelegramOutboxResult<Option<TelegramOutboxRecord>> {
    read_optional_record(failed_telegram_outbox_record_path(daemon_dir, record_id))
}

pub fn list_pending_telegram_outbox_record_paths(
    daemon_dir: impl AsRef<Path>,
) -> TelegramOutboxResult<Vec<PathBuf>> {
    list_record_paths(pending_telegram_outbox_dir(daemon_dir))
}

pub fn list_failed_telegram_outbox_record_paths(
    daemon_dir: impl AsRef<Path>,
) -> TelegramOutboxResult<Vec<PathBuf>> {
    list_record_paths(failed_telegram_outbox_dir(daemon_dir))
}

pub fn inspect_telegram_outbox(
    daemon_dir: impl AsRef<Path>,
    now: u64,
) -> TelegramOutboxResult<TelegramOutboxDiagnostics> {
    let daemon_dir = daemon_dir.as_ref();
    let pending_records =
        read_records_from_paths(list_pending_telegram_outbox_record_paths(daemon_dir)?)?;
    let delivered_records = read_records_from_paths(list_record_paths(
        delivered_telegram_outbox_dir(daemon_dir),
    )?)?;
    let failed_records =
        read_records_from_paths(list_failed_telegram_outbox_record_paths(daemon_dir)?)?;

    let mut retryable_failed_count = 0;
    let mut retry_due_count = 0;
    let mut permanent_failed_count = 0;
    let mut next_retry_at: Option<u64> = None;
    let mut latest_failure: Option<TelegramOutboxFailureDiagnostic> = None;

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

    Ok(TelegramOutboxDiagnostics {
        schema_version: TELEGRAM_OUTBOX_DIAGNOSTICS_SCHEMA_VERSION,
        inspected_at: now,
        pending_count: pending_records.len(),
        delivered_count: delivered_records.len(),
        failed_count: failed_records.len(),
        retryable_failed_count,
        retry_due_count,
        permanent_failed_count,
        tmp_file_count: list_tmp_telegram_outbox_paths(daemon_dir)?.len(),
        oldest_pending: pending_records
            .iter()
            .min_by_key(|record| record.created_at)
            .map(pending_diagnostic_from_record),
        next_retry_at,
        latest_failure,
    })
}

pub fn drain_pending_telegram_outbox<P: TelegramDeliveryPublisher>(
    daemon_dir: impl AsRef<Path>,
    publisher: &mut P,
    attempted_at: u64,
) -> TelegramOutboxResult<Vec<TelegramOutboxDrainOutcome>> {
    drain_pending_telegram_outbox_with_retry_policy(
        daemon_dir,
        publisher,
        attempted_at,
        TelegramOutboxRetryPolicy::default(),
    )
}

pub fn drain_pending_telegram_outbox_with_retry_policy<P: TelegramDeliveryPublisher>(
    daemon_dir: impl AsRef<Path>,
    publisher: &mut P,
    attempted_at: u64,
    retry_policy: TelegramOutboxRetryPolicy,
) -> TelegramOutboxResult<Vec<TelegramOutboxDrainOutcome>> {
    let daemon_dir = daemon_dir.as_ref();
    let paths = list_pending_telegram_outbox_record_paths(daemon_dir)?;
    let mut outcomes = Vec::with_capacity(paths.len());

    for source_path in paths {
        let Some(mut record) = read_optional_record(&source_path)? else {
            continue;
        };
        if record.status != TelegramOutboxStatus::Pending {
            return Err(TelegramOutboxError::InvalidDrainStatus {
                status: record.status,
            });
        }

        let outcome = publisher.deliver(&record);
        record.updated_at = attempted_at;
        match outcome {
            TelegramDeliveryResult::Delivered {
                telegram_message_id,
                delivered_at,
            } => {
                record.status = TelegramOutboxStatus::Delivered;
                record.attempts.push(TelegramDeliveryAttempt {
                    attempted_at,
                    status: TelegramDeliveryAttemptStatus::Delivered,
                    telegram_message_id: Some(telegram_message_id),
                    error_class: None,
                    error_detail: None,
                    retry_after: None,
                    retryable: false,
                    next_attempt_at: None,
                });
                record.updated_at = delivered_at.max(attempted_at);
                outcomes.push(transition_record(
                    daemon_dir,
                    &source_path,
                    delivered_telegram_outbox_record_path(daemon_dir, &record.record_id),
                    &record,
                    Some(telegram_message_id),
                )?);
            }
            TelegramDeliveryResult::RetryableFailure {
                error_class,
                error_detail,
                retry_after,
            } => {
                let next_attempt_at =
                    next_attempt_at(&record, attempted_at, retry_policy, retry_after);
                record.status = TelegramOutboxStatus::Failed;
                record.attempts.push(TelegramDeliveryAttempt {
                    attempted_at,
                    status: TelegramDeliveryAttemptStatus::Failed,
                    telegram_message_id: None,
                    error_class: Some(error_class),
                    error_detail: Some(error_detail),
                    retry_after,
                    retryable: true,
                    next_attempt_at: Some(next_attempt_at),
                });
                outcomes.push(transition_record(
                    daemon_dir,
                    &source_path,
                    failed_telegram_outbox_record_path(daemon_dir, &record.record_id),
                    &record,
                    None,
                )?);
            }
            TelegramDeliveryResult::PermanentFailure {
                error_class,
                error_detail,
            } => {
                record.status = TelegramOutboxStatus::Failed;
                record.attempts.push(TelegramDeliveryAttempt {
                    attempted_at,
                    status: TelegramDeliveryAttemptStatus::Failed,
                    telegram_message_id: None,
                    error_class: Some(error_class),
                    error_detail: Some(error_detail),
                    retry_after: None,
                    retryable: false,
                    next_attempt_at: None,
                });
                outcomes.push(transition_record(
                    daemon_dir,
                    &source_path,
                    failed_telegram_outbox_record_path(daemon_dir, &record.record_id),
                    &record,
                    None,
                )?);
            }
        }
    }

    Ok(outcomes)
}

pub fn requeue_due_failed_telegram_outbox_records(
    daemon_dir: impl AsRef<Path>,
    now: u64,
) -> TelegramOutboxResult<Vec<TelegramOutboxRequeueOutcome>> {
    let daemon_dir = daemon_dir.as_ref();
    let paths = list_failed_telegram_outbox_record_paths(daemon_dir)?;
    let mut outcomes = Vec::with_capacity(paths.len());

    for source_path in paths {
        let Some(mut record) = read_optional_record(&source_path)? else {
            continue;
        };
        if record.status != TelegramOutboxStatus::Failed {
            return Err(TelegramOutboxError::InvalidRequeueStatus {
                status: record.status,
            });
        }

        if !is_retry_due(&record, now) {
            continue;
        }

        record.status = TelegramOutboxStatus::Pending;
        record.updated_at = now;
        outcomes.push(transition_failed_record_to_pending(
            daemon_dir,
            &source_path,
            pending_telegram_outbox_record_path(daemon_dir, &record.record_id),
            &record,
        )?);
    }

    Ok(outcomes)
}

pub fn run_telegram_outbox_maintenance<P: TelegramDeliveryPublisher>(
    daemon_dir: impl AsRef<Path>,
    publisher: &mut P,
    now: u64,
) -> TelegramOutboxResult<TelegramOutboxMaintenanceReport> {
    run_telegram_outbox_maintenance_with_retry_policy(
        daemon_dir,
        publisher,
        now,
        TelegramOutboxRetryPolicy::default(),
    )
}

/// Maintenance variant used before the Bot API client lands: inspect the
/// outbox and requeue any due failed records, but do not attempt drain.
/// Pending records accumulate and surface through diagnostics. Callers must
/// switch to [`run_telegram_outbox_maintenance`] with a real publisher
/// once delivery is available.
pub fn run_telegram_outbox_maintenance_without_drain(
    daemon_dir: impl AsRef<Path>,
    now: u64,
) -> TelegramOutboxResult<TelegramOutboxMaintenanceReport> {
    let daemon_dir = daemon_dir.as_ref();
    let diagnostics_before = inspect_telegram_outbox(daemon_dir, now)?;
    let requeued = requeue_due_failed_telegram_outbox_records(daemon_dir, now)?;
    let diagnostics_after = inspect_telegram_outbox(daemon_dir, now)?;

    Ok(TelegramOutboxMaintenanceReport {
        diagnostics_before,
        requeued,
        drained: Vec::new(),
        diagnostics_after,
    })
}

pub fn run_telegram_outbox_maintenance_with_retry_policy<P: TelegramDeliveryPublisher>(
    daemon_dir: impl AsRef<Path>,
    publisher: &mut P,
    now: u64,
    retry_policy: TelegramOutboxRetryPolicy,
) -> TelegramOutboxResult<TelegramOutboxMaintenanceReport> {
    let daemon_dir = daemon_dir.as_ref();
    let diagnostics_before = inspect_telegram_outbox(daemon_dir, now)?;
    let requeued = requeue_due_failed_telegram_outbox_records(daemon_dir, now)?;
    let drained =
        drain_pending_telegram_outbox_with_retry_policy(daemon_dir, publisher, now, retry_policy)?;
    let diagnostics_after = inspect_telegram_outbox(daemon_dir, now)?;

    Ok(TelegramOutboxMaintenanceReport {
        diagnostics_before,
        requeued,
        drained,
        diagnostics_after,
    })
}

fn validate_delivery_request(request: &TelegramDeliveryRequest) -> TelegramOutboxResult<()> {
    if request.nostr_event_id.is_empty() {
        return Err(TelegramOutboxError::MissingField {
            field: "nostrEventId",
        });
    }
    if request.correlation_id.is_empty() {
        return Err(TelegramOutboxError::MissingField {
            field: "correlationId",
        });
    }
    if request.writer_version.is_empty() {
        return Err(TelegramOutboxError::MissingField {
            field: "writerVersion",
        });
    }
    if request.project_binding.project_d_tag.is_empty() {
        return Err(TelegramOutboxError::MissingField {
            field: "projectBinding.projectDTag",
        });
    }
    if request.project_binding.backend_pubkey.is_empty() {
        return Err(TelegramOutboxError::MissingField {
            field: "projectBinding.backendPubkey",
        });
    }
    if request.sender_identity.agent_pubkey.is_empty() {
        return Err(TelegramOutboxError::MissingField {
            field: "senderIdentity.agentPubkey",
        });
    }
    Ok(())
}

fn pending_diagnostic_from_record(
    record: &TelegramOutboxRecord,
) -> TelegramOutboxPendingDiagnostic {
    TelegramOutboxPendingDiagnostic {
        record_id: record.record_id.clone(),
        nostr_event_id: record.nostr_event_id.clone(),
        created_at: record.created_at,
        correlation_id: record.correlation_id.clone(),
        project_d_tag: record.project_binding.project_d_tag.clone(),
        chat_id: record.channel_binding.chat_id,
        delivery_reason: record.delivery_reason.clone(),
    }
}

fn failure_diagnostic_from_record(
    record: &TelegramOutboxRecord,
    latest_attempt: &TelegramDeliveryAttempt,
) -> TelegramOutboxFailureDiagnostic {
    TelegramOutboxFailureDiagnostic {
        record_id: record.record_id.clone(),
        nostr_event_id: record.nostr_event_id.clone(),
        correlation_id: record.correlation_id.clone(),
        project_d_tag: record.project_binding.project_d_tag.clone(),
        chat_id: record.channel_binding.chat_id,
        attempt_count: record.attempts.len(),
        attempted_at: latest_attempt.attempted_at,
        error_class: latest_attempt.error_class.clone(),
        error_detail: latest_attempt.error_detail.clone(),
        retryable: latest_attempt.retryable,
        next_attempt_at: latest_attempt.next_attempt_at,
    }
}

fn list_record_paths(dir: PathBuf) -> TelegramOutboxResult<Vec<PathBuf>> {
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

fn read_records_from_paths(paths: Vec<PathBuf>) -> TelegramOutboxResult<Vec<TelegramOutboxRecord>> {
    paths
        .into_iter()
        .filter_map(|path| match read_optional_record(&path) {
            Ok(Some(record)) => Some(Ok(record)),
            Ok(None) => None,
            Err(error) => Some(Err(error)),
        })
        .collect()
}

fn list_tmp_telegram_outbox_paths(daemon_dir: &Path) -> TelegramOutboxResult<Vec<PathBuf>> {
    let tmp_dir = tmp_telegram_outbox_dir(daemon_dir);
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
    record: &TelegramOutboxRecord,
    attempted_at: u64,
    retry_policy: TelegramOutboxRetryPolicy,
    retry_after: Option<u64>,
) -> u64 {
    if let Some(retry_after_ms) = retry_after {
        return attempted_at.saturating_add(retry_after_ms);
    }
    let previous_failed_attempts = record
        .attempts
        .iter()
        .filter(|attempt| attempt.status == TelegramDeliveryAttemptStatus::Failed)
        .count();
    attempted_at.saturating_add(retry_policy.delay_for_failure_count(previous_failed_attempts))
}

fn is_retry_due(record: &TelegramOutboxRecord, now: u64) -> bool {
    let Some(latest_attempt) = record.attempts.last() else {
        return false;
    };

    latest_attempt.status == TelegramDeliveryAttemptStatus::Failed
        && latest_attempt.retryable
        && latest_attempt
            .next_attempt_at
            .is_none_or(|next_attempt_at| next_attempt_at <= now)
}

fn persist_pending_record(
    daemon_dir: &Path,
    record: &TelegramOutboxRecord,
) -> TelegramOutboxResult<TelegramOutboxRecord> {
    let pending_dir = pending_telegram_outbox_dir(daemon_dir);
    let tmp_dir = tmp_telegram_outbox_dir(daemon_dir);
    fs::create_dir_all(&pending_dir)?;
    fs::create_dir_all(&tmp_dir)?;

    let record_path = pending_telegram_outbox_record_path(daemon_dir, &record.record_id);
    if let Some((existing_path, existing)) =
        read_existing_telegram_outbox_record(daemon_dir, &record.record_id)?
    {
        return existing_record_or_conflict(existing_path, existing, record);
    }

    let tmp_path = tmp_dir.join(format!(
        "{}.{}.{}.tmp",
        record.record_id,
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
            read_existing_telegram_outbox_record(daemon_dir, &record.record_id)?
        {
            return existing_record_or_conflict(existing_path, existing, record);
        }
        Err(TelegramOutboxError::RecordIdConflict { path: record_path })
    })();

    if write_result.is_err() {
        let _ = fs::remove_file(&tmp_path);
    }
    write_result
}

fn transition_record(
    daemon_dir: &Path,
    source_path: &Path,
    target_path: PathBuf,
    record: &TelegramOutboxRecord,
    telegram_message_id: Option<i64>,
) -> TelegramOutboxResult<TelegramOutboxDrainOutcome> {
    let target_dir = target_path
        .parent()
        .expect("telegram outbox target record must have a parent");
    fs::create_dir_all(target_dir)?;
    fs::create_dir_all(tmp_telegram_outbox_dir(daemon_dir))?;

    let existing = read_optional_record(&target_path)?;
    if let Some(existing) = existing {
        ensure_same_record_or_conflict(&target_path, &existing, record)?;
        remove_optional_file(source_path)?;
        sync_parent_dir(source_path)?;
        return Ok(TelegramOutboxDrainOutcome {
            record_id: existing.record_id.clone(),
            nostr_event_id: existing.nostr_event_id.clone(),
            status: existing.status,
            source_path: source_path.to_path_buf(),
            target_path,
            telegram_message_id: existing
                .attempts
                .iter()
                .find_map(|attempt| attempt.telegram_message_id),
        });
    }

    let tmp_path = tmp_telegram_outbox_dir(daemon_dir).join(format!(
        "{}.{}.{}.tmp",
        record.record_id,
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
            return Ok(TelegramOutboxDrainOutcome {
                record_id: record.record_id.clone(),
                nostr_event_id: record.nostr_event_id.clone(),
                status: record.status,
                source_path: source_path.to_path_buf(),
                target_path: target_path.clone(),
                telegram_message_id,
            });
        }

        remove_optional_file(&tmp_path)?;
        let existing = read_optional_record(&target_path)?.ok_or_else(|| {
            TelegramOutboxError::RecordIdConflict {
                path: target_path.clone(),
            }
        })?;
        ensure_same_record_or_conflict(&target_path, &existing, record)?;
        remove_optional_file(source_path)?;
        sync_parent_dir(source_path)?;
        Ok(TelegramOutboxDrainOutcome {
            record_id: existing.record_id.clone(),
            nostr_event_id: existing.nostr_event_id.clone(),
            status: existing.status,
            source_path: source_path.to_path_buf(),
            target_path: target_path.clone(),
            telegram_message_id: existing
                .attempts
                .iter()
                .find_map(|attempt| attempt.telegram_message_id),
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
    record: &TelegramOutboxRecord,
) -> TelegramOutboxResult<TelegramOutboxRequeueOutcome> {
    let target_dir = target_path
        .parent()
        .expect("telegram outbox target record must have a parent");
    fs::create_dir_all(target_dir)?;
    fs::create_dir_all(tmp_telegram_outbox_dir(daemon_dir))?;

    let delivered_path = delivered_telegram_outbox_record_path(daemon_dir, &record.record_id);
    if let Some(existing) = read_optional_record(&delivered_path)? {
        ensure_same_record_or_conflict(&delivered_path, &existing, record)?;
        remove_optional_file(source_path)?;
        sync_parent_dir(source_path)?;
        return Ok(TelegramOutboxRequeueOutcome {
            record_id: existing.record_id.clone(),
            nostr_event_id: existing.nostr_event_id.clone(),
            status: existing.status,
            source_path: source_path.to_path_buf(),
            target_path: delivered_path,
        });
    }

    let existing = read_optional_record(&target_path)?;
    if let Some(existing) = existing {
        ensure_same_record_or_conflict(&target_path, &existing, record)?;
        remove_optional_file(source_path)?;
        sync_parent_dir(source_path)?;
        return Ok(TelegramOutboxRequeueOutcome {
            record_id: existing.record_id.clone(),
            nostr_event_id: existing.nostr_event_id.clone(),
            status: existing.status,
            source_path: source_path.to_path_buf(),
            target_path,
        });
    }

    let tmp_path = tmp_telegram_outbox_dir(daemon_dir).join(format!(
        "{}.{}.{}.tmp",
        record.record_id,
        std::process::id(),
        now_nanos()
    ));
    let write_result = (|| {
        write_record_file(&tmp_path, record)?;
        if create_record_link_without_replacing(&tmp_path, &target_path)? {
            remove_optional_file(&tmp_path)?;
            sync_parent_dir(&target_path)?;
            if let Some(existing) = read_optional_record(&delivered_path)? {
                ensure_same_record_or_conflict(&delivered_path, &existing, record)?;
                remove_optional_file(&target_path)?;
                sync_parent_dir(&target_path)?;
                remove_optional_file(source_path)?;
                sync_parent_dir(source_path)?;
                return Ok(TelegramOutboxRequeueOutcome {
                    record_id: existing.record_id.clone(),
                    nostr_event_id: existing.nostr_event_id.clone(),
                    status: existing.status,
                    source_path: source_path.to_path_buf(),
                    target_path: delivered_path,
                });
            }
            remove_optional_file(source_path)?;
            sync_parent_dir(source_path)?;
            return Ok(TelegramOutboxRequeueOutcome {
                record_id: record.record_id.clone(),
                nostr_event_id: record.nostr_event_id.clone(),
                status: record.status,
                source_path: source_path.to_path_buf(),
                target_path: target_path.clone(),
            });
        }

        remove_optional_file(&tmp_path)?;
        let existing = read_optional_record(&target_path)?.ok_or_else(|| {
            TelegramOutboxError::RecordIdConflict {
                path: target_path.clone(),
            }
        })?;
        ensure_same_record_or_conflict(&target_path, &existing, record)?;
        remove_optional_file(source_path)?;
        sync_parent_dir(source_path)?;
        Ok(TelegramOutboxRequeueOutcome {
            record_id: existing.record_id.clone(),
            nostr_event_id: existing.nostr_event_id.clone(),
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

fn read_existing_telegram_outbox_record(
    daemon_dir: &Path,
    record_id: &str,
) -> TelegramOutboxResult<Option<(PathBuf, TelegramOutboxRecord)>> {
    for path in [
        pending_telegram_outbox_record_path(daemon_dir, record_id),
        delivered_telegram_outbox_record_path(daemon_dir, record_id),
        failed_telegram_outbox_record_path(daemon_dir, record_id),
    ] {
        if let Some(record) = read_optional_record(&path)? {
            return Ok(Some((path, record)));
        }
    }

    Ok(None)
}

fn existing_record_or_conflict(
    existing_path: PathBuf,
    existing: TelegramOutboxRecord,
    requested: &TelegramOutboxRecord,
) -> TelegramOutboxResult<TelegramOutboxRecord> {
    ensure_same_record_or_conflict(&existing_path, &existing, requested)?;
    Ok(existing)
}

fn ensure_same_record_or_conflict(
    existing_path: &Path,
    existing: &TelegramOutboxRecord,
    requested: &TelegramOutboxRecord,
) -> TelegramOutboxResult<()> {
    if existing.record_id == requested.record_id
        && existing.nostr_event_id == requested.nostr_event_id
        && existing.channel_binding == requested.channel_binding
        && existing.reply_to_telegram_message_id == requested.reply_to_telegram_message_id
    {
        return Ok(());
    }

    Err(TelegramOutboxError::RecordIdConflict {
        path: existing_path.to_path_buf(),
    })
}

fn create_record_link_without_replacing(
    source_path: &Path,
    target_path: &Path,
) -> TelegramOutboxResult<bool> {
    match fs::hard_link(source_path, target_path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn remove_optional_file(path: impl AsRef<Path>) -> TelegramOutboxResult<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn read_optional_record(
    path: impl AsRef<Path>,
) -> TelegramOutboxResult<Option<TelegramOutboxRecord>> {
    match fs::read_to_string(path) {
        Ok(content) => {
            let record: TelegramOutboxRecord = serde_json::from_str(&content)?;
            if record.schema_version != TELEGRAM_OUTBOX_RECORD_SCHEMA_VERSION {
                return Err(TelegramOutboxError::UnsupportedSchemaVersion {
                    found: record.schema_version,
                    expected: TELEGRAM_OUTBOX_RECORD_SCHEMA_VERSION,
                });
            }
            Ok(Some(record))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn write_record_file(path: &Path, record: &TelegramOutboxRecord) -> TelegramOutboxResult<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    serde_json::to_writer_pretty(&mut file, record)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    Ok(())
}

fn sync_parent_dir(path: &Path) -> TelegramOutboxResult<()> {
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
    use serde_json::{Value, json};
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    const TELEGRAM_OUTBOX_FIXTURE: &str =
        include_str!("../../../src/test-utils/fixtures/daemon/telegram-outbox.compat.json");
    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn telegram_outbox_fixture_matches_rust_contract() {
        let fixture: Value =
            serde_json::from_str(TELEGRAM_OUTBOX_FIXTURE).expect("fixture must parse");
        let daemon_dir = Path::new("/var/lib/tenex").join(
            fixture["daemonDirName"]
                .as_str()
                .expect("fixture must include daemonDirName"),
        );

        assert_eq!(
            fixture["relativePaths"]["outbox"].as_str(),
            Some(TELEGRAM_OUTBOX_DIR_NAME)
        );
        assert_eq!(
            fixture["relativePaths"]["pending"].as_str(),
            Some("transport-outbox/telegram/pending")
        );
        assert_eq!(
            fixture["relativePaths"]["delivered"].as_str(),
            Some("transport-outbox/telegram/delivered")
        );
        assert_eq!(
            fixture["relativePaths"]["failed"].as_str(),
            Some("transport-outbox/telegram/failed")
        );
        assert_eq!(
            fixture["relativePaths"]["tmp"].as_str(),
            Some("transport-outbox/telegram/tmp")
        );
        assert_eq!(
            telegram_outbox_dir(&daemon_dir),
            daemon_dir.join(TELEGRAM_OUTBOX_DIR_NAME)
        );
        assert_eq!(
            pending_telegram_outbox_dir(&daemon_dir),
            daemon_dir
                .join("transport-outbox")
                .join("telegram")
                .join("pending")
        );
        assert_eq!(
            delivered_telegram_outbox_dir(&daemon_dir),
            daemon_dir
                .join("transport-outbox")
                .join("telegram")
                .join("delivered")
        );
        assert_eq!(
            failed_telegram_outbox_dir(&daemon_dir),
            daemon_dir
                .join("transport-outbox")
                .join("telegram")
                .join("failed")
        );
        assert_eq!(
            tmp_telegram_outbox_dir(&daemon_dir),
            daemon_dir
                .join("transport-outbox")
                .join("telegram")
                .join("tmp")
        );

        for variant_name in [
            "pendingHtml",
            "pendingPlain",
            "pendingAskError",
            "pendingVoice",
        ] {
            let record: TelegramOutboxRecord =
                serde_json::from_value(fixture["records"][variant_name].clone())
                    .unwrap_or_else(|_| panic!("{variant_name} record must deserialize"));
            assert_eq!(record.status, TelegramOutboxStatus::Pending);
            assert!(record.attempts.is_empty());
            assert_eq!(record.schema_version, TELEGRAM_OUTBOX_RECORD_SCHEMA_VERSION);
            assert_eq!(record.writer, TELEGRAM_OUTBOX_WRITER);
            assert!(!record.writer_version.is_empty());
            assert!(!record.record_id.is_empty());
        }

        let delivered: TelegramOutboxRecord =
            serde_json::from_value(fixture["records"]["delivered"].clone())
                .expect("delivered record must deserialize");
        assert_eq!(delivered.status, TelegramOutboxStatus::Delivered);
        assert_eq!(
            delivered.attempts[0].status,
            TelegramDeliveryAttemptStatus::Delivered
        );
        assert_eq!(delivered.attempts[0].telegram_message_id, Some(5001));

        let failed_retryable: TelegramOutboxRecord =
            serde_json::from_value(fixture["records"]["failedRetryable"].clone())
                .expect("failed retryable record must deserialize");
        assert_eq!(failed_retryable.status, TelegramOutboxStatus::Failed);
        assert!(failed_retryable.attempts[0].retryable);
        assert_eq!(
            failed_retryable.attempts[0].next_attempt_at,
            Some(1710001001300)
        );

        let failed_permanent: TelegramOutboxRecord =
            serde_json::from_value(fixture["records"]["failedPermanent"].clone())
                .expect("failed permanent record must deserialize");
        assert!(!failed_permanent.attempts[0].retryable);
        assert_eq!(failed_permanent.attempts[0].next_attempt_at, None);

        let maintenance_report: TelegramOutboxMaintenanceReport =
            serde_json::from_value(fixture["maintenanceReports"]["dueRetryDelivered"].clone())
                .expect("maintenance report fixture must deserialize");
        assert_eq!(maintenance_report.diagnostics_before.failed_count, 1);
        assert_eq!(maintenance_report.diagnostics_before.retry_due_count, 1);
        assert_eq!(maintenance_report.requeued.len(), 1);
        assert_eq!(maintenance_report.drained.len(), 1);
        assert_eq!(
            maintenance_report.drained[0].status,
            TelegramOutboxStatus::Delivered
        );
        assert_eq!(
            maintenance_report.drained[0].telegram_message_id,
            Some(5001)
        );
        assert_eq!(maintenance_report.diagnostics_after.delivered_count, 1);
        assert_eq!(maintenance_report.diagnostics_after.failed_count, 0);

        let expected_derivation = fixture["recordIdDerivation"]
            .as_str()
            .expect("fixture must pin record id derivation rule");
        assert!(expected_derivation.contains("sha256"));
        assert!(expected_derivation.contains("nostrEventId"));
        assert!(expected_derivation.contains("chatId"));
        assert!(expected_derivation.contains("replyToTelegramMessageId"));
    }

    #[test]
    fn derives_stable_record_id_for_fixed_inputs() {
        let id_a = derive_telegram_outbox_record_id("event-a", 1000, Some(42));
        let id_b = derive_telegram_outbox_record_id("event-a", 1000, Some(42));
        assert_eq!(id_a, id_b);
        assert_eq!(id_a.len(), 64);

        let id_different_event = derive_telegram_outbox_record_id("event-b", 1000, Some(42));
        assert_ne!(id_a, id_different_event);

        let id_different_chat = derive_telegram_outbox_record_id("event-a", 2000, Some(42));
        assert_ne!(id_a, id_different_chat);

        let id_none_reply = derive_telegram_outbox_record_id("event-a", 1000, None);
        assert_ne!(id_a, id_none_reply);
    }

    #[test]
    fn inspects_empty_telegram_outbox_diagnostics() {
        let fixture: Value =
            serde_json::from_str(TELEGRAM_OUTBOX_FIXTURE).expect("fixture must parse");
        let expected: TelegramOutboxDiagnostics =
            serde_json::from_value(fixture["diagnostics"]["empty"].clone())
                .expect("empty diagnostics fixture must deserialize");
        let daemon_dir = unique_temp_daemon_dir();

        let diagnostics =
            inspect_telegram_outbox(&daemon_dir, 1710001000000).expect("diagnostics must inspect");

        assert_eq!(diagnostics, expected);

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn accepts_delivery_request_into_pending_outbox() {
        let daemon_dir = unique_temp_daemon_dir();
        let request = sample_request("event-accept-01", "html");

        let record = accept_telegram_delivery_request(&daemon_dir, request, 1710001000100)
            .expect("delivery request must be accepted");

        assert_eq!(record.schema_version, TELEGRAM_OUTBOX_RECORD_SCHEMA_VERSION);
        assert_eq!(record.writer, TELEGRAM_OUTBOX_WRITER);
        assert_eq!(record.status, TelegramOutboxStatus::Pending);
        assert_eq!(record.created_at, 1710001000100);
        assert_eq!(record.updated_at, 1710001000100);
        assert_eq!(record.nostr_event_id, "event-accept-01");
        assert_eq!(
            record.record_id,
            derive_telegram_outbox_record_id("event-accept-01", 12345, Some(777))
        );

        let persisted = read_pending_telegram_outbox_record(&daemon_dir, &record.record_id)
            .expect("record read");
        assert_eq!(persisted, Some(record.clone()));

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn accepts_duplicate_delivery_request_idempotently() {
        let daemon_dir = unique_temp_daemon_dir();
        let first_request = sample_request("event-dup-01", "html");
        let second_request = sample_request("event-dup-01", "html");

        let first_record =
            accept_telegram_delivery_request(&daemon_dir, first_request, 1710001000100)
                .expect("first accept must succeed");
        let second_record =
            accept_telegram_delivery_request(&daemon_dir, second_request, 1710001000500)
                .expect("duplicate accept must be idempotent");

        assert_eq!(second_record, first_record);
        assert_eq!(second_record.created_at, 1710001000100);

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn accepts_duplicate_delivery_request_from_delivered_state() {
        let daemon_dir = unique_temp_daemon_dir();
        let request = sample_request("event-delivered-dup-01", "html");

        accept_telegram_delivery_request(&daemon_dir, request.clone(), 1710001000100)
            .expect("publish request must be accepted");
        let mut publisher = MockDeliveryPublisher::new(vec![TelegramDeliveryResult::Delivered {
            telegram_message_id: 5001,
            delivered_at: 1710001000200,
        }]);
        drain_pending_telegram_outbox(&daemon_dir, &mut publisher, 1710001000200)
            .expect("drain must deliver");

        let duplicate = accept_telegram_delivery_request(&daemon_dir, request, 1710001000300)
            .expect("duplicate after delivery must be idempotent");

        assert_eq!(duplicate.status, TelegramOutboxStatus::Delivered);
        let record_id = duplicate.record_id.clone();
        assert!(
            read_pending_telegram_outbox_record(&daemon_dir, &record_id)
                .expect("pending read must succeed")
                .is_none()
        );
        assert!(
            read_delivered_telegram_outbox_record(&daemon_dir, &record_id)
                .expect("delivered read must succeed")
                .is_some()
        );

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn accepts_duplicate_delivery_request_from_failed_state() {
        let daemon_dir = unique_temp_daemon_dir();
        let request = sample_request("event-failed-dup-01", "html");

        accept_telegram_delivery_request(&daemon_dir, request.clone(), 1710001000100)
            .expect("publish request must be accepted");
        let mut publisher =
            MockDeliveryPublisher::new(vec![TelegramDeliveryResult::RetryableFailure {
                error_class: TelegramErrorClass::Network,
                error_detail: "connection reset".to_string(),
                retry_after: None,
            }]);
        drain_pending_telegram_outbox(&daemon_dir, &mut publisher, 1710001000200)
            .expect("drain must move to failed");

        let duplicate = accept_telegram_delivery_request(&daemon_dir, request, 1710001000300)
            .expect("duplicate after failure must be idempotent");

        assert_eq!(duplicate.status, TelegramOutboxStatus::Failed);
        let record_id = duplicate.record_id.clone();
        assert!(
            read_failed_telegram_outbox_record(&daemon_dir, &record_id)
                .expect("failed read must succeed")
                .is_some()
        );

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn rejects_delivery_request_with_missing_fields() {
        let daemon_dir = unique_temp_daemon_dir();
        let mut request = sample_request("event-missing-01", "html");
        request.correlation_id = String::new();

        let error = accept_telegram_delivery_request(&daemon_dir, request, 1710001000100)
            .expect_err("missing correlation id must be rejected");

        assert!(matches!(
            error,
            TelegramOutboxError::MissingField {
                field: "correlationId"
            }
        ));

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn rejects_delivery_request_missing_writer_version() {
        let daemon_dir = unique_temp_daemon_dir();
        let mut request = sample_request("event-missing-writer-01", "html");
        request.writer_version = String::new();

        let error = accept_telegram_delivery_request(&daemon_dir, request, 1710001000100)
            .expect_err("missing writer version must be rejected");

        assert!(matches!(
            error,
            TelegramOutboxError::MissingField {
                field: "writerVersion"
            }
        ));

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn rejects_delivery_request_missing_project_binding() {
        let daemon_dir = unique_temp_daemon_dir();
        let mut request = sample_request("event-missing-project-01", "html");
        request.project_binding.project_d_tag = String::new();

        let error = accept_telegram_delivery_request(&daemon_dir, request, 1710001000100)
            .expect_err("missing project d-tag must be rejected");

        assert!(matches!(error, TelegramOutboxError::MissingField { .. }));

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn drains_pending_record_to_delivered_after_bot_api_success() {
        let daemon_dir = unique_temp_daemon_dir();
        let request = sample_request("event-drain-delivered-01", "html");
        accept_telegram_delivery_request(&daemon_dir, request, 1710001000100)
            .expect("publish request must be accepted");
        let mut publisher = MockDeliveryPublisher::new(vec![TelegramDeliveryResult::Delivered {
            telegram_message_id: 5001,
            delivered_at: 1710001000200,
        }]);

        let outcomes = drain_pending_telegram_outbox(&daemon_dir, &mut publisher, 1710001000200)
            .expect("drain must succeed");

        assert_eq!(outcomes.len(), 1);
        assert_eq!(outcomes[0].status, TelegramOutboxStatus::Delivered);
        assert_eq!(outcomes[0].telegram_message_id, Some(5001));

        let delivered = read_delivered_telegram_outbox_record(&daemon_dir, &outcomes[0].record_id)
            .expect("delivered read must succeed")
            .expect("delivered record must exist");
        assert_eq!(delivered.status, TelegramOutboxStatus::Delivered);
        assert_eq!(delivered.attempts.len(), 1);
        assert_eq!(delivered.attempts[0].telegram_message_id, Some(5001));
        assert_eq!(delivered.updated_at, 1710001000200);

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn drains_pending_record_to_failed_after_retryable_bot_api_error() {
        let daemon_dir = unique_temp_daemon_dir();
        let request = sample_request("event-drain-retry-01", "plain");
        accept_telegram_delivery_request(&daemon_dir, request, 1710001000100)
            .expect("publish request must be accepted");
        let mut publisher =
            MockDeliveryPublisher::new(vec![TelegramDeliveryResult::RetryableFailure {
                error_class: TelegramErrorClass::RateLimited,
                error_detail: "429 Too Many Requests".to_string(),
                retry_after: Some(5000),
            }]);

        let outcomes = drain_pending_telegram_outbox(&daemon_dir, &mut publisher, 1710001000200)
            .expect("drain must succeed");

        assert_eq!(outcomes.len(), 1);
        assert_eq!(outcomes[0].status, TelegramOutboxStatus::Failed);

        let failed = read_failed_telegram_outbox_record(&daemon_dir, &outcomes[0].record_id)
            .expect("failed read must succeed")
            .expect("failed record must exist");
        assert_eq!(failed.attempts.len(), 1);
        assert!(failed.attempts[0].retryable);
        assert_eq!(
            failed.attempts[0].error_class,
            Some(TelegramErrorClass::RateLimited)
        );
        assert_eq!(failed.attempts[0].retry_after, Some(5000));
        assert_eq!(failed.attempts[0].next_attempt_at, Some(1710001005200));

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn drains_pending_record_to_failed_after_permanent_bot_api_error() {
        let daemon_dir = unique_temp_daemon_dir();
        let request = sample_request("event-drain-perm-01", "html");
        accept_telegram_delivery_request(&daemon_dir, request, 1710001000100)
            .expect("publish request must be accepted");
        let mut publisher =
            MockDeliveryPublisher::new(vec![TelegramDeliveryResult::PermanentFailure {
                error_class: TelegramErrorClass::BotBlocked,
                error_detail: "Forbidden: bot was blocked by the user".to_string(),
            }]);

        let outcomes = drain_pending_telegram_outbox(&daemon_dir, &mut publisher, 1710001000200)
            .expect("drain must succeed");

        assert_eq!(outcomes.len(), 1);
        let failed = read_failed_telegram_outbox_record(&daemon_dir, &outcomes[0].record_id)
            .expect("failed read must succeed")
            .expect("failed record must exist");
        assert!(!failed.attempts[0].retryable);
        assert_eq!(failed.attempts[0].next_attempt_at, None);
        assert_eq!(
            failed.attempts[0].error_class,
            Some(TelegramErrorClass::BotBlocked)
        );

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn drains_ask_error_payload_variant() {
        let daemon_dir = unique_temp_daemon_dir();
        let request = sample_request("event-drain-ask-01", "ask_error");
        accept_telegram_delivery_request(&daemon_dir, request, 1710001000100)
            .expect("publish request must be accepted");
        let mut publisher = MockDeliveryPublisher::new(vec![TelegramDeliveryResult::Delivered {
            telegram_message_id: 5042,
            delivered_at: 1710001000200,
        }]);

        let outcomes = drain_pending_telegram_outbox(&daemon_dir, &mut publisher, 1710001000200)
            .expect("drain must succeed");

        assert_eq!(outcomes[0].telegram_message_id, Some(5042));
        let delivered = read_delivered_telegram_outbox_record(&daemon_dir, &outcomes[0].record_id)
            .expect("delivered read must succeed")
            .expect("delivered record must exist");
        assert!(matches!(
            delivered.payload,
            TelegramDeliveryPayload::AskError { .. }
        ));

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn drains_reserved_voice_payload_variant() {
        let daemon_dir = unique_temp_daemon_dir();
        let request = sample_request("event-drain-voice-01", "voice");
        accept_telegram_delivery_request(&daemon_dir, request, 1710001000100)
            .expect("publish request must be accepted");
        let mut publisher =
            MockDeliveryPublisher::new(vec![TelegramDeliveryResult::PermanentFailure {
                error_class: TelegramErrorClass::BadRequest,
                error_detail: "voice attachments not yet supported".to_string(),
            }]);

        let outcomes = drain_pending_telegram_outbox(&daemon_dir, &mut publisher, 1710001000200)
            .expect("drain must succeed");

        assert_eq!(outcomes[0].status, TelegramOutboxStatus::Failed);
        let failed = read_failed_telegram_outbox_record(&daemon_dir, &outcomes[0].record_id)
            .expect("failed read must succeed")
            .expect("failed record must exist");
        assert!(matches!(
            failed.payload,
            TelegramDeliveryPayload::ReservedVoice { .. }
        ));

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn requeues_due_retryable_failed_record_and_delivers_on_next_drain() {
        let daemon_dir = unique_temp_daemon_dir();
        let request = sample_request("event-requeue-01", "html");
        accept_telegram_delivery_request(&daemon_dir, request, 1710001000100)
            .expect("publish request must be accepted");
        let mut failing_publisher =
            MockDeliveryPublisher::new(vec![TelegramDeliveryResult::RetryableFailure {
                error_class: TelegramErrorClass::ServerError,
                error_detail: "502 Bad Gateway".to_string(),
                retry_after: None,
            }]);
        drain_pending_telegram_outbox(&daemon_dir, &mut failing_publisher, 1710001000200)
            .expect("drain must move to failed");

        let not_due = requeue_due_failed_telegram_outbox_records(&daemon_dir, 1710001001199)
            .expect("not-due requeue scan must succeed");
        assert!(not_due.is_empty());

        let requeued = requeue_due_failed_telegram_outbox_records(&daemon_dir, 1710001001200)
            .expect("due requeue scan must succeed");
        assert_eq!(requeued.len(), 1);
        assert_eq!(requeued[0].status, TelegramOutboxStatus::Pending);

        let mut delivered_publisher =
            MockDeliveryPublisher::new(vec![TelegramDeliveryResult::Delivered {
                telegram_message_id: 6001,
                delivered_at: 1710001001300,
            }]);
        let final_outcomes =
            drain_pending_telegram_outbox(&daemon_dir, &mut delivered_publisher, 1710001001300)
                .expect("second drain must deliver");
        assert_eq!(final_outcomes[0].status, TelegramOutboxStatus::Delivered);

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn does_not_requeue_permanent_failed_record() {
        let daemon_dir = unique_temp_daemon_dir();
        let request = sample_request("event-perm-noreq-01", "html");
        accept_telegram_delivery_request(&daemon_dir, request, 1710001000100)
            .expect("publish request must be accepted");
        let mut publisher =
            MockDeliveryPublisher::new(vec![TelegramDeliveryResult::PermanentFailure {
                error_class: TelegramErrorClass::BotBlocked,
                error_detail: "Forbidden".to_string(),
            }]);
        drain_pending_telegram_outbox(&daemon_dir, &mut publisher, 1710001000200)
            .expect("drain must move to failed");

        let requeued = requeue_due_failed_telegram_outbox_records(&daemon_dir, 1_710_009_999_999)
            .expect("requeue scan must succeed");
        assert!(requeued.is_empty());

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn truncated_record_fails_closed() {
        let daemon_dir = unique_temp_daemon_dir();
        let request = sample_request("event-trunc-01", "html");
        let record = accept_telegram_delivery_request(&daemon_dir, request, 1710001000100)
            .expect("publish request must be accepted");

        let record_path = pending_telegram_outbox_record_path(&daemon_dir, &record.record_id);
        fs::write(&record_path, b"{\"schemaVersion\":1,\"writer\":")
            .expect("truncated write must succeed");

        let error = inspect_telegram_outbox(&daemon_dir, 1710001000200)
            .expect_err("truncated record must fail inspection");

        assert!(matches!(error, TelegramOutboxError::Json(_)));

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn schema_version_mismatch_fails_closed() {
        let daemon_dir = unique_temp_daemon_dir();
        let request = sample_request("event-schema-01", "html");
        let record = accept_telegram_delivery_request(&daemon_dir, request, 1710001000100)
            .expect("publish request must be accepted");

        let mut value: Value = serde_json::to_value(&record).expect("record must serialize");
        value["schemaVersion"] = json!(999);
        let record_path = pending_telegram_outbox_record_path(&daemon_dir, &record.record_id);
        fs::write(&record_path, serde_json::to_vec(&value).unwrap())
            .expect("mismatched write must succeed");

        let error = inspect_telegram_outbox(&daemon_dir, 1710001000200)
            .expect_err("schema mismatch must fail inspection");

        assert!(matches!(
            error,
            TelegramOutboxError::UnsupportedSchemaVersion {
                found: 999,
                expected: 1,
            }
        ));

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn inspects_filesystem_record_counts() {
        let daemon_dir = unique_temp_daemon_dir();

        accept_telegram_delivery_request(
            &daemon_dir,
            sample_request("event-inspect-delivered-01", "html"),
            1710001000150,
        )
        .expect("delivered-bound accept must succeed");
        let mut deliver_publisher =
            MockDeliveryPublisher::new(vec![TelegramDeliveryResult::Delivered {
                telegram_message_id: 7001,
                delivered_at: 1710001000200,
            }]);
        drain_pending_telegram_outbox(&daemon_dir, &mut deliver_publisher, 1710001000200)
            .expect("deliver drain must succeed");

        accept_telegram_delivery_request(
            &daemon_dir,
            sample_request("event-inspect-failed-01", "html"),
            1710001000250,
        )
        .expect("failed-bound accept must succeed");
        let mut fail_publisher =
            MockDeliveryPublisher::new(vec![TelegramDeliveryResult::RetryableFailure {
                error_class: TelegramErrorClass::Network,
                error_detail: "timeout".to_string(),
                retry_after: None,
            }]);
        drain_pending_telegram_outbox(&daemon_dir, &mut fail_publisher, 1710001000300)
            .expect("fail drain must succeed");

        accept_telegram_delivery_request(
            &daemon_dir,
            sample_request("event-inspect-pending-01", "html"),
            1710001000350,
        )
        .expect("pending accept must succeed");

        fs::create_dir_all(tmp_telegram_outbox_dir(&daemon_dir))
            .expect("tmp dir must exist for orphan write");
        fs::write(
            tmp_telegram_outbox_dir(&daemon_dir).join("orphan.tmp"),
            b"partial",
        )
        .expect("orphan tmp write must succeed");

        let diagnostics =
            inspect_telegram_outbox(&daemon_dir, 1710001000400).expect("inspect must succeed");

        assert_eq!(
            diagnostics.schema_version,
            TELEGRAM_OUTBOX_DIAGNOSTICS_SCHEMA_VERSION
        );
        assert_eq!(diagnostics.pending_count, 1);
        assert_eq!(diagnostics.delivered_count, 1);
        assert_eq!(diagnostics.failed_count, 1);
        assert_eq!(diagnostics.retryable_failed_count, 1);
        assert_eq!(diagnostics.retry_due_count, 0);
        assert_eq!(diagnostics.permanent_failed_count, 0);
        assert_eq!(diagnostics.tmp_file_count, 1);
        assert!(diagnostics.oldest_pending.is_some());
        assert_eq!(
            diagnostics.oldest_pending.as_ref().unwrap().nostr_event_id,
            "event-inspect-pending-01"
        );
        assert_eq!(
            diagnostics.oldest_pending.as_ref().unwrap().created_at,
            1710001000350
        );
        assert!(diagnostics.next_retry_at.is_some());

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn maintenance_requeues_and_drains_in_single_pass() {
        let daemon_dir = unique_temp_daemon_dir();
        let request = sample_request("event-maint-01", "html");
        accept_telegram_delivery_request(&daemon_dir, request, 1710001000100)
            .expect("publish request must be accepted");
        let mut failing_publisher =
            MockDeliveryPublisher::new(vec![TelegramDeliveryResult::RetryableFailure {
                error_class: TelegramErrorClass::Network,
                error_detail: "timeout".to_string(),
                retry_after: None,
            }]);
        drain_pending_telegram_outbox(&daemon_dir, &mut failing_publisher, 1710001000200)
            .expect("drain must fail into failed dir");

        let mut delivered_publisher =
            MockDeliveryPublisher::new(vec![TelegramDeliveryResult::Delivered {
                telegram_message_id: 8001,
                delivered_at: 1710001001200,
            }]);
        let report =
            run_telegram_outbox_maintenance(&daemon_dir, &mut delivered_publisher, 1710001001200)
                .expect("maintenance must succeed");

        assert_eq!(report.diagnostics_before.failed_count, 1);
        assert_eq!(report.diagnostics_before.retry_due_count, 1);
        assert_eq!(report.requeued.len(), 1);
        assert_eq!(report.drained.len(), 1);
        assert_eq!(report.drained[0].status, TelegramOutboxStatus::Delivered);
        assert_eq!(report.drained[0].telegram_message_id, Some(8001));
        assert_eq!(report.diagnostics_after.delivered_count, 1);
        assert_eq!(report.diagnostics_after.failed_count, 0);
        assert_eq!(report.diagnostics_after.latest_failure, None);

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn maintenance_leaves_future_retry_failed_records_in_place() {
        let daemon_dir = unique_temp_daemon_dir();
        let request = sample_request("event-maint-future-01", "html");
        accept_telegram_delivery_request(&daemon_dir, request, 1710001000100)
            .expect("publish request must be accepted");
        let mut failing_publisher =
            MockDeliveryPublisher::new(vec![TelegramDeliveryResult::RetryableFailure {
                error_class: TelegramErrorClass::Network,
                error_detail: "timeout".to_string(),
                retry_after: None,
            }]);
        drain_pending_telegram_outbox(&daemon_dir, &mut failing_publisher, 1710001000200)
            .expect("drain must fail into failed dir");

        let mut unused_publisher = MockDeliveryPublisher::new(vec![]);
        let report =
            run_telegram_outbox_maintenance(&daemon_dir, &mut unused_publisher, 1710001001199)
                .expect("maintenance must succeed");

        assert_eq!(report.diagnostics_before.failed_count, 1);
        assert_eq!(report.diagnostics_before.retry_due_count, 0);
        assert_eq!(report.diagnostics_before.next_retry_at, Some(1710001001200));
        assert!(report.requeued.is_empty());
        assert!(report.drained.is_empty());
        assert_eq!(report.diagnostics_after.failed_count, 1);

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    fn sample_request(nostr_event_id: &str, payload: &str) -> TelegramDeliveryRequest {
        let payload = match payload {
            "html" => TelegramDeliveryPayload::HtmlText {
                html: "<b>ok</b>".to_string(),
            },
            "plain" => TelegramDeliveryPayload::PlainText {
                text: "ok".to_string(),
            },
            "ask_error" => TelegramDeliveryPayload::AskError {
                html: "<i>ask</i>".to_string(),
            },
            "voice" => TelegramDeliveryPayload::ReservedVoice {
                marker: "voice:reserved".to_string(),
            },
            other => panic!("unsupported sample payload variant: {other}"),
        };
        let delivery_reason = match &payload {
            TelegramDeliveryPayload::HtmlText { .. } => TelegramDeliveryReason::FinalReply,
            TelegramDeliveryPayload::PlainText { .. } => TelegramDeliveryReason::ConversationMirror,
            TelegramDeliveryPayload::AskError { .. } => TelegramDeliveryReason::AskError,
            TelegramDeliveryPayload::ReservedVoice { .. } => TelegramDeliveryReason::Voice,
        };
        TelegramDeliveryRequest {
            nostr_event_id: nostr_event_id.to_string(),
            correlation_id: "telegram-fixture-01".to_string(),
            project_binding: TelegramProjectBinding {
                project_d_tag: "project-alpha".to_string(),
                backend_pubkey: "b".repeat(64),
            },
            channel_binding: TelegramChannelBinding {
                chat_id: 12345,
                message_thread_id: Some(67890),
                channel_label: Some("alpha-channel".to_string()),
            },
            sender_identity: TelegramSenderIdentity {
                agent_pubkey: "a".repeat(64),
                display_name: Some("Agent Alpha".to_string()),
            },
            delivery_reason,
            reply_to_telegram_message_id: Some(777),
            payload,
            writer_version: "test-version".to_string(),
        }
    }

    struct MockDeliveryPublisher {
        outcomes: VecDeque<TelegramDeliveryResult>,
        delivered_records: Vec<TelegramOutboxRecord>,
    }

    impl MockDeliveryPublisher {
        fn new(outcomes: Vec<TelegramDeliveryResult>) -> Self {
            Self {
                outcomes: outcomes.into(),
                delivered_records: Vec::new(),
            }
        }
    }

    impl TelegramDeliveryPublisher for MockDeliveryPublisher {
        fn deliver(&mut self, record: &TelegramOutboxRecord) -> TelegramDeliveryResult {
            self.delivered_records.push(record.clone());
            self.outcomes
                .pop_front()
                .expect("mock publisher outcome must exist")
        }
    }

    fn unique_temp_daemon_dir() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be after UNIX_EPOCH")
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let daemon_dir = std::env::temp_dir().join(format!(
            "tenex-telegram-outbox-{}-{counter}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&daemon_dir).expect("temp daemon dir must be created");
        daemon_dir
    }
}
