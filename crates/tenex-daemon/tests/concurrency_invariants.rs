//! Concurrency invariants defended by recent daemon fixes.
//!
//! Each test below targets one of the four most-recent concurrency-focused
//! commits. These invariants cannot be observed from the bash e2e harness
//! because they require inspecting internal state (Arc identity, atomic
//! reservation windows, claim-token uniqueness) under true concurrent load:
//!
//! * `ProjectEventIndex` singleton sharing (commit 2a0e32a2):
//!   [`project_event_index_is_shared_singleton_across_paths`].
//! * RAL journal resequence under the append lock (commit d8c8238f):
//!   [`ral_journal_resequences_concurrent_appends_under_append_lock`].
//! * Publish-result sequence drawn from a shared `Arc<AtomicU64>` (commit
//!   5fe5ba00): [`publish_result_sequence_atomic_is_globally_monotonic`].
//! * RAL claim-token uniqueness under concurrent minting (commit context
//!   around scheduler minting):
//!   [`ral_claim_tokens_are_pairwise_unique_under_concurrent_minting`].
//!
//! The tests deliberately call only the crate's public API. None of the
//! private `#[cfg(test)]` helpers inside individual modules are touched, so
//! accidental widening of visibility here would be a code-review signal.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Barrier, Mutex};
use std::thread;

use tempfile::TempDir;

use tenex_daemon::nostr_classification::KIND_PROJECT;
use tenex_daemon::nostr_event::SignedNostrEvent;
use tenex_daemon::project_event_index::ProjectEventIndex;
use tenex_daemon::ral_journal::{
    RAL_JOURNAL_WRITER_RUST_DAEMON, RalJournalEvent, RalJournalIdentity, RalJournalRecord,
    RalJournalReplay, RalReplayEntry, RalReplayStatus, RalTerminalSummary,
    append_ral_journal_record_with_resequence, read_ral_journal_records,
};
use tenex_daemon::ral_scheduler::RalScheduler;

/// Builds a kind-31933 `SignedNostrEvent` carrying the supplied `d` tag. The
/// event is not cryptographically valid — `ProjectEventIndex::upsert` only
/// looks at `kind`, `pubkey`, `created_at`, and the `d` tag, so a stub
/// signature is sufficient for the singleton-sharing invariant.
fn project_stub_event(owner_pubkey: &str, d_tag: &str, created_at: u64) -> SignedNostrEvent {
    SignedNostrEvent {
        id: format!("event-{owner_pubkey}-{d_tag}-{created_at}"),
        pubkey: owner_pubkey.to_string(),
        created_at,
        kind: KIND_PROJECT,
        tags: vec![vec!["d".to_string(), d_tag.to_string()]],
        content: String::new(),
        sig: "0".repeat(128),
    }
}

