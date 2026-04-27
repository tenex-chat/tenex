//! Async driver for worker session admission.
//!
//! Replaces the admit-loop that previously ran inside the central daemon tick.
//! The driver owns a `JoinSet` of in-flight session tasks; when a session
//! finishes it sends a `SessionCompletion` back on the internal channel so the
//! next admission attempt can be triggered immediately.
//!
//! Two external signals wake admission:
//! - `dispatch_enqueued_rx`: a new dispatch record was appended to the
//!   filesystem queue by a producer (nostr ingress, telegram ingress,
//!   scheduled-task maintenance, or delegation-completion path).
//! - `session_completed_rx`: a running session finished, freeing a concurrency
//!   slot that may allow a previously-blocked candidate to be admitted.
//!
//! At shutdown the driver stops accepting new dispatches and awaits the
//! `JoinSet` so no session is orphaned.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::sync::{mpsc, watch};
use tokio::task::JoinSet;

use crate::daemon_signals::{DispatchEnqueued, PublishEnqueued, SessionCompletion};
use crate::daemon_worker_runtime::{
    AdmitWorkerDispatchOutcome, DaemonWorkerFilesystemTerminalInput,
    DaemonWorkerLivePublishMaintenance, DaemonWorkerOperationsStatusRuntimeInput,
    DaemonWorkerTelegramEgressRuntimeInput,
    admit_one_worker_dispatch_from_filesystem, run_started_worker_session_from_filesystem,
};
use crate::warm_worker_runtime::WarmWorkerRegistry;
use crate::dispatch_queue::{
    DispatchQueueLifecycleInput, DispatchQueueStatus, acquire_dispatch_queue_lock,
    append_dispatch_queue_record, plan_dispatch_queue_terminal, replay_dispatch_queue,
};
use crate::project_event_index::ProjectEventIndex;
use crate::publish_outbox::{PublishOutboxRelayPublisher, PublishOutboxRetryPolicy};
use crate::publish_runtime::{PublishRuntimeMaintainInput, maintain_publish_runtime};
use crate::ral_journal::{
    RAL_JOURNAL_WRITER_RUST_DAEMON, RalJournalEvent, RalJournalIdentity, RalJournalRecord,
    append_ral_journal_record_with_resequence,
};
use crate::ral_lock::RalLockInfo;
use crate::worker_dispatch::execution::AgentWorkerProcessDispatchSpawner;
use crate::worker_message_flow::WorkerMessagePublishContext;
use crate::worker_process::{AgentWorkerCommand, AgentWorkerProcessConfig};
use crate::worker_runtime_state::SharedWorkerRuntimeState;

pub struct WorkerAdmissionDriverDeps<P> {
    pub daemon_dir: PathBuf,
    pub tenex_base_dir: PathBuf,
    pub runtime_state: SharedWorkerRuntimeState,
    pub lock_owner: RalLockInfo,
    pub worker_command: AgentWorkerCommand,
    pub worker_config: AgentWorkerProcessConfig,
    pub writer_version: String,
    pub publisher: Arc<Mutex<P>>,
    pub retry_policy: PublishOutboxRetryPolicy,
    pub publish_result_sequence: Arc<AtomicU64>,
    pub project_event_index: Arc<Mutex<ProjectEventIndex>>,
    pub publish_enqueued_tx: Option<mpsc::UnboundedSender<PublishEnqueued>>,
    pub warm_registry: WarmWorkerRegistry,
}

