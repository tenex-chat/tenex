pub mod eligibility;
pub mod notified_log;
pub mod publish;
pub mod root_event;
pub mod state;
pub mod wakeup;

use std::collections::BTreeSet;
use std::path::Path;

use serde::Serialize;
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
use root_event::{RootEventLookupError, read_root_event_author, user_replied_after};
use state::{
    InterventionState, InterventionStateError, read_intervention_state, write_intervention_state,
};
use wakeup::{InterventionArmInputs, InterventionWakeupError, arm_review};

pub const INTERVENTION_WAKEUP_FIRED_OUTCOME_PUBLISHED: &str = "intervention_published";
pub const INTERVENTION_WAKEUP_FIRED_OUTCOME_SKIPPED: &str = "intervention_skipped";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InterventionMaintenanceInput<'a> {
    pub tenex_base_dir: &'a Path,
    pub daemon_dir: &'a Path,
    pub now_ms: u64,
    pub project_descriptors: &'a [ProjectStatusDescriptor],
    pub writer_version: &'a str,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InterventionMaintenanceOutcome {
    pub armed: usize,
    pub skipped_ineligible: usize,
    pub fired_published: usize,
    pub fired_skipped: usize,
    pub fired_failed: usize,
    pub last_processed_ral_sequence: u64,
}

