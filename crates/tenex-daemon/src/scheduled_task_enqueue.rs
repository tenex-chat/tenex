use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::backend_events::project_status::ProjectStatusScheduledTaskKind;
use crate::dispatch_queue::{
    DispatchQueueError, DispatchQueueRecord, DispatchQueueRecordParams, DispatchQueueState,
    DispatchQueueStatus, DispatchRalIdentity, append_dispatch_queue_record,
    build_dispatch_queue_record, replay_dispatch_queue,
};
use crate::project_status_agent_sources::{
    ProjectStatusAgentSourceError, read_project_status_agent_sources,
};
use crate::project_status_descriptors::ProjectStatusDescriptor;
use crate::ral_journal::{
    RalJournalError, RalJournalIdentity, RalReplayEntry, RalReplayStatus, append_ral_journal_record,
};
use crate::ral_scheduler::{
    RalDispatchPreparation, RalDispatchPreparationInput, RalNamespace, RalScheduler,
    RalSchedulerError,
};
use crate::scheduled_task_dispatch_input::{
    ScheduledTaskDispatchInput, ScheduledTaskDispatchInputError,
    ScheduledTaskDispatchInputWriteMetadata, ScheduledTaskDispatchTaskDiagnosticMetadata,
    ScheduledTaskDispatchTaskKind, scheduled_task_dispatch_input_path,
    write_create_or_compare_equal_with_metadata,
};
use crate::scheduled_task_due_planner::ScheduledTaskTriggerPlan;
use crate::worker_protocol::AgentWorkerExecutionFlags;

const SCHEDULED_TASK_TRIGGER_DIGEST_DOMAIN: &[u8] = b"tenex-scheduled-task-trigger-v1";
const SCHEDULED_TASK_WORKER_ID_PREFIX: &str = "scheduled-task-worker";
const SCHEDULED_TASK_CLAIM_TOKEN_PREFIX: &str = "scheduled-task-claim";
const SCHEDULED_TASK_DISPATCH_ID_PREFIX: &str = "scheduled-task";

#[derive(Debug)]
pub struct ScheduledTaskEnqueueInput<'a> {
    pub daemon_dir: &'a Path,
    pub tenex_base_dir: &'a Path,
    pub project: &'a ProjectStatusDescriptor,
    pub plan: &'a ScheduledTaskTriggerPlan,
    pub timestamp: u64,
    pub writer_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTaskEnqueueOutcome {
    pub dispatch_id: String,
    pub triggering_event_id: String,
    pub worker_id: String,
    pub claim_token: String,
    pub project_d_tag: String,
    pub task_id: String,
    pub target_agent_pubkey: String,
    pub conversation_id: String,
    pub sidecar_path: PathBuf,
    pub queued: bool,
    pub already_existed: bool,
    pub recovered_existing_ral: bool,
    pub dispatch_record: DispatchQueueRecord,
}