pub async fn run_worker_admission_driver<P>(
    deps: WorkerAdmissionDriverDeps<P>,
    mut dispatch_enqueued_rx: mpsc::UnboundedReceiver<DispatchEnqueued>,
    mut session_completed_rx: mpsc::UnboundedReceiver<SessionCompletion>,
    mut shutdown_rx: watch::Receiver<bool>,
) where
    P: PublishOutboxRelayPublisher + Send + 'static,
{
    // Internal channel: the per-session adapter task sends SessionCompletion
    // back so the outer loop wakes immediately when a slot is freed.
    let (internal_tx, mut internal_rx) = mpsc::unbounded_channel::<SessionCompletion>();

    let mut join_set: JoinSet<()> = JoinSet::new();

    loop {
        // Drain the admit-loop until NotAdmitted.
        drain_admit_loop(&deps, &internal_tx, &mut join_set).await;

        // Wait for any signal that could change admission eligibility.
        tokio::select! {
            _ = dispatch_enqueued_rx.recv() => {
                // Yield once so any other tasks that are already ready (e.g. a
                // second inbound dispatch arriving on the same relay batch) can
                // run and append their own queue entries before we call
                // drain_admit_loop.  This batches concurrent arrivals into a
                // single drain pass and gives both workers a chance to be
                // admitted together instead of sequentially.
                tokio::task::yield_now().await;
            }
            _ = session_completed_rx.recv() => {}
            _ = internal_rx.recv() => {}
            _ = shutdown_rx.changed() => break,
        }
    }

    // Shutdown: join all in-flight sessions.
    while join_set.join_next().await.is_some() {}
}

