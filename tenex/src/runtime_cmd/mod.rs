mod agent_config_publish;
mod agent_config_reload;
mod agent_config_update;
mod agent_subprocess;
mod control;
mod control_process;
mod control_shell;
#[cfg(test)]
mod control_tests;
mod dispatch_coordinator;
mod dispatch_pipeline;
mod event_routing;
mod mcp_resource_control;
mod mcp_subscription_delivery;
mod mcp_subscriptions;
mod runtime_setup;
mod runtime_state_store;
mod sign_as_user;
mod transport;

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use anyhow::{Context, Result};
use clap::Parser;
use nostr_sdk::prelude::*;
use notify::{
    Config as NotifyConfig, Event as NotifyEvent, RecommendedWatcher, RecursiveMode, Watcher,
};
use tracing::{info, warn};

use agent_config_reload::{
    agent_config_event_is_relevant, reload_agent_snapshot, republish_agent_config,
    startup_publish_missing_agent_configs, RuntimeReloadContext,
};
use control::{serve_control_socket, RuntimeControlState};
use dispatch_coordinator::DispatchCoordinator;
use dispatch_pipeline::{handle_relay_event, handle_transport_dispatch};
use runtime_setup::{
    build_runtime_filters, find_agent_acp_binary, find_agent_binary, pubkey_hex_set,
    resolve_project_working_dir, subscribe_runtime_filters, trusted_runtime_authors,
    RuntimeLockfile,
};
use tenex_conversations::{ConversationStore, Project as ConversationsProject};
use tenex_mcp::ProjectMcpRuntime;
use tenex_project::{models::ProjectAgent, Agent, Project};

use crate::daemon::config;
use crate::nostr_pub::{backend_signer, project_status};
use crate::store::resolve_base_dir;

pub(super) const PROJECT_KIND: u16 = 31933;

#[derive(Parser, Clone)]
pub struct RuntimeArgs {
    /// Project d-tag or full NIP-33 coordinate (31933:<pubkey>:<dTag>).
    pub project_id: String,

    /// TENEX base directory (default: $TENEX_BASE_DIR or ~/.tenex).
    #[arg(long, value_name = "PATH")]
    pub base_dir: Option<PathBuf>,
}

#[derive(Clone)]
struct RuntimeShared {
    client: Client,
    backend_keys: Keys,
    project_addr: String,
    /// Human-readable project title (falls back to d-tag) — handed to
    /// the firewall LLM as part of its judgement context.
    project_title: String,
    /// Human users from config. Kept separate from trusted system authors
    /// because these pubkeys are also used for user-visible status tags and
    /// shell-intervention policy.
    whitelisted_pubkeys: Vec<String>,
    trusted_author_pubkeys: HashSet<String>,
    /// When true, kind:1 events from authors outside trusted runtime authors
    /// and project agents are eligible for firewall + dispatch. When false,
    /// they are still persisted to the conversation store for context but
    /// never trigger an agent run.
    route_unauthorized_authors: bool,
    backend_name: Option<String>,
    project_id: String,
    project_dir: PathBuf,
    base_dir: PathBuf,
    agent_binary: PathBuf,
    agent_acp_binary: PathBuf,
    agent_snapshot: Arc<RwLock<RuntimeAgentSnapshot>>,
    mcp_runtime: Arc<ProjectMcpRuntime>,
    mcp_subscriptions: Arc<mcp_subscriptions::McpSubscriptionRegistry>,
    store: Arc<Mutex<ConversationStore>>,
    coordinator: Arc<Mutex<DispatchCoordinator>>,
    control: Arc<RuntimeControlState>,
    seen: Arc<Mutex<HashSet<EventId>>>,
}

impl RuntimeShared {
    fn agent_snapshot(&self) -> RuntimeAgentSnapshot {
        self.agent_snapshot.read().unwrap().clone()
    }

    fn agent_pubkeys(&self) -> HashSet<String> {
        self.agent_snapshot.read().unwrap().agent_pubkeys.clone()
    }

    /// Pubkeys of every project member, regardless of whether this backend
    /// has the agent's nsec on disk. The difference with [`agent_pubkeys`]
    /// is exactly the set of remote-running agents.
    fn project_member_pubkeys(&self) -> HashSet<String> {
        self.agent_snapshot
            .read()
            .unwrap()
            .project_agents
            .iter()
            .map(|pa| pa.agent_pubkey.clone())
            .collect()
    }
}