#[derive(Debug, Error)]
pub enum ScheduledTaskEnqueueError {
    #[error(
        "scheduled task project mismatch: plan project {plan_project_d_tag:?}, descriptor project {descriptor_project_d_tag:?}"
    )]
    ProjectMismatch {
        plan_project_d_tag: String,
        descriptor_project_d_tag: String,
    },
    #[error("scheduled task project {project_d_tag} has no projectBasePath")]
    MissingProjectBasePath { project_d_tag: String },
    #[error("scheduled task target agent {target_agent:?} not found in project {project_d_tag}")]
    TargetAgentNotFound {
        project_d_tag: String,
        target_agent: String,
    },
    #[error("scheduled task sequence exhausted: {0}")]
    SequenceExhausted(&'static str),
    #[error(
        "scheduled task trigger {triggering_event_id} already has non-claimable RAL status {status:?}"
    )]
    ExistingRalNotClaimed {
        triggering_event_id: String,
        status: RalReplayStatus,
    },
    #[error(
        "scheduled task trigger {triggering_event_id} already has a claimed RAL without a claim token"
    )]
    ExistingRalMissingClaimToken { triggering_event_id: String },
    #[error("scheduled task agent sources failed: {0}")]
    AgentSources(#[from] ProjectStatusAgentSourceError),
    #[error("scheduled task dispatch input failed: {0}")]
    DispatchInput(#[from] ScheduledTaskDispatchInputError),
    #[error("scheduled task RAL journal failed: {0}")]
    RalJournal(#[from] RalJournalError),
    #[error("scheduled task RAL scheduler failed: {0}")]
    RalScheduler(#[from] RalSchedulerError),
    #[error("scheduled task dispatch queue failed: {0}")]
    DispatchQueue(#[from] DispatchQueueError),
}

pub fn enqueue_scheduled_task_dispatch(
    input: ScheduledTaskEnqueueInput<'_>,
) -> Result<ScheduledTaskEnqueueOutcome, ScheduledTaskEnqueueError> {
    validate_project(input.project, input.plan)?;

    let project_base_path = input.project.project_base_path.as_deref().ok_or_else(|| {
        ScheduledTaskEnqueueError::MissingProjectBasePath {
            project_d_tag: input.project.project_d_tag.clone(),
        }
    })?;
    let target_agent_pubkey = resolve_target_agent_pubkey(
        input.tenex_base_dir,
        &input.project.project_d_tag,
        &input.plan.target_agent,
    )?;

    let ids = scheduled_task_dispatch_ids(input.plan, &target_agent_pubkey);
    let conversation_id = scheduled_task_conversation_id(input.plan, &ids.triggering_event_id);
    let metadata_path = input
        .tenex_base_dir
        .join("projects")
        .join(&input.project.project_d_tag);
    let triggering_envelope = build_scheduled_task_triggering_envelope(
        input.project,
        input.plan,
        &ids.triggering_event_id,
        &target_agent_pubkey,
        &conversation_id,
    );
    let execution_flags = AgentWorkerExecutionFlags {
        is_delegation_completion: false,
        has_pending_delegations: false,
        debug: false,
    };

    let sidecar_input = ScheduledTaskDispatchInput {
        dispatch_id: ids.dispatch_id.clone(),
        triggering_event_id: ids.triggering_event_id.clone(),
        worker_id: ids.worker_id.clone(),
        project_base_path: project_base_path.to_string(),
        metadata_path: metadata_path.to_string_lossy().to_string(),
        triggering_envelope,
        execution_flags,
        task_diagnostic_metadata: ScheduledTaskDispatchTaskDiagnosticMetadata {
            project_d_tag: input.plan.project_d_tag.clone(),
            project_ref: input.plan.project_ref.clone(),
            task_id: input.plan.task_id.clone(),
            title: input.plan.title.clone(),
            from_pubkey: input.plan.from_pubkey.clone(),
            target_agent: input.plan.target_agent.clone(),
            target_channel: input.plan.target_channel.clone(),
            schedule: input.plan.schedule.clone(),
            kind: scheduled_task_kind(input.plan.kind),
            due_at: input.plan.due_at,
            last_run: input.plan.last_run,
        },
    };
    write_create_or_compare_equal_with_metadata(
        input.daemon_dir,
        &sidecar_input,
        ScheduledTaskDispatchInputWriteMetadata {
            writer: "scheduled_task_enqueue".to_string(),
            writer_version: input.writer_version.clone(),
            timestamp: input.timestamp,
        },
    )?;

    let dispatch_state = replay_dispatch_queue(input.daemon_dir)?;
    if let Some(existing) = dispatch_state.latest_record(&ids.dispatch_id) {
        return Ok(ScheduledTaskEnqueueOutcome {
            dispatch_id: ids.dispatch_id,
            triggering_event_id: ids.triggering_event_id,
            worker_id: ids.worker_id,
            claim_token: existing.claim_token.clone(),
            project_d_tag: input.project.project_d_tag.clone(),
            task_id: input.plan.task_id.clone(),
            target_agent_pubkey,
            conversation_id,
            sidecar_path: scheduled_task_dispatch_input_path(
                input.daemon_dir,
                existing.dispatch_id.as_str(),
            ),
            queued: existing.status == DispatchQueueStatus::Queued,
            already_existed: true,
            recovered_existing_ral: false,
            dispatch_record: existing.clone(),
        });
    }

    let scheduler = RalScheduler::from_daemon_dir(input.daemon_dir)?;
    let namespace = RalNamespace::new(
        input.project.project_d_tag.clone(),
        target_agent_pubkey.clone(),
        conversation_id.clone(),
    );

    if let Some(identity) = scheduler.active_triggering_event(&namespace, &ids.triggering_event_id)
    {
        let dispatch_record = recover_dispatch_from_existing_ral(
            &dispatch_state,
            input.timestamp,
            &ids,
            scheduler
                .state()
                .entry(identity)
                .expect("active triggering event identity must have a replay entry"),
        )?;
        append_dispatch_queue_record(input.daemon_dir, &dispatch_record)?;
        return Ok(ScheduledTaskEnqueueOutcome {
            dispatch_id: ids.dispatch_id,
            triggering_event_id: ids.triggering_event_id,
            worker_id: ids.worker_id,
            claim_token: dispatch_record.claim_token.clone(),
            project_d_tag: input.project.project_d_tag.clone(),
            task_id: input.plan.task_id.clone(),
            target_agent_pubkey,
            conversation_id,
            sidecar_path: scheduled_task_dispatch_input_path(
                input.daemon_dir,
                dispatch_record.dispatch_id.as_str(),
            ),
            queued: true,
            already_existed: false,
            recovered_existing_ral: true,
            dispatch_record,
        });
    }

    let preparation = scheduler.plan_dispatch_preparation(RalDispatchPreparationInput {
        namespace,
        triggering_event_id: ids.triggering_event_id.clone(),
        worker_id: ids.worker_id.clone(),
        claim_token: ids.claim_token.clone(),
        journal_sequence: next_sequence(scheduler.state().last_sequence, "RAL journal")?,
        dispatch_sequence: next_sequence(dispatch_state.last_sequence, "dispatch queue")?,
        last_dispatch_sequence: dispatch_state.last_sequence,
        timestamp: input.timestamp,
        correlation_id: ids.correlation_id.clone(),
        dispatch_id: ids.dispatch_id.clone(),
        writer_version: input.writer_version,
    })?;
    append_dispatch_preparation(input.daemon_dir, &preparation)?;

    Ok(ScheduledTaskEnqueueOutcome {
        dispatch_id: ids.dispatch_id,
        triggering_event_id: ids.triggering_event_id,
        worker_id: ids.worker_id,
        claim_token: preparation.claim.claim_token.clone(),
        project_d_tag: input.project.project_d_tag.clone(),
        task_id: input.plan.task_id.clone(),
        target_agent_pubkey,
        conversation_id,
        sidecar_path: scheduled_task_dispatch_input_path(
            input.daemon_dir,
            preparation.dispatch_record.dispatch_id.as_str(),
        ),
        queued: true,
        already_existed: false,
        recovered_existing_ral: false,
        dispatch_record: preparation.dispatch_record,
    })
}

fn validate_project(
    project: &ProjectStatusDescriptor,
    plan: &ScheduledTaskTriggerPlan,
) -> Result<(), ScheduledTaskEnqueueError> {
    if project.project_d_tag == plan.project_d_tag {
        return Ok(());
    }
    Err(ScheduledTaskEnqueueError::ProjectMismatch {
        plan_project_d_tag: plan.project_d_tag.clone(),
        descriptor_project_d_tag: project.project_d_tag.clone(),
    })
}

fn resolve_target_agent_pubkey(
    tenex_base_dir: &Path,
    project_d_tag: &str,
    target_agent: &str,
) -> Result<String, ScheduledTaskEnqueueError> {
    let report = read_project_status_agent_sources(tenex_base_dir, project_d_tag)?;
    report
        .agents
        .into_iter()
        .find(|agent| agent.slug == target_agent)
        .map(|agent| agent.pubkey)
        .ok_or_else(|| ScheduledTaskEnqueueError::TargetAgentNotFound {
            project_d_tag: project_d_tag.to_string(),
            target_agent: target_agent.to_string(),
        })
}

fn recover_dispatch_from_existing_ral(
    dispatch_state: &DispatchQueueState,
    timestamp: u64,
    ids: &ScheduledTaskDispatchIds,
    entry: &RalReplayEntry,
) -> Result<DispatchQueueRecord, ScheduledTaskEnqueueError> {
    if entry.status != RalReplayStatus::Claimed {
        return Err(ScheduledTaskEnqueueError::ExistingRalNotClaimed {
            triggering_event_id: ids.triggering_event_id.clone(),
            status: entry.status,
        });
    }
    let claim_token = entry.active_claim_token.clone().ok_or_else(|| {
        ScheduledTaskEnqueueError::ExistingRalMissingClaimToken {
            triggering_event_id: ids.triggering_event_id.clone(),
        }
    })?;

    Ok(build_dispatch_queue_record(DispatchQueueRecordParams {
        sequence: next_sequence(dispatch_state.last_sequence, "dispatch queue")?,
        timestamp,
        correlation_id: ids.correlation_id.clone(),
        dispatch_id: ids.dispatch_id.clone(),
        ral: dispatch_ral_identity(&entry.identity),
        triggering_event_id: ids.triggering_event_id.clone(),
        claim_token,
        status: DispatchQueueStatus::Queued,
    }))
}

fn append_dispatch_preparation(
    daemon_dir: &Path,
    preparation: &RalDispatchPreparation,
) -> Result<(), ScheduledTaskEnqueueError> {
    append_ral_journal_record(daemon_dir, &preparation.allocation_record)?;
    append_ral_journal_record(daemon_dir, &preparation.claim_record)?;
    append_dispatch_queue_record(daemon_dir, &preparation.dispatch_record)?;
    Ok(())
}

fn dispatch_ral_identity(identity: &RalJournalIdentity) -> DispatchRalIdentity {
    DispatchRalIdentity {
        project_id: identity.project_id.clone(),
        agent_pubkey: identity.agent_pubkey.clone(),
        conversation_id: identity.conversation_id.clone(),
        ral_number: identity.ral_number,
    }
}

fn build_scheduled_task_triggering_envelope(
    project: &ProjectStatusDescriptor,
    plan: &ScheduledTaskTriggerPlan,
    triggering_event_id: &str,
    target_agent_pubkey: &str,
    conversation_id: &str,
) -> Value {
    let mut message = json!({
        "id": triggering_event_id,
        "transport": "nostr",
        "nativeId": triggering_event_id,
    });
    if let Some(target_channel) = plan.target_channel.as_deref()
        && let Some(object) = message.as_object_mut()
    {
        object.insert("replyToId".to_string(), json!(target_channel));
    }

    json!({
        "transport": "nostr",
        "principal": {
            "id": format!("nostr:{}", plan.from_pubkey),
            "transport": "nostr",
            "linkedPubkey": plan.from_pubkey,
            "kind": "agent",
        },
        "channel": {
            "id": format!("conversation:{conversation_id}"),
            "transport": "nostr",
            "kind": "conversation",
            "projectBinding": format!("project:{}:{}", project.project_owner_pubkey, project.project_d_tag),
        },
        "message": message,
        "recipients": [
            {
                "id": format!("nostr:{target_agent_pubkey}"),
                "transport": "nostr",
                "linkedPubkey": target_agent_pubkey,
                "kind": "agent",
            }
        ],
        "content": plan.prompt,
        "occurredAt": plan.due_at.saturating_mul(1_000),
        "capabilities": ["reply", "delegate"],
        "metadata": {
            "toolName": "schedule_task",
            "variantOverride": "scheduled_task",
            "scheduledTaskId": plan.task_id,
            "scheduledTaskTitle": plan.title,
            "scheduledTaskKind": scheduled_task_kind_name(plan.kind),
            "scheduledTaskSchedule": plan.schedule,
            "scheduledTaskDueAt": plan.due_at,
        },
    })
}

fn scheduled_task_conversation_id(
    plan: &ScheduledTaskTriggerPlan,
    triggering_event_id: &str,
) -> String {
    plan.target_channel
        .clone()
        .unwrap_or_else(|| triggering_event_id.to_string())
}

fn scheduled_task_kind(kind: ProjectStatusScheduledTaskKind) -> ScheduledTaskDispatchTaskKind {
    match kind {
        ProjectStatusScheduledTaskKind::Cron => ScheduledTaskDispatchTaskKind::Cron,
        ProjectStatusScheduledTaskKind::Oneoff => ScheduledTaskDispatchTaskKind::Oneoff,
    }
}

fn scheduled_task_kind_name(kind: ProjectStatusScheduledTaskKind) -> &'static str {
    match kind {
        ProjectStatusScheduledTaskKind::Cron => "cron",
        ProjectStatusScheduledTaskKind::Oneoff => "oneoff",
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ScheduledTaskDispatchIds {
    dispatch_id: String,
    triggering_event_id: String,
    worker_id: String,
    claim_token: String,
    correlation_id: String,
}

fn scheduled_task_dispatch_ids(
    plan: &ScheduledTaskTriggerPlan,
    target_agent_pubkey: &str,
) -> ScheduledTaskDispatchIds {
    let digest = scheduled_task_trigger_digest(plan, target_agent_pubkey);
    ScheduledTaskDispatchIds {
        dispatch_id: format!("{SCHEDULED_TASK_DISPATCH_ID_PREFIX}-{digest}"),
        triggering_event_id: digest.clone(),
        worker_id: format!("{SCHEDULED_TASK_WORKER_ID_PREFIX}-{digest}"),
        claim_token: format!("{SCHEDULED_TASK_CLAIM_TOKEN_PREFIX}-{digest}"),
        correlation_id: format!("scheduled-task:{digest}"),
    }
}

fn scheduled_task_trigger_digest(
    plan: &ScheduledTaskTriggerPlan,
    target_agent_pubkey: &str,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(SCHEDULED_TASK_TRIGGER_DIGEST_DOMAIN);
    hash_field(&mut hasher, &plan.project_d_tag);
    hash_field(&mut hasher, &plan.project_ref);
    hash_field(&mut hasher, &plan.task_id);
    hasher.update(plan.due_at.to_be_bytes());
    hash_field(&mut hasher, &plan.target_agent);
    hash_field(&mut hasher, target_agent_pubkey);
    hash_optional_field(&mut hasher, plan.target_channel.as_deref());
    hex::encode(hasher.finalize())
}

fn hash_field(hasher: &mut Sha256, value: &str) {
    hasher.update((value.len() as u64).to_be_bytes());
    hasher.update(value.as_bytes());
}

fn hash_optional_field(hasher: &mut Sha256, value: Option<&str>) {
    match value {
        Some(value) => {
            hasher.update([1]);
            hash_field(hasher, value);
        }
        None => hasher.update([0]),
    }
}

fn next_sequence(current: u64, label: &'static str) -> Result<u64, ScheduledTaskEnqueueError> {
    current
        .checked_add(1)
        .ok_or(ScheduledTaskEnqueueError::SequenceExhausted(label))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch_queue::replay_dispatch_queue;
    use crate::project_status_descriptors::ProjectStatusDescriptor;
    use crate::ral_journal::{RalJournalEvent, read_ral_journal_records};
    use crate::scheduled_task_dispatch_input::read_optional;
    use secp256k1::{Keypair, Secp256k1, SecretKey};
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn enqueues_scheduled_task_dispatch_with_sidecar_ral_and_queue_record() {
        let fixture = Fixture::new("scheduled-task-enqueue-basic");
        let plan = scheduled_task_plan(None);

        let outcome = enqueue_scheduled_task_dispatch(ScheduledTaskEnqueueInput {
            daemon_dir: &fixture.daemon_dir,
            tenex_base_dir: &fixture.tenex_base_dir,
            project: &fixture.project,
            plan: &plan,
            timestamp: 1_710_001_000_500,
            writer_version: "test-writer".to_string(),
        })
        .expect("scheduled task dispatch must enqueue");

        assert!(outcome.queued);
        assert!(!outcome.already_existed);
        assert_eq!(outcome.project_d_tag, "demo");
        assert_eq!(outcome.task_id, "task-a");
        assert_eq!(outcome.target_agent_pubkey, fixture.agent_pubkey);
        assert_eq!(outcome.conversation_id, outcome.triggering_event_id);
        assert_eq!(outcome.triggering_event_id.len(), 64);
        assert!(outcome.dispatch_id.starts_with("scheduled-task-"));

        let sidecar = read_optional(&fixture.daemon_dir, &outcome.dispatch_id)
            .expect("sidecar read must succeed")
            .expect("sidecar must exist");
        assert_eq!(sidecar.dispatch_id, outcome.dispatch_id);
        assert_eq!(sidecar.triggering_event_id, outcome.triggering_event_id);
        assert_eq!(sidecar.worker_id, outcome.worker_id);
        assert_eq!(sidecar.project_base_path, fixture.project_base_path);
        assert_eq!(
            sidecar.metadata_path,
            fixture
                .tenex_base_dir
                .join("projects")
                .join("demo")
                .to_string_lossy()
        );
        assert_eq!(
            sidecar.triggering_envelope["message"]["nativeId"],
            json!(outcome.triggering_event_id)
        );
        assert_eq!(
            sidecar.triggering_envelope["content"],
            json!("Run the report")
        );
        assert_eq!(
            sidecar.task_diagnostic_metadata.kind,
            ScheduledTaskDispatchTaskKind::Cron
        );

        let journal_records =
            read_ral_journal_records(&fixture.daemon_dir).expect("RAL journal must replay");
        assert_eq!(journal_records.len(), 2);
        assert!(matches!(
            journal_records[0].event,
            RalJournalEvent::Allocated { .. }
        ));
        assert!(matches!(
            journal_records[1].event,
            RalJournalEvent::Claimed { .. }
        ));

        let dispatch_state =
            replay_dispatch_queue(&fixture.daemon_dir).expect("dispatch queue must replay");
        assert_eq!(dispatch_state.queued, vec![outcome.dispatch_record.clone()]);
        assert_eq!(dispatch_state.last_sequence, 1);
        assert_eq!(outcome.dispatch_record.claim_token, outcome.claim_token);
        assert_eq!(
            outcome.dispatch_record.triggering_event_id,
            outcome.triggering_event_id
        );

        fixture.cleanup();
    }

    #[test]
    fn enqueue_is_idempotent_when_dispatch_already_exists() {
        let fixture = Fixture::new("scheduled-task-enqueue-idempotent");
        let plan = scheduled_task_plan(None);
        let first = enqueue_scheduled_task_dispatch(ScheduledTaskEnqueueInput {
            daemon_dir: &fixture.daemon_dir,
            tenex_base_dir: &fixture.tenex_base_dir,
            project: &fixture.project,
            plan: &plan,
            timestamp: 1_710_001_000_500,
            writer_version: "test-writer".to_string(),
        })
        .expect("first enqueue must succeed");

        let second = enqueue_scheduled_task_dispatch(ScheduledTaskEnqueueInput {
            daemon_dir: &fixture.daemon_dir,
            tenex_base_dir: &fixture.tenex_base_dir,
            project: &fixture.project,
            plan: &plan,
            timestamp: 1_710_001_000_900,
            writer_version: "test-writer".to_string(),
        })
        .expect("second enqueue must be idempotent");

        assert!(second.already_existed);
        assert!(!second.recovered_existing_ral);
        assert_eq!(second.dispatch_id, first.dispatch_id);
        assert_eq!(second.dispatch_record, first.dispatch_record);
        assert_eq!(
            read_ral_journal_records(&fixture.daemon_dir)
                .expect("journal read")
                .len(),
            2
        );
        assert_eq!(
            replay_dispatch_queue(&fixture.daemon_dir)
                .expect("queue replay")
                .queued
                .len(),
            1
        );

        fixture.cleanup();
    }

    #[test]
    fn target_channel_sets_conversation_and_reply_parent() {
        let fixture = Fixture::new("scheduled-task-enqueue-target-channel");
        let plan = scheduled_task_plan(Some("conversation-root"));

        let outcome = enqueue_scheduled_task_dispatch(ScheduledTaskEnqueueInput {
            daemon_dir: &fixture.daemon_dir,
            tenex_base_dir: &fixture.tenex_base_dir,
            project: &fixture.project,
            plan: &plan,
            timestamp: 1_710_001_000_500,
            writer_version: "test-writer".to_string(),
        })
        .expect("scheduled task dispatch must enqueue");

        let sidecar = read_optional(&fixture.daemon_dir, &outcome.dispatch_id)
            .expect("sidecar read")
            .expect("sidecar exists");
        assert_eq!(outcome.conversation_id, "conversation-root");
        assert_eq!(
            sidecar.triggering_envelope["message"]["replyToId"],
            json!("conversation-root")
        );
        assert_eq!(
            outcome.dispatch_record.ral.conversation_id,
            "conversation-root"
        );

        fixture.cleanup();
    }

    #[test]
    fn missing_target_agent_fails_before_writing_side_effects() {
        let fixture = Fixture::new("scheduled-task-enqueue-missing-agent");
        let mut plan = scheduled_task_plan(None);
        plan.target_agent = "unknown".to_string();

        let error = enqueue_scheduled_task_dispatch(ScheduledTaskEnqueueInput {
            daemon_dir: &fixture.daemon_dir,
            tenex_base_dir: &fixture.tenex_base_dir,
            project: &fixture.project,
            plan: &plan,
            timestamp: 1_710_001_000_500,
            writer_version: "test-writer".to_string(),
        })
        .expect_err("missing target agent must fail");

        assert!(matches!(
            error,
            ScheduledTaskEnqueueError::TargetAgentNotFound { .. }
        ));
        assert!(
            read_ral_journal_records(&fixture.daemon_dir)
                .expect("journal read")
                .is_empty()
        );
        assert!(
            replay_dispatch_queue(&fixture.daemon_dir)
                .expect("queue replay")
                .queued
                .is_empty()
        );

        fixture.cleanup();
    }

    struct Fixture {
        root: PathBuf,
        daemon_dir: PathBuf,
        tenex_base_dir: PathBuf,
        project_base_path: String,
        project: ProjectStatusDescriptor,
        agent_pubkey: String,
    }

    impl Fixture {
        fn new(name: &str) -> Self {
            let root = unique_temp_dir(name);
            let daemon_dir = root.join("daemon");
            let tenex_base_dir = root.join("tenex");
            let project_base_path = root.join("repo").to_string_lossy().to_string();
            let owner_pubkey = pubkey_hex(0x02);
            let agent_pubkey = pubkey_hex(0x03);
            let project = ProjectStatusDescriptor {
                project_owner_pubkey: owner_pubkey,
                project_d_tag: "demo".to_string(),
                project_manager_pubkey: Some(agent_pubkey.clone()),
                project_base_path: Some(project_base_path.clone()),
                worktrees: Vec::new(),
            };

            fs::create_dir_all(tenex_base_dir.join("projects").join("demo"))
                .expect("project metadata dir must create");
            fs::create_dir_all(tenex_base_dir.join("agents")).expect("agents dir must create");
            fs::write(
                tenex_base_dir.join("agents").join("index.json"),
                format!(r#"{{"byProject":{{"demo":["{agent_pubkey}"]}}}}"#),
            )
            .expect("agent index must write");
            fs::write(
                tenex_base_dir
                    .join("agents")
                    .join(format!("{agent_pubkey}.json")),
                r#"{"slug":"worker","status":"active","default":{"model":"claude"}}"#,
            )
            .expect("agent file must write");

            Self {
                root,
                daemon_dir,
                tenex_base_dir,
                project_base_path,
                project,
                agent_pubkey,
            }
        }

        fn cleanup(self) {
            fs::remove_dir_all(self.root).expect("temp root cleanup must succeed");
        }
    }

    fn scheduled_task_plan(target_channel: Option<&str>) -> ScheduledTaskTriggerPlan {
        ScheduledTaskTriggerPlan {
            project_d_tag: "demo".to_string(),
            project_ref: "demo-ref".to_string(),
            task_id: "task-a".to_string(),
            title: "Daily report".to_string(),
            prompt: "Run the report".to_string(),
            from_pubkey: pubkey_hex(0x04),
            target_agent: "worker".to_string(),
            target_channel: target_channel.map(str::to_string),
            schedule: "0 9 * * *".to_string(),
            kind: ProjectStatusScheduledTaskKind::Cron,
            due_at: 1_710_001_000,
            last_run: Some(1_710_000_000),
        }
    }

    fn unique_temp_dir(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after Unix epoch")
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("tenex-{name}-{unique}-{counter}"));
        fs::create_dir_all(&path).expect("temp dir must create");
        path
    }

    fn pubkey_hex(seed: u8) -> String {
        let secp = Secp256k1::new();
        let secret = SecretKey::from_byte_array([seed; 32]).expect("test secret key must be valid");
        let keypair = Keypair::from_secret_key(&secp, &secret);
        let (x_only, _) = keypair.x_only_public_key();
        x_only.to_string()
    }
}