async fn drain_admit_loop<P>(
    deps: &WorkerAdmissionDriverDeps<P>,
    completion_tx: &mpsc::UnboundedSender<SessionCompletion>,
    join_set: &mut JoinSet<()>,
) where
    P: PublishOutboxRelayPublisher + Send + 'static,
{
    let now_ms = current_unix_time_ms();
    let telegram_egress = build_telegram_egress(&deps.tenex_base_dir, &deps.writer_version);
    let operations_status_pubkeys = build_operations_status_pubkeys(deps);

    let mut admitted_count = 0usize;
    loop {
        let correlation_id =
            format!("worker-admission-driver:{}:admission-{}", now_ms, admitted_count);

        let daemon_dir = deps.daemon_dir.clone();
        let runtime_state = deps.runtime_state.clone();
        let lock_owner = deps.lock_owner.clone();
        let worker_command = deps.worker_command.clone();
        let worker_config = deps.worker_config.clone();
        let correlation_id_cloned = correlation_id.clone();

        let warm_registry_admit = deps.warm_registry.clone();
        let writer_version_admit = deps.writer_version.clone();
        let admit_result = tokio::task::spawn_blocking(move || {
            let mut spawner = AgentWorkerProcessDispatchSpawner;
            admit_one_worker_dispatch_from_filesystem(
                &mut spawner,
                &daemon_dir,
                &runtime_state,
                now_ms,
                &correlation_id_cloned,
                lock_owner,
                worker_command,
                &worker_config,
                &warm_registry_admit,
                &writer_version_admit,
            )
        })
        .await;

        let outcome = match admit_result {
            Ok(result) => result,
            Err(join_error) => {
                tracing::error!(
                    error = %join_error,
                    "worker-admission-driver: admit spawn_blocking panicked"
                );
                return;
            }
        };

        match outcome {
            Err(error) => {
                tracing::error!(
                    error = %error,
                    "worker-admission-driver: admit_one_worker_dispatch_from_filesystem failed"
                );
                return;
            }
            Ok(AdmitWorkerDispatchOutcome::NotAdmitted { reason, .. }) => {
                tracing::debug!(
                    reason = ?reason,
                    "worker-admission-driver: not admitted; waiting for signal"
                );
                return;
            }
            Ok(AdmitWorkerDispatchOutcome::InjectedIntoWarmWorker {
                dispatch_id,
                worker_id,
            }) => {
                tracing::info!(
                    dispatch_id = %dispatch_id,
                    worker_id = %worker_id,
                    "worker-admission-driver: dispatch injected into warm worker"
                );
                admitted_count += 1;
                continue;
            }
            Ok(AdmitWorkerDispatchOutcome::Admitted(started)) => {
                let dispatch_id = started.runtime_started.dispatch_id.clone();
                let worker_id = started.runtime_started.worker_id.clone();
                let identity = started.runtime_started.identity.clone();
                let claim_token = started.runtime_started.claim_token.clone();
                tracing::info!(
                    dispatch_id = %dispatch_id,
                    worker_id = %worker_id,
                    "worker-admission-driver: session admitted"
                );

                let daemon_dir_s = deps.daemon_dir.clone();
                let daemon_dir_panic = deps.daemon_dir.clone();
                let runtime_state_s = deps.runtime_state.clone();
                let publisher_s = Arc::clone(&deps.publisher);
                let retry_policy_s = deps.retry_policy;
                let publish_seq_s = Arc::clone(&deps.publish_result_sequence);
                let telegram_egress_s = telegram_egress.clone();
                let ops_pubkeys_s = operations_status_pubkeys.clone();
                let tenex_base_dir_s = deps.tenex_base_dir.clone();
                let writer_version_s = deps.writer_version.clone();
                let dispatch_correlation_id =
                    format!("worker-admission-driver:{}:complete-{}", now_ms, admitted_count);
                let tx = completion_tx.clone();
                let warm_exec_tx = completion_tx.clone();
                let publish_enqueued_tx_s = deps.publish_enqueued_tx.clone();
                let warm_registry_s = deps.warm_registry.clone();

                join_set.spawn(async move {
                    let handle = tokio::task::spawn_blocking(move || {
                        let publisher_live = Arc::clone(&publisher_s);
                        let mut live_maintain = move |daemon_dir: &std::path::Path, now: u64| {
                            let mut guard =
                                publisher_live.lock().expect("publisher mutex poisoned");
                            maintain_publish_runtime(PublishRuntimeMaintainInput {
                                daemon_dir,
                                publisher: &mut *guard,
                                now,
                                retry_policy: retry_policy_s,
                            })
                            .map(|_| ())
                            .map_err(|e| e.to_string())
                        };

                        let publish_ctx = WorkerMessagePublishContext {
                            accepted_at: now_ms,
                            result_sequence_source: publish_seq_s,
                            result_timestamp: now_ms,
                            telegram_egress: None,
                            publish_enqueued_tx: publish_enqueued_tx_s,
                        };

                        let operations_status = DaemonWorkerOperationsStatusRuntimeInput {
                            tenex_base_dir: &tenex_base_dir_s,
                            project_owner_pubkeys: &ops_pubkeys_s,
                        };

                        let result = run_started_worker_session_from_filesystem(
                            &daemon_dir_s,
                            &runtime_state_s,
                            now_ms,
                            Some(publish_ctx),
                            telegram_egress_s,
                            Some(operations_status),
                            Some(DaemonWorkerLivePublishMaintenance {
                                maintain: &mut live_maintain,
                            }),
                            DaemonWorkerFilesystemTerminalInput {
                                timestamp: now_ms,
                                writer_version: writer_version_s,
                                resolved_pending_delegations: Vec::new(),
                                dispatch_correlation_id,
                            },
                            started,
                            Some(warm_exec_tx),
                        );

                        if let Err(ref error) = result {
                            tracing::error!(
                                error = %error,
                                "worker-admission-driver: session returned error"
                            );
                        }
                    });

                    match handle.await {
                        Ok(()) => {}
                        Err(join_error) => {
                            tracing::error!(
                                dispatch_id = %dispatch_id,
                                worker_id = %worker_id,
                                error = %join_error,
                                "worker-admission-driver: session spawn_blocking panicked; writing crash terminal"
                            );
                            write_panic_terminal_records(
                                &daemon_dir_panic,
                                &identity,
                                &worker_id,
                                &dispatch_id,
                                &claim_token,
                                now_ms,
                            );
                        }
                    }
                    // The session task has ended; remove this worker from the warm
                    // registry so future admissions don't attempt to inject into a
                    // dead channel.
                    warm_registry_s.remove(&worker_id);
                    let _ = tx.send(SessionCompletion);
                });

                admitted_count += 1;
            }
        }
    }
}

