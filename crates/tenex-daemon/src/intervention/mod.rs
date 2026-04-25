pub mod eligibility;
pub mod notified_log;
pub mod publish;
pub mod root_event;
pub mod state;
pub mod wakeup;

use std::collections::BTreeSet;
use std::path::Path;

use thiserror::Error;
use tracing::{debug, info, warn};

use crate::agent_inventory::{
    AgentInventoryError, read_project_agent_pubkeys_for, resolve_agent_slug_in_project,
};
use crate::backend_config::{BackendConfigError, BackendConfigSnapshot, read_backend_config};
use crate::backend_signer::{BackendSignerError, HexBackendSigner};
use crate::project_status_descriptors::ProjectStatusDescriptor;
use crate::ral_journal::{
    RalJournalError, RalJournalEvent, RalJournalRecord, read_ral_journal_records,
};
use crate::scheduler_wakeups::{
    SchedulerWakeupError, WakeupFailureClassification, WakeupRetryPolicy, WakeupStatus,
    WakeupTarget, list_due_wakeups, mark_wakeup_failed, mark_wakeup_fired,
};

use eligibility::{Eligibility, EligibilityInputs, evaluate as evaluate_eligibility};
use notified_log::{
    INTERVENTION_NOTIFIED_TTL_MS, InterventionNotifiedEntry, InterventionNotifiedLogError,
    append_notified, compact_if_needed, is_notified_recently,
};
use publish::{InterventionPublishError, ReviewRequestInputs, enqueue_review};
use root_event::{RootEventLookupError, user_replied_after};
use state::{
    InterventionState, InterventionStateError, read_intervention_state, write_intervention_state,
};
use wakeup::{InterventionArmInputs, InterventionWakeupError, arm_review};

pub const INTERVENTION_WAKEUP_FIRED_OUTCOME_PUBLISHED: &str = "intervention_published";
pub const INTERVENTION_WAKEUP_FIRED_OUTCOME_SKIPPED: &str = "intervention_skipped";

