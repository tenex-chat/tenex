use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::ral_journal::{
    RalJournalEvent, RalJournalIdentity, RalJournalReplay, RalReplayEntry, RalReplayStatus,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ral_journal::{
        RAL_JOURNAL_WRITER_RUST_DAEMON, RalDelegationType, RalJournalRecord, RalPendingDelegation,
        RalTerminalSummary, replay_ral_journal_records,
    };

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
}