fn build_operations_status_pubkeys<P>(
    deps: &WorkerAdmissionDriverDeps<P>,
) -> BTreeMap<String, String>
where
    P: PublishOutboxRelayPublisher + Send + 'static,
{
    use crate::backend_config::read_backend_config;

    let projects_base = read_backend_config(&deps.tenex_base_dir)
        .ok()
        .and_then(|c| c.projects_base.clone())
        .unwrap_or_else(|| "/tmp/tenex-projects".to_string());

    deps.project_event_index
        .lock()
        .expect("project event index mutex must not be poisoned")
        .descriptors_report(&projects_base)
        .descriptors
        .into_iter()
        .map(|d| (d.project_d_tag, d.project_owner_pubkey))
        .collect()
}

fn build_telegram_egress(
    tenex_base_dir: &std::path::Path,
    writer_version: &str,
) -> Option<DaemonWorkerTelegramEgressRuntimeInput> {
    use crate::backend_config::read_backend_config;

    let backend_pubkey = match read_backend_config(tenex_base_dir)
        .and_then(|config| config.backend_signer())
        .map(|signer| signer.pubkey_hex().to_string())
    {
        Ok(pubkey) => pubkey,
        Err(error) => {
            tracing::warn!(
                error = %error,
                "worker-admission-driver: telegram egress context unavailable"
            );
            return None;
        }
    };

    Some(DaemonWorkerTelegramEgressRuntimeInput {
        data_dir: tenex_base_dir.join("data"),
        backend_pubkey,
        writer_version: writer_version.to_string(),
    })
}

fn current_unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time must be after UNIX_EPOCH")
        .as_millis() as u64
}