#[derive(Clone)]
pub(super) struct RuntimeAgentSnapshot {
    pub(super) agents: Vec<Agent>,
    pub(super) project_agents: Vec<ProjectAgent>,
    pub(super) agent_pubkeys: HashSet<String>,
}

impl RuntimeAgentSnapshot {
    fn load(project: &Project) -> Result<Self> {
        let agents = project.agents()?;
        let project_agents = project.project_agents()?;
        let agent_pubkeys = agents.iter().map(|a| a.pubkey.clone()).collect();
        Ok(Self {
            agents,
            project_agents,
            agent_pubkeys,
        })
    }
}

#[derive(Clone)]
pub(super) struct RuntimeSubscriptionIds {
    pub(super) project: SubscriptionId,
    pub(super) project_definition: SubscriptionId,
    pub(super) directed: SubscriptionId,
    pub(super) stop: SubscriptionId,
    pub(super) config_update: SubscriptionId,
}

impl RuntimeSubscriptionIds {
    fn new(project_id: &str) -> Self {
        Self {
            project: SubscriptionId::new(format!("tenex-runtime-{project_id}-project")),
            project_definition: SubscriptionId::new(format!(
                "tenex-runtime-{project_id}-project-definition"
            )),
            directed: SubscriptionId::new(format!("tenex-runtime-{project_id}-directed")),
            stop: SubscriptionId::new(format!("tenex-runtime-{project_id}-stop")),
            config_update: SubscriptionId::new(format!("tenex-runtime-{project_id}-config-update")),
        }
    }
}

pub(super) struct RuntimeFilters {
    pub(super) project: Filter,
    pub(super) project_definition: Filter,
    pub(super) directed: Filter,
    pub(super) stop: Filter,
    pub(super) config_update: Filter,
}