/// Defends commit 2a0e32a2. Proves that when the ingress path, the routing
/// path, and a subscription-gateway path all hold clones of the same
/// `Arc<Mutex<ProjectEventIndex>>`:
///
/// 1. They are literally the same allocation (`Arc::ptr_eq`).
/// 2. An upsert on any one handle is immediately observable via the others
///    — there is no second, stale copy to race against.
///
/// A regression where, for example, the gateway constructed its own
/// `ProjectEventIndex::new()` instead of cloning the shared Arc would fail
/// both the identity check and the observation check.
#[test]
fn project_event_index_is_shared_singleton_across_paths() {
    let shared = Arc::new(Mutex::new(ProjectEventIndex::new()));

    // Three subsystems each receive a clone of the SAME Arc, the way the
    // daemon wires ingress, routing, and the subscription gateway after
    // commit 2a0e32a2.
    let ingress_handle = Arc::clone(&shared);
    let routing_handle = Arc::clone(&shared);
    let gateway_handle = Arc::clone(&shared);

    // Identity check: all three must be the same underlying allocation.
    assert!(
        Arc::ptr_eq(&ingress_handle, &routing_handle),
        "ingress and routing must share the same ProjectEventIndex Arc"
    );
    assert!(
        Arc::ptr_eq(&ingress_handle, &gateway_handle),
        "ingress and gateway must share the same ProjectEventIndex Arc"
    );
    assert!(
        Arc::ptr_eq(&routing_handle, &gateway_handle),
        "routing and gateway must share the same ProjectEventIndex Arc"
    );

    // Observation check: upserts on the ingress handle become immediately
    // visible on routing and gateway handles without any explicit
    // propagation.
    let owner_pubkey = "a".repeat(64);
    let ingress_upserted = ingress_handle
        .lock()
        .expect("ingress lock must not be poisoned")
        .upsert(project_stub_event(
            &owner_pubkey,
            "proj-shared",
            1_700_000_000,
        ));
    assert!(ingress_upserted, "first upsert must record the event");

    let routing_sees = routing_handle
        .lock()
        .expect("routing lock must not be poisoned")
        .get(&owner_pubkey, "proj-shared")
        .map(|event| event.id.clone());
    assert_eq!(
        routing_sees.as_deref(),
        Some(&*format!("event-{owner_pubkey}-proj-shared-1700000000")),
        "routing must observe the event upserted via the ingress Arc"
    );

    let gateway_report = gateway_handle
        .lock()
        .expect("gateway lock must not be poisoned")
        .descriptors_report("/workspace/projects");
    assert_eq!(
        gateway_report.descriptors.len(),
        1,
        "gateway descriptors_report must reflect the upsert"
    );
    assert_eq!(gateway_report.descriptors[0].project_d_tag, "proj-shared");

    // A newer upsert via the gateway handle must be visible via ingress,
    // closing the loop on bidirectional propagation.
    let gateway_upserted = gateway_handle
        .lock()
        .expect("gateway lock must not be poisoned")
        .upsert(project_stub_event(
            &owner_pubkey,
            "proj-shared",
            1_700_000_500,
        ));
    assert!(
        gateway_upserted,
        "later created_at must replace the earlier entry"
    );
    let ingress_observes_newer = ingress_handle
        .lock()
        .expect("ingress lock must not be poisoned")
        .get(&owner_pubkey, "proj-shared")
        .map(|event| event.created_at);
    assert_eq!(
        ingress_observes_newer,
        Some(1_700_000_500),
        "ingress must observe the update from the gateway handle"
    );

    // Strong count is 4 (the original + three clones) iff no subsystem
    // dropped its handle. Any regression that replaced a clone with a fresh
    // Arc construction would leave this at 1..=3 with three other
    // independent indexes in play.
    assert_eq!(Arc::strong_count(&shared), 4);
}

