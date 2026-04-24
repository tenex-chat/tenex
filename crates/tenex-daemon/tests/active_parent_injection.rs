//! Proves §5.5 of `docs/E2E_TEST_SCENARIOS.md`:
//!
//! > agent1 still streaming when child completion arrives. Child publishes
//! > completion. Completion recorded in journal; daemon does NOT spawn second
//! > agent1 worker; running worker receives via injection on next checkpoint.
//!
//! The bash e2e harness cannot drive this scenario reliably because the
//! injection path at `inbound_runtime.rs:239` fires only when the parent RAL
//! carries `status == Claimed` at the moment the child-completion event is
//! ingested. In the real flow the daemon writes `WaitingForDelegation` before
//! agent2 is even spawned, so the completion always arrives with the parent
//! already in the waiting state, never in the claimed state.
//!
//! This test exercises the exact execution path that fires during the narrow
//! window when a completion arrives while the parent worker is still mid-turn
//! (RAL = Claimed). It uses only the crate's public API.
//!
//! ## Invariants proven
//!
//! **A.** The worker injection queue gains exactly one new record in `queued`
//!    status whose `delegation_completion` payload references the child
//!    completion event.
//!
//! **B.** The dispatch queue is empty — the daemon does NOT spawn a second
//!    agent1 worker to handle the completion.
//!
//! **C.** The RAL journal gains a `DelegationCompleted` record for the parent
//!    identity but no new `Claimed` record (no second worker allocation).

use tempfile::TempDir;

use tenex_daemon::dispatch_queue::replay_dispatch_queue;
use tenex_daemon::inbound_dispatch::{
    DelegationCompletionDispatchInput, DelegationCompletionDispatchOutcome, InboundDispatchProject,
    enqueue_delegation_completion_dispatch,
};
use tenex_daemon::inbound_envelope::{
    ChannelKind, ChannelRef, ExternalMessageRef, InboundEnvelope, InboundMetadata, PrincipalRef,
    RuntimeTransport,
};
use tenex_daemon::ral_journal::{
    RAL_JOURNAL_WRITER_RUST_DAEMON, RalCompletedDelegation, RalDelegationType, RalJournalEvent,
    RalJournalIdentity, RalJournalRecord, RalPendingDelegation, RalReplayStatus,
    append_ral_journal_record, read_ral_journal_records, replay_ral_journal,
};
use tenex_daemon::worker_injection_queue::{
    WorkerDelegationCompletionInjection, WorkerInjectionEnqueueInput, WorkerInjectionQueueStatus,
    WorkerInjectionRole, enqueue_worker_injection, replay_worker_injection_queue,
};

