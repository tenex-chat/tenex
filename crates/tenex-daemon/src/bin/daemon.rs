use std::env;
use std::fmt;
use std::path::{Path, PathBuf};
use std::process;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Mutex, RwLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tenex_daemon::backend_config::read_backend_config;
use tenex_daemon::backend_heartbeat_latch::BackendHeartbeatLatchPlanner;
use tenex_daemon::daemon_foreground::{
    DaemonForegroundStoppableInput, DaemonForegroundWorkerInput,
    run_daemon_foreground_until_stopped_from_filesystem_with_worker,
};
use tenex_daemon::daemon_loop::{
    DaemonMaintenanceLoopClock, DaemonMaintenanceLoopSleeper, DaemonMaintenanceLoopStopSignal,
    SystemDaemonMaintenanceLoopClock,
};
use tenex_daemon::daemon_maintenance::DaemonMaintenanceOutcome;
use tenex_daemon::daemon_maintenance::{NoTelegramPublisher, WithTelegramPublisher};
use tenex_daemon::daemon_shell::DaemonShell;
use tenex_daemon::nip46::client::PublishOutboxHandle;
use tenex_daemon::nip46::outbox_adapter::PublishOutboxAdapter;
use tenex_daemon::nip46::pending::PendingNip46Requests;
use tenex_daemon::nip46::protocol::NIP46_KIND;
use tenex_daemon::nip46::registry::NIP46Registry;
use tenex_daemon::nostr_subscription_gateway::{
    DEFAULT_RELAY_READ_TIMEOUT, NoopNostrSubscriptionObserver, NostrSubscriptionGatewayConfig,
    NostrSubscriptionGatewaySupervisor, NostrSubscriptionObserver, NostrSubscriptionRelayError,
    start_nostr_subscription_gateway,
};
use tenex_daemon::nostr_subscription_tick::{
    NostrSubscriptionTickDiagnostics, NostrSubscriptionTickDispatch,
};
use tenex_daemon::project_agent_whitelist::ingress::WhitelistIngress;
use tenex_daemon::project_agent_whitelist::reconciler::{ReconcilerDeps, run_reconciler_loop};
use tenex_daemon::project_agent_whitelist::snapshot_state::PROJECT_AGENT_SNAPSHOT_KIND;
use tenex_daemon::project_agent_whitelist::snapshot_state::SnapshotState;
use tenex_daemon::project_agent_whitelist::trigger_source::AgentInventoryPoller;
use tenex_daemon::project_boot_state::ProjectBootState;
use tenex_daemon::publish_outbox::{
    PublishOutboxMaintenanceReport, cancel_pending_publish_outbox_records_matching,
};
use tenex_daemon::publish_outbox::{PublishOutboxRelayPublisher, PublishOutboxRetryPolicy};
use tenex_daemon::relay_publisher::{NostrRelayPublisher, RelayPublisherConfig};
use tenex_daemon::subscription_runtime::{
    NostrSubscriptionPlanInput, build_nostr_subscription_plan,
};
use tenex_daemon::telegram::agent_config::read_agent_gateway_bots;
use tenex_daemon::telegram::gateway::{
    GatewayConfig, NoopIngressObserver, TelegramGatewaySupervisor, start_telegram_gateway,
};
use tenex_daemon::telegram::publisher_registry::TelegramPublisherRegistry;
use tenex_daemon::telemetry;
use tenex_daemon::worker_concurrency::WorkerConcurrencyLimits;
use tenex_daemon::worker_dispatch_execution::AgentWorkerProcessDispatchSpawner;
use tenex_daemon::worker_process::{
    AgentWorkerCommand, AgentWorkerProcessConfig, bun_agent_worker_command,
};
use tenex_daemon::worker_runtime_state::new_shared_worker_runtime_state;

const DEFAULT_RELAY_TIMEOUT_MS: u64 = 10_000;
const DEFAULT_SLEEP_MS: u64 = 1_000;
const DEFAULT_WORKER_MAX_FRAMES: u64 = 4_096;
const DEFAULT_MAX_CONCURRENT_WORKERS: u64 = 16;
const DAEMON_FOREGROUND_DIAGNOSTICS_SCHEMA_VERSION: u32 = 1;
const USAGE_EXIT_CODE: i32 = 2;
const RUNTIME_EXIT_CODE: i32 = 1;
const WORKER_ENGINE_ENV: &str = "TENEX_AGENT_WORKER_ENGINE";
const AGENT_WORKER_ENGINE: &str = "agent";
const WHITELIST_RECONCILER_DEBOUNCE: Duration = Duration::from_secs(5);
const WHITELIST_RECONCILER_IDLE_RETRY: Duration = Duration::from_secs(300);
const WHITELIST_POLLER_INTERVAL: Duration = Duration::from_secs(2);
const SHUTDOWN_SLEEP_POLL_INTERVAL: Duration = Duration::from_millis(100);
const SHUTDOWN_REQUESTED_MESSAGE: &[u8] =
    b"\nTENEX daemon: shutdown requested; finishing current work and stopping gateways.\n";
