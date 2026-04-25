//! Wiring for the NIP-46 + kind-14199 whitelist reconciler.
//!
//! Builds the shared `Arc<_>` handles used by the subscription gateway
//! ingress, the heartbeat latch gate on the backend-events tick, and the
//! background supervisor threads (reconciler + agent-inventory poller)
//! that drive the outbound 14199 publishes. Also owns the SIGHUP-triggered
//! reload primitive that swaps the whitelisted owner set in place without
//! restarting any supervisor thread.
//!
//! The binary entrypoint reaches this module for construction and for the
//! reload primitive. The SIGHUP watcher thread itself remains in the
//! binary because it reads process-global signal-driven atomics.

use std::path::Path;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use tokio::sync::{mpsc, watch};
use tokio::sync::mpsc::UnboundedSender;
use tokio::task::JoinHandle;

use thiserror::Error;

use crate::backend_config::read_backend_config;
use crate::backend_heartbeat_latch::BackendHeartbeatLatchPlanner;
use crate::nip46::client::PublishOutboxHandle;
use crate::nip46::outbox_adapter::PublishOutboxAdapter;
use crate::nip46::pending::PendingNip46Requests;
use crate::nip46::protocol::NIP46_KIND;
use crate::nip46::registry::NIP46Registry;
use crate::project_agent_whitelist::ingress::WhitelistIngress;
use crate::project_agent_whitelist::reconciler::{ReconcilerDeps, run_reconciler_loop};
use crate::project_agent_whitelist::snapshot_state::SnapshotState;
use crate::project_agent_whitelist::trigger_source::AgentInventoryPoller;
use crate::daemon_signals::PublishEnqueued;
use crate::publish_outbox::cancel_pending_publish_outbox_records_matching;

/// Debounce window applied to the reconciler trigger channel.
pub const WHITELIST_RECONCILER_DEBOUNCE: Duration = Duration::from_secs(5);
/// Idle-retry window used by the reconciler when no triggers arrive.
pub const WHITELIST_RECONCILER_IDLE_RETRY: Duration = Duration::from_secs(300);
/// Poll interval for the agent-inventory poller that drives the reconciler.
pub const WHITELIST_POLLER_INTERVAL: Duration = Duration::from_secs(2);

#[derive(Debug, Error)]
pub enum WhitelistWiringError {
    #[error("backend config read failed: {0}")]
    BackendConfig(String),
    #[error("backend signer derivation failed: {0}")]
    BackendSigner(String),
    #[error("stale NIP-46 publish cancellation failed: {0}")]
    CancelStaleNip46(String),
}

/// Wiring bundle kept alive for the life of the daemon process.
///
/// Holds the shared `Arc<_>` handles used by the subscription gateway
/// ingress, the heartbeat latch gate on the backend-events tick, and the
/// background supervisor threads (reconciler + agent-inventory poller)
/// that drive the outbound 14199 publishes.
///
/// The `reconciler_owners` and `poller_owners` handles are the same
/// `Arc<RwLock<Vec<String>>>` passed to `ReconcilerDeps` and
/// `AgentInventoryPoller`; SIGHUP-driven config reload swaps both in place
/// without restarting the supervisor threads.
pub struct WhitelistWiring {
    pub ingress: Arc<WhitelistIngress>,
    pub heartbeat_latch: Arc<Mutex<BackendHeartbeatLatchPlanner>>,
    pub nip46_registry: Arc<NIP46Registry>,
    pub reconciler_owners: Arc<RwLock<Vec<String>>>,
    pub poller_owners: Arc<RwLock<Vec<String>>>,
    /// Kept alive so that the trigger channel stays open while the wiring lives.
    _trigger_tx: mpsc::Sender<String>,
    /// Signals both tasks to exit gracefully on shutdown.
    pub shutdown_tx: watch::Sender<bool>,
    pub reconciler_task: JoinHandle<()>,
    pub poller_task: JoinHandle<()>,
}

/// Sharable bundle of the reload-relevant handles inside
/// [`WhitelistWiring`]. Cloning the bundle clones `Arc`s, so the reload
/// watcher thread can hold its own copy without preventing shutdown.
#[derive(Clone)]
pub struct WhitelistReloadHandle {
    pub heartbeat_latch: Arc<Mutex<BackendHeartbeatLatchPlanner>>,
    pub nip46_registry: Arc<NIP46Registry>,
    pub reconciler_owners: Arc<RwLock<Vec<String>>>,
    pub poller_owners: Arc<RwLock<Vec<String>>>,
}

impl WhitelistWiring {
    pub fn reload_handle(&self) -> WhitelistReloadHandle {
        WhitelistReloadHandle {
            heartbeat_latch: Arc::clone(&self.heartbeat_latch),
            nip46_registry: Arc::clone(&self.nip46_registry),
            reconciler_owners: Arc::clone(&self.reconciler_owners),
            poller_owners: Arc::clone(&self.poller_owners),
        }
    }
}

