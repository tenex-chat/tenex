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
use crate::project_event_index::ProjectEventIndex;
use crate::publish_outbox::{PublishOutboxRelayPublisher, PublishOutboxRetryPolicy};
use crate::publish_runtime::{PublishRuntimeMaintainInput, maintain_publish_runtime};
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
            _ = dispatch_enqueued_rx.recv() => {}
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
            Ok(AdmitWorkerDispatchOutcome::Admitted(started)) => {
                let dispatch_id = started.runtime_started.dispatch_id.clone();
                let worker_id = started.runtime_started.worker_id.clone();
                tracing::info!(
                    dispatch_id = %dispatch_id,
                    worker_id = %worker_id,
                    "worker-admission-driver: session admitted"
                );

                let daemon_dir_s = deps.daemon_dir.clone();
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
                let publish_enqueued_tx_s = deps.publish_enqueued_tx.clone();

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
                        );

                        if let Err(ref error) = result {
                            tracing::error!(
                                error = %error,
                                "worker-admission-driver: session returned error"
                            );
                        }
                    });

                    let _ = handle.await;
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
