use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::dispatch_queue::{
    DispatchQueueRecord, DispatchQueueRecordParams, DispatchQueueStatus, DispatchRalIdentity,
    build_dispatch_queue_record,
};
use crate::ral_journal::{
    RAL_JOURNAL_WRITER_RUST_DAEMON, RalCompletedDelegation, RalDelegationSnapshot,
    RalDelegationType, RalJournalEvent, RalJournalIdentity, RalJournalRecord, RalJournalReplay,
    RalJournalResult, RalJournalSnapshot, RalPendingDelegation, RalReplayEntry, RalReplayStatus,
    RalTerminalSummary, RalWorkerError, replay_ral_journal, write_ral_snapshot,
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

    pub fn delegation_snapshot_for(
        &self,
        project_id: &str,
        agent_pubkey: &str,
        conversation_id: &str,
    ) -> RalDelegationSnapshot {
        let mut snapshot = RalDelegationSnapshot::default();
        for entry in self.state.entries.values() {
            if entry.identity.project_id != project_id
                || entry.identity.agent_pubkey != agent_pubkey
                || entry.identity.conversation_id != conversation_id
            {
                continue;
            }
            snapshot
                .pending_delegations
                .extend(entry.pending_delegations.iter().cloned());
            // For each completed delegation, include a synthetic pending entry
            // alongside the completion. The TS worker overlay applies them in
            // registration order — it first sees the pending, then resolves it
            // via the completion — so the `<delegations>` system reminder fires
            // correctly on the resumed session. Without the synthetic pending the
            // overlay's `applyDelegationCompletion` cannot find a match and the
            // completed delegation is silently dropped.
            for completed in &entry.completed_delegations {
                snapshot.pending_delegations.push(RalPendingDelegation {
                    delegation_conversation_id: completed.delegation_conversation_id.clone(),
                    recipient_pubkey: completed.sender_pubkey.clone(),
                    sender_pubkey: completed.recipient_pubkey.clone(),
                    prompt: String::new(),
                    delegation_type: RalDelegationType::Standard,
                    ral_number: entry.identity.ral_number,
                    parent_delegation_conversation_id: None,
                    pending_sub_delegations: None,
                    deferred_completion: None,
                    followup_event_id: None,
                    project_id: None,
                    suggestions: None,
                    killed: None,
                    killed_at: None,
                });
            }
            snapshot
                .completed_delegations
                .extend(entry.completed_delegations.iter().cloned());
        }
        snapshot
    }

    pub fn find_delegation_completion(
        &self,
        input: RalDelegationCompletionLookupInput<'_>,
    ) -> Option<RalDelegationCompletionLookup> {
        let mut entries = self
            .state
            .entries
            .values()
            .filter(|entry| is_active_ral_status(entry.status))
            .collect::<Vec<_>>();
        entries.sort_by(|left, right| compare_identity(&left.identity, &right.identity));

        for reply_target in input.reply_targets.iter().rev() {
            for entry in &entries {
                if entry.completed_delegations.iter().any(|completion| {
                    completion.completion_event_id == input.completion_event_id
                        || (completion.delegation_conversation_id == *reply_target
                            && completion.sender_pubkey == input.completion_sender_pubkey)
                }) {
                    return Some(RalDelegationCompletionLookup::AlreadyRecorded(
                        RalDelegationCompletionAlreadyRecorded {
                            identity: entry.identity.clone(),
                            delegation_conversation_id: reply_target.clone(),
                            completion_event_id: input.completion_event_id.to_string(),
                        },
                    ));
                }

                let Some(pending) = entry.pending_delegations.iter().find(|pending| {
                    pending.delegation_conversation_id == *reply_target
                        && pending.recipient_pubkey == input.completion_sender_pubkey
                }) else {
                    continue;
                };

                let remaining_pending_delegations = entry
                    .pending_delegations
                    .iter()
                    .filter(|candidate| {
                        candidate.delegation_conversation_id != pending.delegation_conversation_id
                            || candidate.recipient_pubkey != pending.recipient_pubkey
                    })
                    .cloned()
                    .collect::<Vec<_>>();
                let deferred = pending
                    .pending_sub_delegations
                    .as_ref()
                    .is_some_and(|pending| !pending.is_empty());

                return Some(RalDelegationCompletionLookup::Pending(
                    RalDelegationCompletionTarget {
                        identity: entry.identity.clone(),
                        status: entry.status,
                        worker_id: entry.worker_id.clone(),
                        active_claim_token: entry.active_claim_token.clone(),
                        triggering_event_id: entry.triggering_event_id.clone(),
                        pending_delegation: pending.clone(),
                        remaining_pending_delegations,
                        deferred,
                    },
                ));
            }
        }

        None
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

    pub fn plan_dispatch_preparation(
        &self,
        input: RalDispatchPreparationInput,
    ) -> Result<RalDispatchPreparation, RalSchedulerError> {
        if input.journal_sequence <= self.state.last_sequence {
            return Err(RalSchedulerError::NonIncreasingJournalSequence {
                sequence: input.journal_sequence,
                last_sequence: self.state.last_sequence,
            });
        }
        if input.dispatch_sequence <= input.last_dispatch_sequence {
            return Err(RalSchedulerError::NonIncreasingDispatchSequence {
                sequence: input.dispatch_sequence,
                last_sequence: input.last_dispatch_sequence,
            });
        }

        let claim_sequence = input
            .journal_sequence
            .checked_add(1)
            .ok_or(RalSchedulerError::RalJournalSequenceExhausted)?;
        let allocation = self.allocate(input.namespace, Some(input.triggering_event_id.clone()))?;
        if input.claim_token.is_empty() {
            return Err(RalSchedulerError::EmptyClaimToken {
                identity: Box::new(allocation.identity),
            });
        }
        let claim_token = input.claim_token;
        let claim = RalClaim {
            identity: allocation.identity.clone(),
            worker_id: input.worker_id.clone(),
            claim_token: claim_token.clone(),
            event: RalJournalEvent::Claimed {
                identity: allocation.identity.clone(),
                worker_id: input.worker_id.clone(),
                claim_token: claim_token.clone(),
            },
        };
        let allocation_record = RalJournalRecord::new(
            RAL_JOURNAL_WRITER_RUST_DAEMON,
            input.writer_version.clone(),
            input.journal_sequence,
            input.timestamp,
            input.correlation_id.clone(),
            allocation.event.clone(),
        );
        let claim_record = RalJournalRecord::new(
            RAL_JOURNAL_WRITER_RUST_DAEMON,
            input.writer_version,
            claim_sequence,
            input.timestamp,
            input.correlation_id.clone(),
            claim.event.clone(),
        );
        let dispatch_record = build_dispatch_queue_record(DispatchQueueRecordParams {
            sequence: input.dispatch_sequence,
            timestamp: input.timestamp,
            correlation_id: input.correlation_id,
            dispatch_id: input.dispatch_id,
            ral: DispatchRalIdentity {
                project_id: allocation.identity.project_id.clone(),
                agent_pubkey: allocation.identity.agent_pubkey.clone(),
                conversation_id: allocation.identity.conversation_id.clone(),
                ral_number: allocation.identity.ral_number,
            },
            triggering_event_id: input.triggering_event_id,
            claim_token,
            status: DispatchQueueStatus::Queued,
        });

        Ok(RalDispatchPreparation {
            allocation,
            claim,
            allocation_record,
            claim_record,
            dispatch_record,
        })
    }

    pub fn plan_delegation_completion(
        &self,
        input: RalDelegationCompletionPlanInput,
    ) -> Result<RalDelegationCompletionPlan, RalSchedulerError> {
        if input.sequence <= self.state.last_sequence {
            return Err(RalSchedulerError::NonIncreasingJournalSequence {
                sequence: input.sequence,
                last_sequence: self.state.last_sequence,
            });
        }

        let entry = self.entry_or_error(&input.identity)?;
        if is_terminal_ral_status(entry.status) {
            return Err(RalSchedulerError::TerminalRal {
                identity: Box::new(input.identity),
                status: entry.status,
            });
        }

        let event = RalJournalEvent::DelegationCompleted {
            identity: input.identity,
            completion: input.completion,
        };
        Ok(RalDelegationCompletionPlan {
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

    pub fn plan_resume_dispatch_preparation(
        &self,
        input: RalResumeDispatchPreparationInput,
    ) -> Result<RalResumeDispatchPreparation, RalSchedulerError> {
        if input.journal_sequence <= self.state.last_sequence {
            return Err(RalSchedulerError::NonIncreasingJournalSequence {
                sequence: input.journal_sequence,
                last_sequence: self.state.last_sequence,
            });
        }
        if input.dispatch_sequence <= input.last_dispatch_sequence {
            return Err(RalSchedulerError::NonIncreasingDispatchSequence {
                sequence: input.dispatch_sequence,
                last_sequence: input.last_dispatch_sequence,
            });
        }

        let claim = self.claim(
            &input.identity,
            input.worker_id.clone(),
            Some(input.claim_token.clone()),
        )?;
        let claim_record = RalJournalRecord::new(
            RAL_JOURNAL_WRITER_RUST_DAEMON,
            input.writer_version,
            input.journal_sequence,
            input.timestamp,
            input.correlation_id.clone(),
            claim.event.clone(),
        );
        let dispatch_record = build_dispatch_queue_record(DispatchQueueRecordParams {
            sequence: input.dispatch_sequence,
            timestamp: input.timestamp,
            correlation_id: input.correlation_id,
            dispatch_id: input.dispatch_id,
            ral: DispatchRalIdentity {
                project_id: input.identity.project_id,
                agent_pubkey: input.identity.agent_pubkey,
                conversation_id: input.identity.conversation_id,
                ral_number: input.identity.ral_number,
            },
            triggering_event_id: input.triggering_event_id,
            claim_token: claim.claim_token.clone(),
            status: DispatchQueueStatus::Queued,
        });

        Ok(RalResumeDispatchPreparation {
            claim,
            claim_record,
            dispatch_record,
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
pub struct RalDispatchPreparationInput {
    pub namespace: RalNamespace,
    pub triggering_event_id: String,
    pub worker_id: String,
    pub claim_token: String,
    pub journal_sequence: u64,
    pub dispatch_sequence: u64,
    pub last_dispatch_sequence: u64,
    pub timestamp: u64,
    pub correlation_id: String,
    pub dispatch_id: String,
    pub writer_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RalDispatchPreparation {
    pub allocation: RalAllocation,
    pub claim: RalClaim,
    pub allocation_record: RalJournalRecord,
    pub claim_record: RalJournalRecord,
    pub dispatch_record: DispatchQueueRecord,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RalDelegationCompletionLookupInput<'a> {
    pub reply_targets: &'a [String],
    pub completion_sender_pubkey: &'a str,
    pub completion_event_id: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RalDelegationCompletionLookup {
    Pending(RalDelegationCompletionTarget),
    AlreadyRecorded(RalDelegationCompletionAlreadyRecorded),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RalDelegationCompletionTarget {
    pub identity: RalJournalIdentity,
    pub status: RalReplayStatus,
    pub worker_id: Option<String>,
    pub active_claim_token: Option<String>,
    pub triggering_event_id: Option<String>,
    pub pending_delegation: RalPendingDelegation,
    pub remaining_pending_delegations: Vec<RalPendingDelegation>,
    pub deferred: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RalDelegationCompletionAlreadyRecorded {
    pub identity: RalJournalIdentity,
    pub delegation_conversation_id: String,
    pub completion_event_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RalDelegationCompletionPlanInput {
    pub identity: RalJournalIdentity,
    pub completion: RalCompletedDelegation,
    pub sequence: u64,
    pub timestamp: u64,
    pub correlation_id: String,
    pub writer_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RalDelegationCompletionPlan {
    pub record: RalJournalRecord,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RalResumeDispatchPreparationInput {
    pub identity: RalJournalIdentity,
    pub worker_id: String,
    pub claim_token: String,
    pub journal_sequence: u64,
    pub dispatch_sequence: u64,
    pub last_dispatch_sequence: u64,
    pub timestamp: u64,
    pub correlation_id: String,
    pub dispatch_id: String,
    pub triggering_event_id: String,
    pub writer_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RalResumeDispatchPreparation {
    pub claim: RalClaim,
    pub claim_record: RalJournalRecord,
    pub dispatch_record: DispatchQueueRecord,
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
    #[error("dispatch sequence {sequence} is not greater than replay sequence {last_sequence}")]
    NonIncreasingDispatchSequence { sequence: u64, last_sequence: u64 },
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
    use crate::dispatch_queue::{append_dispatch_queue_record, replay_dispatch_queue};
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
    fn finds_delegation_completion_by_reply_target_and_delegatee_pubkey() {
        let namespace = make_namespace("project-a", "agent-a", "conversation-a");
        let identity = namespace.identity(1);
        let pending = pending_delegation("delegation-a", RalDelegationType::Standard);
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
                    pending_delegations: vec![
                        pending.clone(),
                        pending_delegation("delegation-b", RalDelegationType::Ask),
                    ],
                    terminal: terminal(),
                },
            ),
        ];
        let scheduler = make_scheduler(records);
        let lookup = scheduler
            .find_delegation_completion(RalDelegationCompletionLookupInput {
                reply_targets: &["irrelevant".to_string(), "delegation-a".to_string()],
                completion_sender_pubkey: "recipient-a",
                completion_event_id: "completion-a",
            })
            .expect("delegation completion must match");

        let RalDelegationCompletionLookup::Pending(target) = lookup else {
            panic!("expected pending completion target");
        };
        assert_eq!(target.identity, identity);
        assert_eq!(target.status, RalReplayStatus::WaitingForDelegation);
        assert_eq!(target.pending_delegation, pending);
        assert_eq!(
            target
                .remaining_pending_delegations
                .iter()
                .map(|pending| pending.delegation_conversation_id.as_str())
                .collect::<Vec<_>>(),
            vec!["delegation-b"]
        );
        assert!(!target.deferred);
    }

    #[test]
    fn plans_resume_dispatch_without_allocating_a_new_ral() {
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
        ]);

        let preparation = scheduler
            .plan_resume_dispatch_preparation(RalResumeDispatchPreparationInput {
                identity: identity.clone(),
                worker_id: "worker-resume".to_string(),
                claim_token: "claim-resume".to_string(),
                journal_sequence: 4,
                dispatch_sequence: 1,
                last_dispatch_sequence: 0,
                timestamp: 1_710_000_900_000,
                correlation_id: "delegation-resume-test".to_string(),
                dispatch_id: "dispatch-resume".to_string(),
                triggering_event_id: "trigger-a".to_string(),
                writer_version: "test-version".to_string(),
            })
            .expect("resume dispatch preparation must build");

        assert_eq!(preparation.claim.identity, identity);
        assert_eq!(preparation.claim_record.sequence, 4);
        assert!(matches!(
            preparation.claim_record.event,
            RalJournalEvent::Claimed { .. }
        ));
        assert_eq!(preparation.dispatch_record.dispatch_id, "dispatch-resume");
        assert_eq!(preparation.dispatch_record.ral.ral_number, 1);
        assert_eq!(preparation.dispatch_record.triggering_event_id, "trigger-a");
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

    #[test]
    fn dispatch_preparation_plans_ral_allocation_claim_and_queued_dispatch_records() {
        let daemon_dir = unique_temp_daemon_dir();
        let namespace = make_namespace("project-a", "agent-a", "conversation-a");
        let scheduler = make_scheduler(Vec::new());
        let preparation = scheduler
            .plan_dispatch_preparation(dispatch_preparation_input(
                namespace.clone(),
                "trigger-a",
                "worker-a",
                "claim-dispatch",
                1,
                1,
                0,
            ))
            .expect("dispatch preparation must plan");

        assert_eq!(preparation.allocation.identity, namespace.identity(1));
        assert_eq!(
            preparation.allocation.triggering_event_id.as_deref(),
            Some("trigger-a")
        );
        assert_eq!(preparation.claim.identity, namespace.identity(1));
        assert_eq!(preparation.claim.worker_id, "worker-a");
        assert_eq!(preparation.claim.claim_token, "claim-dispatch");
        assert_eq!(preparation.allocation_record.sequence, 1);
        assert_eq!(preparation.claim_record.sequence, 2);
        assert_eq!(preparation.dispatch_record.sequence, 1);
        assert_eq!(
            preparation.dispatch_record.status,
            DispatchQueueStatus::Queued
        );
        assert_eq!(
            preparation.dispatch_record.claim_token,
            preparation.claim.claim_token
        );

        append_ral_journal_record(&daemon_dir, &preparation.allocation_record)
            .expect("allocation append must succeed");
        append_ral_journal_record(&daemon_dir, &preparation.claim_record)
            .expect("claim append must succeed");
        append_dispatch_queue_record(&daemon_dir, &preparation.dispatch_record)
            .expect("dispatch queue append must succeed");

        let replay = crate::ral_journal::replay_ral_journal(&daemon_dir)
            .expect("journal replay must succeed");
        let entry = replay
            .states
            .get(&namespace.identity(1))
            .expect("prepared RAL must replay");
        assert_eq!(entry.status, RalReplayStatus::Claimed);
        assert_eq!(entry.worker_id.as_deref(), Some("worker-a"));
        assert_eq!(
            entry.active_claim_token.as_deref(),
            Some(preparation.claim.claim_token.as_str())
        );

        let dispatch_state = replay_dispatch_queue(&daemon_dir).expect("queue replay must succeed");
        assert_eq!(dispatch_state.queued, vec![preparation.dispatch_record]);
        assert!(dispatch_state.leased.is_empty());
        assert!(dispatch_state.terminal.is_empty());

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn dispatch_preparation_uses_journal_replay_for_next_ral_and_independent_queue_sequence() {
        let namespace = make_namespace("project-a", "agent-a", "conversation-a");
        let scheduler = make_scheduler(vec![
            record(
                4,
                RalJournalEvent::Allocated {
                    identity: namespace.identity(1),
                    triggering_event_id: Some("old-trigger".to_string()),
                },
            ),
            record(
                5,
                RalJournalEvent::Completed {
                    identity: namespace.identity(1),
                    worker_id: "worker-old".to_string(),
                    claim_token: "claim-old".to_string(),
                    terminal: terminal(),
                },
            ),
        ]);
        let preparation = scheduler
            .plan_dispatch_preparation(dispatch_preparation_input(
                namespace.clone(),
                "trigger-a",
                "worker-a",
                "claim-explicit",
                6,
                1,
                0,
            ))
            .expect("dispatch preparation must plan");

        assert_eq!(preparation.allocation.identity, namespace.identity(2));
        assert_eq!(preparation.allocation_record.sequence, 6);
        assert_eq!(preparation.claim_record.sequence, 7);
        assert_eq!(preparation.dispatch_record.sequence, 1);
        assert_eq!(preparation.claim.claim_token, "claim-explicit");
        assert_eq!(preparation.dispatch_record.claim_token, "claim-explicit");
    }

    #[test]
    fn dispatch_preparation_rejects_duplicate_trigger_stale_sequence_and_empty_claim() {
        let namespace = make_namespace("project-a", "agent-a", "conversation-a");
        let scheduler = make_scheduler(vec![record(
            2,
            RalJournalEvent::Allocated {
                identity: namespace.identity(1),
                triggering_event_id: Some("trigger-a".to_string()),
            },
        )]);

        match scheduler.plan_dispatch_preparation(dispatch_preparation_input(
            namespace.clone(),
            "fresh-trigger",
            "worker-a",
            "claim-fresh",
            2,
            1,
            0,
        )) {
            Err(RalSchedulerError::NonIncreasingJournalSequence {
                sequence,
                last_sequence,
            }) => {
                assert_eq!(sequence, 2);
                assert_eq!(last_sequence, 2);
            }
            other => panic!("expected stale journal sequence rejection, got {other:?}"),
        }

        match scheduler.plan_dispatch_preparation(dispatch_preparation_input(
            namespace.clone(),
            "trigger-a",
            "worker-a",
            "claim-duplicate",
            3,
            1,
            0,
        )) {
            Err(RalSchedulerError::DuplicateActiveTriggeringEvent {
                triggering_event_id,
                ..
            }) => {
                assert_eq!(triggering_event_id, "trigger-a");
            }
            other => panic!("expected duplicate trigger rejection, got {other:?}"),
        }

        match scheduler.plan_dispatch_preparation(dispatch_preparation_input(
            namespace.clone(),
            "fresh-trigger",
            "worker-a",
            "claim-fresh",
            3,
            1,
            1,
        )) {
            Err(RalSchedulerError::NonIncreasingDispatchSequence {
                sequence,
                last_sequence,
            }) => {
                assert_eq!(sequence, 1);
                assert_eq!(last_sequence, 1);
            }
            other => panic!("expected stale dispatch sequence rejection, got {other:?}"),
        }

        match scheduler.plan_dispatch_preparation(dispatch_preparation_input(
            namespace,
            "fresh-trigger",
            "worker-a",
            "",
            3,
            1,
            0,
        )) {
            Err(RalSchedulerError::EmptyClaimToken { identity }) => {
                assert_eq!(identity.ral_number, 2);
            }
            other => panic!("expected empty claim token rejection, got {other:?}"),
        }
    }

    #[test]
    fn dispatch_preparation_allows_terminal_duplicate_triggering_event() {
        let namespace = make_namespace("project-a", "agent-a", "conversation-a");
        let scheduler = make_scheduler(vec![
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
        ]);
        let preparation = scheduler
            .plan_dispatch_preparation(dispatch_preparation_input(
                namespace.clone(),
                "trigger-a",
                "worker-b",
                "claim-b",
                3,
                1,
                0,
            ))
            .expect("terminal duplicate trigger must not block dispatch preparation");

        assert_eq!(preparation.allocation.identity, namespace.identity(2));
        assert_eq!(
            preparation.allocation.triggering_event_id.as_deref(),
            Some("trigger-a")
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

    fn dispatch_preparation_input(
        namespace: RalNamespace,
        triggering_event_id: &str,
        worker_id: &str,
        claim_token: &str,
        journal_sequence: u64,
        dispatch_sequence: u64,
        last_dispatch_sequence: u64,
    ) -> RalDispatchPreparationInput {
        RalDispatchPreparationInput {
            namespace,
            triggering_event_id: triggering_event_id.to_string(),
            worker_id: worker_id.to_string(),
            claim_token: claim_token.to_string(),
            journal_sequence,
            dispatch_sequence,
            last_dispatch_sequence,
            timestamp: 1710003000000,
            correlation_id: "dispatch-prep-test".to_string(),
            dispatch_id: format!("dispatch-{dispatch_sequence}"),
            writer_version: "test-version".to_string(),
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
