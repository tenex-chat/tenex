use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

pub const SCHEDULER_WAKEUPS_DIR_NAME: &str = "scheduler-wakeups";
pub const SCHEDULER_WAKEUPS_PENDING_DIR_NAME: &str = "pending";
pub const SCHEDULER_WAKEUPS_FIRED_DIR_NAME: &str = "fired";
pub const SCHEDULER_WAKEUPS_FAILED_DIR_NAME: &str = "failed";
pub const SCHEDULER_WAKEUPS_TMP_DIR_NAME: &str = "tmp";
pub const SCHEDULER_WAKEUPS_WRITER: &str = "rust-daemon";
pub const SCHEDULER_WAKEUPS_RECORD_SCHEMA_VERSION: u32 = 1;
pub const SCHEDULER_WAKEUPS_DIAGNOSTICS_SCHEMA_VERSION: u32 = 1;
pub const DEFAULT_SCHEDULER_WAKEUPS_RETRY_BASE_DELAY_SECS: u64 = 30;
pub const DEFAULT_SCHEDULER_WAKEUPS_RETRY_MAX_DELAY_SECS: u64 = 3_600;
pub const DEFAULT_SCHEDULER_WAKEUPS_RETRY_MULTIPLIER: f32 = 2.0;

#[derive(Debug, Error)]
pub enum SchedulerWakeupError {
    #[error("scheduler wakeups io error: {0}")]
    Io(#[from] io::Error),
    #[error("scheduler wakeups json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("scheduler wakeup id conflict at {path}")]
    WakeupIdConflict { path: PathBuf },
    #[error("scheduler wakeup {wakeup_id} is not in pending state (found {status:?})")]
    NotPending {
        wakeup_id: String,
        status: WakeupStatus,
    },
    #[error("scheduler wakeup {wakeup_id} not found")]
    WakeupNotFound { wakeup_id: String },
    #[error(
        "scheduler wakeup record schema version {found} is not supported (expected {expected})"
    )]
    UnsupportedSchemaVersion { found: u32, expected: u32 },
    #[error("scheduler wakeup scheduledFor {scheduled_for} is in the past (now={now})")]
    BackdatedWakeup { scheduled_for: u64, now: u64 },
    #[error("scheduler wakeup record has invalid status {status:?} for requeue")]
    InvalidRequeueStatus { status: WakeupStatus },
    #[error("scheduler wakeup record is missing required field: {field}")]
    MissingField { field: &'static str },
}