#[derive(Debug, Error)]
pub enum InterventionMaintenanceError {
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

pub type InterventionMaintenanceResult<T> = Result<T, InterventionMaintenanceError>;

pub fn run_intervention_maintenance(
    input: InterventionMaintenanceInput<'_>,
) -> InterventionMaintenanceResult<InterventionMaintenanceOutcome> {
    let config = read_backend_config(input.tenex_base_dir)?;
    let previous_state = read_intervention_state(input.daemon_dir)?;
    let mut outcome = InterventionMaintenanceOutcome {
        last_processed_ral_sequence: previous_state.last_processed_ral_sequence,
        ..Default::default()
    };

    if !config.intervention.is_active() {
        return Ok(outcome);
    }

    let signer = config.backend_signer()?;
    let backend_pubkey = signer.pubkey_hex().to_string();

    let new_last_sequence = arm_new_completions(
        &input,
        &config,
        &backend_pubkey,
        previous_state.last_processed_ral_sequence,
        &mut outcome,
    )?;
    outcome.last_processed_ral_sequence = new_last_sequence;
    write_intervention_state(
        input.daemon_dir,
        &InterventionState {
            schema_version: previous_state.schema_version,
            last_processed_ral_sequence: new_last_sequence,
        },
    )?;

    fire_due_reviews(&input, &config, &signer, &backend_pubkey, &mut outcome)?;

    compact_if_needed(input.daemon_dir, input.now_ms, INTERVENTION_NOTIFIED_TTL_MS)?;

    Ok(outcome)
}

fn arm_new_completions(
    input: &InterventionMaintenanceInput<'_>,
    config: &BackendConfigSnapshot,
    backend_pubkey: &str,
    last_processed_sequence: u64,
    outcome: &mut InterventionMaintenanceOutcome,
) -> InterventionMaintenanceResult<u64> {
    let records = read_ral_journal_records(input.daemon_dir)?;
    let mut new_last = last_processed_sequence;
    for record in &records {
        if record.sequence <= last_processed_sequence {
            continue;
        }
        if record.sequence > new_last {
            new_last = record.sequence;
        }
        if let RalJournalEvent::Completed { .. } = record.event {
            match try_arm_completion(input, config, backend_pubkey, record) {
                Ok(ArmOutcome::Armed) => outcome.armed += 1,
                Ok(ArmOutcome::Skipped(reason)) => {
                    outcome.skipped_ineligible += 1;
                    debug!(
                        project = %record.event.identity().project_id,
                        conversation = %record.event.identity().conversation_id,
                        reason = ?reason,
                        "intervention arm skipped",
                    );
                }
                Err(error) => {
                    warn!(
                        project = %record.event.identity().project_id,
                        conversation = %record.event.identity().conversation_id,
                        error = %error,
                        "intervention arm failed",
                    );
                }
            }
        }
    }
    Ok(new_last)
}

enum ArmOutcome {
    Armed,
    Skipped(Eligibility),
}

fn try_arm_completion(
    input: &InterventionMaintenanceInput<'_>,
    config: &BackendConfigSnapshot,
    backend_pubkey: &str,
    record: &RalJournalRecord,
) -> InterventionMaintenanceResult<ArmOutcome> {
    let (identity, terminal) = match &record.event {
        RalJournalEvent::Completed {
            identity, terminal, ..
        } => (identity, terminal),
        _ => unreachable!("try_arm_completion only called for Completed events"),
    };

    if !terminal.published_user_visible_event {
        return Ok(ArmOutcome::Skipped(Eligibility::SkipNotTopLevel));
    }
    if terminal.pending_delegations_remain {
        return Ok(ArmOutcome::Skipped(Eligibility::SkipActiveDelegations));
    }

    let Some(descriptor) = input
        .project_descriptors
        .iter()
        .find(|d| d.project_d_tag == identity.project_id)
    else {
        return Ok(ArmOutcome::Skipped(Eligibility::SkipNotTopLevel));
    };
    let Some(project_base_path) = descriptor.project_base_path.as_deref() else {
        return Ok(ArmOutcome::Skipped(Eligibility::SkipNotTopLevel));
    };
    let project_base = Path::new(project_base_path);

    let agents_dir = input.tenex_base_dir.join("agents");
    let project_agent_pubkeys: BTreeSet<String> =
        read_project_agent_pubkeys_for(&agents_dir, &identity.project_id)?;

    let slug = config
        .intervention
        .agent_slug
        .as_deref()
        .expect("agent slug present when intervention is active");
    let intervention_agent_pubkey =
        resolve_agent_slug_in_project(&agents_dir, &identity.project_id, slug)?;

    let root_event_author = read_root_event_author(project_base, &identity.conversation_id)?;
    let target_user_pubkey = root_event_author.clone();

    let notified_recently = is_notified_recently(
        input.daemon_dir,
        &identity.project_id,
        &identity.conversation_id,
        input.now_ms,
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
        return Ok(ArmOutcome::Skipped(eligibility));
    }

    let user_pubkey = root_event_author.expect("root author is Some when eligibility returns Arm");
    let timeout_ms = u64::from(config.intervention.timeout_seconds).saturating_mul(1_000);
    let scheduled_for_ms = record
        .timestamp
        .saturating_add(timeout_ms)
        .max(input.now_ms);

    arm_review(
        input.daemon_dir,
        InterventionArmInputs {
            project_d_tag: &identity.project_id,
            conversation_id: &identity.conversation_id,
            completing_agent_pubkey: &identity.agent_pubkey,
            user_pubkey: &user_pubkey,
            intervention_agent_slug: slug,
            scheduled_for_ms,
            writer_version: input.writer_version,
        },
        input.now_ms,
    )?;

    Ok(ArmOutcome::Armed)
}

fn fire_due_reviews(
    input: &InterventionMaintenanceInput<'_>,
    config: &BackendConfigSnapshot,
    signer: &HexBackendSigner,
    backend_pubkey: &str,
    outcome: &mut InterventionMaintenanceOutcome,
) -> InterventionMaintenanceResult<()> {
    let due = list_due_wakeups(input.daemon_dir, input.now_ms)?;
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
            input,
            config,
            signer,
            backend_pubkey,
            &record.wakeup_id,
            project_d_tag,
            conversation_id,
            completing_agent_pubkey,
            user_pubkey,
            intervention_agent_slug,
            record.scheduled_for,
        ) {
            Ok(ProcessOutcome::Published) => {
                mark_wakeup_fired(
                    input.daemon_dir,
                    &record.wakeup_id,
                    input.now_ms,
                    INTERVENTION_WAKEUP_FIRED_OUTCOME_PUBLISHED,
                )?;
                outcome.fired_published += 1;
                info!(
                    project = %project_d_tag,
                    conversation = %conversation_id,
                    "intervention review published",
                );
            }
            Ok(ProcessOutcome::Skipped(reason)) => {
                mark_wakeup_fired(
                    input.daemon_dir,
                    &record.wakeup_id,
                    input.now_ms,
                    format!("{}:{reason:?}", INTERVENTION_WAKEUP_FIRED_OUTCOME_SKIPPED),
                )?;
                outcome.fired_skipped += 1;
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
                    input.daemon_dir,
                    &record.wakeup_id,
                    input.now_ms,
                    WakeupFailureClassification::Retryable,
                    Some(error.to_string()),
                    None,
                    WakeupRetryPolicy::default(),
                )?;
                outcome.fired_failed += 1;
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
    input: &InterventionMaintenanceInput<'_>,
    config: &BackendConfigSnapshot,
    signer: &HexBackendSigner,
    backend_pubkey: &str,
    wakeup_id: &str,
    project_d_tag: &str,
    conversation_id: &str,
    completing_agent_pubkey: &str,
    user_pubkey: &str,
    intervention_agent_slug: &str,
    scheduled_for_ms: u64,
) -> InterventionMaintenanceResult<ProcessOutcome> {
    let _ = wakeup_id;
    let Some(descriptor) = input
        .project_descriptors
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

    let agents_dir = input.tenex_base_dir.join("agents");
    let intervention_agent_pubkey =
        resolve_agent_slug_in_project(&agents_dir, project_d_tag, intervention_agent_slug)?;
    let Some(intervention_agent_pubkey) = intervention_agent_pubkey else {
        return Ok(ProcessOutcome::Skipped(FireSkipReason::AgentUnresolved));
    };

    let project_agent_pubkeys: BTreeSet<String> =
        read_project_agent_pubkeys_for(&agents_dir, project_d_tag)?;
    let root_event_author = read_root_event_author(project_base, conversation_id)?;
    let notified_recently = is_notified_recently(
        input.daemon_dir,
        project_d_tag,
        conversation_id,
        input.now_ms,
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

    let request_sequence = input.now_ms;
    let request_inputs = ReviewRequestInputs {
        project_d_tag,
        project_owner_pubkey: &descriptor.project_owner_pubkey,
        project_manager_pubkey: descriptor.project_manager_pubkey.as_deref(),
        conversation_id,
        completing_agent_pubkey,
        user_pubkey,
        intervention_agent_pubkey: &intervention_agent_pubkey,
        created_at: input.now_ms / 1_000,
    };
    enqueue_review(
        input.daemon_dir,
        &request_inputs,
        signer,
        input.now_ms,
        request_sequence,
        input.writer_version,
    )?;

    append_notified(
        input.daemon_dir,
        &InterventionNotifiedEntry {
            project_d_tag: project_d_tag.to_string(),
            conversation_id: conversation_id.to_string(),
            notified_at_ms: input.now_ms,
        },
    )?;

    Ok(ProcessOutcome::Published)
}