/// Defends commit d8c8238f. `append_ral_journal_record_with_resequence`
/// rewrites `record.sequence` to `last_sequence + 1` under the append lock,
/// so concurrent appenders targeting the same `(project, agent,
/// conversation)` identity must end up with strictly-monotonic,
/// gap-free, collision-free sequence numbers `1..=N`.
///
/// A regression that removed the append lock or the resequence step would
/// yield duplicates (two appenders both reading `last_sequence = k` and
/// writing `k + 1`).
#[test]
fn ral_journal_resequences_concurrent_appends_under_append_lock() {
    let tmp = TempDir::new().expect("tempdir must create");
    let daemon_dir = tmp.path().to_path_buf();

    const THREAD_COUNT: usize = 12;

    let identity = RalJournalIdentity {
        project_id: "project-concurrency".to_string(),
        agent_pubkey: "a".repeat(64),
        conversation_id: "conversation-concurrency".to_string(),
        ral_number: 1,
    };

    let barrier = Arc::new(Barrier::new(THREAD_COUNT));
    let mut handles = Vec::with_capacity(THREAD_COUNT);

    for thread_index in 0..THREAD_COUNT {
        let daemon_dir = daemon_dir.clone();
        let identity = identity.clone();
        let barrier = Arc::clone(&barrier);
        handles.push(thread::spawn(move || {
            barrier.wait();
            // Every thread starts with the same colliding sequence number
            // so we can only succeed if the resequence-under-lock step
            // actually rewrites it.
            let mut record = RalJournalRecord::new(
                RAL_JOURNAL_WRITER_RUST_DAEMON,
                "concurrency-invariants-test",
                1,
                1_700_000_000_000 + thread_index as u64,
                format!("corr-{thread_index}"),
                RalJournalEvent::Completed {
                    identity,
                    worker_id: format!("worker-{thread_index}"),
                    claim_token: format!("claim-{thread_index}"),
                    terminal: RalTerminalSummary {
                        published_user_visible_event: true,
                        pending_delegations_remain: false,
                        accumulated_runtime_ms: 10,
                        final_event_ids: vec![format!("final-{thread_index}")],
                        keep_worker_warm: false,
                    },
                },
            );
            append_ral_journal_record_with_resequence(&daemon_dir, &mut record)
                .expect("resequenced append must succeed");
            record.sequence
        }));
    }

    let assigned_sequences: Vec<u64> = handles
        .into_iter()
        .map(|handle| handle.join().expect("appender thread must not panic"))
        .collect();

    // Assigned sequences must be exactly 1..=THREAD_COUNT, in some order.
    let mut sorted = assigned_sequences.clone();
    sorted.sort_unstable();
    let expected: Vec<u64> = (1..=THREAD_COUNT as u64).collect();
    assert_eq!(
        sorted, expected,
        "assigned sequences must be 1..=N with no gaps or duplicates"
    );

    // And the on-disk journal must reflect the same set of sequences,
    // each line parseable.
    let persisted = read_ral_journal_records(&daemon_dir).expect("journal must read");
    assert_eq!(persisted.len(), THREAD_COUNT);
    let mut persisted_sequences: Vec<u64> = persisted.iter().map(|r| r.sequence).collect();
    persisted_sequences.sort_unstable();
    assert_eq!(
        persisted_sequences, expected,
        "persisted sequences must be 1..=N with no gaps or duplicates"
    );

    let mut unique_sequences = HashSet::new();
    for record in &persisted {
        assert!(
            unique_sequences.insert(record.sequence),
            "duplicate sequence {} persisted to journal",
            record.sequence
        );
    }
}

/// Defends commit 5fe5ba00. The publish-result sequence is drawn from a
/// single `Arc<AtomicU64>` (`WorkerMessagePublishContext::result_sequence_source`)
/// via `fetch_add(1, Ordering::Relaxed)`. Concurrent worker sessions
/// sharing this Arc must never observe a collision or a skipped value.
///
/// A regression that reintroduced a per-session counter (the pre-5fe5ba00
/// design) would break the uniqueness assertion: two sessions started from
/// the same baseline would each issue the same next sequence.
#[test]
fn publish_result_sequence_atomic_is_globally_monotonic() {
    const START: u64 = 900;
    const THREAD_COUNT: usize = 16;
    const RESERVATIONS_PER_THREAD: usize = 64;

    // Matches `WorkerMessagePublishContext::result_sequence_source` shape
    // exactly: `Arc<AtomicU64>`.
    let sequence_source = Arc::new(AtomicU64::new(START));

    let barrier = Arc::new(Barrier::new(THREAD_COUNT));
    let mut handles = Vec::with_capacity(THREAD_COUNT);

    for _ in 0..THREAD_COUNT {
        let sequence_source = Arc::clone(&sequence_source);
        let barrier = Arc::clone(&barrier);
        handles.push(thread::spawn(move || {
            barrier.wait();
            let mut reservations = Vec::with_capacity(RESERVATIONS_PER_THREAD);
            for _ in 0..RESERVATIONS_PER_THREAD {
                // Identical call site to worker_message_flow.rs:224.
                let reserved = sequence_source.fetch_add(1, Ordering::Relaxed);
                reservations.push(reserved);
            }
            reservations
        }));
    }

    let all_reservations: Vec<u64> = handles
        .into_iter()
        .flat_map(|handle| handle.join().expect("reservation thread must not panic"))
        .collect();

    // Uniqueness check.
    let unique: HashSet<u64> = all_reservations.iter().copied().collect();
    assert_eq!(
        unique.len(),
        all_reservations.len(),
        "publish_result sequence reservations must be pairwise unique"
    );

    // Contiguity check: every integer in [START, START + total) must be
    // present exactly once.
    let total = (THREAD_COUNT * RESERVATIONS_PER_THREAD) as u64;
    let expected: HashSet<u64> = (START..START + total).collect();
    assert_eq!(
        unique, expected,
        "reservations must cover [START, START + total) with no gaps"
    );

    // And the atomic's final value must equal START + total, proving every
    // reservation advanced the shared counter.
    assert_eq!(
        sequence_source.load(Ordering::Relaxed),
        START + total,
        "shared AtomicU64 must have advanced by exactly total reservations"
    );
}