static DAEMON_STOP_REQUESTED: AtomicBool = AtomicBool::new(false);
static DAEMON_RELOAD_REQUESTED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, PartialEq, Eq)]
struct DaemonCliOptions {
    daemon_dir: Option<PathBuf>,
    tenex_base_dir: Option<PathBuf>,
    iterations: Option<u64>,
    sleep_ms: u64,
    debug: bool,
    /// Maximum number of concurrently running worker sessions across all
    /// projects and agents. `None` means unlimited. Overridable via
    /// `--max-concurrent-workers`; defaults to 16.
    max_concurrent_workers: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct DaemonForegroundDiagnostics {
    schema_version: u32,
    tenex_base_dir: PathBuf,
    daemon_dir: PathBuf,
    started_at: u64,
    stopped_at: u64,
    completed_iterations: u64,
    max_iterations: Option<u64>,
    sleep_ms: u64,
    steps: Vec<DaemonForegroundStepDiagnostics>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct DaemonForegroundStepDiagnostics {
    iteration_index: u64,
    now_ms: u64,
    tick: DaemonForegroundTickDiagnostics,
    sleep_after_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct DaemonForegroundTickDiagnostics {
    maintenance: DaemonMaintenanceOutcome,
    publish_outbox: PublishOutboxMaintenanceReport,
}

#[derive(Debug)]
struct CliError {
    message: String,
    exit_code: i32,
}

impl fmt::Display for CliError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for CliError {}

fn main() {
    match run_cli(env::args().skip(1)) {
        Ok(output) => println!("{output}"),
        Err(error) => {
            eprintln!("{error}");
            process::exit(error.exit_code);
        }
    }
}

fn run_cli<I, S>(args: I) -> Result<String, CliError>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let args = args.into_iter().map(Into::into).collect::<Vec<_>>();
    let options = parse_daemon_args(&args)?;
    validate_iterations(&options)?;
    let (tenex_base_dir, daemon_dir) = resolve_daemon_paths(&options)?;
    let _telemetry = telemetry::init(&daemon_dir);
    tracing::info!(version = env!("CARGO_PKG_VERSION"), "tenex-daemon starting");
    install_signal_handlers()?;
    let mut clock = SystemDaemonMaintenanceLoopClock;
    let mut sleeper = ProcessSignalAwareSleeper;
    let mut stop_signal = ProcessSignalStopSignal;
    let publisher = Arc::new(Mutex::new(actual_relay_publisher(&options)?));

    let whitelist_wiring = build_whitelist_wiring(&tenex_base_dir, &daemon_dir)?;
    let project_boot_state = Arc::new(Mutex::new(ProjectBootState::new()));
    let project_event_index = Arc::new(Mutex::new(
        tenex_daemon::project_event_index::ProjectEventIndex::new(),
    ));

    // While the daemon is running, a dedicated thread watches for SIGHUP
    // (via the global reload flag set by `request_daemon_reload`) and
    // invokes `reload_whitelist_wiring` to swap the whitelisted owner set
    // without restarting any supervisor thread. The watcher exits when the
    // daemon stop flag is set.
    let reload_watcher = whitelist_wiring
        .as_ref()
        .map(|wiring| spawn_reload_watcher(tenex_base_dir.clone(), wiring.reload_handle()));

    // Start the Nostr and Telegram gateway supervisors before the foreground
    // worker loop so relay messages can enqueue filesystem dispatches while
    // the loop admits and executes queued work.
    let nostr_supervisor = start_nostr_subscription_supervisor_from_options(
        &options,
        whitelist_wiring
            .as_ref()
            .map(|wiring| Arc::clone(&wiring.ingress)),
        Arc::clone(&project_boot_state),
        Arc::clone(&project_event_index),
    )?;
    let gateway_supervisor =
        start_gateway_supervisor_from_options(&options, Arc::clone(&project_event_index))?;

    let mut telegram_registry = build_telegram_publisher_registry_from_options(&options)?;
    let heartbeat_latch = whitelist_wiring
        .as_ref()
        .map(|wiring| Arc::clone(&wiring.heartbeat_latch));
    let diagnostics_result = if telegram_registry.is_empty() {
        let mut telegram_publisher = NoTelegramPublisher;
        run_daemon_foreground(
            &options,
            heartbeat_latch.clone(),
            Arc::clone(&project_boot_state),
            Arc::clone(&project_event_index),
            &mut clock,
            &mut sleeper,
            &mut stop_signal,
            &publisher,
            &mut telegram_publisher,
        )
    } else {
        let mut telegram_publisher = WithTelegramPublisher(&mut telegram_registry);
        run_daemon_foreground(
            &options,
            heartbeat_latch,
            project_boot_state,
            project_event_index,
            &mut clock,
            &mut sleeper,
            &mut stop_signal,
            &publisher,
            &mut telegram_publisher,
        )
    };

    emit_shutdown_status("foreground loop stopped; shutting down gateway threads");
    if let Some(supervisor) = gateway_supervisor {
        supervisor.request_stop();
        emit_shutdown_status("Telegram gateway stopped");
    }
    if let Some(supervisor) = nostr_supervisor {
        emit_shutdown_status(format_args!(
            "stopping Nostr subscription gateway; waiting for relay reads, up to {}s",
            DEFAULT_RELAY_READ_TIMEOUT.as_secs()
        ));
        supervisor.request_stop();
        supervisor.join();
        emit_shutdown_status("Nostr subscription gateway stopped");
    }
    if let Some(watcher) = reload_watcher {
        // The foreground loop has exited, so `DAEMON_STOP_REQUESTED` is set
        // and the watcher will exit on its next poll.
        emit_shutdown_status("stopping reload watcher");
        let _ = watcher.join();
    }
    // Dropping the whitelist wiring closes the reconciler trigger channel,
    // which causes `run_reconciler_loop` to exit. The supervisor threads
    // detach here; on a clean shutdown the main thread exits immediately
    // after and the OS reaps them.
    drop(whitelist_wiring);

    let diagnostics = diagnostics_result?;
    emit_shutdown_status("shutdown complete");
    tracing::info!("tenex-daemon stopped");
    serde_json::to_string_pretty(&diagnostics).map_err(|error| runtime_error(error.to_string()))
}

/// Wiring for the NIP-46 + kind-14199 whitelist reconciler.
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
struct WhitelistWiring {
    ingress: Arc<WhitelistIngress>,
    heartbeat_latch: Arc<Mutex<BackendHeartbeatLatchPlanner>>,
    nip46_registry: Arc<NIP46Registry>,
    reconciler_owners: Arc<RwLock<Vec<String>>>,
    poller_owners: Arc<RwLock<Vec<String>>>,
    /// Kept alive so that dropping the wiring closes the channel and exits
    /// the reconciler loop on shutdown.
    _trigger_tx: Sender<String>,
    _reconciler_thread: JoinHandle<()>,
    _poller_thread: JoinHandle<()>,
}

/// Sharable bundle of the reload-relevant handles inside
/// [`WhitelistWiring`]. Cloning the bundle clones `Arc`s, so the reload
/// watcher thread can hold its own copy without preventing shutdown.
#[derive(Clone)]
struct WhitelistReloadHandle {
    heartbeat_latch: Arc<Mutex<BackendHeartbeatLatchPlanner>>,
    nip46_registry: Arc<NIP46Registry>,
    reconciler_owners: Arc<RwLock<Vec<String>>>,
    poller_owners: Arc<RwLock<Vec<String>>>,
}

impl WhitelistWiring {
    fn reload_handle(&self) -> WhitelistReloadHandle {
        WhitelistReloadHandle {
            heartbeat_latch: Arc::clone(&self.heartbeat_latch),
            nip46_registry: Arc::clone(&self.nip46_registry),
            reconciler_owners: Arc::clone(&self.reconciler_owners),
            poller_owners: Arc::clone(&self.poller_owners),
        }
    }
}

/// Outcome reported by [`reload_whitelist_wiring`]. Exposes enough to log the
/// reload at `info!` and lets tests assert that the swap happened.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ReloadOutcome {
    previous_owner_count: usize,
    new_owner_count: usize,
    nip46_clients_cleared: bool,
}

#[derive(Debug, thiserror::Error)]
enum ReloadError {
    #[error("reload config read failed: {0}")]
    Config(String),
}

/// Poll interval for the SIGHUP reload watcher thread. Short enough that a
/// SIGHUP arriving while the daemon is otherwise idle is picked up within a
/// human-perceptible delay, long enough that the watcher does not burn CPU.
const RELOAD_WATCHER_POLL_INTERVAL: Duration = Duration::from_millis(250);

/// Spawn the SIGHUP reload watcher. The thread exits when
/// `DAEMON_STOP_REQUESTED` is set.
fn spawn_reload_watcher(tenex_base_dir: PathBuf, handle: WhitelistReloadHandle) -> JoinHandle<()> {
    thread::Builder::new()
        .name("whitelist-reload-watcher".to_string())
        .spawn(move || run_reload_watcher(tenex_base_dir, handle))
        .expect("reload watcher thread must spawn")
}

fn run_reload_watcher(tenex_base_dir: PathBuf, handle: WhitelistReloadHandle) {
    while !DAEMON_STOP_REQUESTED.load(Ordering::Relaxed) {
        if DAEMON_RELOAD_REQUESTED.swap(false, Ordering::SeqCst) {
            match reload_whitelist_from_handle(&tenex_base_dir, &handle) {
                Ok(outcome) => {
                    tracing::info!(
                        previous_owner_count = outcome.previous_owner_count,
                        new_owner_count = outcome.new_owner_count,
                        nip46_clients_cleared = outcome.nip46_clients_cleared,
                        "SIGHUP reload complete"
                    );
                }
                Err(error) => {
                    tracing::error!(
                        error = %error,
                        "SIGHUP reload failed; keeping previous configuration"
                    );
                    tenex_daemon::stdout_status::print_sighup_reload_failed(&error);
                }
            }
        }
        thread::sleep(RELOAD_WATCHER_POLL_INTERVAL);
    }
}

/// Re-read `config.json`, clear the NIP-46 client cache, and swap the
/// whitelisted owner sets in the reconciler, the agent inventory poller, and
/// the heartbeat latch — all without restarting any supervisor thread. The
/// heartbeat latch's own `replace_owners` preserves a latched `Stopped`
/// state: owners that have already sent a stop snapshot stay stopped even
/// when the whitelist changes.
///
/// The daemon binary reaches this entry point through the SIGHUP-driven
/// watcher thread via `reload_whitelist_from_handle`; this wrapper is kept
/// for tests that want to drive the reload synchronously from a single
/// owning `WhitelistWiring` handle.
#[cfg(test)]
fn reload_whitelist_wiring(
    tenex_base_dir: &Path,
    wiring: &WhitelistWiring,
) -> Result<ReloadOutcome, ReloadError> {
    reload_whitelist_from_handle(tenex_base_dir, &wiring.reload_handle())
}

fn reload_whitelist_from_handle(
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

fn build_whitelist_wiring(
    tenex_base_dir: &Path,
    daemon_dir: &Path,
) -> Result<Option<WhitelistWiring>, CliError> {
    let config =
        read_backend_config(tenex_base_dir).map_err(|error| runtime_error(error.to_string()))?;
    if config.whitelisted_pubkeys.is_empty() {
        tracing::info!(
            "no whitelisted pubkeys configured; skipping NIP-46 + 14199 reconciler wiring"
        );
        return Ok(None);
    }

    let backend_signer = Arc::new(
        config
            .backend_signer()
            .map_err(|error| runtime_error(error.to_string()))?,
    );
    let backend_pubkey = backend_signer.pubkey_hex().to_string();
    cancel_stale_nip46_publish_requests(daemon_dir, &backend_pubkey)?;

    let pending = PendingNip46Requests::default();
    let outbox_adapter = Arc::new(PublishOutboxAdapter::new(daemon_dir.to_path_buf()));
    let outbox_handle: Arc<dyn PublishOutboxHandle + Send + Sync> = outbox_adapter;

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

    let (trigger_tx, trigger_rx) = channel::<String>();
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

    let reconciler_thread = thread::Builder::new()
        .name("whitelist-reconciler".to_string())
        .spawn(move || run_reconciler_loop(reconciler_deps, trigger_rx))
        .map_err(|error| runtime_error(format!("reconciler thread spawn failed: {error}")))?;

    let poller = AgentInventoryPoller {
        tenex_base_dir: tenex_base_dir.to_path_buf(),
        owners: Arc::clone(&poller_owners),
        interval: WHITELIST_POLLER_INTERVAL,
        trigger_tx: trigger_tx.clone(),
    };
    let poller_thread = thread::Builder::new()
        .name("whitelist-poller".to_string())
        .spawn(move || poller.run_forever())
        .map_err(|error| runtime_error(format!("poller thread spawn failed: {error}")))?;

    Ok(Some(WhitelistWiring {
        ingress,
        heartbeat_latch,
        nip46_registry,
        reconciler_owners,
        poller_owners,
        _trigger_tx: trigger_tx,
        _reconciler_thread: reconciler_thread,
        _poller_thread: poller_thread,
    }))
}

fn cancel_stale_nip46_publish_requests(
    daemon_dir: &Path,
    backend_pubkey: &str,
) -> Result<(), CliError> {
    let cancelled = cancel_pending_publish_outbox_records_matching(daemon_dir, |record| {
        record.event.kind == NIP46_KIND
            && record.event.pubkey == backend_pubkey
            && record.request.request_id.starts_with("nip46:")
    })
    .map_err(|error| runtime_error(error.to_string()))?;

    if !cancelled.is_empty() {
        tracing::warn!(
            cancelled_count = cancelled.len(),
            "cancelled stale pending NIP-46 publish requests from previous daemon session"
        );
    }

    Ok(())
}

fn start_nostr_subscription_supervisor_from_options(
    options: &DaemonCliOptions,
    whitelist_ingress: Option<Arc<WhitelistIngress>>,
    project_boot_state: Arc<Mutex<ProjectBootState>>,
    project_event_index: Arc<Mutex<tenex_daemon::project_event_index::ProjectEventIndex>>,
) -> Result<Option<NostrSubscriptionGatewaySupervisor>, CliError> {
    let (tenex_base_dir, daemon_dir) = resolve_daemon_paths(options)?;
    let plan = build_nostr_subscription_plan(NostrSubscriptionPlanInput {
        tenex_base_dir: &tenex_base_dir,
        since: Some(current_unix_time_ms() / 1_000),
        lesson_definition_ids: &[],
        project_event_index: &project_event_index,
    })
    .map_err(|error| runtime_error(format!("nostr subscription plan failed: {error}")))?;
    if plan.relay_urls.is_empty() || plan.filters.is_empty() {
        return Ok(None);
    }

    let backend_config =
        read_backend_config(&tenex_base_dir).map_err(|error| runtime_error(error.to_string()))?;
    let auth_signer = backend_config
        .backend_signer()
        .map_err(|error| runtime_error(error.to_string()))?;
    let mut config =
        NostrSubscriptionGatewayConfig::new(tenex_base_dir.clone(), daemon_dir.clone(), plan)
            .with_auth_signer(auth_signer);
    config.project_boot_state = project_boot_state;
    config.project_event_index = project_event_index;
    if let Some(ingress) = whitelist_ingress {
        config = config.with_whitelist_ingress(ingress);
    }
    config.writer_version = daemon_writer_version();
    let supervisor = if options.debug {
        start_nostr_subscription_gateway(config, StdoutNostrDebugObserver)
    } else {
        start_nostr_subscription_gateway(config, NoopNostrSubscriptionObserver)
    }
    .map_err(|error| runtime_error(format!("failed to start nostr subscription: {error}")))?;
    Ok(Some(supervisor))
}

#[derive(Debug, Clone, Copy)]
struct StdoutNostrDebugObserver;

impl NostrSubscriptionObserver for StdoutNostrDebugObserver {
    fn on_tick(&self, _relay_url: &str, diagnostics: &NostrSubscriptionTickDiagnostics) {
        for event in &diagnostics.processed_events {
            let dispatch = diagnostics
                .dispatches
                .iter()
                .find(|dispatch| debug_dispatch_event_id(dispatch) == event.event_id);
            println!(
                "{}",
                format_debug_event_line(event.kind, &event.pubkey, dispatch)
            );
        }
    }

    fn on_batch(&self, _relay_url: &str, _diagnostics: NostrSubscriptionTickDiagnostics) {}

    fn on_error(&self, _relay_url: &str, _error: &NostrSubscriptionRelayError) {}
}

fn format_debug_event_line(
    kind: u64,
    sender_pubkey: &str,
    dispatch: Option<&NostrSubscriptionTickDispatch>,
) -> String {
    let project_id = dispatch
        .and_then(debug_dispatch_project_id)
        .unwrap_or("unknown");
    let action = dispatch
        .map(|dispatch| debug_dispatch_action(kind, dispatch))
        .unwrap_or_else(|| "received".to_string());

    format!(
        "[EVENT] {kind} from {} for {project_id} -> {action}",
        short_pubkey(sender_pubkey)
    )
}

fn debug_dispatch_event_id(dispatch: &NostrSubscriptionTickDispatch) -> &str {
    match dispatch {
        NostrSubscriptionTickDispatch::Queued { event_id, .. }
        | NostrSubscriptionTickDispatch::Ignored { event_id, .. } => event_id,
    }
}

fn debug_dispatch_project_id(dispatch: &NostrSubscriptionTickDispatch) -> Option<&str> {
    match dispatch {
        NostrSubscriptionTickDispatch::Queued { project_id, .. } => Some(project_id),
        NostrSubscriptionTickDispatch::Ignored { project_id, .. } => project_id.as_deref(),
    }
}

fn debug_dispatch_action(kind: u64, dispatch: &NostrSubscriptionTickDispatch) -> String {
    match dispatch {
        NostrSubscriptionTickDispatch::Queued {
            agent_pubkey,
            already_existed,
            ..
        } => {
            if *already_existed {
                format!("routing to {} (already queued)", short_pubkey(agent_pubkey))
            } else {
                format!("routing to {}", short_pubkey(agent_pubkey))
            }
        }
        NostrSubscriptionTickDispatch::Ignored { code, pubkeys, .. } => match code.as_str() {
            "project_booted" => "Booting project".to_string(),
            "project_updated" => "Updating project".to_string(),
            "agent_config_updated" => format!(
                "Updating agent config{}",
                pubkeys
                    .first()
                    .map(|pubkey| format!(" {}", short_pubkey(pubkey)))
                    .unwrap_or_default()
            ),
            "agent_config_update_noop" => format!(
                "Agent config unchanged{}",
                pubkeys
                    .first()
                    .map(|pubkey| format!(" {}", short_pubkey(pubkey)))
                    .unwrap_or_default()
            ),
            "delegation_completion_recorded" => "recording delegation completion".to_string(),
            "dispatch_not_queued" | "delegation_resume_not_queued" => {
                "dispatch already exists".to_string()
            }
            "never_route" if kind == PROJECT_AGENT_SNAPSHOT_KIND => {
                "updating project-agent snapshot".to_string()
            }
            "never_route" if kind == NIP46_KIND => "handling NIP-46 response".to_string(),
            "never_route" => "ignoring never-route event".to_string(),
            other => format!("ignoring ({other})"),
        },
    }
}

fn short_pubkey(pubkey: &str) -> String {
    pubkey.chars().take(4).collect()
}

fn build_telegram_publisher_registry_from_options(
    options: &DaemonCliOptions,
) -> Result<TelegramPublisherRegistry, CliError> {
    let (tenex_base_dir, _) = resolve_daemon_paths(options)?;
    TelegramPublisherRegistry::from_agent_config(&tenex_base_dir)
        .map_err(|error| runtime_error(format!("telegram publisher registry failed: {error}")))
}

/// Build a [`TelegramGatewaySupervisor`] from the on-disk agent
/// configurations. Returns `None` when no agent has a Telegram bot token
/// configured; the gateway is simply not started in that case.
fn start_gateway_supervisor_from_options(
    options: &DaemonCliOptions,
    project_event_index: Arc<Mutex<tenex_daemon::project_event_index::ProjectEventIndex>>,
) -> Result<Option<TelegramGatewaySupervisor>, CliError> {
    let (tenex_base_dir, daemon_dir) = resolve_daemon_paths(options)?;
    let bots = read_agent_gateway_bots(&tenex_base_dir)
        .map_err(|error| runtime_error(format!("telegram agent config scan failed: {error}")))?;
    if bots.is_empty() {
        return Ok(None);
    }

    let data_dir = telegram_data_dir(&tenex_base_dir);
    let backend_config =
        read_backend_config(&tenex_base_dir).map_err(|error| runtime_error(error.to_string()))?;
    let signer: std::sync::Arc<
        dyn tenex_daemon::backend_events::heartbeat::BackendSigner + Send + Sync,
    > = std::sync::Arc::new(
        backend_config
            .backend_signer()
            .map_err(|error| runtime_error(error.to_string()))?,
    );
    let mut config = GatewayConfig::new(tenex_base_dir.clone(), daemon_dir.clone(), data_dir);
    config.bots = bots;
    config.writer_version = daemon_writer_version();
    config.signer = Some(signer);
    config.project_event_index = project_event_index;

    match start_telegram_gateway(config, NoopIngressObserver) {
        Ok(supervisor) => Ok(Some(supervisor)),
        Err(error) => Err(runtime_error(format!(
            "failed to start telegram gateway: {error}"
        ))),
    }
}

/// Resolve the directory that contains `transport-bindings.json` and
/// `identity-bindings.json`. The TS side computes this as
/// `ConfigService.getConfigPath("data")`, which lands at
/// `$TENEX_BASE_DIR/data`.
fn telegram_data_dir(tenex_base_dir: &Path) -> PathBuf {
    tenex_base_dir.join("data")
}

fn run_daemon_foreground<C, S, Stop, P>(
    options: &DaemonCliOptions,
    heartbeat_latch: Option<Arc<Mutex<BackendHeartbeatLatchPlanner>>>,
    project_boot_state: Arc<Mutex<ProjectBootState>>,
    project_event_index: Arc<Mutex<tenex_daemon::project_event_index::ProjectEventIndex>>,
    clock: &mut C,
    sleeper: &mut S,
    stop_signal: &mut Stop,
    publisher: &Arc<Mutex<P>>,
    telegram_publisher: &mut dyn tenex_daemon::daemon_maintenance::TelegramMaintenancePublisher,
) -> Result<DaemonForegroundDiagnostics, CliError>
where
    C: DaemonMaintenanceLoopClock,
    S: DaemonMaintenanceLoopSleeper,
    Stop: DaemonMaintenanceLoopStopSignal,
    P: PublishOutboxRelayPublisher + Send + 'static,
{
    validate_iterations(options)?;

    let (tenex_base_dir, daemon_dir) = resolve_daemon_paths(options)?;
    let shell = DaemonShell::new(&daemon_dir);
    let worker_command = build_agent_worker_command()?;
    let worker_config = AgentWorkerProcessConfig::default();
    let worker_runtime_state = new_shared_worker_runtime_state();
    let mut worker_spawner = AgentWorkerProcessDispatchSpawner;
    let report = run_daemon_foreground_until_stopped_from_filesystem_with_worker(
        &shell,
        DaemonForegroundStoppableInput {
            tenex_base_dir: &tenex_base_dir,
            max_iterations: options.iterations,
            sleep_ms: options.sleep_ms,
            retry_policy: PublishOutboxRetryPolicy::default(),
            project_boot_state,
            project_event_index,
            heartbeat_latch,
        },
        DaemonForegroundWorkerInput {
            runtime_state: worker_runtime_state,
            limits: WorkerConcurrencyLimits {
                global: options.max_concurrent_workers,
                per_project: None,
                per_agent: None,
            },
            correlation_id_prefix: "daemon-foreground-worker".to_string(),
            command: worker_command,
            worker_config: &worker_config,
            writer_version: daemon_writer_version(),
            resolved_pending_delegations: Vec::new(),
            publish_result_sequence: Some(Arc::new(AtomicU64::new(1))),
            max_frames: DEFAULT_WORKER_MAX_FRAMES,
            session_registry: tenex_daemon::worker_session_registry::WorkerSessionRegistry::new(),
        },
        clock,
        sleeper,
        stop_signal,
        &mut worker_spawner,
        publisher,
        telegram_publisher,
    )
    .map_err(|error| runtime_error(error.to_string()))?;

    let stopped_at = current_unix_time_ms();
    let steps: Vec<DaemonForegroundStepDiagnostics> = report
        .tick_loop
        .steps
        .into_iter()
        .map(|step| DaemonForegroundStepDiagnostics {
            iteration_index: step.iteration_index,
            now_ms: step.now_ms,
            tick: DaemonForegroundTickDiagnostics {
                maintenance: step.maintenance_outcome.maintenance,
                publish_outbox: step.maintenance_outcome.publish_outbox,
            },
            sleep_after_ms: step.sleep_after_ms,
        })
        .collect();

    Ok(DaemonForegroundDiagnostics {
        schema_version: DAEMON_FOREGROUND_DIAGNOSTICS_SCHEMA_VERSION,
        tenex_base_dir: report.tenex_base_dir,
        daemon_dir: report.daemon_dir,
        started_at: report.started_at_ms,
        stopped_at,
        completed_iterations: steps.len() as u64,
        max_iterations: options.iterations,
        sleep_ms: options.sleep_ms,
        steps,
    })
}

fn build_agent_worker_command() -> Result<AgentWorkerCommand, CliError> {
    Ok(bun_agent_worker_command(&repository_root()?, bun_program())
        .env(WORKER_ENGINE_ENV, AGENT_WORKER_ENGINE))
}

fn repository_root() -> Result<PathBuf, CliError> {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .ok_or_else(|| runtime_error("failed to resolve repository root"))
}

fn bun_program() -> PathBuf {
    env::var_os("BUN_BIN")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("bun"))
}

fn daemon_writer_version() -> String {
    format!("tenex-daemon@{}", env!("CARGO_PKG_VERSION"))
}

fn actual_relay_publisher(options: &DaemonCliOptions) -> Result<NostrRelayPublisher, CliError> {
    let (tenex_base_dir, _) = resolve_daemon_paths(options)?;
    let backend_config =
        read_backend_config(&tenex_base_dir).map_err(|error| runtime_error(error.to_string()))?;
    let relay_config = RelayPublisherConfig::new(
        backend_config.effective_relay_urls(),
        Duration::from_millis(DEFAULT_RELAY_TIMEOUT_MS),
    )
    .map_err(|error| runtime_error(error.to_string()))?;
    let auth_signer = backend_config
        .backend_signer()
        .map_err(|error| runtime_error(error.to_string()))?;
    Ok(NostrRelayPublisher::with_auth_signer(
        relay_config,
        auth_signer,
    ))
}

fn validate_iterations(options: &DaemonCliOptions) -> Result<(), CliError> {
    if options.iterations == Some(0) {
        return Err(usage_error("--iterations must be greater than 0"));
    }

    Ok(())
}

fn parse_daemon_args(args: &[String]) -> Result<DaemonCliOptions, CliError> {
    if matches!(
        args.first().map(String::as_str),
        Some("help" | "--help" | "-h") | None
    ) {
        return Err(usage_error(usage()));
    }

    let mut daemon_dir = None;
    let mut tenex_base_dir = None;
    let mut iterations = None;
    let mut sleep_ms = DEFAULT_SLEEP_MS;
    let mut debug = false;
    let mut max_concurrent_workers = Some(DEFAULT_MAX_CONCURRENT_WORKERS);
    let mut index = 0;

    while index < args.len() {
        match args[index].as_str() {
            "--daemon-dir" => {
                index += 1;
                let value = args
                    .get(index)
                    .ok_or_else(|| usage_error("--daemon-dir requires a value"))?;
                daemon_dir = Some(PathBuf::from(value));
            }
            "--tenex-base-dir" => {
                index += 1;
                let value = args
                    .get(index)
                    .ok_or_else(|| usage_error("--tenex-base-dir requires a value"))?;
                tenex_base_dir = Some(PathBuf::from(value));
            }
            "--iterations" => {
                index += 1;
                let value = args
                    .get(index)
                    .ok_or_else(|| usage_error("--iterations requires a value"))?;
                iterations = Some(parse_u64_arg("--iterations", value)?);
            }
            "--sleep-ms" => {
                index += 1;
                let value = args
                    .get(index)
                    .ok_or_else(|| usage_error("--sleep-ms requires a value"))?;
                sleep_ms = parse_u64_arg("--sleep-ms", value)?;
            }
            "--debug" => {
                debug = true;
            }
            "--max-concurrent-workers" => {
                index += 1;
                let value = args
                    .get(index)
                    .ok_or_else(|| usage_error("--max-concurrent-workers requires a value"))?;
                let parsed = parse_u64_arg("--max-concurrent-workers", value)?;
                max_concurrent_workers = if parsed == 0 { None } else { Some(parsed) };
            }
            "--help" | "-h" => return Err(usage_error(usage())),
            argument => {
                return Err(usage_error(format!(
                    "unknown argument: {argument}\n\n{}",
                    usage()
                )));
            }
        }
        index += 1;
    }

    if daemon_dir.is_none() && tenex_base_dir.is_none() {
        return Err(usage_error("--daemon-dir or --tenex-base-dir is required"));
    }

    Ok(DaemonCliOptions {
        daemon_dir,
        tenex_base_dir,
        iterations,
        sleep_ms,
        debug,
        max_concurrent_workers,
    })
}

fn resolve_daemon_paths(options: &DaemonCliOptions) -> Result<(PathBuf, PathBuf), CliError> {
    let daemon_dir = match &options.daemon_dir {
        Some(daemon_dir) => daemon_dir.clone(),
        None => options
            .tenex_base_dir
            .as_ref()
            .map(|base_dir| base_dir.join("daemon"))
            .ok_or_else(|| usage_error("--daemon-dir or --tenex-base-dir is required"))?,
    };

    let tenex_base_dir = options
        .tenex_base_dir
        .clone()
        .unwrap_or_else(|| infer_tenex_base_dir(&daemon_dir));

    Ok((tenex_base_dir, daemon_dir))
}

fn infer_tenex_base_dir(daemon_dir: &Path) -> PathBuf {
    if daemon_dir.file_name().and_then(|name| name.to_str()) == Some("daemon") {
        return daemon_dir
            .parent()
            .map(PathBuf::from)
            .unwrap_or_else(|| daemon_dir.to_path_buf());
    }

    daemon_dir.to_path_buf()
}

fn parse_u64_arg(name: &str, value: &str) -> Result<u64, CliError> {
    value
        .parse::<u64>()
        .map_err(|_| usage_error(format!("{name} must be an unsigned integer")))
}

fn current_unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time must be after UNIX_EPOCH")
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

fn usage() -> String {
    [
        "usage:",
        "  daemon --daemon-dir <path> [--iterations <count>] [--sleep-ms <ms>] [--max-concurrent-workers <count>] [--debug]",
        "  daemon --tenex-base-dir <path> [--iterations <count>] [--sleep-ms <ms>] [--max-concurrent-workers <count>] [--debug]",
        "",
        "  --max-concurrent-workers <count>  Cap the number of worker sessions that run concurrently.",
        "                                   0 means unlimited. Default: 16.",
    ]
    .join("\n")
}

#[derive(Debug, Clone, Copy, Default)]
struct ProcessSignalStopSignal;

impl DaemonMaintenanceLoopStopSignal for ProcessSignalStopSignal {
    fn should_stop(&mut self) -> bool {
        DAEMON_STOP_REQUESTED.load(Ordering::Relaxed)
    }
}

#[derive(Debug, Clone, Copy, Default)]
struct ProcessSignalAwareSleeper;

impl DaemonMaintenanceLoopSleeper for ProcessSignalAwareSleeper {
    fn sleep_ms(&mut self, sleep_ms: u64) {
        let mut remaining = Duration::from_millis(sleep_ms);
        while remaining > Duration::ZERO && !DAEMON_STOP_REQUESTED.load(Ordering::Relaxed) {
            let step = remaining.min(SHUTDOWN_SLEEP_POLL_INTERVAL);
            thread::sleep(step);
            remaining = remaining.saturating_sub(step);
        }
    }
}

extern "C" fn request_daemon_stop(_signal: libc::c_int) {
    let already_requested = DAEMON_STOP_REQUESTED.swap(true, Ordering::SeqCst);
    if !already_requested {
        unsafe {
            let _ = libc::write(
                libc::STDERR_FILENO,
                SHUTDOWN_REQUESTED_MESSAGE.as_ptr() as *const libc::c_void,
                SHUTDOWN_REQUESTED_MESSAGE.len(),
            );
        }
    }
}

extern "C" fn request_daemon_reload(_signal: libc::c_int) {
    DAEMON_RELOAD_REQUESTED.store(true, Ordering::SeqCst);
}

fn install_signal_handlers() -> Result<(), CliError> {
    DAEMON_STOP_REQUESTED.store(false, Ordering::SeqCst);
    DAEMON_RELOAD_REQUESTED.store(false, Ordering::SeqCst);
    for signal in [libc::SIGINT, libc::SIGTERM] {
        install_signal_handler(signal, request_daemon_stop)?;
    }
    install_signal_handler(libc::SIGHUP, request_daemon_reload)?;
    Ok(())
}

fn install_signal_handler(
    signal: libc::c_int,
    handler: extern "C" fn(libc::c_int),
) -> Result<(), CliError> {
    let mut action = unsafe { std::mem::zeroed::<libc::sigaction>() };
    action.sa_sigaction = handler as usize;
    action.sa_flags = 0;
    let install_result = unsafe {
        libc::sigemptyset(&mut action.sa_mask);
        libc::sigaction(signal, &action, std::ptr::null_mut())
    };
    if install_result == -1 {
        return Err(runtime_error(format!(
            "failed to install signal handler for signal {signal}"
        )));
    }
    Ok(())
}

fn emit_shutdown_status(message: impl fmt::Display) {
    if DAEMON_STOP_REQUESTED.load(Ordering::Relaxed) {
        eprintln!("TENEX daemon: {message}");
    }
}

fn usage_error(message: impl Into<String>) -> CliError {
    CliError {
        message: message.into(),
        exit_code: USAGE_EXIT_CODE,
    }
}

fn runtime_error(message: impl Into<String>) -> CliError {
    CliError {
        message: message.into(),
        exit_code: RUNTIME_EXIT_CODE,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::collections::VecDeque;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    use secp256k1::{Keypair, Secp256k1, SecretKey};
    use tenex_daemon::backend_config::backend_config_path;
    use tenex_daemon::daemon_loop::NeverStopDaemonMaintenanceLoop;
    use tenex_daemon::nostr_event::SignedNostrEvent;
    use tenex_daemon::publish_outbox::{PublishRelayError, PublishRelayReport, PublishRelayResult};
    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);
    const TEST_SECRET_KEY_HEX: &str =
        "0101010101010101010101010101010101010101010101010101010101010101";

    #[derive(Debug, Default)]
    struct RecordingClock {
        now_ms_values: VecDeque<u64>,
        observed_now_ms_values: Vec<u64>,
    }

    impl DaemonMaintenanceLoopClock for RecordingClock {
        fn now_ms(&mut self) -> u64 {
            let now_ms = self
                .now_ms_values
                .pop_front()
                .expect("clock must have a value");
            self.observed_now_ms_values.push(now_ms);
            now_ms
        }
    }

    #[derive(Debug, Default)]
    struct RecordingSleeper {
        sleeps_ms: Vec<u64>,
    }

    impl DaemonMaintenanceLoopSleeper for RecordingSleeper {
        fn sleep_ms(&mut self, sleep_ms: u64) {
            self.sleeps_ms.push(sleep_ms);
        }
    }

    #[derive(Debug, Default)]
    struct RecordingPublisher {
        published_event_ids: Vec<String>,
    }

    impl PublishOutboxRelayPublisher for RecordingPublisher {
        fn publish_signed_event(
            &mut self,
            event: &SignedNostrEvent,
        ) -> Result<PublishRelayReport, PublishRelayError> {
            self.published_event_ids.push(event.id.clone());
            Ok(PublishRelayReport {
                relay_results: vec![PublishRelayResult {
                    relay_url: "wss://relay.one".to_string(),
                    accepted: true,
                    message: None,
                }],
            })
        }
    }

    #[test]
    fn parses_daemon_args_with_tenex_base_dir() {
        let options = parse_daemon_args(&[
            "--tenex-base-dir".to_string(),
            "/tmp/tenex".to_string(),
            "--iterations".to_string(),
            "2".to_string(),
            "--sleep-ms".to_string(),
            "25".to_string(),
        ])
        .expect("daemon args must parse");

        assert_eq!(options.tenex_base_dir, Some(PathBuf::from("/tmp/tenex")));
        assert!(options.daemon_dir.is_none());
        assert_eq!(options.iterations, Some(2));
        assert_eq!(options.sleep_ms, 25);
        assert!(!options.debug);
    }

    #[test]
    fn parses_daemon_args_without_iteration_cap() {
        let options =
            parse_daemon_args(&["--tenex-base-dir".to_string(), "/tmp/tenex".to_string()])
                .expect("daemon args must parse");

        assert_eq!(options.tenex_base_dir, Some(PathBuf::from("/tmp/tenex")));
        assert_eq!(options.iterations, None);
        assert_eq!(options.sleep_ms, DEFAULT_SLEEP_MS);
        assert!(!options.debug);
    }

    #[test]
    fn parses_daemon_args_with_debug() {
        let options = parse_daemon_args(&[
            "--tenex-base-dir".to_string(),
            "/tmp/tenex".to_string(),
            "--debug".to_string(),
        ])
        .expect("daemon args must parse");

        assert!(options.debug);
    }

    #[test]
    fn resolves_daemon_dir_from_base_dir() {
        let options = DaemonCliOptions {
            daemon_dir: None,
            tenex_base_dir: Some(PathBuf::from("/tmp/tenex")),
            iterations: Some(1),
            sleep_ms: 0,
            debug: false,
            max_concurrent_workers: Some(DEFAULT_MAX_CONCURRENT_WORKERS),
        };

        let (tenex_base_dir, daemon_dir) =
            resolve_daemon_paths(&options).expect("paths must resolve");

        assert_eq!(tenex_base_dir, PathBuf::from("/tmp/tenex"));
        assert_eq!(daemon_dir, PathBuf::from("/tmp/tenex/daemon"));
    }

    #[test]
    fn resolves_base_dir_from_daemon_dir() {
        let options = DaemonCliOptions {
            daemon_dir: Some(PathBuf::from("/tmp/tenex/daemon")),
            tenex_base_dir: None,
            iterations: Some(1),
            sleep_ms: 0,
            debug: false,
            max_concurrent_workers: Some(DEFAULT_MAX_CONCURRENT_WORKERS),
        };

        let (tenex_base_dir, daemon_dir) =
            resolve_daemon_paths(&options).expect("paths must resolve");

        assert_eq!(tenex_base_dir, PathBuf::from("/tmp/tenex"));
        assert_eq!(daemon_dir, PathBuf::from("/tmp/tenex/daemon"));
    }

    #[test]
    fn foreground_runner_serializes_diagnostics() {
        let fixture = foreground_fixture("foreground_runner_serializes_diagnostics");
        let options = DaemonCliOptions {
            daemon_dir: Some(fixture.daemon_dir.clone()),
            tenex_base_dir: Some(fixture.tenex_base_dir.clone()),
            iterations: Some(2),
            sleep_ms: 25,
            debug: false,
            max_concurrent_workers: Some(DEFAULT_MAX_CONCURRENT_WORKERS),
        };
        let mut clock = RecordingClock {
            now_ms_values: VecDeque::from(vec![
                1_710_001_000_000,
                1_710_001_000_100,
                1_710_001_000_200,
            ]),
            observed_now_ms_values: Vec::new(),
        };
        let mut sleeper = RecordingSleeper::default();
        let mut stop_signal = NeverStopDaemonMaintenanceLoop;
        let publisher = Arc::new(Mutex::new(RecordingPublisher::default()));
        let mut telegram_publisher = NoTelegramPublisher;

        let diagnostics = run_daemon_foreground(
            &options,
            None,
            Arc::new(Mutex::new(ProjectBootState::new())),
            Arc::new(Mutex::new(
                tenex_daemon::project_event_index::ProjectEventIndex::new(),
            )),
            &mut clock,
            &mut sleeper,
            &mut stop_signal,
            &publisher,
            &mut telegram_publisher,
        )
        .expect("foreground runner must succeed");

        assert_eq!(diagnostics.tenex_base_dir, fixture.tenex_base_dir);
        assert_eq!(diagnostics.daemon_dir, fixture.daemon_dir);
        assert_eq!(diagnostics.started_at, 1_710_001_000_000);
        assert_eq!(diagnostics.completed_iterations, 2);
        assert_eq!(diagnostics.max_iterations, Some(2));
        assert_eq!(diagnostics.sleep_ms, 25);
        assert_eq!(
            clock.observed_now_ms_values,
            vec![1_710_001_000_000, 1_710_001_000_100, 1_710_001_000_200]
        );
        assert_eq!(sleeper.sleeps_ms, vec![25]);
        assert_eq!(diagnostics.steps.len(), 2);
        assert_eq!(diagnostics.steps[0].iteration_index, 0);
        assert_eq!(diagnostics.steps[0].sleep_after_ms, Some(25));
        assert!(!publisher.lock().unwrap().published_event_ids.is_empty());

        let json = serde_json::to_value(&diagnostics).expect("diagnostics must serialize");
        assert_eq!(json["schemaVersion"], Value::from(1));
        assert_eq!(json["completedIterations"], Value::from(2));
        assert_eq!(json["maxIterations"], Value::from(2));
    }

    #[test]
    fn formats_debug_event_lines_for_routes_and_boots() {
        let route = NostrSubscriptionTickDispatch::Queued {
            frame_index: 0,
            event_id: "event-alpha".to_string(),
            dispatch_id: "dispatch-alpha".to_string(),
            project_id: "project-alpha".to_string(),
            agent_pubkey: "abcdef0123456789".to_string(),
            conversation_id: "conversation-alpha".to_string(),
            queued: true,
            already_existed: false,
        };
        assert_eq!(
            format_debug_event_line(1, "1234567890abcdef", Some(&route)),
            "[EVENT] 1 from 1234 for project-alpha -> routing to abcd"
        );

        let boot = NostrSubscriptionTickDispatch::Ignored {
            frame_index: 0,
            event_id: "event-boot".to_string(),
            code: "project_booted".to_string(),
            detail: "project project-alpha boot state recorded in session state".to_string(),
            class: None,
            project_id: Some("project-alpha".to_string()),
            pubkeys: Vec::new(),
            dispatch_id: None,
        };
        assert_eq!(
            format_debug_event_line(24000, "1234567890abcdef", Some(&boot)),
            "[EVENT] 24000 from 1234 for project-alpha -> Booting project"
        );

        let owner_snapshot = NostrSubscriptionTickDispatch::Ignored {
            frame_index: 0,
            event_id: "event-snapshot".to_string(),
            code: "never_route".to_string(),
            detail: "nostr event class NeverRoute is not a worker conversation".to_string(),
            class: None,
            project_id: None,
            pubkeys: Vec::new(),
            dispatch_id: None,
        };
        assert_eq!(
            format_debug_event_line(
                PROJECT_AGENT_SNAPSHOT_KIND,
                "1234567890abcdef",
                Some(&owner_snapshot)
            ),
            "[EVENT] 14199 from 1234 for unknown -> updating project-agent snapshot"
        );
    }

    fn foreground_fixture(prefix: &str) -> ForegroundFixture {
        let tenex_base_dir = unique_temp_dir(prefix);
        let daemon_dir = tenex_base_dir.join("daemon");
        let agents_dir = tenex_base_dir.join("agents");
        fs::create_dir_all(&daemon_dir).expect("daemon dir must create");
        fs::create_dir_all(&agents_dir).expect("agents dir must create");
        fs::write(
            backend_config_path(&tenex_base_dir),
            format!(
                r#"{{
                    "whitelistedPubkeys": ["{}"],
                    "tenexPrivateKey": "{TEST_SECRET_KEY_HEX}",
                    "relays": ["wss://relay.one"]
                }}"#,
                pubkey_hex(0x02),
            ),
        )
        .expect("config must write");