#[derive(Debug, Error)]
pub enum InterventionArmError {
    #[error("intervention config error: {0}")]
    Config(#[from] BackendConfigError),
    #[error("intervention signer error: {0}")]
    Signer(#[from] BackendSignerError),
    #[error("intervention state error: {0}")]
    State(#[from] InterventionStateError),
    #[error("intervention ral journal error: {0}")]
    RalJournal(#[from] RalJournalError),
    #[error("intervention wakeup error: {0}")]
    Wakeup(#[from] InterventionWakeupError),
    #[error("intervention agent inventory error: {0}")]
    AgentInventory(#[from] AgentInventoryError),
    #[error("intervention root event lookup error: {0}")]
    RootEvent(#[from] RootEventLookupError),
    #[error("intervention notified log error: {0}")]
    NotifiedLog(#[from] InterventionNotifiedLogError),
}

#[derive(Debug, Error)]
pub enum InterventionFireError {
    #[error("intervention config error: {0}")]
    Config(#[from] BackendConfigError),
    #[error("intervention signer error: {0}")]
    Signer(#[from] BackendSignerError),
    #[error("intervention scheduler wakeup error: {0}")]
    SchedulerWakeup(#[from] SchedulerWakeupError),
    #[error("intervention root event lookup error: {0}")]
    RootEvent(#[from] RootEventLookupError),
    #[error("intervention notified log error: {0}")]
    NotifiedLog(#[from] InterventionNotifiedLogError),
    #[error("intervention agent inventory error: {0}")]
    AgentInventory(#[from] AgentInventoryError),
    #[error("intervention publish error: {0}")]
    Publish(#[from] InterventionPublishError),
}

/// Scan the RAL journal for `Completed` events that have not yet been armed,
/// arm a wakeup for each eligible one, and persist the new
/// `last_processed_ral_sequence`.
///
/// Returns the updated `last_processed_ral_sequence` so the driver can cache
/// it across calls.
pub fn arm_from_journal(
    daemon_dir: &Path,
    tenex_base_dir: &Path,
    project_descriptors: &[ProjectStatusDescriptor],
    now_ms: u64,
    writer_version: &str,
) -> Result<u64, InterventionArmError> {
    let config = read_backend_config(tenex_base_dir)?;
    if !config.intervention.is_active() {
        return Ok(read_intervention_state(daemon_dir)?.last_processed_ral_sequence);
    }

    let previous_state = read_intervention_state(daemon_dir)?;
    let signer = config.backend_signer()?;
    let backend_pubkey = signer.pubkey_hex().to_string();

    let records = read_ral_journal_records(daemon_dir)?;
    let mut new_last = previous_state.last_processed_ral_sequence;

    for record in &records {
        if record.sequence <= previous_state.last_processed_ral_sequence {
            continue;
        }
        if let RalJournalEvent::Completed { .. } = record.event {
            match try_arm_completion(
                daemon_dir,
                tenex_base_dir,
                &config,
                &backend_pubkey,
                project_descriptors,
                record,
                now_ms,
                writer_version,
            ) {
                Ok(ArmOutcome::Armed) => {
                    info!(
                        project = %record.event.identity().project_id,
                        conversation = %record.event.identity().conversation_id,
                        sequence = record.sequence,
                        "intervention armed",
                    );
                    if record.sequence > new_last {
                        new_last = record.sequence;
                    }
                }
                Ok(ArmOutcome::SkippedPermanent(reason)) => {
                    debug!(
                        project = %record.event.identity().project_id,
                        conversation = %record.event.identity().conversation_id,
                        reason = ?reason,
                        "intervention arm skipped (permanent)",
                    );
                    if record.sequence > new_last {
                        new_last = record.sequence;
                    }
                }
                Ok(ArmOutcome::SkippedNoDescriptor) => {
                    debug!(
                        project = %record.event.identity().project_id,
                        conversation = %record.event.identity().conversation_id,
                        sequence = record.sequence,
                        "intervention arm skipped (no project descriptor — will retry on project-index-changed)",
                    );
                    // Do NOT advance new_last: retry this record once the
                    // project event index is populated.
                }
                Err(error) => {
                    warn!(
                        project = %record.event.identity().project_id,
                        conversation = %record.event.identity().conversation_id,
                        error = %error,
                        "intervention arm failed",
                    );
                    // Error is not necessarily transient — advance the checkpoint
                    // to avoid repeated failures on every arm pass.
                    if record.sequence > new_last {
                        new_last = record.sequence;
                    }
                }
            }
        } else {
            // Non-Completed records (allocated, claimed, etc.) are not actionable
            // but we still advance the checkpoint past them.
            if record.sequence > new_last {
                new_last = record.sequence;
            }
        }
    }

    write_intervention_state(
        daemon_dir,
        &InterventionState {
            schema_version: 1,
            last_processed_ral_sequence: new_last,
        },
    )?;

    compact_if_needed(daemon_dir, now_ms, INTERVENTION_NOTIFIED_TTL_MS)
        .map_err(InterventionArmError::NotifiedLog)?;

    Ok(new_last)
}

/// Fire all intervention reviews whose `scheduled_for` is at or before `now_ms`.
/// Uses the supplied `project_descriptors` to resolve project metadata for each
/// due wakeup.
pub fn fire_due_reviews_now(
    daemon_dir: &Path,
    tenex_base_dir: &Path,
    project_descriptors: &[ProjectStatusDescriptor],
    now_ms: u64,
    writer_version: &str,
) -> Result<(), InterventionFireError> {
    let config = read_backend_config(tenex_base_dir)?;
    if !config.intervention.is_active() {
        return Ok(());
    }
    let signer = config.backend_signer()?;
    let backend_pubkey = signer.pubkey_hex().to_string();
    fire_due_reviews_with_config(
        daemon_dir,
        tenex_base_dir,
        &config,
        &signer,
        &backend_pubkey,
        project_descriptors,
        now_ms,
        writer_version,
    )
}

/// Compute the earliest `scheduled_for` (ms) across all pending
/// `InterventionReview` wakeups, or `None` if there are no pending wakeups.
pub fn next_intervention_wakeup_at(daemon_dir: &Path) -> Option<u64> {
    use crate::scheduler_wakeups::{
        list_pending_scheduler_wakeup_paths, read_pending_wakeup_record,
    };
    let paths = list_pending_scheduler_wakeup_paths(daemon_dir).ok()?;
    let mut earliest: Option<u64> = None;
    for path in paths {
        let wakeup_id = path.file_stem()?.to_str()?.to_string();
        if let Ok(Some(record)) = read_pending_wakeup_record(daemon_dir, &wakeup_id) {
            if record.status == WakeupStatus::Pending
                && matches!(record.target, WakeupTarget::InterventionReview { .. })
            {
                earliest = Some(earliest.map_or(record.scheduled_for, |e| e.min(record.scheduled_for)));
            }
        }
    }
    earliest
}

enum ArmOutcome {
    Armed,
    /// Permanently skipped — the record's `last_processed_ral_sequence`
    /// checkpoint can be advanced past this entry.
    SkippedPermanent(Eligibility),
    /// Transiently skipped because the project descriptor is not yet in the
    /// index (e.g. the 31933 event has not been replayed from the relay yet).
    /// The checkpoint is NOT advanced so the record will be retried when
    /// `project_index_changed` fires.
    SkippedNoDescriptor,
}

#[allow(clippy::too_many_arguments)]
fn try_arm_completion(
    daemon_dir: &Path,
    tenex_base_dir: &Path,
    config: &BackendConfigSnapshot,
    backend_pubkey: &str,
    project_descriptors: &[ProjectStatusDescriptor],
    record: &RalJournalRecord,
    now_ms: u64,
    writer_version: &str,
) -> Result<ArmOutcome, InterventionArmError> {
    let (identity, terminal) = match &record.event {
        RalJournalEvent::Completed {
            identity, terminal, ..
        } => (identity, terminal),
        _ => unreachable!("try_arm_completion only called for Completed events"),
    };

    if !terminal.published_user_visible_event {
        return Ok(ArmOutcome::SkippedPermanent(Eligibility::SkipNotTopLevel));
    }
    if terminal.pending_delegations_remain {
        return Ok(ArmOutcome::SkippedPermanent(Eligibility::SkipActiveDelegations));
    }

    let Some(descriptor) = project_descriptors
        .iter()
        .find(|d| d.project_d_tag == identity.project_id)
    else {
        // Project descriptor not yet in index — transient, retry on project-index-changed.
        return Ok(ArmOutcome::SkippedNoDescriptor);
    };
    let Some(project_base_path) = descriptor.project_base_path.as_deref() else {
        // Descriptor is present but has no base path — treat as permanent skip
        // since a descriptor without a base path is a configuration issue.
        return Ok(ArmOutcome::SkippedPermanent(Eligibility::SkipNotTopLevel));
    };
    let project_base = Path::new(project_base_path);

    let agents_dir = tenex_base_dir.join("agents");
    let project_agent_pubkeys: BTreeSet<String> =
        read_project_agent_pubkeys_for(&agents_dir, &identity.project_id)?;

    let slug = config
        .intervention
        .agent_slug
        .as_deref()
        .expect("agent slug present when intervention is active");
    let intervention_agent_pubkey =
        resolve_agent_slug_in_project(&agents_dir, &identity.project_id, slug)?;

    let root_event_author =
        root_event::read_root_event_author(project_base, &identity.conversation_id)?;
    let target_user_pubkey = root_event_author.clone();

    let notified_recently = is_notified_recently(
        daemon_dir,
        &identity.project_id,
        &identity.conversation_id,
        now_ms,
        INTERVENTION_NOTIFIED_TTL_MS,
    )?;

    let eligibility = evaluate_eligibility(EligibilityInputs {
        config: &config.intervention,
        project_d_tag: &identity.project_id,
        conversation_id: &identity.conversation_id,
        completing_agent_pubkey: &identity.agent_pubkey,
        target_user_pubkey: target_user_pubkey.as_deref().unwrap_or(""),
        intervention_agent_pubkey: intervention_agent_pubkey.as_deref(),
        root_event_author_pubkey: root_event_author.as_deref(),
        project_agent_pubkeys: &project_agent_pubkeys,
        backend_pubkey,
        whitelisted_pubkeys: &config.whitelisted_pubkeys,
        ral_has_active_delegations: terminal.pending_delegations_remain,
        notified_recently,
    });

    if eligibility != Eligibility::Arm {
        return Ok(ArmOutcome::SkippedPermanent(eligibility));
    }

    let user_pubkey = root_event_author.expect("root author is Some when eligibility returns Arm");
    let timeout_ms = u64::from(config.intervention.timeout_seconds).saturating_mul(1_000);
    let scheduled_for_ms = record
        .timestamp
        .saturating_add(timeout_ms)
        .max(now_ms);

    arm_review(
        daemon_dir,
        InterventionArmInputs {
            project_d_tag: &identity.project_id,
            conversation_id: &identity.conversation_id,
            completing_agent_pubkey: &identity.agent_pubkey,
            user_pubkey: &user_pubkey,
            intervention_agent_slug: slug,
            scheduled_for_ms,
            writer_version,
        },
        now_ms,
    )?;

    Ok(ArmOutcome::Armed)
}

#[allow(clippy::too_many_arguments)]
fn fire_due_reviews_with_config(
    daemon_dir: &Path,
    tenex_base_dir: &Path,
    config: &BackendConfigSnapshot,
    signer: &HexBackendSigner,
    backend_pubkey: &str,
    project_descriptors: &[ProjectStatusDescriptor],
    now_ms: u64,
    writer_version: &str,
) -> Result<(), InterventionFireError> {
    let due = list_due_wakeups(daemon_dir, now_ms)?;
    for record in due {
        if record.status != WakeupStatus::Pending {
            continue;
        }
        let WakeupTarget::InterventionReview {
            project_d_tag,
            conversation_id,
            completing_agent_pubkey,
            user_pubkey,
            intervention_agent_slug,
        } = &record.target
        else {
            continue;
        };

        match process_due_review(
            daemon_dir,
            tenex_base_dir,
            config,
            signer,
            backend_pubkey,
            project_descriptors,
            &record.wakeup_id,
            project_d_tag,
            conversation_id,
            completing_agent_pubkey,
            user_pubkey,
            intervention_agent_slug,
            record.scheduled_for,
            now_ms,
            writer_version,
        ) {
            Ok(ProcessOutcome::Published) => {
                mark_wakeup_fired(
                    daemon_dir,
                    &record.wakeup_id,
                    now_ms,
                    INTERVENTION_WAKEUP_FIRED_OUTCOME_PUBLISHED,
                )?;
                info!(
                    project = %project_d_tag,
                    conversation = %conversation_id,
                    "intervention review published",
                );
            }
            Ok(ProcessOutcome::Skipped(reason)) => {
                mark_wakeup_fired(
                    daemon_dir,
                    &record.wakeup_id,
                    now_ms,
                    format!("{}:{reason:?}", INTERVENTION_WAKEUP_FIRED_OUTCOME_SKIPPED),
                )?;
                debug!(
                    project = %project_d_tag,
                    conversation = %conversation_id,
                    reason = ?reason,
                    "intervention review skipped at fire",
                );
            }
            Err(error) => {
                warn!(
                    project = %project_d_tag,
                    conversation = %conversation_id,
                    error = %error,
                    "intervention review failed",
                );
                mark_wakeup_failed(
                    daemon_dir,
                    &record.wakeup_id,
                    now_ms,
                    WakeupFailureClassification::Retryable,
                    Some(error.to_string()),
                    None,
                    WakeupRetryPolicy::default(),
                )?;
            }
        }
    }
    Ok(())
}

enum ProcessOutcome {
    Published,
    Skipped(FireSkipReason),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FireSkipReason {
    UserReplied,
    Ineligible(Eligibility),
    ProjectMissing,
    AgentUnresolved,
}

#[allow(clippy::too_many_arguments)]
fn process_due_review(
    daemon_dir: &Path,
    tenex_base_dir: &Path,
    config: &BackendConfigSnapshot,
    signer: &HexBackendSigner,
    backend_pubkey: &str,
    project_descriptors: &[ProjectStatusDescriptor],
    wakeup_id: &str,
    project_d_tag: &str,
    conversation_id: &str,
    completing_agent_pubkey: &str,
    user_pubkey: &str,
    intervention_agent_slug: &str,
    scheduled_for_ms: u64,
    now_ms: u64,
    writer_version: &str,
) -> Result<ProcessOutcome, InterventionFireError> {
    let _ = wakeup_id;
    let Some(descriptor) = project_descriptors
        .iter()
        .find(|d| d.project_d_tag == project_d_tag)
    else {
        return Ok(ProcessOutcome::Skipped(FireSkipReason::ProjectMissing));
    };
    let Some(project_base_path) = descriptor.project_base_path.as_deref() else {
        return Ok(ProcessOutcome::Skipped(FireSkipReason::ProjectMissing));
    };
    let project_base = Path::new(project_base_path);

    if user_replied_after(project_base, conversation_id, user_pubkey, scheduled_for_ms)? {
        return Ok(ProcessOutcome::Skipped(FireSkipReason::UserReplied));
    }

    let agents_dir = tenex_base_dir.join("agents");
    let intervention_agent_pubkey =
        resolve_agent_slug_in_project(&agents_dir, project_d_tag, intervention_agent_slug)?;
    let Some(intervention_agent_pubkey) = intervention_agent_pubkey else {
        return Ok(ProcessOutcome::Skipped(FireSkipReason::AgentUnresolved));
    };

    let project_agent_pubkeys: BTreeSet<String> =
        read_project_agent_pubkeys_for(&agents_dir, project_d_tag)?;
    let root_event_author = root_event::read_root_event_author(project_base, conversation_id)
        .map_err(InterventionFireError::from_root_event)?;
    let notified_recently = is_notified_recently(
        daemon_dir,
        project_d_tag,
        conversation_id,
        now_ms,
        INTERVENTION_NOTIFIED_TTL_MS,
    )?;
    let eligibility = evaluate_eligibility(EligibilityInputs {
        config: &config.intervention,
        project_d_tag,
        conversation_id,
        completing_agent_pubkey,
        target_user_pubkey: user_pubkey,
        intervention_agent_pubkey: Some(&intervention_agent_pubkey),
        root_event_author_pubkey: root_event_author.as_deref(),
        project_agent_pubkeys: &project_agent_pubkeys,
        backend_pubkey,
        whitelisted_pubkeys: &config.whitelisted_pubkeys,
        ral_has_active_delegations: false,
        notified_recently,
    });
    if eligibility != Eligibility::Arm {
        return Ok(ProcessOutcome::Skipped(FireSkipReason::Ineligible(
            eligibility,
        )));
    }

    let request_sequence = now_ms;
    let request_inputs = ReviewRequestInputs {
        project_d_tag,
        project_owner_pubkey: &descriptor.project_owner_pubkey,
        project_manager_pubkey: descriptor.project_manager_pubkey.as_deref(),
        conversation_id,
        completing_agent_pubkey,
        user_pubkey,
        intervention_agent_pubkey: &intervention_agent_pubkey,
        created_at: now_ms / 1_000,
    };
    enqueue_review(
        daemon_dir,
        &request_inputs,
        signer,
        now_ms,
        request_sequence,
        writer_version,
    )?;

    append_notified(
        daemon_dir,
        &InterventionNotifiedEntry {
            project_d_tag: project_d_tag.to_string(),
            conversation_id: conversation_id.to_string(),
            notified_at_ms: now_ms,
        },
    )?;

    Ok(ProcessOutcome::Published)
}

impl InterventionFireError {
    fn from_root_event(source: RootEventLookupError) -> Self {
        Self::RootEvent(source)
    }
}