/// Called when a `spawn_blocking` session task panics. Writes a `Crashed` RAL
/// terminal record and cancels the leased dispatch so neither the journal nor
/// the queue stays stuck in an active state forever.
///
/// Errors are logged and swallowed — this is best-effort cleanup after a panic;
/// there is nothing the caller can do about a secondary write failure.
fn write_panic_terminal_records(
    daemon_dir: &std::path::Path,
    identity: &RalJournalIdentity,
    worker_id: &str,
    dispatch_id: &str,
    claim_token: &str,
    timestamp: u64,
) {
    let correlation_id = format!("panic-terminal:{dispatch_id}");

    let mut crash_record = RalJournalRecord::new(
        RAL_JOURNAL_WRITER_RUST_DAEMON,
        "worker-admission-driver",
        0, // resequenced under the append lock
        timestamp,
        &correlation_id,
        RalJournalEvent::Crashed {
            identity: identity.clone(),
            worker_id: worker_id.to_string(),
            claim_token: Some(claim_token.to_string()),
            crash_reason: "spawn_blocking panicked; JoinError detected".to_string(),
            last_heartbeat_at: None,
        },
    );

    if let Err(error) = append_ral_journal_record_with_resequence(daemon_dir, &mut crash_record) {
        tracing::error!(
            dispatch_id = %dispatch_id,
            worker_id = %worker_id,
            error = %error,
            "write_panic_terminal_records: failed to write Crashed RAL record after panic"
        );
    }

    // Cancel the leased dispatch so the queue is no longer stuck.
    let cancel_result = (|| {
        let _lock = acquire_dispatch_queue_lock(daemon_dir)?;
        let state = replay_dispatch_queue(daemon_dir)?;
        let cancelled = plan_dispatch_queue_terminal(
            &state,
            DispatchQueueLifecycleInput {
                dispatch_id: dispatch_id.to_string(),
                sequence: state.last_sequence + 1,
                timestamp,
                correlation_id: correlation_id.clone(),
            },
            DispatchQueueStatus::Cancelled,
        )?;
        append_dispatch_queue_record(daemon_dir, &cancelled)
    })();

    if let Err(error) = cancel_result {
        tracing::error!(
            dispatch_id = %dispatch_id,
            worker_id = %worker_id,
            error = %error,
            "write_panic_terminal_records: failed to cancel leased dispatch after panic"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch_queue::{
        DispatchQueueRecordParams, DispatchQueueStatus, DispatchRalIdentity,
        append_dispatch_queue_record, build_dispatch_queue_record, replay_dispatch_queue,
    };
    use crate::ral_journal::{RalJournalEvent, RalReplayStatus, replay_ral_journal};
    use std::sync::atomic::Ordering;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    static TEMP_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    fn unique_temp_daemon_dir() -> std::path::PathBuf {
        let index = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "tenex-admission-driver-{}-{index}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or(Duration::from_secs(0))
                .as_nanos()
        ))
    }

    fn cleanup_temp_dir(path: std::path::PathBuf) {
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn write_panic_terminal_records_writes_crash_ral_and_cancels_leased_dispatch() {
        let daemon_dir = unique_temp_daemon_dir();
        let identity = RalJournalIdentity {
            project_id: "project-panic".to_string(),
            agent_pubkey: "a".repeat(64),
            conversation_id: "conversation-panic".to_string(),
            ral_number: 1,
        };
        let dispatch_id = "dispatch-panic";
        let claim_token = "claim-panic";
        let worker_id = "worker-panic";
        let timestamp = 1_710_000_700_000_u64;

        // Seed an Allocated + Claimed RAL record so the journal has an active entry.
        use crate::ral_journal::{
            RAL_JOURNAL_WRITER_RUST_DAEMON, RalJournalRecord, append_ral_journal_record,
        };
        append_ral_journal_record(
            &daemon_dir,
            &RalJournalRecord::new(
                RAL_JOURNAL_WRITER_RUST_DAEMON,
                "test",
                1,
                timestamp,
                "seed-alloc",
                RalJournalEvent::Allocated {
                    identity: identity.clone(),
                    triggering_event_id: Some("event-panic".to_string()),
                },
            ),
        )
        .expect("seed allocated must append");
        append_ral_journal_record(
            &daemon_dir,
            &RalJournalRecord::new(
                RAL_JOURNAL_WRITER_RUST_DAEMON,
                "test",
                2,
                timestamp + 1,
                "seed-claim",
                RalJournalEvent::Claimed {
                    identity: identity.clone(),
                    worker_id: worker_id.to_string(),
                    claim_token: claim_token.to_string(),
                },
            ),
        )
        .expect("seed claimed must append");

        // Seed a leased dispatch record.
        let leased = build_dispatch_queue_record(DispatchQueueRecordParams {
            sequence: 1,
            timestamp,
            correlation_id: "seed-lease".to_string(),
            dispatch_id: dispatch_id.to_string(),
            ral: DispatchRalIdentity {
                project_id: identity.project_id.clone(),
                agent_pubkey: identity.agent_pubkey.clone(),
                conversation_id: identity.conversation_id.clone(),
                ral_number: identity.ral_number,
            },
            triggering_event_id: "event-panic".to_string(),
            claim_token: claim_token.to_string(),
            status: DispatchQueueStatus::Leased,
        });
        append_dispatch_queue_record(&daemon_dir, &leased).expect("seed lease must append");

        // Simulate what happens when spawn_blocking panics.
        write_panic_terminal_records(
            &daemon_dir,
            &identity,
            worker_id,
            dispatch_id,
            claim_token,
            timestamp + 100,
        );

        // Verify: RAL journal has a Crashed terminal entry.
        let ral = replay_ral_journal(&daemon_dir).expect("RAL journal must replay");
        let entry = ral
            .states
            .get(&identity)
            .expect("RAL entry must exist after crash");
        assert_eq!(
            entry.status,
            RalReplayStatus::Crashed,
            "RAL entry must be Crashed after panic terminal"
        );

        // Verify: dispatch queue entry is Cancelled (no longer Leased).
        let queue = replay_dispatch_queue(&daemon_dir).expect("dispatch queue must replay");
        assert!(
            queue.leased.is_empty(),
            "no dispatch must remain leased after panic terminal"
        );
        assert_eq!(
            queue.terminal.len(),
            1,
            "dispatch must have one terminal record"
        );
        assert_eq!(
            queue.terminal[0].status,
            DispatchQueueStatus::Cancelled,
            "panicked dispatch must be Cancelled"
        );

        cleanup_temp_dir(daemon_dir);
    }
}