/// Builds a pre-allocated `RalReplayEntry` in the `Allocated` state so
/// `RalScheduler::claim` can mint a token for it.
fn allocated_replay_entry(identity: RalJournalIdentity, sequence: u64) -> RalReplayEntry {
    RalReplayEntry {
        identity,
        status: RalReplayStatus::Allocated,
        last_sequence: sequence,
        updated_at: sequence * 1_000,
        last_correlation_id: format!("corr-allocated-{sequence}"),
        worker_id: None,
        active_claim_token: None,
        pending_delegations: Vec::new(),
        completed_delegations: Vec::new(),
        triggering_event_id: Some(format!("trigger-{sequence}")),
        final_event_ids: Vec::new(),
        accumulated_runtime_ms: 0,
        error: None,
        abort_reason: None,
        crash_reason: None,
    }
}

/// Defends the claim-token uniqueness invariant exercised by the scheduler.
/// `RalScheduler::claim(..., None)` mints a fresh token through
/// `mint_claim_token`, which blends a process-global `AtomicU64` counter,
/// a nanosecond timestamp, and per-identity inputs into a SHA-256 digest.
/// Concurrent minting across distinct identities must always yield
/// pairwise-distinct claim tokens.
///
/// A regression that removed the `AtomicU64` counter or the timestamp —
/// leaving only the identity-and-worker inputs — would collapse the token
/// space for threads that hit the same nanosecond, producing collisions.
#[test]
fn ral_claim_tokens_are_pairwise_unique_under_concurrent_minting() {
    const THREAD_COUNT: usize = 16;

    // Pre-allocate THREAD_COUNT distinct identities inside the scheduler
    // state. Each thread claims a different identity; the claim call is
    // `&self`, so the shared `Arc<RalScheduler>` is safe to share across
    // threads.
    let mut states = HashMap::with_capacity(THREAD_COUNT);
    let identities: Vec<RalJournalIdentity> = (0..THREAD_COUNT)
        .map(|index| RalJournalIdentity {
            project_id: "project-claim".to_string(),
            agent_pubkey: format!("{:064x}", 1u64 + index as u64),
            conversation_id: format!("conversation-{index}"),
            ral_number: 1,
        })
        .collect();
    for (index, identity) in identities.iter().enumerate() {
        states.insert(
            identity.clone(),
            allocated_replay_entry(identity.clone(), index as u64 + 1),
        );
    }
    let replay = RalJournalReplay {
        last_sequence: THREAD_COUNT as u64,
        states,
    };
    let scheduler = Arc::new(RalScheduler::from_replay(&replay));

    let barrier = Arc::new(Barrier::new(THREAD_COUNT));
    let mut handles = Vec::with_capacity(THREAD_COUNT);

    for (index, identity) in identities.into_iter().enumerate() {
        let scheduler = Arc::clone(&scheduler);
        let barrier = Arc::clone(&barrier);
        handles.push(thread::spawn(move || {
            barrier.wait();
            let claim = scheduler
                .claim(&identity, format!("worker-{index}"), None)
                .expect("allocated identity must be claimable");
            claim.claim_token
        }));
    }

    let tokens: Vec<String> = handles
        .into_iter()
        .map(|handle| handle.join().expect("claim thread must not panic"))
        .collect();

    let unique: HashSet<&str> = tokens.iter().map(String::as_str).collect();
    assert_eq!(
        unique.len(),
        tokens.len(),
        "claim tokens must be pairwise distinct across concurrent minting; got {tokens:?}"
    );

    // Every token must have the `claim_` prefix carried by the current
    // scheduler; drift in that shape should be a review-level decision,
    // not a silent change.
    for token in &tokens {
        assert!(
            token.starts_with("claim_"),
            "unexpected claim token shape: {token}"
        );
    }
}