/// Outcome reported by [`reload_whitelist_from_handle`]. Exposes enough to
/// log the reload at `info!` and lets tests assert that the swap happened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReloadOutcome {
    pub previous_owner_count: usize,
    pub new_owner_count: usize,
    pub nip46_clients_cleared: bool,
}

#[derive(Debug, Error)]
pub enum ReloadError {
    #[error("reload config read failed: {0}")]
    Config(String),
}

pub fn build_whitelist_wiring(
    tenex_base_dir: &Path,
    daemon_dir: &Path,
    runtime_handle: &tokio::runtime::Handle,
    publish_enqueued_tx: Option<UnboundedSender<PublishEnqueued>>,
) -> Result<Option<WhitelistWiring>, WhitelistWiringError> {
    let config = read_backend_config(tenex_base_dir)
        .map_err(|error| WhitelistWiringError::BackendConfig(error.to_string()))?;
    if config.whitelisted_pubkeys.is_empty() {
        tracing::info!(
            "no whitelisted pubkeys configured; skipping NIP-46 + 14199 reconciler wiring"
        );
        return Ok(None);
    }

    let backend_signer = Arc::new(
        config
            .backend_signer()
            .map_err(|error| WhitelistWiringError::BackendSigner(error.to_string()))?,
    );
    let backend_pubkey = backend_signer.pubkey_hex().to_string();
    cancel_stale_nip46_publish_requests(daemon_dir, &backend_pubkey)?;

    let pending = PendingNip46Requests::default();
    let mut outbox_adapter = PublishOutboxAdapter::new(daemon_dir.to_path_buf());
    if let Some(tx) = publish_enqueued_tx {
        outbox_adapter = outbox_adapter.with_publish_enqueued_tx(tx);
    }
    let outbox_handle: Arc<dyn PublishOutboxHandle + Send + Sync> = Arc::new(outbox_adapter);

    let nip46_registry = Arc::new(NIP46Registry::new(
        Arc::clone(&backend_signer),
        pending,
        Arc::clone(&outbox_handle),
    ));

    let snapshot_state = Arc::new(SnapshotState::default());
    let heartbeat_latch = Arc::new(Mutex::new(BackendHeartbeatLatchPlanner::new(
        backend_pubkey.clone(),
        config.whitelisted_pubkeys.clone(),
    )));

    let (trigger_tx, trigger_rx) = mpsc::channel::<String>(256);
    let (shutdown_tx, shutdown_rx_reconciler) = watch::channel(false);
    let shutdown_rx_poller = shutdown_tx.subscribe();

    let reconciler_owners = Arc::new(RwLock::new(config.whitelisted_pubkeys.clone()));
    let poller_owners = Arc::new(RwLock::new(config.whitelisted_pubkeys.clone()));
    let ingress = Arc::new(WhitelistIngress {
        snapshot_state: Arc::clone(&snapshot_state),
        heartbeat_latch: Arc::clone(&heartbeat_latch),
        owners: Arc::clone(&reconciler_owners),
        reconciler_trigger: trigger_tx.clone(),
        nip46_registry: Arc::clone(&nip46_registry),
    });

    let default_relay = config
        .effective_relay_urls()
        .first()
        .cloned()
        .unwrap_or_default();
    let reconciler_deps = ReconcilerDeps {
        tenex_base_dir: tenex_base_dir.to_path_buf(),
        backend_pubkey,
        owners: Arc::clone(&reconciler_owners),
        snapshot_state,
        nip46_registry: Arc::clone(&nip46_registry),
        nip46_config: config.nip46.clone(),
        default_relay,
        outbox: outbox_handle,
        debounce: WHITELIST_RECONCILER_DEBOUNCE,
        idle_retry: WHITELIST_RECONCILER_IDLE_RETRY,
    };

    let reconciler_task =
        runtime_handle.spawn(run_reconciler_loop(reconciler_deps, trigger_rx, shutdown_rx_reconciler));

    let poller = AgentInventoryPoller {
        tenex_base_dir: tenex_base_dir.to_path_buf(),
        owners: Arc::clone(&poller_owners),
        interval: WHITELIST_POLLER_INTERVAL,
        trigger_tx: trigger_tx.clone(),
    };
    let poller_task = runtime_handle.spawn(poller.run_forever(shutdown_rx_poller));

    Ok(Some(WhitelistWiring {
        ingress,
        heartbeat_latch,
        nip46_registry,
        reconciler_owners,
        poller_owners,
        _trigger_tx: trigger_tx,
        shutdown_tx,
        reconciler_task,
        poller_task,
    }))
}

fn cancel_stale_nip46_publish_requests(
    daemon_dir: &Path,
    backend_pubkey: &str,
) -> Result<(), WhitelistWiringError> {
    let cancelled = cancel_pending_publish_outbox_records_matching(daemon_dir, |record| {
        record.event.kind == NIP46_KIND
            && record.event.pubkey == backend_pubkey
            && record.request.request_id.starts_with("nip46:")
    })
    .map_err(|error| WhitelistWiringError::CancelStaleNip46(error.to_string()))?;

    if !cancelled.is_empty() {
        tracing::warn!(
            cancelled_count = cancelled.len(),
            "cancelled stale pending NIP-46 publish requests from previous daemon session"
        );
    }

    Ok(())
}

