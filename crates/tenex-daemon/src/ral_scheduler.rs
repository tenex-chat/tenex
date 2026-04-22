use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::ral_journal::{
    RAL_JOURNAL_WRITER_RUST_DAEMON, RalJournalEvent, RalJournalIdentity, RalJournalRecord,
    RalJournalReplay, RalJournalResult, RalJournalSnapshot, RalPendingDelegation, RalReplayEntry,
    RalReplayStatus, RalTerminalSummary, RalWorkerError, replay_ral_journal, write_ral_snapshot,
};

static CLAIM_TOKEN_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct RalNamespace {
    pub project_id: String,
    pub agent_pubkey: String,
    pub conversation_id: String,
}

impl RalNamespace {
    pub fn new(
        project_id: impl Into<String>,
        agent_pubkey: impl Into<String>,
        conversation_id: impl Into<String>,
    ) -> Self {
        Self {
            project_id: project_id.into(),
            agent_pubkey: agent_pubkey.into(),
            conversation_id: conversation_id.into(),
        }
    }

    pub fn identity(&self, ral_number: u64) -> RalJournalIdentity {
        RalJournalIdentity {
            project_id: self.project_id.clone(),
            agent_pubkey: self.agent_pubkey.clone(),
            conversation_id: self.conversation_id.clone(),
            ral_number,
        }
    }
}

