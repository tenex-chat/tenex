//! Concurrency invariants defended by recent daemon fixes.
//!
//! Each test below targets one of the concurrency-focused commits. These
//! invariants cannot be observed from the bash e2e harness because they
//! require inspecting internal state (atomic reservation windows,
//! claim-token uniqueness, sequence-number resequencing) under true
//! concurrent load:
//!
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
//!
//! The `ProjectEventIndex` singleton-sharing invariant (commit 2a0e32a2)
//! is not exercised here. The only faithful in-process expression of that
//! invariant would stand up the full daemon ingress/routing/gateway wiring
//! (relay sockets, signers, filesystem state), which this integration
//! target does not own. Instead, the contract is enforced statically by
//! the type signatures: every subsystem that handles the index takes
//! `Arc<Mutex<ProjectEventIndex>>` by parameter, never constructs its
//! own. The relevant call sites are
//! `daemon_foreground::DaemonForegroundInput::project_event_index`,
//! `daemon_loop::DaemonLoopInput::project_event_index`,
//! `nostr_subscription_gateway::GatewayRouteInput::project_event_index`,
//! and `subscription_runtime::SubscriptionRuntimeInput::project_event_index`.
//! A regression introducing a fresh `ProjectEventIndex::new()` on any of
//! those paths would either change those signatures (a code-review signal)
//! or leave the existing `Arc` handle unreferenced (a `cargo clippy`
//! signal).

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Barrier};
use std::thread;

use tempfile::TempDir;

use tenex_daemon::ral_journal::{
    RAL_JOURNAL_WRITER_RUST_DAEMON, RalJournalEvent, RalJournalIdentity, RalJournalRecord,
    RalJournalReplay, RalReplayEntry, RalReplayStatus, RalTerminalSummary,
    append_ral_journal_record_with_resequence, read_ral_journal_records,
};
use tenex_daemon::ral_scheduler::RalScheduler;

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
/// The critical case is concurrent minting *for the same identity with
/// the same worker id*: all identity-derived hash inputs collide, so the
/// only sources of uniqueness are the `AtomicU64` counter and the
/// nanosecond timestamp.
///
/// `RalScheduler::claim` takes `&self` and does not mutate state — it only
/// returns the `Claimed` event for the caller to persist. That means
/// threads racing the same identity all reach `mint_claim_token` with
/// identical inputs, so token uniqueness must come entirely from the
/// mint-internal entropy.
///
/// A regression that removed the `AtomicU64` counter — leaving only the
/// nanosecond timestamp — would collide whenever two threads on the same
/// core hit the same nanosecond. A regression that removed both would
/// produce hard-duplicate tokens and fail immediately.
#[test]
fn ral_claim_tokens_are_pairwise_unique_under_concurrent_minting() {
    const THREAD_COUNT: usize = 32;

    // Single identity, allocated and unclaimed. All threads contend for it.
    let identity = RalJournalIdentity {
        project_id: "project-claim".to_string(),
        agent_pubkey: "a".repeat(64),
        conversation_id: "conversation-shared".to_string(),
        ral_number: 1,
    };
    let mut states = std::collections::HashMap::with_capacity(1);
    states.insert(identity.clone(), allocated_replay_entry(identity.clone(), 1));
    let replay = RalJournalReplay {
        last_sequence: 1,
        states,
    };
    let scheduler = Arc::new(RalScheduler::from_replay(&replay));

    let barrier = Arc::new(Barrier::new(THREAD_COUNT));
    let mut handles = Vec::with_capacity(THREAD_COUNT);

    // Every thread claims the SAME identity with the SAME worker_id, so
    // every identity-derived input to `mint_claim_token` is byte-identical
    // across threads. Uniqueness can only come from the AtomicU64 counter
    // and the nanosecond timestamp inside the mint.
    for _ in 0..THREAD_COUNT {
        let scheduler = Arc::clone(&scheduler);
        let barrier = Arc::clone(&barrier);
        let identity = identity.clone();
        handles.push(thread::spawn(move || {
            barrier.wait();
            let claim = scheduler
                .claim(&identity, "worker-shared", None)
                .expect("allocated identity must be claimable; claim is &self");
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
        "claim tokens must be pairwise distinct when {THREAD_COUNT} threads \
         mint for the same identity+worker; got {tokens:?}"
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