/// Re-read `config.json`, clear the NIP-46 client cache, and swap the
/// whitelisted owner sets in the reconciler, the agent inventory poller, and
/// the heartbeat latch — all without restarting any supervisor thread. The
/// heartbeat latch's own `replace_owners` preserves a latched `Stopped`
/// state: owners that have already sent a stop snapshot stay stopped even
/// when the whitelist changes.
pub fn reload_whitelist_from_handle(
    tenex_base_dir: &Path,
    handle: &WhitelistReloadHandle,
) -> Result<ReloadOutcome, ReloadError> {
    let config = read_backend_config(tenex_base_dir)
        .map_err(|error| ReloadError::Config(error.to_string()))?;
    let new_owners = config.whitelisted_pubkeys;

    let previous_owner_count = handle
        .reconciler_owners
        .read()
        .expect("reconciler owners lock must not be poisoned")
        .len();

    handle.nip46_registry.reload();

    {
        let mut guard = handle
            .reconciler_owners
            .write()
            .expect("reconciler owners lock must not be poisoned");
        *guard = new_owners.clone();
    }
    {
        let mut guard = handle
            .poller_owners
            .write()
            .expect("poller owners lock must not be poisoned");
        *guard = new_owners.clone();
    }
    {
        let mut latch = handle
            .heartbeat_latch
            .lock()
            .expect("heartbeat latch lock must not be poisoned");
        latch.replace_owners(new_owners.clone());
    }

    let new_owner_count = new_owners.len();
    tracing::info!(
        previous_owner_count,
        new_owner_count,
        "whitelist wiring reloaded after SIGHUP"
    );

    Ok(ReloadOutcome {
        previous_owner_count,
        new_owner_count,
        nip46_clients_cleared: true,
    })
}

/// Synchronous reload entry point used by tests that drive the reload from
/// a single owning [`WhitelistWiring`] handle. The production daemon drives
/// reload through the SIGHUP watcher thread via
/// [`reload_whitelist_from_handle`].
pub fn reload_whitelist_wiring(
    tenex_base_dir: &Path,
    wiring: &WhitelistWiring,
) -> Result<ReloadOutcome, ReloadError> {
    reload_whitelist_from_handle(tenex_base_dir, &wiring.reload_handle())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const TEST_SECRET_KEY_HEX: &str =
        "0101010101010101010101010101010101010101010101010101010101010101";

    fn write_backend_config(tenex_base_dir: &Path, owners: &[String]) {
        let daemon_dir = tenex_base_dir.join("daemon");
        let agents_dir = tenex_base_dir.join("agents");
        fs::create_dir_all(&daemon_dir).expect("daemon dir must create");
        fs::create_dir_all(&agents_dir).expect("agents dir must create");
        let owners_json = serde_json::to_string(owners).expect("owners must serialize");
        fs::write(
            tenex_base_dir.join("config.json"),
            format!(
                r#"{{
                    "whitelistedPubkeys": {owners_json},
                    "tenexPrivateKey": "{TEST_SECRET_KEY_HEX}",
                    "relays": ["wss://relay.one"]
                }}"#
            ),
        )
        .expect("config must write");
    }

    fn owner_pubkey() -> String {
        use secp256k1::{Keypair, Secp256k1, SecretKey};
        let secret = SecretKey::from_byte_array([0x02_u8; 32]).expect("valid secret");
        let secp = Secp256k1::new();
        let keypair = Keypair::from_secret_key(&secp, &secret);
        let (xonly, _) = keypair.x_only_public_key();
        hex::encode(xonly.serialize())
    }

    /// Proves that the abandoned-thread regression is fixed: constructing a
    /// WhitelistWiring, sending `true` on the shutdown channel, and awaiting
    /// both task handles completes within 1 second without either task
    /// blocking.
    #[tokio::test]
    async fn shutdown_tx_causes_both_tasks_to_exit_within_one_second() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let tenex_base_dir = std::env::temp_dir()
            .join(format!("tenex-wiring-shutdown-{nanos}-{}", std::process::id()));
        let daemon_dir = tenex_base_dir.join("daemon");

        let owner = owner_pubkey();
        write_backend_config(&tenex_base_dir, &[owner]);

        let runtime_handle = tokio::runtime::Handle::current();
        let wiring = build_whitelist_wiring(&tenex_base_dir, &daemon_dir, &runtime_handle, None)
            .expect("wiring must build")
            .expect("non-empty whitelist must produce wiring");

        wiring.shutdown_tx.send(true).expect("shutdown send must succeed");

        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            let _ = wiring.reconciler_task.await;
            let _ = wiring.poller_task.await;
        })
        .await
        .expect("both tasks must exit within 1 second of shutdown signal");

        fs::remove_dir_all(&tenex_base_dir).ok();
    }
}