        ForegroundFixture {
            tenex_base_dir,
            daemon_dir,
        }
    }

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be after UNIX_EPOCH")
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("{prefix}-{unique}-{counter}"))
    }

    struct ForegroundFixture {
        tenex_base_dir: PathBuf,
        daemon_dir: PathBuf,
    }

    fn pubkey_hex(fill_byte: u8) -> String {
        let secret_bytes = [fill_byte; 32];
        let secret = SecretKey::from_byte_array(secret_bytes).expect("valid secret");
        let secp = Secp256k1::new();
        let keypair = Keypair::from_secret_key(&secp, &secret);
        let (xonly, _) = keypair.x_only_public_key();
        hex::encode(xonly.serialize())
    }

    #[test]
    fn build_whitelist_wiring_returns_none_when_no_whitelisted_pubkeys() {
        let tenex_base_dir = unique_temp_dir("whitelist-wiring-empty");
        let daemon_dir = tenex_base_dir.join("daemon");
        fs::create_dir_all(&daemon_dir).expect("daemon dir must create");
        fs::write(
            backend_config_path(&tenex_base_dir),
            format!(
                r#"{{
                    "whitelistedPubkeys": [],
                    "tenexPrivateKey": "{TEST_SECRET_KEY_HEX}",
                    "relays": ["wss://relay.one"]
                }}"#
            ),
        )
        .expect("config must write");

        let wiring = build_whitelist_wiring(&tenex_base_dir, &daemon_dir)
            .expect("wiring construction must succeed");
        assert!(wiring.is_none());

        fs::remove_dir_all(tenex_base_dir).expect("cleanup must succeed");
    }

    #[test]
    fn build_whitelist_wiring_constructs_ingress_and_latch_for_whitelisted_owner() {
        use tenex_daemon::backend_heartbeat_latch::BackendHeartbeatLatchState;

        let tenex_base_dir = unique_temp_dir("whitelist-wiring-full");
        let daemon_dir = tenex_base_dir.join("daemon");
        let agents_dir = tenex_base_dir.join("agents");
        fs::create_dir_all(&daemon_dir).expect("daemon dir must create");
        fs::create_dir_all(&agents_dir).expect("agents dir must create");
        let owner = pubkey_hex(0x02);
        fs::write(
            backend_config_path(&tenex_base_dir),
            format!(
                r#"{{
                    "whitelistedPubkeys": ["{owner}"],
                    "tenexPrivateKey": "{TEST_SECRET_KEY_HEX}",
                    "relays": ["wss://relay.one"]
                }}"#
            ),
        )
        .expect("config must write");

        let wiring = build_whitelist_wiring(&tenex_base_dir, &daemon_dir)
            .expect("wiring construction must succeed")
            .expect("non-empty whitelist must produce wiring");

        // The heartbeat latch starts Active because the owner set is
        // non-empty. It only flips to Stopped once a 14199 with a
        // backend-p-tag arrives through the ingress.
        assert_eq!(
            wiring.heartbeat_latch.lock().unwrap().state(),
            BackendHeartbeatLatchState::Active
        );
        // Ingress is an Arc; confirm we can clone it to share with the
        // subscription gateway config.
        let _cloned_ingress = Arc::clone(&wiring.ingress);

        // Dropping the wiring closes the trigger channel and exits the
        // supervisor threads; no assertions required, but we verify the
        // destructor runs cleanly without blocking on tests.
        drop(wiring);

        fs::remove_dir_all(tenex_base_dir).expect("cleanup must succeed");
    }

    #[test]
    fn subscription_plan_includes_14199_and_nip46_filters_when_owner_is_whitelisted() {
        use tenex_daemon::subscription_runtime::{
            NostrSubscriptionPlanInput, build_nostr_subscription_plan,
        };

        let tenex_base_dir = unique_temp_dir("whitelist-plan");
        let owner = pubkey_hex(0x03);
        fs::create_dir_all(&tenex_base_dir).expect("base dir must create");
        fs::write(
            backend_config_path(&tenex_base_dir),
            format!(
                r#"{{
                    "whitelistedPubkeys": ["{owner}"],
                    "tenexPrivateKey": "{TEST_SECRET_KEY_HEX}",
                    "relays": ["wss://relay.one"]
                }}"#
            ),
        )
        .expect("config must write");

        let project_event_index = Arc::new(Mutex::new(
            tenex_daemon::project_event_index::ProjectEventIndex::new(),
        ));
        let plan = build_nostr_subscription_plan(NostrSubscriptionPlanInput {
            tenex_base_dir: &tenex_base_dir,
            since: Some(1_710_001_000),
            lesson_definition_ids: &[],
            project_event_index: &project_event_index,
        })
        .expect("subscription plan must build");

        let snapshot = plan
            .project_agent_snapshot_filter
            .expect("project-agent-snapshot filter must be present when owners exist");
        assert_eq!(snapshot.kinds, vec![14199]);
        assert!(snapshot.authors.contains(&owner));

        let nip46_filter = plan
            .nip46_reply_filter
            .expect("nip46 reply filter must be present when owners exist");
        assert_eq!(nip46_filter.kinds, vec![24133]);
        assert!(nip46_filter.authors.contains(&owner));

        fs::remove_dir_all(tenex_base_dir).expect("cleanup must succeed");
    }

    fn write_whitelist_config(tenex_base_dir: &Path, owners: &[String]) {
        let owners_json = serde_json::to_string(owners).expect("owners must serialize");
        fs::write(
            backend_config_path(tenex_base_dir),
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

    #[test]
    fn reload_whitelist_wiring_swaps_reconciler_owners_and_clears_registry() {
        use tenex_daemon::backend_config::Nip46Config;

        let tenex_base_dir = unique_temp_dir("reload-swap");
        let daemon_dir = tenex_base_dir.join("daemon");
        let agents_dir = tenex_base_dir.join("agents");
        fs::create_dir_all(&daemon_dir).expect("daemon dir must create");
        fs::create_dir_all(&agents_dir).expect("agents dir must create");

        let owner_initial = pubkey_hex(0x11);
        let owner_new_a = pubkey_hex(0x22);
        let owner_new_b = pubkey_hex(0x33);
        write_whitelist_config(&tenex_base_dir, std::slice::from_ref(&owner_initial));

        let wiring = build_whitelist_wiring(&tenex_base_dir, &daemon_dir)
            .expect("wiring build must succeed")
            .expect("non-empty whitelist must produce wiring");

        // Prime the NIP-46 registry client cache for the initial owner so we
        // can assert the reload clears it.
        let nip46_config = Nip46Config::default();
        wiring
            .nip46_registry
            .client_for_owner(&owner_initial, &nip46_config, "wss://relay.one/")
            .expect("initial client must build");
        assert!(
            wiring
                .nip46_registry
                .client_for_cached_owner(&owner_initial)
                .is_some(),
            "initial owner client must be cached before reload"
        );
        assert_eq!(
            wiring.heartbeat_latch.lock().unwrap().owner_count(),
            1,
            "latch starts with one configured owner"
        );

        // Flip the config on disk to a two-owner whitelist and reload.
        write_whitelist_config(&tenex_base_dir, &[owner_new_a.clone(), owner_new_b.clone()]);
        let outcome =
            reload_whitelist_wiring(&tenex_base_dir, &wiring).expect("reload must succeed");

        assert_eq!(outcome.previous_owner_count, 1);
        assert_eq!(outcome.new_owner_count, 2);
        assert!(outcome.nip46_clients_cleared);

        assert_eq!(
            *wiring.reconciler_owners.read().unwrap(),
            vec![owner_new_a.clone(), owner_new_b.clone()],
            "reconciler owners must contain the two reloaded owners"
        );
        assert_eq!(
            *wiring.poller_owners.read().unwrap(),
            vec![owner_new_a.clone(), owner_new_b.clone()],
            "poller owners must contain the two reloaded owners"
        );

        {
            let latch = wiring.heartbeat_latch.lock().unwrap();
            assert_eq!(latch.owner_count(), 2);
            assert!(latch.contains_owner(&owner_new_a));
            assert!(latch.contains_owner(&owner_new_b));
            assert!(!latch.contains_owner(&owner_initial));
        }

        assert!(
            wiring
                .nip46_registry
                .client_for_cached_owner(&owner_initial)
                .is_none(),
            "reload must drop the previously-cached NIP-46 client"
        );

        drop(wiring);
        fs::remove_dir_all(tenex_base_dir).expect("cleanup must succeed");
    }

    #[test]
    fn reload_whitelist_wiring_keeps_latch_stopped_if_previously_stopped() {
        use tenex_daemon::backend_heartbeat_latch::BackendHeartbeatLatchState;
        use tenex_daemon::nip46::protocol::NIP46_KIND;
        use tenex_daemon::nostr_event::SignedNostrEvent;

        let tenex_base_dir = unique_temp_dir("reload-latched-stopped");
        let daemon_dir = tenex_base_dir.join("daemon");
        let agents_dir = tenex_base_dir.join("agents");
        fs::create_dir_all(&daemon_dir).expect("daemon dir must create");
        fs::create_dir_all(&agents_dir).expect("agents dir must create");

        let owner_initial = pubkey_hex(0x44);
        let owner_new = pubkey_hex(0x55);
        write_whitelist_config(&tenex_base_dir, std::slice::from_ref(&owner_initial));

        let wiring = build_whitelist_wiring(&tenex_base_dir, &daemon_dir)
            .expect("wiring build must succeed")
            .expect("non-empty whitelist must produce wiring");

        // Compute the backend pubkey from the config so we can craft a
        // matching 14199 that latches the heartbeat to Stopped.
        let backend_pubkey = read_backend_config(&tenex_base_dir)
            .expect("config must read")
            .backend_signer()
            .expect("backend signer must build")
            .pubkey_hex()
            .to_string();

        let stop_event = SignedNostrEvent {
            id: "0".repeat(64),
            pubkey: owner_initial.clone(),
            created_at: 1_710_000_000,
            kind: 14199,
            tags: vec![vec!["p".to_string(), backend_pubkey.clone()]],
            content: String::new(),
            sig: "0".repeat(128),
        };
        wiring.ingress.handle_event(&stop_event);
        // Ensure the ingress does not spuriously dispatch the stop-event as
        // an NIP-46 envelope (it only listens for kind 14199 + kind 24133).
        assert_ne!(stop_event.kind, NIP46_KIND);
        assert_eq!(
            wiring.heartbeat_latch.lock().unwrap().state(),
            BackendHeartbeatLatchState::Stopped,
            "ingress must latch heartbeat to Stopped after a matching 14199"
        );

        write_whitelist_config(&tenex_base_dir, std::slice::from_ref(&owner_new));
        let outcome =
            reload_whitelist_wiring(&tenex_base_dir, &wiring).expect("reload must succeed");
        assert_eq!(outcome.new_owner_count, 1);

        let latch = wiring.heartbeat_latch.lock().unwrap();
        assert_eq!(
            latch.state(),
            BackendHeartbeatLatchState::Stopped,
            "latched-Stopped state must survive the reload"
        );
        assert!(!latch.should_heartbeat());
        assert!(latch.contains_owner(&owner_new));
        assert!(!latch.contains_owner(&owner_initial));
        drop(latch);

        drop(wiring);
        fs::remove_dir_all(tenex_base_dir).expect("cleanup must succeed");
    }

    #[test]
    fn run_reconciler_loop_picks_up_new_owners_on_reload() {
        use std::collections::BTreeSet;
        use std::str::FromStr;
        use std::sync::Mutex as StdMutex;
        use std::sync::mpsc as std_mpsc;
        use std::thread as std_thread;
        use std::time::Instant;

        use secp256k1::PublicKey;
        use tenex_daemon::backend_config::{Nip46Config, OwnerNip46Config};
        use tenex_daemon::backend_signer::HexBackendSigner;
        use tenex_daemon::nip44;
        use tenex_daemon::nip46::client::PublishOutboxHandle;
        use tenex_daemon::nip46::pending::PendingNip46Requests;
        use tenex_daemon::nip46::protocol::{Nip46Request, Nip46Response};
        use tenex_daemon::nip46::registry::NIP46Registry;
        use tenex_daemon::nostr_event::{
            NormalizedNostrEvent, SignedNostrEvent, canonical_payload, event_hash_hex,
        };
        use tenex_daemon::project_agent_whitelist::reconciler::{
            ReconcilerDeps, run_reconciler_loop,
        };
        use tenex_daemon::project_agent_whitelist::snapshot_state::SnapshotState;

        const OWNER_A_SECRET_HEX: &str =
            "0202020202020202020202020202020202020202020202020202020202020202";
        const OWNER_B_SECRET_HEX: &str =
            "0303030303030303030303030303030303030303030303030303030303030303";

        struct CaptureOutbox {
            captured: StdMutex<Vec<(SignedNostrEvent, Vec<String>)>>,
        }

        impl CaptureOutbox {
            fn new() -> Arc<Self> {
                Arc::new(Self {
                    captured: StdMutex::new(Vec::new()),
                })
            }

            fn captured(&self) -> Vec<(SignedNostrEvent, Vec<String>)> {
                self.captured.lock().unwrap().clone()
            }
        }

        impl PublishOutboxHandle for CaptureOutbox {
            fn enqueue(
                &self,
                event: SignedNostrEvent,
                relay_urls: Vec<String>,
            ) -> Result<(), String> {
                self.captured.lock().unwrap().push((event, relay_urls));
                Ok(())
            }
        }

        struct OwnerKeys {
            secret: secp256k1::SecretKey,
            keypair: secp256k1::Keypair,
            xonly_hex: String,
            secp: secp256k1::Secp256k1<secp256k1::All>,
        }

        impl OwnerKeys {
            fn from_secret_hex(secret_hex: &str) -> Self {
                let secret = secp256k1::SecretKey::from_str(secret_hex).expect("valid secret");
                let secp = secp256k1::Secp256k1::new();
                let keypair = secp256k1::Keypair::from_secret_key(&secp, &secret);
                let (xonly, _) = keypair.x_only_public_key();
                Self {
                    secret,
                    keypair,
                    xonly_hex: hex::encode(xonly.serialize()),
                    secp,
                }
            }

            fn sign_event(&self, template: &NormalizedNostrEvent) -> SignedNostrEvent {
                let mut filled = template.clone();
                filled.pubkey = Some(self.xonly_hex.clone());
                if filled.created_at.is_none() {
                    filled.created_at = Some(1_710_000_000);
                }
                let canonical = canonical_payload(&filled).expect("canonical payload");
                let id = event_hash_hex(&canonical);
                let digest: [u8; 32] = hex::decode(&id).unwrap().try_into().unwrap();
                let sig = self
                    .secp
                    .sign_schnorr_no_aux_rand(digest.as_slice(), &self.keypair);
                SignedNostrEvent {
                    id,
                    pubkey: self.xonly_hex.clone(),
                    created_at: filled.created_at.unwrap(),
                    kind: filled.kind,
                    tags: filled.tags,
                    content: filled.content,
                    sig: hex::encode(sig.to_byte_array()),
                }
            }
        }

        fn decrypt_request(
            owner: &OwnerKeys,
            backend_pubkey: &str,
            captured: &SignedNostrEvent,
        ) -> Nip46Request {
            let backend_pk =
                PublicKey::from_str(&format!("02{backend_pubkey}")).expect("valid backend pk");
            let conversation_key =
                nip44::conversation_key(&owner.secret, &backend_pk).expect("conversation key");
            let plaintext =
                nip44::decrypt(&conversation_key, &captured.content).expect("decrypt ciphertext");
            serde_json::from_slice(&plaintext).expect("parse request")
        }

        fn encrypt_response(
            owner: &OwnerKeys,
            backend_pubkey: &str,
            response: &Nip46Response,
        ) -> String {
            let backend_pk =
                PublicKey::from_str(&format!("02{backend_pubkey}")).expect("valid backend pk");
            let conversation_key =
                nip44::conversation_key(&owner.secret, &backend_pk).expect("conversation key");
            let plaintext = serde_json::to_string(response).expect("serialize response");
            nip44::encrypt(&conversation_key, plaintext.as_bytes()).expect("encrypt response")
        }

        fn wait_for_kind(
            outbox: &CaptureOutbox,
            kind: u64,
            from_index: usize,
            timeout: Duration,
        ) -> Option<(usize, SignedNostrEvent)> {
            let deadline = Instant::now() + timeout;
            loop {
                let captured = outbox.captured();
                for (idx, (event, _)) in captured.iter().enumerate().skip(from_index) {
                    if event.kind == kind {
                        return Some((idx, event.clone()));
                    }
                }
                if Instant::now() >= deadline {
                    return None;
                }
                std_thread::sleep(Duration::from_millis(5));
            }
        }

        let tenex_base_dir = unique_temp_dir("reload-reconciler");
        let daemon_dir = tenex_base_dir.join("daemon");
        let agents_dir_path = tenex_base_dir.join("agents");
        fs::create_dir_all(&daemon_dir).expect("daemon dir must create");
        fs::create_dir_all(&agents_dir_path).expect("agents dir must create");

        // Drop one agent file so the reconciler has something to publish.
        let agent_pubkey = pubkey_hex(0x21);
        fs::write(
            agents_dir_path.join(format!("{agent_pubkey}.json")),
            serde_json::to_vec_pretty(&serde_json::json!({
                "slug": "alpha",
                "status": "active",
            }))
            .expect("agent json must serialize"),
        )
        .expect("agent file must write");

        let owner_a = OwnerKeys::from_secret_hex(OWNER_A_SECRET_HEX);
        let owner_b = OwnerKeys::from_secret_hex(OWNER_B_SECRET_HEX);

        let backend_signer = Arc::new(
            HexBackendSigner::from_private_key_hex(TEST_SECRET_KEY_HEX)
                .expect("backend signer must build"),
        );
        let backend_pubkey = backend_signer.pubkey_hex().to_string();

        let outbox = CaptureOutbox::new();
        let outbox_handle: Arc<dyn PublishOutboxHandle + Send + Sync> = Arc::clone(&outbox) as _;
        let pending = PendingNip46Requests::default();
        let registry = Arc::new(NIP46Registry::new(
            Arc::clone(&backend_signer),
            pending,
            Arc::clone(&outbox_handle),
        ));

        let mut owners_config = std::collections::HashMap::new();
        owners_config.insert(
            owner_a.xonly_hex.clone(),
            OwnerNip46Config {
                bunker_uri: Some(format!(
                    "bunker://{}?relay=wss://relay.test/",
                    owner_a.xonly_hex
                )),
            },
        );
        owners_config.insert(
            owner_b.xonly_hex.clone(),
            OwnerNip46Config {
                bunker_uri: Some(format!(
                    "bunker://{}?relay=wss://relay.test/",
                    owner_b.xonly_hex
                )),
            },
        );
        let nip46_config = Nip46Config {
            signing_timeout_ms: 2_000,
            max_retries: 0,
            owners: owners_config,
        };

        let reconciler_owners = Arc::new(RwLock::new(vec![owner_a.xonly_hex.clone()]));
        let snapshot_state = Arc::new(SnapshotState::new());
        snapshot_state.mark_catchup_complete();
        let deps = ReconcilerDeps {
            tenex_base_dir: tenex_base_dir.clone(),
            backend_pubkey: backend_pubkey.clone(),
            owners: Arc::clone(&reconciler_owners),
            snapshot_state: Arc::clone(&snapshot_state),
            nip46_registry: Arc::clone(&registry),
            nip46_config: nip46_config.clone(),
            default_relay: "wss://relay.test/".to_string(),
            outbox: Arc::clone(&outbox_handle),
            debounce: Duration::from_millis(20),
            idle_retry: Duration::from_millis(200),
        };

        let (trigger_tx, trigger_rx) = std_mpsc::channel::<String>();
        let loop_handle = std_thread::spawn(move || run_reconciler_loop(deps, trigger_rx));

        // Mock bunker driving both owners: sign whichever `sign_event`
        // request lands in the outbox next.
        let registry_for_bunker = Arc::clone(&registry);
        let nip46_config_for_bunker = nip46_config.clone();
        let outbox_for_bunker = Arc::clone(&outbox);
        let backend_pubkey_for_bunker = backend_pubkey.clone();
        let owner_a_secret = OWNER_A_SECRET_HEX.to_string();
        let owner_b_secret = OWNER_B_SECRET_HEX.to_string();
        let owner_a_pub = owner_a.xonly_hex.clone();
        let owner_b_pub = owner_b.xonly_hex.clone();
        let bunker_handle = std_thread::spawn(move || {
            // Materialise clients so we have references for dispatch. The
            // reconciler will dedupe via the shared registry.
            let client_a = registry_for_bunker
                .client_for_owner(&owner_a_pub, &nip46_config_for_bunker, "wss://relay.test/")
                .expect("owner_a client must build");
            let client_b = registry_for_bunker
                .client_for_owner(&owner_b_pub, &nip46_config_for_bunker, "wss://relay.test/")
                .expect("owner_b client must build");

            let owner_a_keys = OwnerKeys::from_secret_hex(&owner_a_secret);
            let owner_b_keys = OwnerKeys::from_secret_hex(&owner_b_secret);

            let mut cursor = 0;
            for _ in 0..2 {
                // Each round: first a connect envelope, then a sign_event.
                let (connect_idx, connect_event) =
                    wait_for_kind(&outbox_for_bunker, 24133, cursor, Duration::from_secs(5))
                        .expect("connect envelope must arrive");
                cursor = connect_idx + 1;
                let addressed_to_a = connect_event.tags.iter().any(|tag| {
                    tag.get(1)
                        .map(|value| value == &owner_a_pub)
                        .unwrap_or(false)
                });
                let (client, keys) = if addressed_to_a {
                    (&client_a, &owner_a_keys)
                } else {
                    (&client_b, &owner_b_keys)
                };
                let connect_request =
                    decrypt_request(keys, &backend_pubkey_for_bunker, &connect_event);
                assert_eq!(connect_request.method, "connect");
                let connect_response = Nip46Response {
                    id: connect_request.id,
                    result: Some("ack".to_string()),
                    error: None,
                };
                let encrypted_connect =
                    encrypt_response(keys, &backend_pubkey_for_bunker, &connect_response);
                client
                    .dispatch_incoming(&encrypted_connect)
                    .expect("connect dispatch");

                let (sign_idx, sign_event) =
                    wait_for_kind(&outbox_for_bunker, 24133, cursor, Duration::from_secs(5))
                        .expect("sign envelope must arrive");
                cursor = sign_idx + 1;
                let sign_request = decrypt_request(keys, &backend_pubkey_for_bunker, &sign_event);
                assert_eq!(sign_request.method, "sign_event");
                let unsigned: NormalizedNostrEvent =
                    serde_json::from_str(&sign_request.params[0]).unwrap();
                let signed = keys.sign_event(&unsigned);
                let sign_response = Nip46Response {
                    id: sign_request.id,
                    result: Some(serde_json::to_string(&signed).unwrap()),
                    error: None,
                };
                let encrypted_sign =
                    encrypt_response(keys, &backend_pubkey_for_bunker, &sign_response);
                client
                    .dispatch_incoming(&encrypted_sign)
                    .expect("sign dispatch");
            }
        });

        // First reconcile owner_a — it's in the owners list.
        trigger_tx
            .send(owner_a.xonly_hex.clone())
            .expect("trigger owner_a");
        let wait_until = Instant::now() + Duration::from_secs(5);
        loop {
            let captured_for_a: Vec<_> = outbox
                .captured()
                .into_iter()
                .filter(|(event, _)| event.kind == 14199 && event.pubkey == owner_a.xonly_hex)
                .collect();
            if !captured_for_a.is_empty() {
                break;
            }
            assert!(
                Instant::now() < wait_until,
                "timed out waiting for owner_a 14199 publication"
            );
            std_thread::sleep(Duration::from_millis(10));
        }

        // SIGHUP-style swap: replace the reconciler's owners set with [owner_b].
        {
            let mut guard = reconciler_owners.write().unwrap();
            *guard = vec![owner_b.xonly_hex.clone()];
        }

        // Reconcile owner_b; the reconciler honours triggers regardless of
        // the `owners` list, but if the shared set were the source of truth
        // for other supervisors, this is now the only configured owner.
        trigger_tx
            .send(owner_b.xonly_hex.clone())
            .expect("trigger owner_b");
        let wait_until = Instant::now() + Duration::from_secs(5);
        loop {
            let captured_for_b: Vec<_> = outbox
                .captured()
                .into_iter()
                .filter(|(event, _)| event.kind == 14199 && event.pubkey == owner_b.xonly_hex)
                .collect();
            if !captured_for_b.is_empty() {
                break;
            }
            assert!(
                Instant::now() < wait_until,
                "timed out waiting for owner_b 14199 publication after reload"
            );
            std_thread::sleep(Duration::from_millis(10));
        }

        drop(trigger_tx);
        loop_handle.join().expect("reconciler loop joins");
        bunker_handle.join().expect("bunker joins");

        let final_events: Vec<String> = outbox
            .captured()
            .into_iter()
            .filter_map(|(event, _)| {
                if event.kind == 14199 {
                    Some(event.pubkey)
                } else {
                    None
                }
            })
            .collect();
        let observed: BTreeSet<String> = final_events.into_iter().collect();
        assert!(observed.contains(&owner_a.xonly_hex));
        assert!(observed.contains(&owner_b.xonly_hex));

        fs::remove_dir_all(tenex_base_dir).expect("cleanup must succeed");
    }
}