#[test]
fn active_parent_completion_becomes_injection_not_new_dispatch() {
    let tmp = TempDir::new().expect("tempdir must create");
    let daemon_dir = tmp.path();

    // Identity of the parent agent (agent1) that is currently streaming.
    let identity = RalJournalIdentity {
        project_id: "project-alpha".to_string(),
        agent_pubkey: "a".repeat(64),
        conversation_id: "conversation-parent".to_string(),
        ral_number: 1,
    };

    // The worker ID and claim token that the running agent1 worker holds.
    let worker_id = "active-worker-1";
    let claim_token = "active-claim-token-1";

    // The delegation conversation the child (agent2) was running.
    let delegation_conv_id = "delegation-conv-child-1";
    let child_pubkey = "b".repeat(64);
    let completion_event_id = "completion-event-abc123";

    // ── Seed the RAL journal with: Allocated → Claimed → DelegationRegistered
    //
    // This represents agent1 mid-turn (Claimed) having already registered its
    // delegation to agent2 (DelegationRegistered) but not yet yielded control
    // (still Claimed, not WaitingForDelegation).
    let pending_delegation = RalPendingDelegation {
        delegation_conversation_id: delegation_conv_id.to_string(),
        recipient_pubkey: child_pubkey.clone(),
        sender_pubkey: identity.agent_pubkey.clone(),
        prompt: "go do the subtask".to_string(),
        delegation_type: RalDelegationType::Standard,
        ral_number: 1,
        parent_delegation_conversation_id: None,
        pending_sub_delegations: None,
        deferred_completion: None,
        followup_event_id: None,
        project_id: None,
        suggestions: None,
        killed: None,
        killed_at: None,
    };
    let seed_records = [
        RalJournalRecord::new(
            RAL_JOURNAL_WRITER_RUST_DAEMON,
            "active-parent-injection-test@0",
            1,
            1_710_000_100_000,
            "seed-alloc",
            RalJournalEvent::Allocated {
                identity: identity.clone(),
                triggering_event_id: Some("triggering-event-1".to_string()),
            },
        ),
        RalJournalRecord::new(
            RAL_JOURNAL_WRITER_RUST_DAEMON,
            "active-parent-injection-test@0",
            2,
            1_710_000_200_000,
            "seed-claim",
            RalJournalEvent::Claimed {
                identity: identity.clone(),
                worker_id: worker_id.to_string(),
                claim_token: claim_token.to_string(),
            },
        ),
        RalJournalRecord::new(
            RAL_JOURNAL_WRITER_RUST_DAEMON,
            "active-parent-injection-test@0",
            3,
            1_710_000_300_000,
            "seed-deleg-reg",
            RalJournalEvent::DelegationRegistered {
                identity: identity.clone(),
                worker_id: worker_id.to_string(),
                claim_token: claim_token.to_string(),
                pending_delegation: pending_delegation.clone(),
            },
        ),
    ];
    for record in &seed_records {
        append_ral_journal_record(daemon_dir, record).expect("seed journal must append");
    }

    // Verify the seeded state: status is Claimed with one pending delegation.
    let replay = replay_ral_journal(daemon_dir).expect("journal must replay after seeding");
    let entry = replay
        .states
        .get(&identity)
        .expect("seeded identity must be in replay");
    assert_eq!(
        entry.status,
        RalReplayStatus::Claimed,
        "seeded parent must be Claimed"
    );
    assert_eq!(
        entry.pending_delegations.len(),
        1,
        "seeded parent must have one pending delegation"
    );

    // ── Build the child completion envelope and completion record.
    //
    // This is what the daemon would receive when agent2 publishes its kind:1.
    let completion_envelope = InboundEnvelope {
        transport: RuntimeTransport::Nostr,
        principal: PrincipalRef {
            id: format!("nostr:{child_pubkey}"),
            transport: RuntimeTransport::Nostr,
            linked_pubkey: Some(child_pubkey.clone()),
            display_name: None,
            username: None,
            kind: None,
        },
        channel: ChannelRef {
            id: format!("nostr:conversation:{delegation_conv_id}"),
            transport: RuntimeTransport::Nostr,
            kind: ChannelKind::Conversation,
            project_binding: None,
        },
        message: ExternalMessageRef {
            id: format!("nostr:{completion_event_id}"),
            transport: RuntimeTransport::Nostr,
            native_id: completion_event_id.to_string(),
            reply_to_id: None,
        },
        recipients: Vec::new(),
        content: "task complete: the subtask is done".to_string(),
        occurred_at: 1_710_000_900,
        capabilities: Vec::new(),
        metadata: InboundMetadata::default(),
    };

    let completion = RalCompletedDelegation {
        delegation_conversation_id: delegation_conv_id.to_string(),
        sender_pubkey: child_pubkey.clone(),
        recipient_pubkey: identity.agent_pubkey.clone(),
        response: completion_envelope.content.clone(),
        completed_at: 1_710_000_900,
        completion_event_id: completion_event_id.to_string(),
        full_transcript: None,
    };

    // ── Call enqueue_delegation_completion_dispatch with parent_status=Claimed,
    //    resume_if_waiting=false.
    //
    // This is what inbound_runtime::try_handle_delegation_completion calls.
    // With Claimed + resume_if_waiting=false, the function writes only a
    // DelegationCompleted journal record — it does NOT create a dispatch record.
    let dispatch_outcome =
        enqueue_delegation_completion_dispatch(DelegationCompletionDispatchInput {
            daemon_dir,
            project: InboundDispatchProject {
                project_id: &identity.project_id,
                project_base_path: "/tmp/project-alpha",
                metadata_path: "/tmp/project-alpha/.tenex/project.json",
            },
            identity: &identity,
            parent_status: RalReplayStatus::Claimed,
            completion: &completion,
            triggering_envelope: &completion_envelope,
            remaining_pending_delegation_ids: &[],
            resume_if_waiting: false,
            timestamp: 1_710_000_900_000,
            writer_version: "active-parent-injection-test@0",
        })
        .expect("delegation completion dispatch must succeed");

    // Confirm the dispatch path took the Recorded branch (not Resumed).
    assert!(
        matches!(
            dispatch_outcome,
            DelegationCompletionDispatchOutcome::Recorded { .. }
        ),
        "Claimed parent must yield Recorded dispatch outcome, not Resumed"
    );

    // ── Call enqueue_worker_injection — the injection path.
    //
    // This is what inbound_runtime::try_handle_delegation_completion calls
    // immediately after enqueue_delegation_completion_dispatch when it detects
    // target.status == Claimed.
    let injection_id = format!("delegation-completion:{completion_event_id}");
    let correlation_id = format!("delegation-completion-inject:{completion_event_id}");
    let injection_outcome = enqueue_worker_injection(WorkerInjectionEnqueueInput {
        daemon_dir: daemon_dir.to_path_buf(),
        timestamp: 1_710_000_900_000,
        correlation_id: correlation_id.clone(),
        worker_id: worker_id.to_string(),
        identity: identity.clone(),
        injection_id: injection_id.clone(),
        lease_token: claim_token.to_string(),
        role: WorkerInjectionRole::System,
        content: completion.response.clone(),
        delegation_completion: Some(WorkerDelegationCompletionInjection {
            delegation_conversation_id: delegation_conv_id.to_string(),
            recipient_pubkey: child_pubkey.clone(),
            completed_at: completion.completed_at,
            completion_event_id: completion_event_id.to_string(),
        }),
    })
    .expect("worker injection must enqueue");

    assert!(injection_outcome.queued, "injection must be queued");
    assert!(!injection_outcome.already_existed, "injection must be new");

    // ── Invariant A: injection queue has exactly one queued record with a
    //    delegationCompletion payload referencing the child event.
    let injection_state =
        replay_worker_injection_queue(daemon_dir).expect("injection queue must replay");
    assert_eq!(
        injection_state.queued.len(),
        1,
        "invariant A: exactly one queued injection record"
    );
    assert!(
        injection_state.sent.is_empty(),
        "invariant A: no sent injection records yet"
    );
    let queued = &injection_state.queued[0];
    assert_eq!(
        queued.status,
        WorkerInjectionQueueStatus::Queued,
        "invariant A: injection status must be queued"
    );
    assert_eq!(
        queued.worker_id, worker_id,
        "invariant A: injection must target the running worker"
    );
    let delegation_compl = queued
        .delegation_completion
        .as_ref()
        .expect("invariant A: injection must carry a delegationCompletion payload");
    assert_eq!(
        delegation_compl.completion_event_id, completion_event_id,
        "invariant A: delegationCompletion must reference the child event"
    );
    assert_eq!(
        delegation_compl.delegation_conversation_id, delegation_conv_id,
        "invariant A: delegationCompletion must reference the delegation conversation"
    );

    // ── Invariant B: dispatch queue has zero records — no second worker spawned.
    let dispatch_state = replay_dispatch_queue(daemon_dir).expect("dispatch queue must replay");
    assert!(
        dispatch_state.queued.is_empty(),
        "invariant B: dispatch queue must be empty — no second agent1 worker spawned"
    );
    assert!(
        dispatch_state.leased.is_empty(),
        "invariant B: no leased dispatch records"
    );
    assert!(
        dispatch_state.terminal.is_empty(),
        "invariant B: no terminal dispatch records"
    );

    // ── Invariant C: RAL journal has the three seed records plus a
    //    DelegationCompleted record, but no new Claimed record.
    let journal =
        read_ral_journal_records(daemon_dir).expect("RAL journal must read after dispatch");
    assert_eq!(
        journal.len(),
        4,
        "invariant C: journal must have 3 seed records + 1 DelegationCompleted"
    );
    let claimed_count = journal
        .iter()
        .filter(|r| matches!(r.event, RalJournalEvent::Claimed { .. }))
        .count();
    assert_eq!(
        claimed_count, 1,
        "invariant C: exactly one Claimed record — no second worker allocated"
    );
    assert!(
        journal
            .iter()
            .any(|r| matches!(r.event, RalJournalEvent::DelegationCompleted { .. })),
        "invariant C: journal must contain a DelegationCompleted record for the parent"
    );
    // Confirm the DelegationCompleted references the correct child event.
    let deleg_completed = journal
        .iter()
        .find(|r| matches!(r.event, RalJournalEvent::DelegationCompleted { .. }))
        .expect("DelegationCompleted must be in journal");
    if let RalJournalEvent::DelegationCompleted {
        identity: deleg_identity,
        completion: deleg_completion,
    } = &deleg_completed.event
    {
        assert_eq!(
            deleg_identity, &identity,
            "invariant C: DelegationCompleted must reference the parent identity"
        );
        assert_eq!(
            deleg_completion.completion_event_id, completion_event_id,
            "invariant C: DelegationCompleted must reference the child completion event"
        );
    }
}