pub type SchedulerWakeupResult<T> = Result<T, SchedulerWakeupError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WakeupStatus {
    Pending,
    Fired,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WakeupAttemptStatus {
    Fired,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WakeupFailureClassification {
    Retryable,
    Permanent,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum WakeupTarget {
    ProjectWakeup {
        project_d_tag: String,
    },
    AgentWakeup {
        project_d_tag: String,
        agent_pubkey: String,
    },
    DelegationTimeout {
        ral_id: String,
    },
}

impl WakeupTarget {
    fn discriminator(&self) -> &'static str {
        match self {
            WakeupTarget::ProjectWakeup { .. } => "project_wakeup",
            WakeupTarget::AgentWakeup { .. } => "agent_wakeup",
            WakeupTarget::DelegationTimeout { .. } => "delegation_timeout",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeupAttempt {
    pub attempted_at: u64,
    pub status: WakeupAttemptStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub classification: Option<WakeupFailureClassification>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_attempt_at: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeupRecord {
    pub schema_version: u32,
    pub writer: String,
    pub writer_version: String,
    pub wakeup_id: String,
    pub status: WakeupStatus,
    pub created_at: u64,
    pub updated_at: u64,
    pub scheduled_for: u64,
    pub target: WakeupTarget,
    pub requester_context: String,
    #[serde(default)]
    pub fire_attempts: Vec<WakeupAttempt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_attempt_at: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeupEnqueueRequest {
    pub scheduled_for: u64,
    pub target: WakeupTarget,
    pub requester_context: String,
    pub writer_version: String,
    pub allow_backdated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeupCancelOutcome {
    pub wakeup_id: String,
    pub previous_status: WakeupStatus,
    pub source_path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeupRequeueOutcome {
    pub wakeup_id: String,
    pub source_path: PathBuf,
    pub target_path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeupPendingDiagnostic {
    pub wakeup_id: String,
    pub scheduled_for: u64,
    pub target: WakeupTarget,
    pub requester_context: String,
    pub created_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeupFailureDiagnostic {
    pub wakeup_id: String,
    pub target: WakeupTarget,
    pub attempt_count: usize,
    pub attempted_at: u64,
    pub classification: WakeupFailureClassification,
    pub error_detail: Option<String>,
    pub next_attempt_at: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerWakeupsDiagnostics {
    pub schema_version: u32,
    pub inspected_at: u64,
    pub pending_count: usize,
    pub fired_count: usize,
    pub failed_count: usize,
    pub retryable_failed_count: usize,
    pub permanent_failed_count: usize,
    pub due_pending_count: usize,
    pub due_retry_count: usize,
    pub tmp_file_count: usize,
    pub oldest_pending: Option<WakeupPendingDiagnostic>,
    pub next_retry_at: Option<u64>,
    pub latest_failure: Option<WakeupFailureDiagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerWakeupsMaintenanceReport {
    pub diagnostics_before: SchedulerWakeupsDiagnostics,
    pub requeued: Vec<WakeupRequeueOutcome>,
    pub diagnostics_after: SchedulerWakeupsDiagnostics,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WakeupRetryPolicy {
    pub base_delay_secs: u64,
    pub max_delay_secs: u64,
    pub multiplier: f32,
}

impl Default for WakeupRetryPolicy {
    fn default() -> Self {
        Self {
            base_delay_secs: DEFAULT_SCHEDULER_WAKEUPS_RETRY_BASE_DELAY_SECS,
            max_delay_secs: DEFAULT_SCHEDULER_WAKEUPS_RETRY_MAX_DELAY_SECS,
            multiplier: DEFAULT_SCHEDULER_WAKEUPS_RETRY_MULTIPLIER,
        }
    }
}

impl WakeupRetryPolicy {
    pub fn delay_for_failure_count(self, previous_failed_attempts: usize) -> u64 {
        let base = self.base_delay_secs.max(1);
        let max_delay = self.max_delay_secs.max(base);
        let multiplier = if self.multiplier.is_finite() && self.multiplier >= 1.0 {
            self.multiplier
        } else {
            1.0
        };

        let mut delay = base as f64;
        for _ in 0..previous_failed_attempts {
            delay *= multiplier as f64;
            if delay >= max_delay as f64 {
                return max_delay;
            }
        }
        (delay.round() as u64).clamp(base, max_delay)
    }
}

pub fn scheduler_wakeups_dir(daemon_dir: impl AsRef<Path>) -> PathBuf {
    daemon_dir.as_ref().join(SCHEDULER_WAKEUPS_DIR_NAME)
}

pub fn pending_scheduler_wakeup_dir(daemon_dir: impl AsRef<Path>) -> PathBuf {
    scheduler_wakeups_dir(daemon_dir).join(SCHEDULER_WAKEUPS_PENDING_DIR_NAME)
}

pub fn fired_scheduler_wakeup_dir(daemon_dir: impl AsRef<Path>) -> PathBuf {
    scheduler_wakeups_dir(daemon_dir).join(SCHEDULER_WAKEUPS_FIRED_DIR_NAME)
}

pub fn failed_scheduler_wakeup_dir(daemon_dir: impl AsRef<Path>) -> PathBuf {
    scheduler_wakeups_dir(daemon_dir).join(SCHEDULER_WAKEUPS_FAILED_DIR_NAME)
}

pub fn tmp_scheduler_wakeup_dir(daemon_dir: impl AsRef<Path>) -> PathBuf {
    scheduler_wakeups_dir(daemon_dir).join(SCHEDULER_WAKEUPS_TMP_DIR_NAME)
}

pub fn pending_scheduler_wakeup_record_path(
    daemon_dir: impl AsRef<Path>,
    wakeup_id: &str,
) -> PathBuf {
    pending_scheduler_wakeup_dir(daemon_dir).join(format!("{wakeup_id}.json"))
}

pub fn fired_scheduler_wakeup_record_path(
    daemon_dir: impl AsRef<Path>,
    wakeup_id: &str,
) -> PathBuf {
    fired_scheduler_wakeup_dir(daemon_dir).join(format!("{wakeup_id}.json"))
}

pub fn failed_scheduler_wakeup_record_path(
    daemon_dir: impl AsRef<Path>,
    wakeup_id: &str,
) -> PathBuf {
    failed_scheduler_wakeup_dir(daemon_dir).join(format!("{wakeup_id}.json"))
}

pub fn derive_wakeup_id(
    scheduled_for: u64,
    target: &WakeupTarget,
    requester_context: &str,
) -> SchedulerWakeupResult<String> {
    let target_payload = serde_json::to_string(target)?;
    let mut hasher = Sha256::new();
    hasher.update(b"scheduler-wakeups/v1\n");
    hasher.update(scheduled_for.to_string().as_bytes());
    hasher.update(b"\n");
    hasher.update(target.discriminator().as_bytes());
    hasher.update(b"\n");
    hasher.update(target_payload.as_bytes());
    hasher.update(b"\n");
    hasher.update(requester_context.as_bytes());
    Ok(hex::encode(hasher.finalize()))
}

pub fn enqueue_wakeup(
    daemon_dir: impl AsRef<Path>,
    request: WakeupEnqueueRequest,
    now: u64,
) -> SchedulerWakeupResult<WakeupRecord> {
    validate_enqueue_request(&request, now)?;

    let wakeup_id = derive_wakeup_id(
        request.scheduled_for,
        &request.target,
        &request.requester_context,
    )?;

    let record = WakeupRecord {
        schema_version: SCHEDULER_WAKEUPS_RECORD_SCHEMA_VERSION,
        writer: SCHEDULER_WAKEUPS_WRITER.to_string(),
        writer_version: request.writer_version,
        wakeup_id,
        status: WakeupStatus::Pending,
        created_at: now,
        updated_at: now,
        scheduled_for: request.scheduled_for,
        target: request.target,
        requester_context: request.requester_context,
        fire_attempts: Vec::new(),
        next_attempt_at: None,
    };

    persist_pending_record(daemon_dir.as_ref(), &record)
}

pub fn read_pending_wakeup_record(
    daemon_dir: impl AsRef<Path>,
    wakeup_id: &str,
) -> SchedulerWakeupResult<Option<WakeupRecord>> {
    read_optional_record(pending_scheduler_wakeup_record_path(daemon_dir, wakeup_id))
}

pub fn read_fired_wakeup_record(
    daemon_dir: impl AsRef<Path>,
    wakeup_id: &str,
) -> SchedulerWakeupResult<Option<WakeupRecord>> {
    read_optional_record(fired_scheduler_wakeup_record_path(daemon_dir, wakeup_id))
}

pub fn read_failed_wakeup_record(
    daemon_dir: impl AsRef<Path>,
    wakeup_id: &str,
) -> SchedulerWakeupResult<Option<WakeupRecord>> {
    read_optional_record(failed_scheduler_wakeup_record_path(daemon_dir, wakeup_id))
}

pub fn list_pending_scheduler_wakeup_paths(
    daemon_dir: impl AsRef<Path>,
) -> SchedulerWakeupResult<Vec<PathBuf>> {
    list_record_paths(pending_scheduler_wakeup_dir(daemon_dir))
}

pub fn list_failed_scheduler_wakeup_paths(
    daemon_dir: impl AsRef<Path>,
) -> SchedulerWakeupResult<Vec<PathBuf>> {
    list_record_paths(failed_scheduler_wakeup_dir(daemon_dir))
}

pub fn list_due_wakeups(
    daemon_dir: impl AsRef<Path>,
    now: u64,
) -> SchedulerWakeupResult<Vec<WakeupRecord>> {
    let pending_records =
        read_records_from_paths(list_pending_scheduler_wakeup_paths(daemon_dir.as_ref())?)?;
    let mut due: Vec<WakeupRecord> = pending_records
        .into_iter()
        .filter(|record| record.scheduled_for <= now)
        .collect();
    due.sort_by(|a, b| {
        a.scheduled_for
            .cmp(&b.scheduled_for)
            .then_with(|| a.wakeup_id.cmp(&b.wakeup_id))
    });
    Ok(due)
}

pub fn cancel_wakeup(
    daemon_dir: impl AsRef<Path>,
    wakeup_id: &str,
) -> SchedulerWakeupResult<Option<WakeupCancelOutcome>> {
    let daemon_dir = daemon_dir.as_ref();
    let pending_path = pending_scheduler_wakeup_record_path(daemon_dir, wakeup_id);
    if let Some(record) = read_optional_record(&pending_path)? {
        remove_optional_file(&pending_path)?;
        sync_parent_dir(&pending_path)?;
        return Ok(Some(WakeupCancelOutcome {
            wakeup_id: record.wakeup_id,
            previous_status: WakeupStatus::Pending,
            source_path: pending_path,
        }));
    }

    let fired_path = fired_scheduler_wakeup_record_path(daemon_dir, wakeup_id);
    if let Some(record) = read_optional_record(&fired_path)? {
        return Ok(Some(WakeupCancelOutcome {
            wakeup_id: record.wakeup_id,
            previous_status: WakeupStatus::Fired,
            source_path: fired_path,
        }));
    }

    let failed_path = failed_scheduler_wakeup_record_path(daemon_dir, wakeup_id);
    if let Some(record) = read_optional_record(&failed_path)? {
        return Ok(Some(WakeupCancelOutcome {
            wakeup_id: record.wakeup_id,
            previous_status: WakeupStatus::Failed,
            source_path: failed_path,
        }));
    }

    Ok(None)
}

pub fn mark_wakeup_fired(
    daemon_dir: impl AsRef<Path>,
    wakeup_id: &str,
    fired_at: u64,
    outcome: impl Into<String>,
) -> SchedulerWakeupResult<WakeupRecord> {
    let daemon_dir = daemon_dir.as_ref();
    let source_path = pending_scheduler_wakeup_record_path(daemon_dir, wakeup_id);
    let mut record = read_optional_record(&source_path)?.ok_or_else(|| {
        SchedulerWakeupError::WakeupNotFound {
            wakeup_id: wakeup_id.to_string(),
        }
    })?;
    if record.status != WakeupStatus::Pending {
        return Err(SchedulerWakeupError::NotPending {
            wakeup_id: wakeup_id.to_string(),
            status: record.status,
        });
    }

    record.status = WakeupStatus::Fired;
    record.updated_at = fired_at;
    record.next_attempt_at = None;
    record.fire_attempts.push(WakeupAttempt {
        attempted_at: fired_at,
        status: WakeupAttemptStatus::Fired,
        outcome: Some(outcome.into()),
        classification: None,
        error_detail: None,
        next_attempt_at: None,
    });

    transition_record(
        daemon_dir,
        &source_path,
        fired_scheduler_wakeup_record_path(daemon_dir, wakeup_id),
        &record,
    )?;
    Ok(record)
}

pub fn mark_wakeup_failed(
    daemon_dir: impl AsRef<Path>,
    wakeup_id: &str,
    failed_at: u64,
    classification: WakeupFailureClassification,
    error_detail: Option<String>,
    retry_after_secs: Option<u64>,
    retry_policy: WakeupRetryPolicy,
) -> SchedulerWakeupResult<WakeupRecord> {
    let daemon_dir = daemon_dir.as_ref();
    let source_path = pending_scheduler_wakeup_record_path(daemon_dir, wakeup_id);
    let mut record = read_optional_record(&source_path)?.ok_or_else(|| {
        SchedulerWakeupError::WakeupNotFound {
            wakeup_id: wakeup_id.to_string(),
        }
    })?;
    if record.status != WakeupStatus::Pending {
        return Err(SchedulerWakeupError::NotPending {
            wakeup_id: wakeup_id.to_string(),
            status: record.status,
        });
    }

    let previous_failed_attempts = record
        .fire_attempts
        .iter()
        .filter(|attempt| attempt.status == WakeupAttemptStatus::Failed)
        .count();

    let next_attempt_at = match classification {
        WakeupFailureClassification::Retryable => Some(compute_next_attempt_at(
            failed_at,
            previous_failed_attempts,
            retry_after_secs,
            retry_policy,
        )),
        WakeupFailureClassification::Permanent => None,
    };

    record.status = WakeupStatus::Failed;
    record.updated_at = failed_at;
    record.next_attempt_at = next_attempt_at;
    record.fire_attempts.push(WakeupAttempt {
        attempted_at: failed_at,
        status: WakeupAttemptStatus::Failed,
        outcome: None,
        classification: Some(classification),
        error_detail,
        next_attempt_at,
    });

    transition_record(
        daemon_dir,
        &source_path,
        failed_scheduler_wakeup_record_path(daemon_dir, wakeup_id),
        &record,
    )?;
    Ok(record)
}

pub fn requeue_due_failed_wakeups(
    daemon_dir: impl AsRef<Path>,
    now: u64,
) -> SchedulerWakeupResult<Vec<WakeupRequeueOutcome>> {
    let daemon_dir = daemon_dir.as_ref();
    let paths = list_failed_scheduler_wakeup_paths(daemon_dir)?;
    let mut outcomes = Vec::with_capacity(paths.len());

    for source_path in paths {
        let Some(mut record) = read_optional_record(&source_path)? else {
            continue;
        };
        if record.status != WakeupStatus::Failed {
            return Err(SchedulerWakeupError::InvalidRequeueStatus {
                status: record.status,
            });
        }

        if !is_retry_due(&record, now) {
            continue;
        }

        record.status = WakeupStatus::Pending;
        record.updated_at = now;
        record.next_attempt_at = None;
        let target_path = pending_scheduler_wakeup_record_path(daemon_dir, &record.wakeup_id);
        transition_record(daemon_dir, &source_path, target_path.clone(), &record)?;
        outcomes.push(WakeupRequeueOutcome {
            wakeup_id: record.wakeup_id.clone(),
            source_path,
            target_path,
        });
    }

    Ok(outcomes)
}

pub fn inspect_scheduler_wakeups(
    daemon_dir: impl AsRef<Path>,
    now: u64,
) -> SchedulerWakeupResult<SchedulerWakeupsDiagnostics> {
    let daemon_dir = daemon_dir.as_ref();
    let pending_records =
        read_records_from_paths(list_pending_scheduler_wakeup_paths(daemon_dir)?)?;
    let fired_records =
        read_records_from_paths(list_record_paths(fired_scheduler_wakeup_dir(daemon_dir))?)?;
    let failed_records = read_records_from_paths(list_failed_scheduler_wakeup_paths(daemon_dir)?)?;

    let due_pending_count = pending_records
        .iter()
        .filter(|record| record.scheduled_for <= now)
        .count();

    let mut retryable_failed_count = 0;
    let mut permanent_failed_count = 0;
    let mut due_retry_count = 0;
    let mut next_retry_at: Option<u64> = None;
    let mut latest_failure: Option<WakeupFailureDiagnostic> = None;

    for record in &failed_records {
        let Some(latest_attempt) = record.fire_attempts.last() else {
            permanent_failed_count += 1;
            continue;
        };
        let classification = latest_attempt
            .classification
            .unwrap_or(WakeupFailureClassification::Permanent);

        match classification {
            WakeupFailureClassification::Retryable => {
                retryable_failed_count += 1;
                let retry_at = latest_attempt.next_attempt_at.unwrap_or(now);
                next_retry_at =
                    Some(next_retry_at.map_or(retry_at, |current| current.min(retry_at)));
                if retry_at <= now {
                    due_retry_count += 1;
                }
            }
            WakeupFailureClassification::Permanent => {
                permanent_failed_count += 1;
            }
        }

        let candidate = failure_diagnostic_from_record(record, latest_attempt, classification);
        if latest_failure
            .as_ref()
            .is_none_or(|current| candidate.attempted_at > current.attempted_at)
        {
            latest_failure = Some(candidate);
        }
    }

    let oldest_pending = pending_records
        .iter()
        .min_by(|a, b| {
            a.scheduled_for
                .cmp(&b.scheduled_for)
                .then_with(|| a.wakeup_id.cmp(&b.wakeup_id))
        })
        .map(pending_diagnostic_from_record);

    Ok(SchedulerWakeupsDiagnostics {
        schema_version: SCHEDULER_WAKEUPS_DIAGNOSTICS_SCHEMA_VERSION,
        inspected_at: now,
        pending_count: pending_records.len(),
        fired_count: fired_records.len(),
        failed_count: failed_records.len(),
        retryable_failed_count,
        permanent_failed_count,
        due_pending_count,
        due_retry_count,
        tmp_file_count: list_tmp_scheduler_wakeup_paths(daemon_dir)?.len(),
        oldest_pending,
        next_retry_at,
        latest_failure,
    })
}

pub fn run_scheduler_maintenance(
    daemon_dir: impl AsRef<Path>,
    now: u64,
) -> SchedulerWakeupResult<SchedulerWakeupsMaintenanceReport> {
    let daemon_dir = daemon_dir.as_ref();
    let diagnostics_before = inspect_scheduler_wakeups(daemon_dir, now)?;
    let requeued = requeue_due_failed_wakeups(daemon_dir, now)?;
    let diagnostics_after = inspect_scheduler_wakeups(daemon_dir, now)?;
    Ok(SchedulerWakeupsMaintenanceReport {
        diagnostics_before,
        requeued,
        diagnostics_after,
    })
}

fn validate_enqueue_request(request: &WakeupEnqueueRequest, now: u64) -> SchedulerWakeupResult<()> {
    if request.writer_version.is_empty() {
        return Err(SchedulerWakeupError::MissingField {
            field: "writerVersion",
        });
    }
    if request.requester_context.is_empty() {
        return Err(SchedulerWakeupError::MissingField {
            field: "requesterContext",
        });
    }
    match &request.target {
        WakeupTarget::ProjectWakeup { project_d_tag } => {
            if project_d_tag.is_empty() {
                return Err(SchedulerWakeupError::MissingField {
                    field: "target.projectDTag",
                });
            }
        }
        WakeupTarget::AgentWakeup {
            project_d_tag,
            agent_pubkey,
        } => {
            if project_d_tag.is_empty() {
                return Err(SchedulerWakeupError::MissingField {
                    field: "target.projectDTag",
                });
            }
            if agent_pubkey.is_empty() {
                return Err(SchedulerWakeupError::MissingField {
                    field: "target.agentPubkey",
                });
            }
        }
        WakeupTarget::DelegationTimeout { ral_id } => {
            if ral_id.is_empty() {
                return Err(SchedulerWakeupError::MissingField {
                    field: "target.ralId",
                });
            }
        }
    }
    if !request.allow_backdated && request.scheduled_for < now {
        return Err(SchedulerWakeupError::BackdatedWakeup {
            scheduled_for: request.scheduled_for,
            now,
        });
    }
    Ok(())
}

fn compute_next_attempt_at(
    failed_at: u64,
    previous_failed_attempts: usize,
    retry_after_secs: Option<u64>,
    retry_policy: WakeupRetryPolicy,
) -> u64 {
    if let Some(secs) = retry_after_secs {
        return failed_at.saturating_add(secs);
    }
    failed_at.saturating_add(retry_policy.delay_for_failure_count(previous_failed_attempts))
}

fn is_retry_due(record: &WakeupRecord, now: u64) -> bool {
    let Some(latest_attempt) = record.fire_attempts.last() else {
        return false;
    };
    if latest_attempt.status != WakeupAttemptStatus::Failed {
        return false;
    }
    if latest_attempt.classification != Some(WakeupFailureClassification::Retryable) {
        return false;
    }
    record.next_attempt_at.is_none_or(|next| next <= now)
}

fn pending_diagnostic_from_record(record: &WakeupRecord) -> WakeupPendingDiagnostic {
    WakeupPendingDiagnostic {
        wakeup_id: record.wakeup_id.clone(),
        scheduled_for: record.scheduled_for,
        target: record.target.clone(),
        requester_context: record.requester_context.clone(),
        created_at: record.created_at,
    }
}

fn failure_diagnostic_from_record(
    record: &WakeupRecord,
    latest_attempt: &WakeupAttempt,
    classification: WakeupFailureClassification,
) -> WakeupFailureDiagnostic {
    WakeupFailureDiagnostic {
        wakeup_id: record.wakeup_id.clone(),
        target: record.target.clone(),
        attempt_count: record.fire_attempts.len(),
        attempted_at: latest_attempt.attempted_at,
        classification,
        error_detail: latest_attempt.error_detail.clone(),
        next_attempt_at: latest_attempt.next_attempt_at,
    }
}

fn list_record_paths(dir: PathBuf) -> SchedulerWakeupResult<Vec<PathBuf>> {
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

fn read_records_from_paths(paths: Vec<PathBuf>) -> SchedulerWakeupResult<Vec<WakeupRecord>> {
    paths
        .into_iter()
        .filter_map(|path| match read_optional_record(&path) {
            Ok(Some(record)) => Some(Ok(record)),
            Ok(None) => None,
            Err(error) => Some(Err(error)),
        })
        .collect()
}

fn list_tmp_scheduler_wakeup_paths(daemon_dir: &Path) -> SchedulerWakeupResult<Vec<PathBuf>> {
    let tmp_dir = tmp_scheduler_wakeup_dir(daemon_dir);
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

fn persist_pending_record(
    daemon_dir: &Path,
    record: &WakeupRecord,
) -> SchedulerWakeupResult<WakeupRecord> {
    let pending_dir = pending_scheduler_wakeup_dir(daemon_dir);
    let tmp_dir = tmp_scheduler_wakeup_dir(daemon_dir);
    fs::create_dir_all(&pending_dir)?;
    fs::create_dir_all(&tmp_dir)?;

    let record_path = pending_scheduler_wakeup_record_path(daemon_dir, &record.wakeup_id);
    if let Some((existing_path, existing)) =
        read_existing_wakeup_record(daemon_dir, &record.wakeup_id)?
    {
        return existing_record_or_conflict(existing_path, existing, record);
    }

    let tmp_path = tmp_dir.join(format!(
        "{}.{}.{}.tmp",
        record.wakeup_id,
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
            read_existing_wakeup_record(daemon_dir, &record.wakeup_id)?
        {
            return existing_record_or_conflict(existing_path, existing, record);
        }
        Err(SchedulerWakeupError::WakeupIdConflict { path: record_path })
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
    record: &WakeupRecord,
) -> SchedulerWakeupResult<()> {
    let target_dir = target_path
        .parent()
        .expect("scheduler wakeup target record must have a parent");
    fs::create_dir_all(target_dir)?;
    fs::create_dir_all(tmp_scheduler_wakeup_dir(daemon_dir))?;

    if read_optional_record(&target_path)?.is_some() {
        return Err(SchedulerWakeupError::WakeupIdConflict { path: target_path });
    }

    let tmp_path = tmp_scheduler_wakeup_dir(daemon_dir).join(format!(
        "{}.{}.{}.tmp",
        record.wakeup_id,
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
            return Ok(());
        }
        remove_optional_file(&tmp_path)?;
        Err(SchedulerWakeupError::WakeupIdConflict {
            path: target_path.clone(),
        })
    })();

    if write_result.is_err() {
        let _ = fs::remove_file(&tmp_path);
    }

    write_result
}

fn read_existing_wakeup_record(
    daemon_dir: &Path,
    wakeup_id: &str,
) -> SchedulerWakeupResult<Option<(PathBuf, WakeupRecord)>> {
    for path in [
        pending_scheduler_wakeup_record_path(daemon_dir, wakeup_id),
        fired_scheduler_wakeup_record_path(daemon_dir, wakeup_id),
        failed_scheduler_wakeup_record_path(daemon_dir, wakeup_id),
    ] {
        if let Some(record) = read_optional_record(&path)? {
            return Ok(Some((path, record)));
        }
    }
    Ok(None)
}

fn existing_record_or_conflict(
    existing_path: PathBuf,
    existing: WakeupRecord,
    requested: &WakeupRecord,
) -> SchedulerWakeupResult<WakeupRecord> {
    if existing.wakeup_id == requested.wakeup_id
        && existing.target == requested.target
        && existing.scheduled_for == requested.scheduled_for
        && existing.requester_context == requested.requester_context
    {
        return Ok(existing);
    }
    Err(SchedulerWakeupError::WakeupIdConflict {
        path: existing_path,
    })
}

fn create_record_link_without_replacing(
    source_path: &Path,
    target_path: &Path,
) -> SchedulerWakeupResult<bool> {
    match fs::hard_link(source_path, target_path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn remove_optional_file(path: impl AsRef<Path>) -> SchedulerWakeupResult<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn read_optional_record(path: impl AsRef<Path>) -> SchedulerWakeupResult<Option<WakeupRecord>> {
    match fs::read_to_string(path) {
        Ok(content) => {
            let record: WakeupRecord = serde_json::from_str(&content)?;
            if record.schema_version != SCHEDULER_WAKEUPS_RECORD_SCHEMA_VERSION {
                return Err(SchedulerWakeupError::UnsupportedSchemaVersion {
                    found: record.schema_version,
                    expected: SCHEDULER_WAKEUPS_RECORD_SCHEMA_VERSION,
                });
            }
            Ok(Some(record))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn write_record_file(path: &Path, record: &WakeupRecord) -> SchedulerWakeupResult<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    serde_json::to_writer_pretty(&mut file, record)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    Ok(())
}

fn sync_parent_dir(path: &Path) -> SchedulerWakeupResult<()> {
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
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn unique_temp_daemon_dir() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be after UNIX_EPOCH")
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let daemon_dir = std::env::temp_dir().join(format!(
            "tenex-scheduler-wakeups-{}-{counter}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&daemon_dir).expect("temp daemon dir must be created");
        daemon_dir
    }

    fn project_wakeup_request(
        scheduled_for: u64,
        project_d_tag: &str,
        requester_context: &str,
    ) -> WakeupEnqueueRequest {
        WakeupEnqueueRequest {
            scheduled_for,
            target: WakeupTarget::ProjectWakeup {
                project_d_tag: project_d_tag.to_string(),
            },
            requester_context: requester_context.to_string(),
            writer_version: "test-version".to_string(),
            allow_backdated: false,
        }
    }

    fn agent_wakeup_request(
        scheduled_for: u64,
        project_d_tag: &str,
        agent_pubkey: &str,
        requester_context: &str,
    ) -> WakeupEnqueueRequest {
        WakeupEnqueueRequest {
            scheduled_for,
            target: WakeupTarget::AgentWakeup {
                project_d_tag: project_d_tag.to_string(),
                agent_pubkey: agent_pubkey.to_string(),
            },
            requester_context: requester_context.to_string(),
            writer_version: "test-version".to_string(),
            allow_backdated: false,
        }
    }

    fn delegation_timeout_request(
        scheduled_for: u64,
        ral_id: &str,
        requester_context: &str,
    ) -> WakeupEnqueueRequest {
        WakeupEnqueueRequest {
            scheduled_for,
            target: WakeupTarget::DelegationTimeout {
                ral_id: ral_id.to_string(),
            },
            requester_context: requester_context.to_string(),
            writer_version: "test-version".to_string(),
            allow_backdated: false,
        }
    }

    #[test]
    fn derives_stable_wakeup_id_for_fixed_inputs() {
        let target = WakeupTarget::ProjectWakeup {
            project_d_tag: "project-alpha".to_string(),
        };
        let id_a = derive_wakeup_id(1_710_001_100, &target, "trace-01").expect("id derives");
        let id_b = derive_wakeup_id(1_710_001_100, &target, "trace-01").expect("id derives");
        assert_eq!(id_a, id_b);
        assert_eq!(id_a.len(), 64);

        let id_other_time =
            derive_wakeup_id(1_710_001_200, &target, "trace-01").expect("id derives");
        assert_ne!(id_a, id_other_time);

        let id_other_target = derive_wakeup_id(
            1_710_001_100,
            &WakeupTarget::ProjectWakeup {
                project_d_tag: "project-beta".to_string(),
            },
            "trace-01",
        )
        .expect("id derives");
        assert_ne!(id_a, id_other_target);

        let id_other_context =
            derive_wakeup_id(1_710_001_100, &target, "trace-02").expect("id derives");
        assert_ne!(id_a, id_other_context);
    }

    #[test]
    fn wakeup_target_variants_round_trip() {
        let targets = [
            WakeupTarget::ProjectWakeup {
                project_d_tag: "project-alpha".to_string(),
            },
            WakeupTarget::AgentWakeup {
                project_d_tag: "project-alpha".to_string(),
                agent_pubkey: "a".repeat(64),
            },
            WakeupTarget::DelegationTimeout {
                ral_id: "ral-01".to_string(),
            },
        ];
        for target in targets {
            let json = serde_json::to_string(&target).expect("target serializes");
            let round_trip: WakeupTarget =
                serde_json::from_str(&json).expect("target deserializes");
            assert_eq!(round_trip, target);
        }
    }

    #[test]
    fn enqueue_persists_pending_record() {
        let daemon_dir = unique_temp_daemon_dir();
        let request = project_wakeup_request(1_710_001_100, "project-alpha", "trace-01");

        let record =
            enqueue_wakeup(&daemon_dir, request, 1_710_001_000).expect("enqueue must succeed");

        assert_eq!(
            record.schema_version,
            SCHEDULER_WAKEUPS_RECORD_SCHEMA_VERSION
        );
        assert_eq!(record.writer, SCHEDULER_WAKEUPS_WRITER);
        assert_eq!(record.status, WakeupStatus::Pending);
        assert_eq!(record.created_at, 1_710_001_000);
        assert_eq!(record.updated_at, 1_710_001_000);
        assert_eq!(record.scheduled_for, 1_710_001_100);
        assert!(record.fire_attempts.is_empty());
        assert!(record.next_attempt_at.is_none());

        let persisted = read_pending_wakeup_record(&daemon_dir, &record.wakeup_id)
            .expect("pending read must succeed");
        assert_eq!(persisted.as_ref(), Some(&record));

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn enqueue_is_idempotent_for_identical_inputs() {
        let daemon_dir = unique_temp_daemon_dir();
        let first = project_wakeup_request(1_710_001_100, "project-alpha", "trace-01");
        let second = project_wakeup_request(1_710_001_100, "project-alpha", "trace-01");

        let first_record =
            enqueue_wakeup(&daemon_dir, first, 1_710_001_000).expect("first enqueue must succeed");
        let second_record = enqueue_wakeup(&daemon_dir, second, 1_710_001_050)
            .expect("duplicate enqueue must be idempotent");

        assert_eq!(first_record, second_record);
        let paths = list_pending_scheduler_wakeup_paths(&daemon_dir).expect("listing must succeed");
        assert_eq!(paths.len(), 1);

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn enqueue_rejects_backdated_without_opt_in() {
        let daemon_dir = unique_temp_daemon_dir();
        let request = project_wakeup_request(1_710_000_900, "project-alpha", "trace-01");

        let error = enqueue_wakeup(&daemon_dir, request, 1_710_001_000)
            .expect_err("backdated wakeup must be rejected");

        assert!(matches!(
            error,
            SchedulerWakeupError::BackdatedWakeup {
                scheduled_for: 1_710_000_900,
                now: 1_710_001_000,
            }
        ));

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn enqueue_allows_backdated_when_opted_in() {
        let daemon_dir = unique_temp_daemon_dir();
        let mut request = project_wakeup_request(1_710_000_900, "project-alpha", "trace-01");
        request.allow_backdated = true;

        let record = enqueue_wakeup(&daemon_dir, request, 1_710_001_000)
            .expect("backdated enqueue with opt-in must succeed");

        assert_eq!(record.scheduled_for, 1_710_000_900);

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn enqueue_rejects_missing_requester_context() {
        let daemon_dir = unique_temp_daemon_dir();
        let mut request = project_wakeup_request(1_710_001_100, "project-alpha", "trace-01");
        request.requester_context = String::new();

        let error = enqueue_wakeup(&daemon_dir, request, 1_710_001_000)
            .expect_err("missing requester context must be rejected");

        assert!(matches!(
            error,
            SchedulerWakeupError::MissingField {
                field: "requesterContext",
            }
        ));

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn enqueue_rejects_missing_writer_version() {
        let daemon_dir = unique_temp_daemon_dir();
        let mut request = project_wakeup_request(1_710_001_100, "project-alpha", "trace-01");
        request.writer_version = String::new();

        let error = enqueue_wakeup(&daemon_dir, request, 1_710_001_000)
            .expect_err("missing writer version must be rejected");

        assert!(matches!(
            error,
            SchedulerWakeupError::MissingField {
                field: "writerVersion",
            }
        ));

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn enqueue_rejects_empty_target_fields() {
        let daemon_dir = unique_temp_daemon_dir();
        let request = agent_wakeup_request(1_710_001_100, "project-alpha", "", "trace-01");

        let error = enqueue_wakeup(&daemon_dir, request, 1_710_001_000)
            .expect_err("missing agent pubkey must be rejected");

        assert!(matches!(
            error,
            SchedulerWakeupError::MissingField {
                field: "target.agentPubkey",
            }
        ));

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn enqueue_persists_agent_and_delegation_variants() {
        let daemon_dir = unique_temp_daemon_dir();
        let agent = agent_wakeup_request(
            1_710_001_100,
            "project-alpha",
            &"a".repeat(64),
            "trace-agent",
        );
        let delegation = delegation_timeout_request(1_710_001_200, "ral-01", "trace-delegation");

        let agent_record =
            enqueue_wakeup(&daemon_dir, agent, 1_710_001_000).expect("agent enqueue must succeed");
        let delegation_record = enqueue_wakeup(&daemon_dir, delegation, 1_710_001_000)
            .expect("delegation enqueue must succeed");

        assert!(matches!(
            agent_record.target,
            WakeupTarget::AgentWakeup { .. }
        ));
        assert!(matches!(
            delegation_record.target,
            WakeupTarget::DelegationTimeout { .. }
        ));
        assert_ne!(agent_record.wakeup_id, delegation_record.wakeup_id);

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn retry_policy_default_has_exponential_growth() {
        let policy = WakeupRetryPolicy::default();
        assert_eq!(policy.delay_for_failure_count(0), 30);
        assert_eq!(policy.delay_for_failure_count(1), 60);
        assert_eq!(policy.delay_for_failure_count(2), 120);
        let high = policy.delay_for_failure_count(100);
        assert_eq!(high, policy.max_delay_secs);
    }

    #[test]
    fn list_due_wakeups_only_returns_records_past_scheduled_for() {
        let daemon_dir = unique_temp_daemon_dir();
        enqueue_wakeup(
            &daemon_dir,
            project_wakeup_request(1_710_001_100, "project-alpha", "future"),
            1_710_001_000,
        )
        .expect("future enqueue");
        let mut past_request = project_wakeup_request(1_710_000_900, "project-alpha", "past");
        past_request.allow_backdated = true;
        enqueue_wakeup(&daemon_dir, past_request, 1_710_001_000).expect("past enqueue");

        let due_at_t1 = list_due_wakeups(&daemon_dir, 1_710_000_950).expect("due listing");
        assert_eq!(due_at_t1.len(), 1);
        assert_eq!(due_at_t1[0].scheduled_for, 1_710_000_900);

        let due_at_t2 = list_due_wakeups(&daemon_dir, 1_710_001_200).expect("due listing");
        assert_eq!(due_at_t2.len(), 2);

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn list_due_wakeups_sorts_by_scheduled_for_then_wakeup_id() {
        let daemon_dir = unique_temp_daemon_dir();
        enqueue_wakeup(
            &daemon_dir,
            project_wakeup_request(1_710_001_500, "project-alpha", "trace-c"),
            1_710_001_000,
        )
        .expect("enqueue c");
        enqueue_wakeup(
            &daemon_dir,
            project_wakeup_request(1_710_001_100, "project-alpha", "trace-a"),
            1_710_001_000,
        )
        .expect("enqueue a");
        enqueue_wakeup(
            &daemon_dir,
            project_wakeup_request(1_710_001_100, "project-alpha", "trace-b"),
            1_710_001_000,
        )
        .expect("enqueue b");

        let due = list_due_wakeups(&daemon_dir, 1_710_002_000).expect("due listing");
        assert_eq!(due.len(), 3);
        assert_eq!(due[0].scheduled_for, 1_710_001_100);
        assert_eq!(due[1].scheduled_for, 1_710_001_100);
        assert_eq!(due[2].scheduled_for, 1_710_001_500);
        assert!(due[0].wakeup_id < due[1].wakeup_id);

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn cancel_removes_pending_record() {
        let daemon_dir = unique_temp_daemon_dir();
        let record = enqueue_wakeup(
            &daemon_dir,
            project_wakeup_request(1_710_001_100, "project-alpha", "trace-01"),
            1_710_001_000,
        )
        .expect("enqueue");

        let outcome = cancel_wakeup(&daemon_dir, &record.wakeup_id)
            .expect("cancel must succeed")
            .expect("cancel must return outcome");
        assert_eq!(outcome.previous_status, WakeupStatus::Pending);
        assert_eq!(outcome.wakeup_id, record.wakeup_id);

        assert!(
            read_pending_wakeup_record(&daemon_dir, &record.wakeup_id)
                .expect("pending read")
                .is_none()
        );
        let paths = list_pending_scheduler_wakeup_paths(&daemon_dir).expect("pending listing");
        assert!(paths.is_empty());

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn cancel_unknown_wakeup_returns_none() {
        let daemon_dir = unique_temp_daemon_dir();

        let outcome = cancel_wakeup(&daemon_dir, "unknown-id").expect("cancel must succeed");
        assert!(outcome.is_none());

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn cancel_returns_existing_state_for_fired_wakeup() {
        let daemon_dir = unique_temp_daemon_dir();
        let record = enqueue_wakeup(
            &daemon_dir,
            project_wakeup_request(1_710_001_100, "project-alpha", "trace-01"),
            1_710_001_000,
        )
        .expect("enqueue");
        mark_wakeup_fired(&daemon_dir, &record.wakeup_id, 1_710_001_150, "dispatched")
            .expect("fire must succeed");

        let outcome = cancel_wakeup(&daemon_dir, &record.wakeup_id)
            .expect("cancel must succeed")
            .expect("cancel must report existing fired state");
        assert_eq!(outcome.previous_status, WakeupStatus::Fired);
        assert!(
            read_fired_wakeup_record(&daemon_dir, &record.wakeup_id)
                .expect("fired read")
                .is_some()
        );

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn cancel_returns_existing_state_for_failed_wakeup() {
        let daemon_dir = unique_temp_daemon_dir();
        let record = enqueue_wakeup(
            &daemon_dir,
            project_wakeup_request(1_710_001_100, "project-alpha", "trace-01"),
            1_710_001_000,
        )
        .expect("enqueue");
        mark_wakeup_failed(
            &daemon_dir,
            &record.wakeup_id,
            1_710_001_150,
            WakeupFailureClassification::Permanent,
            Some("target missing".to_string()),
            None,
            WakeupRetryPolicy::default(),
        )
        .expect("fail must succeed");

        let outcome = cancel_wakeup(&daemon_dir, &record.wakeup_id)
            .expect("cancel must succeed")
            .expect("cancel must report existing failed state");
        assert_eq!(outcome.previous_status, WakeupStatus::Failed);

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn mark_fired_moves_record_from_pending_to_fired() {
        let daemon_dir = unique_temp_daemon_dir();
        let record = enqueue_wakeup(
            &daemon_dir,
            project_wakeup_request(1_710_001_100, "project-alpha", "trace-01"),
            1_710_001_000,
        )
        .expect("enqueue");

        let fired = mark_wakeup_fired(&daemon_dir, &record.wakeup_id, 1_710_001_150, "dispatched")
            .expect("fire must succeed");

        assert_eq!(fired.status, WakeupStatus::Fired);
        assert_eq!(fired.updated_at, 1_710_001_150);
        assert_eq!(fired.fire_attempts.len(), 1);
        assert_eq!(fired.fire_attempts[0].status, WakeupAttemptStatus::Fired);
        assert_eq!(
            fired.fire_attempts[0].outcome.as_deref(),
            Some("dispatched")
        );

        assert!(
            read_pending_wakeup_record(&daemon_dir, &record.wakeup_id)
                .expect("pending read")
                .is_none()
        );
        let persisted = read_fired_wakeup_record(&daemon_dir, &record.wakeup_id)
            .expect("fired read")
            .expect("fired record must persist");
        assert_eq!(persisted.fire_attempts, fired.fire_attempts);

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn mark_fired_fails_closed_when_no_pending_record() {
        let daemon_dir = unique_temp_daemon_dir();

        let error = mark_wakeup_fired(&daemon_dir, "missing-id", 1_710_001_150, "dispatched")
            .expect_err("missing pending record must be rejected");
        assert!(matches!(error, SchedulerWakeupError::WakeupNotFound { .. }));

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn mark_failed_retryable_sets_next_attempt_from_policy() {
        let daemon_dir = unique_temp_daemon_dir();
        let record = enqueue_wakeup(
            &daemon_dir,
            project_wakeup_request(1_710_001_100, "project-alpha", "trace-01"),
            1_710_001_000,
        )
        .expect("enqueue");

        let policy = WakeupRetryPolicy {
            base_delay_secs: 45,
            max_delay_secs: 600,
            multiplier: 2.0,
        };
        let failed = mark_wakeup_failed(
            &daemon_dir,
            &record.wakeup_id,
            1_710_001_150,
            WakeupFailureClassification::Retryable,
            Some("relay unreachable".to_string()),
            None,
            policy,
        )
        .expect("fail retryable must succeed");

        assert_eq!(failed.status, WakeupStatus::Failed);
        assert_eq!(failed.next_attempt_at, Some(1_710_001_150 + 45));
        assert_eq!(failed.fire_attempts.len(), 1);
        assert_eq!(
            failed.fire_attempts[0].classification,
            Some(WakeupFailureClassification::Retryable)
        );
        assert_eq!(
            failed.fire_attempts[0].error_detail.as_deref(),
            Some("relay unreachable")
        );
        assert_eq!(failed.fire_attempts[0].next_attempt_at, Some(1_710_001_195));

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn mark_failed_retryable_honours_retry_after_override() {
        let daemon_dir = unique_temp_daemon_dir();
        let record = enqueue_wakeup(
            &daemon_dir,
            project_wakeup_request(1_710_001_100, "project-alpha", "trace-01"),
            1_710_001_000,
        )
        .expect("enqueue");

        let failed = mark_wakeup_failed(
            &daemon_dir,
            &record.wakeup_id,
            1_710_001_150,
            WakeupFailureClassification::Retryable,
            None,
            Some(120),
            WakeupRetryPolicy::default(),
        )
        .expect("fail retryable must succeed");

        assert_eq!(failed.next_attempt_at, Some(1_710_001_270));

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn mark_failed_permanent_has_no_next_attempt() {
        let daemon_dir = unique_temp_daemon_dir();
        let record = enqueue_wakeup(
            &daemon_dir,
            project_wakeup_request(1_710_001_100, "project-alpha", "trace-01"),
            1_710_001_000,
        )
        .expect("enqueue");

        let failed = mark_wakeup_failed(
            &daemon_dir,
            &record.wakeup_id,
            1_710_001_150,
            WakeupFailureClassification::Permanent,
            Some("target not found".to_string()),
            None,
            WakeupRetryPolicy::default(),
        )
        .expect("fail permanent must succeed");

        assert!(failed.next_attempt_at.is_none());
        assert_eq!(
            failed.fire_attempts[0].classification,
            Some(WakeupFailureClassification::Permanent)
        );
        assert!(failed.fire_attempts[0].next_attempt_at.is_none());

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn mark_failed_fails_closed_when_no_pending_record() {
        let daemon_dir = unique_temp_daemon_dir();

        let error = mark_wakeup_failed(
            &daemon_dir,
            "missing-id",
            1_710_001_150,
            WakeupFailureClassification::Permanent,
            None,
            None,
            WakeupRetryPolicy::default(),
        )
        .expect_err("missing record must be rejected");
        assert!(matches!(error, SchedulerWakeupError::WakeupNotFound { .. }));

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn requeue_moves_due_retryable_back_to_pending() {
        let daemon_dir = unique_temp_daemon_dir();
        let record = enqueue_wakeup(
            &daemon_dir,
            project_wakeup_request(1_710_001_100, "project-alpha", "trace-01"),
            1_710_001_000,
        )
        .expect("enqueue");
        mark_wakeup_failed(
            &daemon_dir,
            &record.wakeup_id,
            1_710_001_150,
            WakeupFailureClassification::Retryable,
            None,
            Some(50),
            WakeupRetryPolicy::default(),
        )
        .expect("fail retryable");

        let outcomes = requeue_due_failed_wakeups(&daemon_dir, 1_710_001_100)
            .expect("requeue before retry must succeed");
        assert!(outcomes.is_empty());

        let outcomes = requeue_due_failed_wakeups(&daemon_dir, 1_710_001_210)
            .expect("requeue at retry time must succeed");
        assert_eq!(outcomes.len(), 1);
        assert_eq!(outcomes[0].wakeup_id, record.wakeup_id);

        let pending = read_pending_wakeup_record(&daemon_dir, &record.wakeup_id)
            .expect("pending read")
            .expect("record must be pending");
        assert_eq!(pending.status, WakeupStatus::Pending);
        assert_eq!(pending.fire_attempts.len(), 1);
        assert!(pending.next_attempt_at.is_none());
        assert_eq!(pending.updated_at, 1_710_001_210);
        assert!(
            read_failed_wakeup_record(&daemon_dir, &record.wakeup_id)
                .expect("failed read")
                .is_none()
        );

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn requeue_preserves_permanent_failures_and_future_retries() {
        let daemon_dir = unique_temp_daemon_dir();
        let retry_later = enqueue_wakeup(
            &daemon_dir,
            project_wakeup_request(1_710_001_100, "project-alpha", "retry-later"),
            1_710_001_000,
        )
        .expect("enqueue retry-later");
        let permanent = enqueue_wakeup(
            &daemon_dir,
            project_wakeup_request(1_710_001_100, "project-alpha", "permanent"),
            1_710_001_000,
        )
        .expect("enqueue permanent");

        mark_wakeup_failed(
            &daemon_dir,
            &retry_later.wakeup_id,
            1_710_001_150,
            WakeupFailureClassification::Retryable,
            None,
            Some(1_000),
            WakeupRetryPolicy::default(),
        )
        .expect("fail retry-later");
        mark_wakeup_failed(
            &daemon_dir,
            &permanent.wakeup_id,
            1_710_001_150,
            WakeupFailureClassification::Permanent,
            None,
            None,
            WakeupRetryPolicy::default(),
        )
        .expect("fail permanent");

        let outcomes =
            requeue_due_failed_wakeups(&daemon_dir, 1_710_001_500).expect("requeue must succeed");
        assert!(outcomes.is_empty());
        assert!(
            read_failed_wakeup_record(&daemon_dir, &retry_later.wakeup_id)
                .expect("failed read")
                .is_some()
        );
        assert!(
            read_failed_wakeup_record(&daemon_dir, &permanent.wakeup_id)
                .expect("failed read")
                .is_some()
        );

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn mark_failed_after_requeue_appends_attempt_history() {
        let daemon_dir = unique_temp_daemon_dir();
        let record = enqueue_wakeup(
            &daemon_dir,
            project_wakeup_request(1_710_001_100, "project-alpha", "trace-01"),
            1_710_001_000,
        )
        .expect("enqueue");
        mark_wakeup_failed(
            &daemon_dir,
            &record.wakeup_id,
            1_710_001_150,
            WakeupFailureClassification::Retryable,
            Some("transient".to_string()),
            Some(10),
            WakeupRetryPolicy::default(),
        )
        .expect("first failure");
        requeue_due_failed_wakeups(&daemon_dir, 1_710_001_200).expect("requeue");
        let failed_again = mark_wakeup_failed(
            &daemon_dir,
            &record.wakeup_id,
            1_710_001_250,
            WakeupFailureClassification::Retryable,
            Some("still transient".to_string()),
            Some(20),
            WakeupRetryPolicy::default(),
        )
        .expect("second failure");

        assert_eq!(failed_again.fire_attempts.len(), 2);
        assert_eq!(
            failed_again.fire_attempts[0].error_detail.as_deref(),
            Some("transient")
        );
        assert_eq!(
            failed_again.fire_attempts[1].error_detail.as_deref(),
            Some("still transient")
        );
        assert_eq!(
            failed_again.fire_attempts[1].next_attempt_at,
            Some(1_710_001_270)
        );

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn requeue_rejects_records_with_non_failed_status() {
        let daemon_dir = unique_temp_daemon_dir();
        let record = enqueue_wakeup(
            &daemon_dir,
            project_wakeup_request(1_710_001_100, "project-alpha", "trace-01"),
            1_710_001_000,
        )
        .expect("enqueue");
        let failed_path = failed_scheduler_wakeup_record_path(&daemon_dir, &record.wakeup_id);
        fs::create_dir_all(failed_path.parent().expect("parent")).expect("mkdir");
        let mut broken = record.clone();
        broken.status = WakeupStatus::Fired;
        fs::write(&failed_path, serde_json::to_string(&broken).expect("json"))
            .expect("write broken record");

        let error = requeue_due_failed_wakeups(&daemon_dir, 1_710_001_500)
            .expect_err("non-failed record must fail closed");
        assert!(matches!(
            error,
            SchedulerWakeupError::InvalidRequeueStatus { .. }
        ));

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn inspect_returns_empty_diagnostics_for_missing_dirs() {
        let daemon_dir = unique_temp_daemon_dir();

        let diagnostics = inspect_scheduler_wakeups(&daemon_dir, 1_710_001_000)
            .expect("diagnostics must inspect");

        assert_eq!(
            diagnostics.schema_version,
            SCHEDULER_WAKEUPS_DIAGNOSTICS_SCHEMA_VERSION
        );
        assert_eq!(diagnostics.inspected_at, 1_710_001_000);
        assert_eq!(diagnostics.pending_count, 0);
        assert_eq!(diagnostics.fired_count, 0);
        assert_eq!(diagnostics.failed_count, 0);
        assert_eq!(diagnostics.due_pending_count, 0);
        assert_eq!(diagnostics.due_retry_count, 0);
        assert_eq!(diagnostics.retryable_failed_count, 0);
        assert_eq!(diagnostics.permanent_failed_count, 0);
        assert_eq!(diagnostics.tmp_file_count, 0);
        assert!(diagnostics.oldest_pending.is_none());
        assert!(diagnostics.next_retry_at.is_none());
        assert!(diagnostics.latest_failure.is_none());

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn inspect_counts_pending_fired_failed_records() {
        let daemon_dir = unique_temp_daemon_dir();
        let future_record = enqueue_wakeup(
            &daemon_dir,
            project_wakeup_request(1_710_002_000, "project-alpha", "future"),
            1_710_001_000,
        )
        .expect("future enqueue");
        let fire_record = enqueue_wakeup(
            &daemon_dir,
            project_wakeup_request(1_710_001_100, "project-alpha", "to-fire"),
            1_710_001_000,
        )
        .expect("fire enqueue");
        let retryable_record = enqueue_wakeup(
            &daemon_dir,
            project_wakeup_request(1_710_001_100, "project-alpha", "retryable"),
            1_710_001_000,
        )
        .expect("retryable enqueue");
        let permanent_record = enqueue_wakeup(
            &daemon_dir,
            project_wakeup_request(1_710_001_100, "project-alpha", "permanent"),
            1_710_001_000,
        )
        .expect("permanent enqueue");

        mark_wakeup_fired(
            &daemon_dir,
            &fire_record.wakeup_id,
            1_710_001_200,
            "dispatched",
        )
        .expect("fire");
        mark_wakeup_failed(
            &daemon_dir,
            &retryable_record.wakeup_id,
            1_710_001_200,
            WakeupFailureClassification::Retryable,
            Some("boom".to_string()),
            Some(100),
            WakeupRetryPolicy::default(),
        )
        .expect("fail retryable");
        mark_wakeup_failed(
            &daemon_dir,
            &permanent_record.wakeup_id,
            1_710_001_200,
            WakeupFailureClassification::Permanent,
            Some("blocked".to_string()),
            None,
            WakeupRetryPolicy::default(),
        )
        .expect("fail permanent");

        let diagnostics = inspect_scheduler_wakeups(&daemon_dir, 1_710_001_500).expect("inspect");

        assert_eq!(diagnostics.pending_count, 1);
        assert_eq!(diagnostics.fired_count, 1);
        assert_eq!(diagnostics.failed_count, 2);
        assert_eq!(diagnostics.retryable_failed_count, 1);
        assert_eq!(diagnostics.permanent_failed_count, 1);
        assert_eq!(diagnostics.due_pending_count, 0);
        assert_eq!(diagnostics.due_retry_count, 1);
        assert_eq!(diagnostics.next_retry_at, Some(1_710_001_300));

        let oldest = diagnostics
            .oldest_pending
            .expect("oldest pending must exist");
        assert_eq!(oldest.wakeup_id, future_record.wakeup_id);

        let failure = diagnostics
            .latest_failure
            .expect("latest failure must exist");
        assert_eq!(failure.attempt_count, 1);

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn read_fails_closed_on_truncated_record() {
        let daemon_dir = unique_temp_daemon_dir();
        let record = enqueue_wakeup(
            &daemon_dir,
            project_wakeup_request(1_710_001_100, "project-alpha", "trace-01"),
            1_710_001_000,
        )
        .expect("enqueue");
        let path = pending_scheduler_wakeup_record_path(&daemon_dir, &record.wakeup_id);
        fs::write(&path, "{ not-json").expect("truncate");

        let error =
            read_pending_wakeup_record(&daemon_dir, &record.wakeup_id).expect_err("must fail");
        assert!(matches!(error, SchedulerWakeupError::Json(_)));

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn read_fails_closed_on_schema_version_mismatch() {
        let daemon_dir = unique_temp_daemon_dir();
        let record = enqueue_wakeup(
            &daemon_dir,
            project_wakeup_request(1_710_001_100, "project-alpha", "trace-01"),
            1_710_001_000,
        )
        .expect("enqueue");
        let path = pending_scheduler_wakeup_record_path(&daemon_dir, &record.wakeup_id);
        let content = fs::read_to_string(&path).expect("read");
        let replaced = content.replace(
            &format!(
                "\"schemaVersion\": {}",
                SCHEDULER_WAKEUPS_RECORD_SCHEMA_VERSION
            ),
            "\"schemaVersion\": 999",
        );
        fs::write(&path, replaced).expect("rewrite");

        let error =
            read_pending_wakeup_record(&daemon_dir, &record.wakeup_id).expect_err("must fail");
        assert!(matches!(
            error,
            SchedulerWakeupError::UnsupportedSchemaVersion {
                found: 999,
                expected: SCHEDULER_WAKEUPS_RECORD_SCHEMA_VERSION,
            }
        ));

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn atomic_write_leaves_no_tmp_file_on_success() {
        let daemon_dir = unique_temp_daemon_dir();
        enqueue_wakeup(
            &daemon_dir,
            project_wakeup_request(1_710_001_100, "project-alpha", "trace-01"),
            1_710_001_000,
        )
        .expect("enqueue");

        let tmp_dir = tmp_scheduler_wakeup_dir(&daemon_dir);
        let tmp_entries: Vec<_> = fs::read_dir(&tmp_dir)
            .expect("tmp dir readable")
            .collect::<Result<_, _>>()
            .expect("tmp entries");
        assert!(
            tmp_entries.is_empty(),
            "tmp dir must be empty after successful enqueue"
        );

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn transition_fails_closed_on_destination_collision() {
        let daemon_dir = unique_temp_daemon_dir();
        let record = enqueue_wakeup(
            &daemon_dir,
            project_wakeup_request(1_710_001_100, "project-alpha", "trace-01"),
            1_710_001_000,
        )
        .expect("enqueue");

        let fired_path = fired_scheduler_wakeup_record_path(&daemon_dir, &record.wakeup_id);
        fs::create_dir_all(fired_path.parent().expect("parent")).expect("mkdir");
        fs::write(&fired_path, "{}").expect("write stray fired record");

        let error = mark_wakeup_fired(&daemon_dir, &record.wakeup_id, 1_710_001_150, "dispatched")
            .expect_err("fire must fail when fired destination exists");
        assert!(matches!(error, SchedulerWakeupError::Json(_)));
        assert!(
            read_pending_wakeup_record(&daemon_dir, &record.wakeup_id)
                .expect("pending read")
                .is_some(),
            "pending record must remain after failed transition"
        );

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn transition_fails_closed_when_destination_record_already_present() {
        let daemon_dir = unique_temp_daemon_dir();
        let record = enqueue_wakeup(
            &daemon_dir,
            project_wakeup_request(1_710_001_100, "project-alpha", "trace-01"),
            1_710_001_000,
        )
        .expect("enqueue");

        let fired_path = fired_scheduler_wakeup_record_path(&daemon_dir, &record.wakeup_id);
        fs::create_dir_all(fired_path.parent().expect("parent")).expect("mkdir");
        let mut fake = record.clone();
        fake.status = WakeupStatus::Fired;
        fs::write(&fired_path, serde_json::to_string(&fake).expect("json"))
            .expect("write valid fired record");

        let error = mark_wakeup_fired(&daemon_dir, &record.wakeup_id, 1_710_001_150, "dispatched")
            .expect_err("fire must fail closed when destination record exists");
        assert!(matches!(
            error,
            SchedulerWakeupError::WakeupIdConflict { .. }
        ));
        assert!(
            read_pending_wakeup_record(&daemon_dir, &record.wakeup_id)
                .expect("pending read")
                .is_some(),
            "pending record must remain after failed transition"
        );

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn maintenance_requeues_due_retry_and_snapshots_diagnostics() {
        let daemon_dir = unique_temp_daemon_dir();
        let record = enqueue_wakeup(
            &daemon_dir,
            project_wakeup_request(1_710_001_100, "project-alpha", "trace-01"),
            1_710_001_000,
        )
        .expect("enqueue");
        mark_wakeup_failed(
            &daemon_dir,
            &record.wakeup_id,
            1_710_001_150,
            WakeupFailureClassification::Retryable,
            Some("transient".to_string()),
            Some(50),
            WakeupRetryPolicy::default(),
        )
        .expect("fail retryable");

        let report =
            run_scheduler_maintenance(&daemon_dir, 1_710_001_250).expect("maintenance must run");

        assert_eq!(report.diagnostics_before.failed_count, 1);
        assert_eq!(report.diagnostics_before.retryable_failed_count, 1);
        assert_eq!(report.diagnostics_before.due_retry_count, 1);
        assert_eq!(report.requeued.len(), 1);
        assert_eq!(report.requeued[0].wakeup_id, record.wakeup_id);
        assert_eq!(
            report.requeued[0].target_path,
            pending_scheduler_wakeup_record_path(&daemon_dir, &record.wakeup_id)
        );
        assert_eq!(report.diagnostics_after.failed_count, 0);
        assert_eq!(report.diagnostics_after.pending_count, 1);
        assert_eq!(report.diagnostics_after.due_pending_count, 1);

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn maintenance_is_idempotent_without_due_records() {
        let daemon_dir = unique_temp_daemon_dir();
        let record = enqueue_wakeup(
            &daemon_dir,
            project_wakeup_request(1_710_001_100, "project-alpha", "trace-01"),
            1_710_001_000,
        )
        .expect("enqueue");
        mark_wakeup_failed(
            &daemon_dir,
            &record.wakeup_id,
            1_710_001_150,
            WakeupFailureClassification::Retryable,
            None,
            Some(600),
            WakeupRetryPolicy::default(),
        )
        .expect("fail retryable");

        let report =
            run_scheduler_maintenance(&daemon_dir, 1_710_001_200).expect("maintenance must run");

        assert_eq!(report.diagnostics_before.failed_count, 1);
        assert_eq!(report.diagnostics_before.due_retry_count, 0);
        assert!(report.requeued.is_empty());
        assert_eq!(report.diagnostics_after.failed_count, 1);
        assert_eq!(report.diagnostics_after.retryable_failed_count, 1);

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }
}