pub async fn run(args: RuntimeArgs) -> Result<()> {
    let base_dir = resolve_base_dir(args.base_dir);

    let cfg = config::load(&base_dir)
        .with_context(|| format!("loading config from {}", base_dir.display()))?;

    let project = Project::open(&args.project_id, &base_dir)
        .with_context(|| format!("opening project '{}'", args.project_id))?;
    let meta = project.metadata()?.with_context(|| {
        format!(
            "project '{}' has no event.json — has it been received from a relay?",
            args.project_id
        )
    })?;
    let agent_snapshot = RuntimeAgentSnapshot::load(&project)?;

    if agent_snapshot.agents.is_empty() {
        anyhow::bail!("project '{}' has no agents", meta.d_tag);
    }

    let store = Arc::new(Mutex::new(
        ConversationsProject::open_conversations(&meta.d_tag, &base_dir)
            .context("opening conversation store")?,
    ));

    let lock_dir = base_dir.join("projects").join(meta.d_tag.as_str());
    std::fs::create_dir_all(&lock_dir)?;
    let _lock = RuntimeLockfile::acquire(&lock_dir)?;

    let user_authors: Vec<PublicKey> = cfg
        .whitelisted_pubkeys
        .iter()
        .filter_map(|pk| PublicKey::from_hex(pk).ok())
        .collect();

    if user_authors.is_empty() {
        anyhow::bail!("no valid whitelisted pubkeys in config");
    }

    let backend_keys =
        backend_signer::ensure_backend_keys(&base_dir).context("loading runtime relay signer")?;
    let trusted_authors = trusted_runtime_authors(&user_authors, backend_keys.public_key());
    let trusted_author_pubkeys = pubkey_hex_set(&trusted_authors);
    let client = Client::new(backend_keys.clone());
    for relay in &cfg.relays {
        if let Err(e) = client.add_relay(relay.as_str()).await {
            warn!(relay, error = %e, "add_relay failed");
        }
    }
    client.connect().await;
    info!(relays = cfg.relays.len(), project = %meta.d_tag, "connected to relays");

    let since = Timestamp::now();
    let owner_pubkey = meta
        .owner_pubkey
        .as_deref()
        .context("project metadata has no owner_pubkey")?;
    let owner_key = PublicKey::from_hex(owner_pubkey)
        .with_context(|| format!("invalid project owner pubkey '{}'", owner_pubkey))?;
    let project_addr = format!("31933:{}:{}", owner_pubkey, meta.d_tag);

    let subscription_ids = RuntimeSubscriptionIds::new(&meta.d_tag);
    subscribe_runtime_filters(
        &client,
        &subscription_ids,
        build_runtime_filters(
            &user_authors,
            &trusted_authors,
            &project_addr,
            owner_key,
            &meta.d_tag,
            since,
            &agent_snapshot,
        ),
    )
    .await?;
    info!("subscriptions active");

    if cfg.route_unauthorized_authors {
        match crate::store::llms::LlmsDoc::load(&base_dir) {
            Ok(llms) if llms.firewall().is_none() => {
                warn!(
                    "routeUnauthorizedAuthors=true but no llms.firewall role is configured — \
                     every external-author event will fail closed. Set the 'firewall' role in \
                     ~/.tenex/llms.json (an Ollama-backed config is recommended)."
                );
            }
            Ok(_) => {}
            Err(e) => {
                warn!(error = %e, "failed to load llms.json while checking firewall role");
            }
        }
    }

    let agent_snapshot_state = Arc::new(RwLock::new(agent_snapshot.clone()));

    // Publish project status (kind:24010) immediately and every 30 seconds.
    let client_status = client.clone();
    let keys_status = backend_keys.clone();
    let meta_status = meta.clone();
    let agent_snapshot_status = agent_snapshot_state.clone();
    let whitelist_status = cfg.whitelisted_pubkeys.clone();
    let base_dir_status = base_dir.clone();
    let project_dir_status = resolve_project_working_dir(&base_dir, &meta.d_tag)
        .with_context(|| format!("resolving project working directory for '{}'", meta.d_tag))?;
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(30));
        loop {
            interval.tick().await;
            let snapshot = agent_snapshot_status.read().unwrap().clone();
            match project_status::build_project_status_event(
                &keys_status,
                &meta_status,
                &project_dir_status,
                &base_dir_status,
                &snapshot.agents,
                &whitelist_status,
            ) {
                Ok(event) => {
                    if let Err(e) = client_status.send_event(&event).await {
                        warn!(error = %e, "24010 publish failed");
                    }
                }
                Err(e) => warn!(error = %e, "24010 build failed"),
            }
        }
    });

    let agent_binary = find_agent_binary();
    let agent_acp_binary = find_agent_acp_binary();
    let project_dir = resolve_project_working_dir(&base_dir, &meta.d_tag)
        .with_context(|| format!("resolving project working directory for '{}'", meta.d_tag))?;
    std::fs::create_dir_all(&project_dir)
        .with_context(|| format!("creating project directory {}", project_dir.display()))?;
    let mcp_runtime = ProjectMcpRuntime::load(&project_dir)
        .with_context(|| format!("loading project MCP config from {}", project_dir.display()))?;
    let configured_mcp_servers = mcp_runtime.configured_server_names();
    if !configured_mcp_servers.is_empty() {
        info!(servers = %configured_mcp_servers.join(", "), "project MCP servers configured");
    }
    let mcp_subscriptions = mcp_subscriptions::McpSubscriptionRegistry::load(base_dir.clone())
        .context("loading MCP subscription registry")?;
    let coordinator = Arc::new(Mutex::new(DispatchCoordinator::default()));
    let (transport_dispatch_tx, mut transport_dispatch_rx) =
        tokio::sync::mpsc::unbounded_channel::<control::TransportDispatchRequest>();
    let (mcp_control_tx, mut mcp_control_rx) =
        tokio::sync::mpsc::unbounded_channel::<mcp_subscriptions::McpControlCommand>();
    let control = Arc::new(RuntimeControlState::new(
        base_dir.clone(),
        meta.d_tag.clone(),
        transport_dispatch_tx,
        mcp_control_tx,
    ));
    let project_title = meta.title.clone().unwrap_or_else(|| meta.d_tag.clone());
    let shared = Arc::new(RuntimeShared {
        client: client.clone(),
        backend_keys: backend_keys.clone(),
        project_addr: project_addr.clone(),
        project_title,
        whitelisted_pubkeys: cfg.whitelisted_pubkeys.clone(),
        trusted_author_pubkeys,
        route_unauthorized_authors: cfg.route_unauthorized_authors,
        backend_name: cfg.backend_name.clone(),
        project_id: meta.d_tag.clone(),
        project_dir: project_dir.clone(),
        base_dir: base_dir.clone(),
        agent_binary,
        agent_acp_binary,
        agent_snapshot: agent_snapshot_state,
        mcp_runtime,
        mcp_subscriptions,
        store: store.clone(),
        coordinator,
        control: control.clone(),
        seen: Arc::new(Mutex::new(HashSet::new())),
    });
    shared
        .mcp_subscriptions
        .restore_active(shared.clone())
        .await
        .context("restoring MCP subscriptions")?;
    let control_socket_path = control.socket_path();
    let control_task = tokio::spawn(serve_control_socket(control, control_socket_path.clone()));

    let agents_dir = base_dir.join("agents");
    let (agent_fs_tx, mut agent_fs_rx) =
        tokio::sync::mpsc::channel::<Result<NotifyEvent, notify::Error>>(64);
    let mut agent_config_watcher = RecommendedWatcher::new(
        move |res| {
            agent_fs_tx.blocking_send(res).ok();
        },
        NotifyConfig::default(),
    )
    .context("create agent config watcher")?;
    agent_config_watcher
        .watch(&agents_dir, RecursiveMode::NonRecursive)
        .with_context(|| format!("watch agents dir {}", agents_dir.display()))?;
    info!(path = %agents_dir.display(), "watching for agent config changes");

    let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let mut notifications = client.notifications();
    let reload_context = RuntimeReloadContext {
        subscription_ids: &subscription_ids,
        user_authors: &user_authors,
        trusted_authors: &trusted_authors,
        project_addr: &project_addr,
        owner: owner_key,
        project_dtag: &meta.d_tag,
        since,
        meta: &meta,
    };

    // Startup-only: REQ kind:0 for every managed agent's pubkey, diff
    // against on-disk config mtimes, publish the gaps. Bounded by a 5s
    // fetch timeout so a slow relay can't block the runtime from coming up.
    startup_publish_missing_agent_configs(&shared).await;

    loop {
        tokio::select! {
            Some(event) = agent_fs_rx.recv() => {
                match event {
                    Ok(event) if agent_config_event_is_relevant(&event) => {
                        // Capture which agent file(s) fired before we reload
                        // the snapshot — `reload_agent_snapshot` already
                        // republishes kind:0 for every agent, but we also
                        // emit a targeted republish per changed file so the
                        // logs attribute the change to the right agent and
                        // so a future bulk-reload skip optimization stays
                        // safe.
                        let changed_pubkeys: Vec<String> = event
                            .paths
                            .iter()
                            .filter_map(|p| agent_config_publish::agent_pubkey_from_path(p))
                            .collect();
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        if let Err(error) = reload_agent_snapshot(&shared, &reload_context)
                        .await
                        {
                            warn!(error = %error, "agent config reload failed");
                        }
                        for agent_pubkey in changed_pubkeys {
                            republish_agent_config(&shared, &agent_pubkey).await;
                        }
                    }
                    Ok(_) => {}
                    Err(error) => warn!(error = %error, "agent config watcher error"),
                }
            }
            result = notifications.recv() => {
                match result {
                    Ok(RelayPoolNotification::Event { event, .. }) => {
                        handle_relay_event(&shared, event, &reload_context, &base_dir).await;
                    }
                    Ok(_) => {}
                    Err(e) => {
                        warn!(error = %e, "relay notification error");
                    }
                }
            }
            Some(req) = transport_dispatch_rx.recv() => {
                handle_transport_dispatch(shared.clone(), req).await;
            }
            Some(cmd) = mcp_control_rx.recv() => {
                mcp_subscriptions::handle_control(shared.clone(), cmd).await;
            }
            _ = tokio::signal::ctrl_c() => {
                info!("shutting down (SIGINT)");
                break;
            }
            _ = sigterm.recv() => {
                info!("shutting down (SIGTERM)");
                break;
            }
        }
    }

    shared.mcp_subscriptions.shutdown().await;
    shared.mcp_runtime.shutdown().await;
    control_task.abort();
    let _ = tokio::fs::remove_file(control_socket_path).await;
    client.disconnect().await;
    Ok(())
}