impl From<&RalJournalIdentity> for RalNamespace {
    fn from(identity: &RalJournalIdentity) -> Self {
        Self::new(
            identity.project_id.clone(),
            identity.agent_pubkey.clone(),
            identity.conversation_id.clone(),
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RalStatusClass {
    Active,
    Terminal,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RalNamespaceState {
    pub next_ral_number: u64,
    pub ral_number_exhausted: bool,
    pub active_ral_count: usize,
    pub terminal_ral_count: usize,
    pub active_triggering_events: HashMap<String, RalJournalIdentity>,
}

impl Default for RalNamespaceState {
    fn default() -> Self {
        Self {
            next_ral_number: 1,
            ral_number_exhausted: false,
            active_ral_count: 0,
            terminal_ral_count: 0,
            active_triggering_events: HashMap::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RalSchedulerState {
    pub last_sequence: u64,
    pub namespaces: HashMap<RalNamespace, RalNamespaceState>,
    pub entries: HashMap<RalJournalIdentity, RalReplayEntry>,
}

impl RalSchedulerState {
    pub fn from_replay(replay: &RalJournalReplay) -> Self {
        let mut namespaces = HashMap::<RalNamespace, RalNamespaceState>::new();

        for entry in replay.states.values() {
            let identity = &entry.identity;
            let namespace = RalNamespace::from(identity);
            let namespace_state = namespaces.entry(namespace).or_default();

            if identity.ral_number == u64::MAX {
                namespace_state.ral_number_exhausted = true;
            } else {
                namespace_state.next_ral_number =
                    namespace_state.next_ral_number.max(identity.ral_number + 1);
            }

            match classify_ral_status(entry.status) {
                RalStatusClass::Active => {
                    namespace_state.active_ral_count += 1;
                    if let Some(triggering_event_id) = &entry.triggering_event_id {
                        namespace_state
                            .active_triggering_events
                            .entry(triggering_event_id.clone())
                            .or_insert_with(|| identity.clone());
                    }
                }
                RalStatusClass::Terminal => {
                    namespace_state.terminal_ral_count += 1;
                }
            }
        }

        Self {
            last_sequence: replay.last_sequence,
            namespaces,
            entries: replay.states.clone(),
        }
    }

    pub fn namespace(&self, namespace: &RalNamespace) -> Option<&RalNamespaceState> {
        self.namespaces.get(namespace)
    }

    pub fn next_ral_number(&self, namespace: &RalNamespace) -> u64 {
        self.namespace(namespace)
            .map(|state| state.next_ral_number)
            .unwrap_or(1)
    }

    pub fn entry(&self, identity: &RalJournalIdentity) -> Option<&RalReplayEntry> {
        self.entries.get(identity)
    }

    pub fn active_triggering_event(
        &self,
        namespace: &RalNamespace,
        triggering_event_id: &str,
    ) -> Option<&RalJournalIdentity> {
        self.namespace(namespace)
            .and_then(|state| state.active_triggering_events.get(triggering_event_id))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RalScheduler {
    state: RalSchedulerState,
}

impl RalScheduler {
    pub fn from_daemon_dir(daemon_dir: impl AsRef<Path>) -> RalJournalResult<Self> {
        let replay = replay_ral_journal(daemon_dir)?;
        Ok(Self::from_replay(&replay))
    }

    pub fn new(replay: &RalJournalReplay) -> Self {
        Self::from_replay(replay)
    }

    pub fn from_replay(replay: &RalJournalReplay) -> Self {
        Self {
            state: RalSchedulerState::from_replay(replay),
        }
    }

    pub fn state(&self) -> &RalSchedulerState {
        &self.state
    }

    pub fn to_snapshot(
        &self,
        writer_version: impl Into<String>,
        created_at: u64,
    ) -> RalJournalSnapshot {
        RalJournalSnapshot::from_replay(
            RAL_JOURNAL_WRITER_RUST_DAEMON,
            writer_version,
            created_at,
            &RalJournalReplay {
                last_sequence: self.state.last_sequence,
                states: self.state.entries.clone(),
            },
        )
    }

    pub fn persist_snapshot(
        &self,
        daemon_dir: impl AsRef<Path>,
        writer_version: impl Into<String>,
        created_at: u64,
    ) -> RalJournalResult<()> {
        let snapshot = self.to_snapshot(writer_version, created_at);
        write_ral_snapshot(daemon_dir, &snapshot)
    }

    pub fn next_ral_number(&self, namespace: &RalNamespace) -> u64 {
        self.state.next_ral_number(namespace)
    }

    pub fn entry(&self, identity: &RalJournalIdentity) -> Option<&RalReplayEntry> {
        self.state.entry(identity)
    }

    pub fn active_triggering_event(
        &self,
        namespace: &RalNamespace,
        triggering_event_id: &str,
    ) -> Option<&RalJournalIdentity> {
        self.state
            .active_triggering_event(namespace, triggering_event_id)
    }

    pub fn allocate(
        &self,
        namespace: RalNamespace,
        triggering_event_id: Option<String>,
    ) -> Result<RalAllocation, RalSchedulerError> {
        if let Some(triggering_event_id) = &triggering_event_id
            && let Some(existing_identity) = self
                .state
                .active_triggering_event(&namespace, triggering_event_id)
        {
            return Err(RalSchedulerError::DuplicateActiveTriggeringEvent {
                namespace: Box::new(namespace),
                triggering_event_id: triggering_event_id.clone(),
                existing_identity: Box::new(existing_identity.clone()),
            });
        }

        if self
            .state
            .namespace(&namespace)
            .map(|state| state.ral_number_exhausted)
            .unwrap_or(false)
        {
            return Err(RalSchedulerError::RalNumberExhausted {
                namespace: Box::new(namespace),
            });
        }

        let ral_number = self.next_ral_number(&namespace);
        let identity = namespace.identity(ral_number);
        let event = RalJournalEvent::Allocated {
            identity: identity.clone(),
            triggering_event_id: triggering_event_id.clone(),
        };

        Ok(RalAllocation {
            identity,
            triggering_event_id,
            event,
        })
    }

    pub fn claim(
        &self,
        identity: &RalJournalIdentity,
        worker_id: impl Into<String>,
        claim_token: Option<String>,
    ) -> Result<RalClaim, RalSchedulerError> {
        let entry = self.entry_or_error(identity)?;
        if is_terminal_ral_status(entry.status) {
            return Err(RalSchedulerError::TerminalRal {
                identity: Box::new(identity.clone()),
                status: entry.status,
            });
        }

        if let Some(active_claim_token) = &entry.active_claim_token {
            return Err(RalSchedulerError::AlreadyClaimed {
                identity: Box::new(identity.clone()),
                active_claim_token: active_claim_token.clone(),
            });
        }

        if !is_claimable_ral_status(entry.status) {
            return Err(RalSchedulerError::NotClaimable {
                identity: Box::new(identity.clone()),
                status: entry.status,
            });
        }

        let worker_id = worker_id.into();
        let claim_token = match claim_token {
            Some(claim_token) if claim_token.is_empty() => {
                return Err(RalSchedulerError::EmptyClaimToken {
                    identity: Box::new(identity.clone()),
                });
            }
            Some(claim_token) => claim_token,
            None => self.mint_claim_token(identity, &worker_id),
        };

        let event = RalJournalEvent::Claimed {
            identity: identity.clone(),
            worker_id: worker_id.clone(),
            claim_token: claim_token.clone(),
        };

        Ok(RalClaim {
            identity: identity.clone(),
            worker_id,
            claim_token,
            event,
        })
    }

    pub fn validate_claim_token(
        &self,
        identity: &RalJournalIdentity,
        claim_token: &str,
    ) -> Result<&RalReplayEntry, RalSchedulerError> {
        if claim_token.is_empty() {
            return Err(RalSchedulerError::EmptyClaimToken {
                identity: Box::new(identity.clone()),
            });
        }

        let entry = self.entry_or_error(identity)?;
        if is_terminal_ral_status(entry.status) {
            return Err(RalSchedulerError::TerminalRal {
                identity: Box::new(identity.clone()),
                status: entry.status,
            });
        }

        let Some(active_claim_token) = &entry.active_claim_token else {
            return Err(RalSchedulerError::NoActiveClaim {
                identity: Box::new(identity.clone()),
                status: entry.status,
            });
        };

        if active_claim_token != claim_token {
            return Err(RalSchedulerError::InvalidClaimToken {
                identity: Box::new(identity.clone()),
            });
        }

        Ok(entry)
    }

    pub fn has_valid_claim_token(&self, identity: &RalJournalIdentity, claim_token: &str) -> bool {
        self.validate_claim_token(identity, claim_token).is_ok()
    }

    pub fn plan_orphan_reconciliation(
        &self,
        input: RalOrphanReconciliationInput,
    ) -> Result<RalOrphanReconciliationPlan, RalSchedulerError> {
        let mut entries = self.state.entries.values().collect::<Vec<_>>();
        entries.sort_by(|left, right| compare_identity(&left.identity, &right.identity));

        let mut next_sequence = input.next_sequence;
        let mut actions = Vec::new();

        for entry in entries {
            if entry.status != RalReplayStatus::Claimed {
                continue;
            }

            let Some(worker_id) = &entry.worker_id else {
                continue;
            };

            if input.live_worker_ids.contains(worker_id) {
                continue;
            }

            let record = RalJournalRecord::new(
                RAL_JOURNAL_WRITER_RUST_DAEMON,
                input.writer_version.clone(),
                next_sequence,
                input.timestamp,
                input.correlation_id.clone(),
                RalJournalEvent::Crashed {
                    identity: entry.identity.clone(),
                    worker_id: worker_id.clone(),
                    claim_token: entry.active_claim_token.clone(),
                    crash_reason: format!(
                        "worker {worker_id} was not live during RAL reconciliation"
                    ),
                    last_heartbeat_at: None,
                },
            );
            actions.push(RalOrphanReconciliationAction {
                reason: RalOrphanReconciliationReason::ClaimedWorkerMissing,
                identity: entry.identity.clone(),
                worker_id: worker_id.clone(),
                record,
            });
            next_sequence = next_sequence
                .checked_add(1)
                .ok_or(RalSchedulerError::RalJournalSequenceExhausted)?;
        }

        Ok(RalOrphanReconciliationPlan { actions })
    }

    pub fn plan_worker_transition(
        &self,
        input: RalWorkerTransitionInput,
    ) -> Result<RalWorkerTransitionPlan, RalSchedulerError> {
        if input.sequence <= self.state.last_sequence {
            return Err(RalSchedulerError::NonIncreasingJournalSequence {
                sequence: input.sequence,
                last_sequence: self.state.last_sequence,
            });
        }

        let entry = self.validate_claim_token(&input.identity, &input.claim_token)?;
        if entry.worker_id.as_deref() != Some(input.worker_id.as_str()) {
            return Err(RalSchedulerError::WorkerClaimMismatch {
                identity: Box::new(input.identity),
                expected_worker_id: entry.worker_id.clone(),
                actual_worker_id: input.worker_id,
            });
        }

        let event = match input.transition {
            RalWorkerTransition::WaitingForDelegation {
                pending_delegations,
                terminal,
            } => RalJournalEvent::WaitingForDelegation {
                identity: input.identity.clone(),
                worker_id: input.worker_id.clone(),
                claim_token: input.claim_token.clone(),
                pending_delegations,
                terminal,
            },
            RalWorkerTransition::Completed { terminal } => RalJournalEvent::Completed {
                identity: input.identity.clone(),
                worker_id: input.worker_id.clone(),
                claim_token: input.claim_token.clone(),
                terminal,
            },
            RalWorkerTransition::NoResponse { terminal } => RalJournalEvent::NoResponse {
                identity: input.identity.clone(),
                worker_id: input.worker_id.clone(),
                claim_token: input.claim_token.clone(),
                terminal,
            },
            RalWorkerTransition::Error { error, terminal } => RalJournalEvent::Error {
                identity: input.identity.clone(),
                worker_id: input.worker_id.clone(),
                claim_token: input.claim_token.clone(),
                error,
                terminal,
            },
            RalWorkerTransition::Aborted {
                abort_reason,
                terminal,
            } => RalJournalEvent::Aborted {
                identity: input.identity.clone(),
                worker_id: Some(input.worker_id.clone()),
                claim_token: Some(input.claim_token.clone()),
                abort_reason,
                terminal,
            },
        };

        Ok(RalWorkerTransitionPlan {
            record: RalJournalRecord::new(
                RAL_JOURNAL_WRITER_RUST_DAEMON,
                input.writer_version,
                input.sequence,
                input.timestamp,
                input.correlation_id,
                event,
            ),
        })
    }

    fn entry_or_error(
        &self,
        identity: &RalJournalIdentity,
    ) -> Result<&RalReplayEntry, RalSchedulerError> {
        self.state
            .entry(identity)
            .ok_or_else(|| RalSchedulerError::RalNotFound {
                identity: Box::new(identity.clone()),
            })
    }

    fn mint_claim_token(&self, identity: &RalJournalIdentity, worker_id: &str) -> String {
        let counter = CLAIM_TOKEN_COUNTER.fetch_add(1, Ordering::Relaxed);
        let timestamp_nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let mut hasher = Sha256::new();
        hasher.update(b"tenex-ral-claim-v1");
        hasher.update(self.state.last_sequence.to_be_bytes());
        hasher.update(identity.project_id.as_bytes());
        hasher.update([0]);
        hasher.update(identity.agent_pubkey.as_bytes());
        hasher.update([0]);
        hasher.update(identity.conversation_id.as_bytes());
        hasher.update([0]);
        hasher.update(identity.ral_number.to_be_bytes());
        hasher.update(worker_id.as_bytes());
        hasher.update(counter.to_be_bytes());
        hasher.update(timestamp_nanos.to_be_bytes());
        let digest = hasher.finalize();
        format!("claim_{}", hex::encode(&digest[..16]))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RalAllocation {
    pub identity: RalJournalIdentity,
    pub triggering_event_id: Option<String>,
    pub event: RalJournalEvent,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RalClaim {
    pub identity: RalJournalIdentity,
    pub worker_id: String,
    pub claim_token: String,
    pub event: RalJournalEvent,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RalOrphanReconciliationInput {
    pub live_worker_ids: HashSet<String>,
    pub next_sequence: u64,
    pub timestamp: u64,
    pub correlation_id: String,
    pub writer_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RalOrphanReconciliationPlan {
    pub actions: Vec<RalOrphanReconciliationAction>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RalOrphanReconciliationAction {
    pub reason: RalOrphanReconciliationReason,
    pub identity: RalJournalIdentity,
    pub worker_id: String,
    pub record: RalJournalRecord,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RalOrphanReconciliationReason {
    ClaimedWorkerMissing,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RalWorkerTransitionInput {
    pub identity: RalJournalIdentity,
    pub worker_id: String,
    pub claim_token: String,
    pub sequence: u64,
    pub timestamp: u64,
    pub correlation_id: String,
    pub writer_version: String,
    pub transition: RalWorkerTransition,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RalWorkerTransition {
    WaitingForDelegation {
        pending_delegations: Vec<RalPendingDelegation>,
        terminal: RalTerminalSummary,
    },
    Completed {
        terminal: RalTerminalSummary,
    },
    NoResponse {
        terminal: RalTerminalSummary,
    },
    Error {
        error: RalWorkerError,
        terminal: RalTerminalSummary,
    },
    Aborted {
        abort_reason: String,
        terminal: RalTerminalSummary,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RalWorkerTransitionPlan {
    pub record: RalJournalRecord,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum RalSchedulerError {
    #[error("active RAL already exists for triggering event {triggering_event_id}")]
    DuplicateActiveTriggeringEvent {
        namespace: Box<RalNamespace>,
        triggering_event_id: String,
        existing_identity: Box<RalJournalIdentity>,
    },
    #[error("RAL number space exhausted")]
    RalNumberExhausted { namespace: Box<RalNamespace> },
    #[error("RAL not found")]
    RalNotFound { identity: Box<RalJournalIdentity> },
    #[error("RAL is terminal with status {status:?}")]
    TerminalRal {
        identity: Box<RalJournalIdentity>,
        status: RalReplayStatus,
    },
    #[error("RAL with status {status:?} cannot be claimed")]
    NotClaimable {
        identity: Box<RalJournalIdentity>,
        status: RalReplayStatus,
    },
    #[error("RAL is already claimed")]
    AlreadyClaimed {
        identity: Box<RalJournalIdentity>,
        active_claim_token: String,
    },
    #[error("claim token cannot be empty")]
    EmptyClaimToken { identity: Box<RalJournalIdentity> },
    #[error("RAL has no active claim token for status {status:?}")]
    NoActiveClaim {
        identity: Box<RalJournalIdentity>,
        status: RalReplayStatus,
    },
    #[error("claim token does not match current RAL state")]
    InvalidClaimToken { identity: Box<RalJournalIdentity> },
    #[error("RAL journal sequence space exhausted")]
    RalJournalSequenceExhausted,
    #[error("RAL journal sequence {sequence} is not greater than replay sequence {last_sequence}")]
    NonIncreasingJournalSequence { sequence: u64, last_sequence: u64 },
    #[error("worker {actual_worker_id} does not own the active RAL claim")]
    WorkerClaimMismatch {
        identity: Box<RalJournalIdentity>,
        expected_worker_id: Option<String>,
        actual_worker_id: String,
    },
}

pub fn classify_ral_status(status: RalReplayStatus) -> RalStatusClass {
    if is_terminal_ral_status(status) {
        RalStatusClass::Terminal
    } else {
        RalStatusClass::Active
    }
}

pub fn is_active_ral_status(status: RalReplayStatus) -> bool {
    !is_terminal_ral_status(status)
}

pub fn is_terminal_ral_status(status: RalReplayStatus) -> bool {
    matches!(
        status,
        RalReplayStatus::Completed
            | RalReplayStatus::NoResponse
            | RalReplayStatus::Error
            | RalReplayStatus::Aborted
            | RalReplayStatus::Crashed
    )
}

pub fn is_claimable_ral_status(status: RalReplayStatus) -> bool {
    matches!(
        status,
        RalReplayStatus::Allocated | RalReplayStatus::WaitingForDelegation
    )
}

fn compare_identity(left: &RalJournalIdentity, right: &RalJournalIdentity) -> std::cmp::Ordering {
    left.project_id
        .cmp(&right.project_id)
        .then_with(|| left.agent_pubkey.cmp(&right.agent_pubkey))
        .then_with(|| left.conversation_id.cmp(&right.conversation_id))
        .then_with(|| left.ral_number.cmp(&right.ral_number))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ral_journal::{
        RAL_JOURNAL_WRITER_RUST_DAEMON, RalDelegationType, RalJournalRecord, RalPendingDelegation,
        RalTerminalSummary, append_ral_journal_record, read_ral_snapshot,
        replay_ral_journal_records,
    };
    use std::collections::HashSet;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn classifies_active_and_terminal_statuses() {
        for status in [
            RalReplayStatus::Allocated,
            RalReplayStatus::Claimed,
            RalReplayStatus::WaitingForDelegation,
        ] {
            assert_eq!(classify_ral_status(status), RalStatusClass::Active);
            assert!(is_active_ral_status(status));
            assert!(!is_terminal_ral_status(status));
        }

        for status in [
            RalReplayStatus::Completed,
            RalReplayStatus::NoResponse,
            RalReplayStatus::Error,
            RalReplayStatus::Aborted,
            RalReplayStatus::Crashed,
        ] {
            assert_eq!(classify_ral_status(status), RalStatusClass::Terminal);
            assert!(!is_active_ral_status(status));
            assert!(is_terminal_ral_status(status));
        }

        assert!(is_claimable_ral_status(RalReplayStatus::Allocated));
        assert!(is_claimable_ral_status(
            RalReplayStatus::WaitingForDelegation
        ));
        assert!(!is_claimable_ral_status(RalReplayStatus::Claimed));
    }

    #[test]
    fn derives_next_ral_number_per_project_agent_conversation_namespace() {
        let base_namespace = make_namespace("project-a", "agent-a", "conversation-a");
        let same_agent_different_project = make_namespace("project-b", "agent-a", "conversation-a");
        let same_project_different_agent = make_namespace("project-a", "agent-b", "conversation-a");
        let records = vec![
            record(
                1,
                RalJournalEvent::Allocated {
                    identity: base_namespace.identity(1),
                    triggering_event_id: Some("trigger-a-1".to_string()),
                },
            ),
            record(
                2,
                RalJournalEvent::Completed {
                    identity: base_namespace.identity(1),
                    worker_id: "worker-a".to_string(),
                    claim_token: "claim-a".to_string(),
                    terminal: terminal(),
                },
            ),
            record(
                3,
                RalJournalEvent::Allocated {
                    identity: base_namespace.identity(7),
                    triggering_event_id: Some("trigger-a-7".to_string()),
                },
            ),
            record(
                4,
                RalJournalEvent::Allocated {
                    identity: same_agent_different_project.identity(2),
                    triggering_event_id: None,
                },
            ),
            record(
                5,
                RalJournalEvent::Allocated {
                    identity: same_project_different_agent.identity(4),
                    triggering_event_id: None,
                },
            ),
        ];
        let scheduler = make_scheduler(records);

        assert_eq!(scheduler.next_ral_number(&base_namespace), 8);
        assert_eq!(scheduler.next_ral_number(&same_agent_different_project), 3);
        assert_eq!(scheduler.next_ral_number(&same_project_different_agent), 5);
        assert_eq!(
            scheduler.next_ral_number(&make_namespace("project-a", "agent-a", "conversation-b")),
            1
        );
    }

    #[test]
    fn allocation_rejects_duplicate_triggering_event_for_active_rals() {
        let namespace = make_namespace("project-a", "agent-a", "conversation-a");
        let active_identity = namespace.identity(1);
        let records = vec![
            record(
                1,
                RalJournalEvent::Allocated {
                    identity: active_identity.clone(),
                    triggering_event_id: Some("trigger-active".to_string()),
                },
            ),
            record(
                2,
                RalJournalEvent::Allocated {
                    identity: namespace.identity(2),
                    triggering_event_id: Some("trigger-terminal".to_string()),
                },
            ),
            record(
                3,
                RalJournalEvent::Completed {
                    identity: namespace.identity(2),
                    worker_id: "worker-a".to_string(),
                    claim_token: "claim-a".to_string(),
                    terminal: terminal(),
                },
            ),
        ];
        let scheduler = make_scheduler(records);

        match scheduler.allocate(namespace.clone(), Some("trigger-active".to_string())) {
            Err(RalSchedulerError::DuplicateActiveTriggeringEvent {
                triggering_event_id,
                existing_identity,
                ..
            }) => {
                assert_eq!(triggering_event_id, "trigger-active");
                assert_eq!(existing_identity.as_ref(), &active_identity);
            }
            other => panic!("expected duplicate active trigger rejection, got {other:?}"),
        }

        let terminal_duplicate = scheduler
            .allocate(namespace.clone(), Some("trigger-terminal".to_string()))
            .expect("terminal RAL trigger must not block allocation");
        assert_eq!(terminal_duplicate.identity, namespace.identity(3));

        let fresh = scheduler
            .allocate(namespace.clone(), Some("trigger-fresh".to_string()))
            .expect("fresh trigger must allocate");
        assert_eq!(fresh.identity, namespace.identity(3));
        assert_eq!(
            fresh.event,
            RalJournalEvent::Allocated {
                identity: namespace.identity(3),
                triggering_event_id: Some("trigger-fresh".to_string()),
            }
        );
    }

    #[test]
    fn claim_accepts_supplied_token_and_validation_uses_current_replay_state() {
        let namespace = make_namespace("project-a", "agent-a", "conversation-a");
        let identity = namespace.identity(1);
        let allocated = record(
            1,
            RalJournalEvent::Allocated {
                identity: identity.clone(),
                triggering_event_id: Some("trigger-a".to_string()),
            },
        );
        let scheduler = make_scheduler(vec![allocated.clone()]);
        let claim = scheduler
            .claim(&identity, "worker-a", Some("opaque-token-a".to_string()))
            .expect("allocated RAL must be claimable");

        assert_eq!(claim.claim_token, "opaque-token-a");
        assert_eq!(
            claim.event,
            RalJournalEvent::Claimed {
                identity: identity.clone(),
                worker_id: "worker-a".to_string(),
                claim_token: "opaque-token-a".to_string(),
            }
        );

        match scheduler.validate_claim_token(&identity, "opaque-token-a") {
            Err(RalSchedulerError::NoActiveClaim { status, .. }) => {
                assert_eq!(status, RalReplayStatus::Allocated);
            }
            other => panic!("allocated replay must not validate a future claim, got {other:?}"),
        }

        let claimed = record(2, claim.event);
        let claimed_scheduler = make_scheduler(vec![allocated, claimed.clone()]);
        let entry = claimed_scheduler
            .validate_claim_token(&identity, "opaque-token-a")
            .expect("current claimed replay must validate token");
        assert_eq!(entry.status, RalReplayStatus::Claimed);

        match claimed_scheduler.validate_claim_token(&identity, "wrong-token") {
            Err(RalSchedulerError::InvalidClaimToken { identity: invalid }) => {
                assert_eq!(invalid.as_ref(), &identity);
            }
            other => panic!("expected invalid token error, got {other:?}"),
        }

        match claimed_scheduler.claim(&identity, "worker-b", None) {
            Err(RalSchedulerError::AlreadyClaimed {
                active_claim_token, ..
            }) => {
                assert_eq!(active_claim_token, "opaque-token-a");
            }
            other => panic!("expected already claimed error, got {other:?}"),
        }

        let completed_scheduler = make_scheduler(vec![
            claimed,
            record(
                3,
                RalJournalEvent::Completed {
                    identity: identity.clone(),
                    worker_id: "worker-a".to_string(),
                    claim_token: "opaque-token-a".to_string(),
                    terminal: terminal(),
                },
            ),
        ]);

        match completed_scheduler.validate_claim_token(&identity, "opaque-token-a") {
            Err(RalSchedulerError::TerminalRal { status, .. }) => {
                assert_eq!(status, RalReplayStatus::Completed);
            }
            other => panic!("expected terminal validation error, got {other:?}"),
        }
    }

    #[test]
    fn claim_mints_non_empty_token_for_allocated_ral() {
        let namespace = make_namespace("project-a", "agent-a", "conversation-a");
        let identity = namespace.identity(1);
        let scheduler = make_scheduler(vec![record(
            1,
            RalJournalEvent::Allocated {
                identity: identity.clone(),
                triggering_event_id: None,
            },
        )]);

        let first = scheduler
            .claim(&identity, "worker-a", None)
            .expect("allocated RAL must be claimable");
        let second = scheduler
            .claim(&identity, "worker-a", None)
            .expect("minting another candidate token from same replay must succeed");

        assert!(first.claim_token.starts_with("claim_"));
        assert!(second.claim_token.starts_with("claim_"));
        assert_ne!(first.claim_token, second.claim_token);
    }

    #[test]
    fn waiting_for_delegation_is_active_and_claimable_for_resumption() {
        let namespace = make_namespace("project-a", "agent-a", "conversation-a");
        let identity = namespace.identity(1);
        let records = vec![
            record(
                1,
                RalJournalEvent::Allocated {
                    identity: identity.clone(),
                    triggering_event_id: Some("trigger-a".to_string()),
                },
            ),
            record(
                2,
                RalJournalEvent::Claimed {
                    identity: identity.clone(),
                    worker_id: "worker-a".to_string(),
                    claim_token: "claim-a".to_string(),
                },
            ),
            record(
                3,
                RalJournalEvent::WaitingForDelegation {
                    identity: identity.clone(),
                    worker_id: "worker-a".to_string(),
                    claim_token: "claim-a".to_string(),
                    pending_delegations: vec![pending_delegation(
                        "delegation-a",
                        RalDelegationType::Standard,
                    )],
                    terminal: terminal(),
                },
            ),
        ];
        let scheduler = make_scheduler(records);

        let namespace_state = scheduler
            .state()
            .namespace(&namespace)
            .expect("namespace must exist");
        assert_eq!(namespace_state.active_ral_count, 1);
        assert_eq!(namespace_state.terminal_ral_count, 0);
        assert_eq!(
            namespace_state
                .active_triggering_events
                .get("trigger-a")
                .cloned(),
            Some(identity.clone())
        );

        match scheduler.allocate(namespace.clone(), Some("trigger-a".to_string())) {
            Err(RalSchedulerError::DuplicateActiveTriggeringEvent { .. }) => {}
            other => panic!("expected waiting RAL trigger to block duplicate, got {other:?}"),
        }

        let claim = scheduler
            .claim(&identity, "worker-b", Some("claim-resume".to_string()))
            .expect("waiting RAL must be claimable for resumption");
        assert_eq!(
            claim.event,
            RalJournalEvent::Claimed {
                identity,
                worker_id: "worker-b".to_string(),
                claim_token: "claim-resume".to_string(),
            }
        );
    }

    #[test]
    fn scheduler_bootstraps_from_authoritative_daemon_journal() {
        let daemon_dir = unique_temp_daemon_dir();
        let namespace = make_namespace("project-a", "agent-a", "conversation-a");
        let identity = namespace.identity(1);
        let records = vec![
            record(
                1,
                RalJournalEvent::Allocated {
                    identity: identity.clone(),
                    triggering_event_id: Some("trigger-a".to_string()),
                },
            ),
            record(
                2,
                RalJournalEvent::Claimed {
                    identity: identity.clone(),
                    worker_id: "worker-a".to_string(),
                    claim_token: "claim-a".to_string(),
                },
            ),
        ];
        for record in &records {
            append_ral_journal_record(&daemon_dir, record).expect("journal append must succeed");
        }

        let scheduler =
            RalScheduler::from_daemon_dir(&daemon_dir).expect("scheduler must bootstrap");

        assert_eq!(scheduler.next_ral_number(&namespace), 2);
        assert!(scheduler.has_valid_claim_token(&identity, "claim-a"));
        assert_eq!(
            scheduler.active_triggering_event(&namespace, "trigger-a"),
            Some(&identity)
        );

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn scheduler_persists_snapshot_cache_without_using_it_as_authority() {
        let daemon_dir = unique_temp_daemon_dir();
        let namespace = make_namespace("project-a", "agent-a", "conversation-a");
        let records = vec![
            record(
                1,
                RalJournalEvent::Allocated {
                    identity: namespace.identity(1),
                    triggering_event_id: Some("trigger-a".to_string()),
                },
            ),
            record(
                2,
                RalJournalEvent::Completed {
                    identity: namespace.identity(1),
                    worker_id: "worker-a".to_string(),
                    claim_token: "claim-a".to_string(),
                    terminal: terminal(),
                },
            ),
            record(
                3,
                RalJournalEvent::Allocated {
                    identity: namespace.identity(3),
                    triggering_event_id: Some("trigger-c".to_string()),
                },
            ),
        ];
        let scheduler = make_scheduler(records);

        scheduler
            .persist_snapshot(&daemon_dir, "test-version", 1710000000000)
            .expect("snapshot persist must succeed");

        let snapshot = read_ral_snapshot(&daemon_dir)
            .expect("snapshot read must succeed")
            .expect("snapshot must exist");
        assert_eq!(snapshot.writer, RAL_JOURNAL_WRITER_RUST_DAEMON);
        assert_eq!(snapshot.writer_version, "test-version");
        assert_eq!(snapshot.created_at, 1710000000000);
        assert_eq!(snapshot.last_sequence, 3);
        assert_eq!(snapshot.states.len(), 2);

        let journal_scheduler =
            RalScheduler::from_daemon_dir(&daemon_dir).expect("missing journal is empty authority");
        assert_eq!(journal_scheduler.next_ral_number(&namespace), 1);

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn reconciliation_plans_crash_records_for_claimed_rals_without_live_workers() {
        let missing_namespace = make_namespace("project-a", "agent-a", "conversation-a");
        let live_namespace = make_namespace("project-a", "agent-b", "conversation-a");
        let waiting_namespace = make_namespace("project-a", "agent-c", "conversation-a");
        let completed_namespace = make_namespace("project-a", "agent-d", "conversation-a");
        let missing_identity = missing_namespace.identity(1);
        let live_identity = live_namespace.identity(1);
        let waiting_identity = waiting_namespace.identity(1);
        let completed_identity = completed_namespace.identity(1);
        let records = vec![
            record(
                1,
                RalJournalEvent::Allocated {
                    identity: missing_identity.clone(),
                    triggering_event_id: Some("trigger-missing".to_string()),
                },
            ),
            record(
                2,
                RalJournalEvent::Claimed {
                    identity: missing_identity.clone(),
                    worker_id: "worker-missing".to_string(),
                    claim_token: "claim-missing".to_string(),
                },
            ),
            record(
                3,
                RalJournalEvent::Allocated {
                    identity: live_identity,
                    triggering_event_id: Some("trigger-live".to_string()),
                },
            ),
            record(
                4,
                RalJournalEvent::Claimed {
                    identity: live_namespace.identity(1),
                    worker_id: "worker-live".to_string(),
                    claim_token: "claim-live".to_string(),
                },
            ),
            record(
                5,
                RalJournalEvent::Allocated {
                    identity: waiting_identity.clone(),
                    triggering_event_id: Some("trigger-waiting".to_string()),
                },
            ),
            record(
                6,
                RalJournalEvent::Claimed {
                    identity: waiting_identity.clone(),
                    worker_id: "worker-missing".to_string(),
                    claim_token: "claim-waiting".to_string(),
                },
            ),
            record(
                7,
                RalJournalEvent::WaitingForDelegation {
                    identity: waiting_identity,
                    worker_id: "worker-missing".to_string(),
                    claim_token: "claim-waiting".to_string(),
                    pending_delegations: vec![pending_delegation(
                        "delegation-a",
                        RalDelegationType::Standard,
                    )],
                    terminal: terminal(),
                },
            ),
            record(
                8,
                RalJournalEvent::Completed {
                    identity: completed_identity,
                    worker_id: "worker-missing".to_string(),
                    claim_token: "claim-completed".to_string(),
                    terminal: terminal(),
                },
            ),
        ];
        let scheduler = make_scheduler(records.clone());
        let plan = scheduler
            .plan_orphan_reconciliation(reconciliation_input(["worker-live"], 9, 1710000000000))
            .expect("reconciliation plan must build");

        assert_eq!(plan.actions.len(), 1);
        let action = &plan.actions[0];
        assert_eq!(
            action.reason,
            RalOrphanReconciliationReason::ClaimedWorkerMissing
        );
        assert_eq!(action.identity, missing_identity);
        assert_eq!(action.worker_id, "worker-missing");
        assert_eq!(action.record.sequence, 9);
        assert_eq!(action.record.timestamp, 1710000000000);
        assert_eq!(action.record.correlation_id, "reconcile-test");
        match &action.record.event {
            RalJournalEvent::Crashed {
                identity,
                worker_id,
                claim_token,
                crash_reason,
                last_heartbeat_at,
            } => {
                assert_eq!(identity, &missing_namespace.identity(1));
                assert_eq!(worker_id, "worker-missing");
                assert_eq!(claim_token.as_deref(), Some("claim-missing"));
                assert_eq!(
                    crash_reason,
                    "worker worker-missing was not live during RAL reconciliation"
                );
                assert_eq!(last_heartbeat_at, &None);
            }
            other => panic!("expected crashed journal event, got {other:?}"),
        }

        let mut replay_records = records;
        replay_records.push(action.record.clone());
        let replay = replay_ral_journal_records(replay_records).expect("replay must succeed");
        let crashed = replay
            .states
            .get(&missing_namespace.identity(1))
            .expect("missing RAL must still exist");
        assert_eq!(crashed.status, RalReplayStatus::Crashed);
        assert_eq!(crashed.active_claim_token, None);
    }

    #[test]
    fn reconciliation_orders_planned_records_by_ral_identity() {
        let namespace_b = make_namespace("project-b", "agent-b", "conversation-b");
        let namespace_a = make_namespace("project-a", "agent-a", "conversation-a");
        let records = vec![
            record(
                1,
                RalJournalEvent::Allocated {
                    identity: namespace_b.identity(1),
                    triggering_event_id: Some("trigger-b".to_string()),
                },
            ),
            record(
                2,
                RalJournalEvent::Claimed {
                    identity: namespace_b.identity(1),
                    worker_id: "worker-b".to_string(),
                    claim_token: "claim-b".to_string(),
                },
            ),
            record(
                3,
                RalJournalEvent::Allocated {
                    identity: namespace_a.identity(1),
                    triggering_event_id: Some("trigger-a".to_string()),
                },
            ),
            record(
                4,
                RalJournalEvent::Claimed {
                    identity: namespace_a.identity(1),
                    worker_id: "worker-a".to_string(),
                    claim_token: "claim-a".to_string(),
                },
            ),
        ];
        let scheduler = make_scheduler(records);
        let plan = scheduler
            .plan_orphan_reconciliation(reconciliation_input([], 5, 1710000001000))
            .expect("reconciliation plan must build");

        assert_eq!(
            plan.actions
                .iter()
                .map(|action| (
                    action.identity.project_id.as_str(),
                    action.record.sequence,
                    action.worker_id.as_str()
                ))
                .collect::<Vec<_>>(),
            vec![("project-a", 5, "worker-a"), ("project-b", 6, "worker-b")]
        );
    }

    #[test]
    fn worker_transition_plans_completed_record_after_validating_claim() {
        let namespace = make_namespace("project-a", "agent-a", "conversation-a");
        let identity = namespace.identity(1);
        let records = vec![
            record(
                1,
                RalJournalEvent::Allocated {
                    identity: identity.clone(),
                    triggering_event_id: Some("trigger-a".to_string()),
                },
            ),
            record(
                2,
                RalJournalEvent::Claimed {
                    identity: identity.clone(),
                    worker_id: "worker-a".to_string(),
                    claim_token: "claim-a".to_string(),
                },
            ),
        ];
        let scheduler = make_scheduler(records.clone());
        let plan = scheduler
            .plan_worker_transition(worker_transition_input(
                identity.clone(),
                "worker-a",
                "claim-a",
                3,
                RalWorkerTransition::Completed {
                    terminal: RalTerminalSummary {
                        published_user_visible_event: true,
                        pending_delegations_remain: false,
                        accumulated_runtime_ms: 123,
                        final_event_ids: vec!["event-a".to_string()],
                        keep_worker_warm: false,
                    },
                },
            ))
            .expect("worker transition must plan");

        assert_eq!(plan.record.sequence, 3);
        assert_eq!(plan.record.timestamp, 1710002000003);
        assert_eq!(plan.record.correlation_id, "transition-test");
        match &plan.record.event {
            RalJournalEvent::Completed {
                identity: event_identity,
                worker_id,
                claim_token,
                terminal,
            } => {
                assert_eq!(event_identity, &identity);
                assert_eq!(worker_id, "worker-a");
                assert_eq!(claim_token, "claim-a");
                assert_eq!(terminal.final_event_ids, vec!["event-a".to_string()]);
                assert_eq!(terminal.accumulated_runtime_ms, 123);
            }
            other => panic!("expected completed event, got {other:?}"),
        }

        let mut replay_records = records;
        replay_records.push(plan.record);
        let replay = replay_ral_journal_records(replay_records).expect("replay must succeed");
        let entry = replay.states.get(&identity).expect("entry must replay");
        assert_eq!(entry.status, RalReplayStatus::Completed);
        assert_eq!(entry.active_claim_token, None);
        assert_eq!(entry.final_event_ids, vec!["event-a".to_string()]);
    }

    #[test]
    fn worker_transition_supports_waiting_no_response_error_and_aborted_events() {
        let namespace = make_namespace("project-a", "agent-a", "conversation-a");
        let identity = namespace.identity(1);
        let scheduler = make_scheduler(vec![
            record(
                1,
                RalJournalEvent::Allocated {
                    identity: identity.clone(),
                    triggering_event_id: Some("trigger-a".to_string()),
                },
            ),
            record(
                2,
                RalJournalEvent::Claimed {
                    identity: identity.clone(),
                    worker_id: "worker-a".to_string(),
                    claim_token: "claim-a".to_string(),
                },
            ),
        ]);

        let planned = [
            worker_transition_input(
                identity.clone(),
                "worker-a",
                "claim-a",
                3,
                RalWorkerTransition::WaitingForDelegation {
                    pending_delegations: vec![pending_delegation(
                        "delegation-a",
                        RalDelegationType::Ask,
                    )],
                    terminal: terminal(),
                },
            ),
            worker_transition_input(
                identity.clone(),
                "worker-a",
                "claim-a",
                4,
                RalWorkerTransition::NoResponse {
                    terminal: terminal(),
                },
            ),
            worker_transition_input(
                identity.clone(),
                "worker-a",
                "claim-a",
                5,
                RalWorkerTransition::Error {
                    error: RalWorkerError {
                        code: "execution_failed".to_string(),
                        message: "execution failed".to_string(),
                        retryable: false,
                    },
                    terminal: terminal(),
                },
            ),
            worker_transition_input(
                identity.clone(),
                "worker-a",
                "claim-a",
                6,
                RalWorkerTransition::Aborted {
                    abort_reason: "stop requested".to_string(),
                    terminal: terminal(),
                },
            ),
        ]
        .into_iter()
        .map(|input| {
            scheduler
                .plan_worker_transition(input)
                .expect("transition must plan")
                .record
                .event
        })
        .collect::<Vec<_>>();

        assert!(matches!(
            &planned[0],
            RalJournalEvent::WaitingForDelegation {
                pending_delegations,
                ..
            } if pending_delegations.len() == 1
        ));
        assert!(matches!(&planned[1], RalJournalEvent::NoResponse { .. }));
        assert!(matches!(
            &planned[2],
            RalJournalEvent::Error { error, .. } if error.code == "execution_failed"
        ));
        assert!(matches!(
            &planned[3],
            RalJournalEvent::Aborted {
                worker_id,
                claim_token,
                abort_reason,
                ..
            } if worker_id.as_deref() == Some("worker-a")
                && claim_token.as_deref() == Some("claim-a")
                && abort_reason == "stop requested"
        ));
    }

    #[test]
    fn worker_transition_rejects_stale_sequence_wrong_claim_and_wrong_worker() {
        let namespace = make_namespace("project-a", "agent-a", "conversation-a");
        let identity = namespace.identity(1);
        let scheduler = make_scheduler(vec![
            record(
                1,
                RalJournalEvent::Allocated {
                    identity: identity.clone(),
                    triggering_event_id: Some("trigger-a".to_string()),
                },
            ),
            record(
                2,
                RalJournalEvent::Claimed {
                    identity: identity.clone(),
                    worker_id: "worker-a".to_string(),
                    claim_token: "claim-a".to_string(),
                },
            ),
        ]);

        match scheduler.plan_worker_transition(worker_transition_input(
            identity.clone(),
            "worker-a",
            "claim-a",
            2,
            RalWorkerTransition::Completed {
                terminal: terminal(),
            },
        )) {
            Err(RalSchedulerError::NonIncreasingJournalSequence {
                sequence,
                last_sequence,
            }) => {
                assert_eq!(sequence, 2);
                assert_eq!(last_sequence, 2);
            }
            other => panic!("expected stale sequence rejection, got {other:?}"),
        }

        match scheduler.plan_worker_transition(worker_transition_input(
            identity.clone(),
            "worker-a",
            "wrong-claim",
            3,
            RalWorkerTransition::Completed {
                terminal: terminal(),
            },
        )) {
            Err(RalSchedulerError::InvalidClaimToken {
                identity: error_identity,
            }) => {
                assert_eq!(error_identity.as_ref(), &identity);
            }
            other => panic!("expected invalid claim token rejection, got {other:?}"),
        }

        match scheduler.plan_worker_transition(worker_transition_input(
            identity.clone(),
            "worker-b",
            "claim-a",
            3,
            RalWorkerTransition::Completed {
                terminal: terminal(),
            },
        )) {
            Err(RalSchedulerError::WorkerClaimMismatch {
                identity: error_identity,
                expected_worker_id,
                actual_worker_id,
            }) => {
                assert_eq!(error_identity.as_ref(), &identity);
                assert_eq!(expected_worker_id.as_deref(), Some("worker-a"));
                assert_eq!(actual_worker_id, "worker-b");
            }
            other => panic!("expected worker claim mismatch, got {other:?}"),
        }
    }

    fn make_scheduler(records: Vec<RalJournalRecord>) -> RalScheduler {
        let replay = replay_ral_journal_records(records).expect("replay must succeed");
        RalScheduler::from_replay(&replay)
    }

    fn make_namespace(project_id: &str, agent_pubkey: &str, conversation_id: &str) -> RalNamespace {
        RalNamespace::new(project_id, agent_pubkey, conversation_id)
    }

    fn pending_delegation(
        delegation_conversation_id: &str,
        delegation_type: RalDelegationType,
    ) -> RalPendingDelegation {
        RalPendingDelegation {
            delegation_conversation_id: delegation_conversation_id.to_string(),
            recipient_pubkey: "recipient-a".to_string(),
            sender_pubkey: "agent-a".to_string(),
            prompt: "delegated prompt".to_string(),
            delegation_type,
            ral_number: 1,
            parent_delegation_conversation_id: None,
            pending_sub_delegations: None,
            deferred_completion: None,
            followup_event_id: None,
            project_id: None,
            suggestions: None,
            killed: None,
            killed_at: None,
        }
    }

    fn terminal() -> RalTerminalSummary {
        RalTerminalSummary {
            published_user_visible_event: false,
            pending_delegations_remain: false,
            accumulated_runtime_ms: 0,
            final_event_ids: Vec::new(),
            keep_worker_warm: false,
        }
    }

    fn record(sequence: u64, event: RalJournalEvent) -> RalJournalRecord {
        RalJournalRecord::new(
            RAL_JOURNAL_WRITER_RUST_DAEMON,
            "test-version",
            sequence,
            sequence * 1_000,
            format!("corr-{sequence}"),
            event,
        )
    }

    fn reconciliation_input<const N: usize>(
        live_worker_ids: [&str; N],
        next_sequence: u64,
        timestamp: u64,
    ) -> RalOrphanReconciliationInput {
        RalOrphanReconciliationInput {
            live_worker_ids: live_worker_ids
                .into_iter()
                .map(ToString::to_string)
                .collect::<HashSet<_>>(),
            next_sequence,
            timestamp,
            correlation_id: "reconcile-test".to_string(),
            writer_version: "test-version".to_string(),
        }
    }

    fn worker_transition_input(
        identity: RalJournalIdentity,
        worker_id: &str,
        claim_token: &str,
        sequence: u64,
        transition: RalWorkerTransition,
    ) -> RalWorkerTransitionInput {
        RalWorkerTransitionInput {
            identity,
            worker_id: worker_id.to_string(),
            claim_token: claim_token.to_string(),
            sequence,
            timestamp: 1710002000000 + sequence,
            correlation_id: "transition-test".to_string(),
            writer_version: "test-version".to_string(),
            transition,
        }
    }

    fn unique_temp_daemon_dir() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after epoch")
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "tenex-daemon-ral-scheduler-test-{}-{nanos}-{counter}",
            std::process::id()
        ))
    }
}
