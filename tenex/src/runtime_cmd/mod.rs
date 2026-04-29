mod agent_config_update;
mod control;
mod control_process;
mod control_shell;
#[cfg(test)]
mod control_tests;
mod transport;

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use clap::Parser;
use nostr::JsonUtil;
use nostr_sdk::prelude::*;
use notify::{
    Config as NotifyConfig, Event as NotifyEvent, RecommendedWatcher, RecursiveMode, Watcher,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter};
use tracing::{info, info_span, warn, Instrument};

use control::{serve_control_socket, RuntimeControlState};
use tenex_conversations::{
    AgentContextState, ConversationStore, MessageQuery, NewMessage, Project as ConversationsProject,
};
use tenex_mcp::{ProjectMcpRuntime, SocketServerConfig};
use tenex_project::{
    models::{ProjectAgent, ProjectMetadata},
    Agent, Project,
};

use crate::daemon::config;
use crate::nostr_pub::{backend_signer, operations_status, project_status};
use crate::store::tenex_config::TenexConfigDoc;
use crate::store::{atomic, resolve_base_dir};

const DRIVER_STALE_AFTER_MS: i64 = 10 * 60 * 1000;
const PROJECT_KIND: u16 = 31933;

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
    backend_keys: Option<Keys>,
    project_addr: String,
    whitelisted_pubkeys: Vec<String>,
    project_id: String,
    project_dir: PathBuf,
    base_dir: PathBuf,
    agent_binary: PathBuf,
    agent_acp_binary: PathBuf,
    agent_snapshot: Arc<RwLock<RuntimeAgentSnapshot>>,
    mcp_runtime: Arc<ProjectMcpRuntime>,
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
}

#[derive(Clone)]
struct RuntimeAgentSnapshot {
    agents: Vec<Agent>,
    project_agents: Vec<ProjectAgent>,
    agent_pubkeys: HashSet<String>,
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
struct RuntimeSubscriptionIds {
    project: SubscriptionId,
    project_definition: SubscriptionId,
    directed: SubscriptionId,
    stop: SubscriptionId,
    config_update: SubscriptionId,
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

struct RuntimeFilters {
    project: Filter,
    project_definition: Filter,
    directed: Filter,
    stop: Filter,
    config_update: Filter,
}

#[derive(Clone)]
struct DispatchJob {
    event: Event,
    agent: Agent,
    conv_id: String,
    agent_json: PathBuf,
    allow_driver_preempt: bool,
    completion_recipient_pubkey: Option<String>,
    /// Set when this dispatch was triggered via the transport-bridge socket
    /// (`tenex-telegram` etc). Each event the agent emits is also forwarded
    /// to the bridge so it can render the reply on the originating channel.
    response_tee: Option<transport::TransportTee>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AgentRuntimeKind {
    Tenex,
    Acp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DelegationRoute {
    parent_agent_pubkey: String,
    parent_conversation_id: String,
    parent_completion_recipient_pubkey: String,
    child_agent_pubkey: String,
    child_conversation_id: String,
    delegation_event_id: String,
    created_at: i64,
}

struct ActiveMcpBridge {
    manifest_path: PathBuf,
    socket_path: PathBuf,
    shutdown: tokio::sync::oneshot::Sender<()>,
    task: tokio::task::JoinHandle<()>,
}

impl ActiveMcpBridge {
    async fn shutdown(self) {
        let _ = self.shutdown.send(());
        let _ = tokio::time::timeout(Duration::from_secs(2), self.task).await;
        let _ = tokio::fs::remove_file(self.manifest_path).await;
        let _ = tokio::fs::remove_file(self.socket_path).await;
    }
}

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
struct DispatchKey {
    agent_pubkey: String,
    conversation_id: String,
}

impl DispatchKey {
    fn new(agent_pubkey: impl Into<String>, conversation_id: impl Into<String>) -> Self {
        Self {
            agent_pubkey: agent_pubkey.into(),
            conversation_id: conversation_id.into(),
        }
    }
}

#[derive(Default)]
struct DispatchCoordinator {
    entries: HashMap<DispatchKey, DispatchEntry>,
}

#[derive(Default)]
struct DispatchEntry {
    active_runs: usize,
    driver_busy: bool,
    queued: VecDeque<DispatchJob>,
}

impl DispatchCoordinator {
    fn dispatch_inbound(
        &mut self,
        job: DispatchJob,
        allow_parallel_when_busy: bool,
    ) -> Option<DispatchJob> {
        let key = DispatchKey::new(job.agent.pubkey.clone(), job.conv_id.clone());
        let entry = self.entries.entry(key).or_default();

        if entry.active_runs == 0 {
            entry.active_runs = 1;
            entry.driver_busy = true;
            return Some(job);
        }

        if entry.driver_busy && !allow_parallel_when_busy {
            entry.queued.push_back(job);
            return None;
        }

        entry.active_runs += 1;
        entry.driver_busy = true;
        Some(job)
    }

    fn mark_driver_busy(&mut self, key: &DispatchKey) {
        if let Some(entry) = self.entries.get_mut(key) {
            entry.driver_busy = true;
        }
    }

    fn mark_driver_free(&mut self, key: &DispatchKey) {
        let Some(entry) = self.entries.get_mut(key) else {
            return;
        };
        entry.driver_busy = false;
    }

    fn sync_driver_busy(&mut self, key: &DispatchKey, driver_busy: bool) {
        if let Some(entry) = self.entries.get_mut(key) {
            entry.driver_busy = driver_busy;
        }
    }

    fn drop_queued_matching(
        &mut self,
        key: &DispatchKey,
        mut should_drop: impl FnMut(&DispatchJob) -> bool,
    ) {
        if let Some(entry) = self.entries.get_mut(key) {
            entry.queued.retain(|job| !should_drop(job));
        }
    }

    fn finish_run(&mut self, key: &DispatchKey) -> Option<DispatchJob> {
        let Some(entry) = self.entries.get_mut(key) else {
            return None;
        };

        entry.active_runs = entry.active_runs.saturating_sub(1);
        if entry.active_runs == 0 {
            entry.driver_busy = false;
        }

        let next = if !entry.driver_busy {
            if let Some(job) = entry.queued.pop_back() {
                entry.queued.clear();
                entry.active_runs += 1;
                entry.driver_busy = true;
                Some(job)
            } else {
                None
            }
        } else {
            None
        };

        if entry.active_runs == 0 && entry.queued.is_empty() {
            self.entries.remove(key);
        }

        next
    }

    fn active_agent_pubkeys(&self) -> Vec<String> {
        let mut out = Vec::new();
        for (key, entry) in &self.entries {
            if entry.active_runs > 0 && !out.contains(&key.agent_pubkey) {
                out.push(key.agent_pubkey.clone());
            }
        }
        out
    }
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

    let authors: Vec<PublicKey> = cfg
        .whitelisted_pubkeys
        .iter()
        .filter_map(|pk| PublicKey::from_hex(pk).ok())
        .collect();

    if authors.is_empty() {
        anyhow::bail!("no valid whitelisted pubkeys in config");
    }

    let client = Client::default();
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

    let backend_keys = match backend_signer::ensure_backend_keys(&base_dir) {
        Ok(keys) => Some(keys),
        Err(e) => {
            warn!(error = %e, "backend keys unavailable; status events (24010/24133) will not be published");
            None
        }
    };

    let subscription_ids = RuntimeSubscriptionIds::new(&meta.d_tag);
    subscribe_runtime_filters(
        &client,
        &subscription_ids,
        build_runtime_filters(
            &authors,
            &project_addr,
            owner_key,
            &meta.d_tag,
            since,
            &agent_snapshot,
        ),
    )
    .await?;
    info!("subscriptions active");

    let agent_snapshot_state = Arc::new(RwLock::new(agent_snapshot.clone()));

    // Publish project status (kind:24010) immediately and every 30 seconds.
    if let Some(ref keys) = backend_keys {
        let client_status = client.clone();
        let keys_status = keys.clone();
        let meta_status = meta.clone();
        let agent_snapshot_status = agent_snapshot_state.clone();
        let base_dir_status = base_dir.clone();
        let whitelist_status = cfg.whitelisted_pubkeys.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(30));
            loop {
                interval.tick().await;
                let snapshot = agent_snapshot_status.read().unwrap().clone();
                let models_status = match crate::store::llms::LlmsDoc::load(&base_dir_status) {
                    Ok(llms) => project_status::collect_model_access(&llms, &snapshot.agents),
                    Err(e) => {
                        warn!(error = %e, "24010 model tag collection failed");
                        Vec::new()
                    }
                };
                match project_status::build_project_status_event(
                    &keys_status,
                    &meta_status,
                    &snapshot.agents,
                    &snapshot.project_agents,
                    &models_status,
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
    }

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
    let coordinator = Arc::new(Mutex::new(DispatchCoordinator::default()));
    let (transport_dispatch_tx, mut transport_dispatch_rx) =
        tokio::sync::mpsc::unbounded_channel::<control::TransportDispatchRequest>();
    let control = Arc::new(RuntimeControlState::new(
        base_dir.clone(),
        meta.d_tag.clone(),
        transport_dispatch_tx,
    ));
    let shared = Arc::new(RuntimeShared {
        client: client.clone(),
        backend_keys: backend_keys.clone(),
        project_addr: project_addr.clone(),
        whitelisted_pubkeys: cfg.whitelisted_pubkeys.clone(),
        project_id: meta.d_tag.clone(),
        project_dir: project_dir.clone(),
        base_dir: base_dir.clone(),
        agent_binary,
        agent_acp_binary,
        agent_snapshot: agent_snapshot_state,
        mcp_runtime,
        store: store.clone(),
        coordinator,
        control: control.clone(),
        seen: Arc::new(Mutex::new(HashSet::new())),
    });
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

    loop {
        tokio::select! {
            Some(event) = agent_fs_rx.recv() => {
                match event {
                    Ok(event) if agent_config_event_is_relevant(&event) => {
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        if let Err(error) = reload_agent_snapshot(
                            &shared,
                            &subscription_ids,
                            &authors,
                            &project_addr,
                            owner_key,
                            &meta.d_tag,
                            since,
                            &meta,
                        )
                        .await
                        {
                            warn!(error = %error, "agent config reload failed");
                        }
                    }
                    Ok(_) => {}
                    Err(error) => warn!(error = %error, "agent config watcher error"),
                }
            }
            result = notifications.recv() => {
                match result {
                    Ok(RelayPoolNotification::Event { event, .. }) => {
                        if !mark_seen(&shared.seen, event.id) {
                            continue;
                        }
                        if event.kind == Kind::Custom(PROJECT_KIND) {
                            if let Err(e) = handle_project_definition_update(
                                &shared,
                                &subscription_ids,
                                &authors,
                                &project_addr,
                                owner_key,
                                &meta.d_tag,
                                since,
                                &event,
                            )
                            .await
                            {
                                warn!(event_id = %event.id.to_hex()[..8], error = %e, "project definition update failed");
                            }
                            continue;
                        }
                        if event.kind == Kind::Custom(tenex_protocol::nostr::kinds::STOP_COMMAND) {
                            if let Err(e) = handle_stop_command(shared.clone(), &event).await {
                                warn!(event_id = %event.id.to_hex()[..8], error = %e, "stop command failed");
                            }
                            continue;
                        }
                        if event.kind == Kind::Custom(tenex_protocol::nostr::kinds::AGENT_CONFIG_UPDATE) {
                            if let Err(e) = handle_agent_config_update(
                                &shared,
                                &subscription_ids,
                                &authors,
                                &project_addr,
                                owner_key,
                                &meta.d_tag,
                                since,
                                &meta,
                                &event,
                            )
                            .await
                            {
                                warn!(event_id = %event.id.to_hex()[..8], error = %e, "agent config update failed");
                            }
                            continue;
                        }
                        if !event_matches_project_scope(&event, &shared.project_addr) {
                            continue;
                        }
                        let agent_pubkeys = shared.agent_pubkeys();
                        if agent_pubkeys.contains(&event.pubkey.to_hex())
                            && !targets_project_agent(&event, &agent_pubkeys)
                        {
                            continue;
                        }
                        let short = &event.id.to_hex()[..8];
                        info!(event_id = short, "received event");
                        if let Err(e) = register_delegation_route_if_needed(
                            &shared.store,
                            &event,
                            &agent_pubkeys,
                            None,
                        ) {
                            warn!(event_id = short, error = %e, "failed to register delegation route");
                        }
                        match select_dispatch_target(&shared, &event) {
                            Ok((agent, conv_id, completion_recipient_pubkey)) => {
                                info!(event_id = short, agent = %agent.slug, conversation_id = %conv_id, "dispatching");
                                if is_agent_blocked(&shared.store, &conv_id, &agent.pubkey) {
                                    warn!(
                                        event_id = short,
                                        agent = %agent.slug,
                                        conversation_id = %conv_id,
                                        "agent is blocked in conversation"
                                    );
                                    continue;
                                }
                                let agent_json = base_dir
                                    .join("agents")
                                    .join(format!("{}.json", agent.pubkey));
                                let job = DispatchJob {
                                    event: *event,
                                    agent: agent.clone(),
                                    conv_id,
                                    agent_json,
                                    allow_driver_preempt: false,
                                    completion_recipient_pubkey,
                                    response_tee: None,
                                };
                                if let Err(e) = accept_dispatch(shared.clone(), job).await {
                                    warn!(event_id = short, agent = %agent.slug, error = %e, "dispatch failed");
                                }
                            }
                            Err(e) => {
                                warn!(event_id = short, error = %e, "no dispatch target");
                            }
                        }
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

    shared.mcp_runtime.shutdown().await;
    control_task.abort();
    let _ = tokio::fs::remove_file(control_socket_path).await;
    client.disconnect().await;
    Ok(())
}

fn resolve_project_working_dir(base_dir: &Path, project_dtag: &str) -> Result<PathBuf> {
    let config = TenexConfigDoc::load(base_dir)?;
    let projects_base = config
        .projects_base()
        .unwrap_or_else(crate::onboard::commit::default_projects_base);
    Ok(crate::utils::path_expand::resolve_path(&projects_base).join(project_dtag))
}

fn build_runtime_filters(
    authors: &[PublicKey],
    project_addr: &str,
    owner: PublicKey,
    project_dtag: &str,
    since: Timestamp,
    snapshot: &RuntimeAgentSnapshot,
) -> RuntimeFilters {
    let agent_keys: Vec<PublicKey> = snapshot
        .agents
        .iter()
        .filter_map(|a| PublicKey::from_hex(&a.pubkey).ok())
        .collect();
    let mut p_authors = authors.to_vec();
    p_authors.extend(agent_keys.iter().copied());

    RuntimeFilters {
        project: Filter::new()
            .kind(Kind::TextNote)
            .authors(authors.to_vec())
            .custom_tags(SingleLetterTag::lowercase(Alphabet::A), [project_addr])
            .since(since),
        project_definition: Filter::new()
            .kind(Kind::Custom(PROJECT_KIND))
            .author(owner)
            .custom_tags(SingleLetterTag::lowercase(Alphabet::D), [project_dtag]),
        directed: Filter::new()
            .kind(Kind::TextNote)
            .authors(p_authors)
            .pubkeys(agent_keys.clone())
            .since(since),
        stop: Filter::new()
            .kind(Kind::Custom(tenex_protocol::nostr::kinds::STOP_COMMAND))
            .authors(authors.to_vec())
            .pubkeys(agent_keys.clone())
            .since(since),
        config_update: Filter::new()
            .kind(Kind::Custom(
                tenex_protocol::nostr::kinds::AGENT_CONFIG_UPDATE,
            ))
            .authors(authors.to_vec())
            .since(since),
    }
}

async fn subscribe_runtime_filters(
    client: &Client,
    ids: &RuntimeSubscriptionIds,
    filters: RuntimeFilters,
) -> Result<()> {
    for id in [
        &ids.project,
        &ids.project_definition,
        &ids.directed,
        &ids.stop,
        &ids.config_update,
    ] {
        client.unsubscribe(id).await;
    }
    client
        .subscribe_with_id(ids.project.clone(), filters.project, None)
        .await?;
    client
        .subscribe_with_id(
            ids.project_definition.clone(),
            filters.project_definition,
            None,
        )
        .await?;
    client
        .subscribe_with_id(ids.directed.clone(), filters.directed, None)
        .await?;
    client
        .subscribe_with_id(ids.stop.clone(), filters.stop, None)
        .await?;
    client
        .subscribe_with_id(ids.config_update.clone(), filters.config_update, None)
        .await?;
    Ok(())
}

fn agent_config_event_is_relevant(event: &NotifyEvent) -> bool {
    event.paths.iter().any(|path| {
        path.extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension == "json")
    })
}

async fn reload_agent_snapshot(
    shared: &RuntimeShared,
    subscription_ids: &RuntimeSubscriptionIds,
    authors: &[PublicKey],
    project_addr: &str,
    owner: PublicKey,
    project_dtag: &str,
    since: Timestamp,
    meta: &ProjectMetadata,
) -> Result<()> {
    let old_pubkeys = shared.agent_pubkeys();
    let snapshot = load_agent_snapshot_after_change(shared, &old_pubkeys).await?;
    let new_pubkeys = snapshot.agent_pubkeys.clone();
    {
        let mut current = shared.agent_snapshot.write().unwrap();
        *current = snapshot.clone();
    }

    subscribe_runtime_filters(
        &shared.client,
        subscription_ids,
        build_runtime_filters(authors, project_addr, owner, project_dtag, since, &snapshot),
    )
    .await?;
    publish_project_status_now(shared, meta).await;

    let added = new_pubkeys.difference(&old_pubkeys).count();
    let removed = old_pubkeys.difference(&new_pubkeys).count();
    info!(
        agents = snapshot.agents.len(),
        added, removed, "reloaded agent configuration"
    );
    Ok(())
}

async fn handle_project_definition_update(
    shared: &RuntimeShared,
    subscription_ids: &RuntimeSubscriptionIds,
    authors: &[PublicKey],
    project_addr: &str,
    owner: PublicKey,
    project_dtag: &str,
    since: Timestamp,
    event: &Event,
) -> Result<()> {
    if event.pubkey != owner || project_definition_dtag(event).as_deref() != Some(project_dtag) {
        return Ok(());
    }
    let persisted = persist_newer_project_definition(shared, project_dtag, event)?;
    if !persisted {
        return Ok(());
    }

    reload_project_membership_snapshot(
        shared,
        subscription_ids,
        authors,
        project_addr,
        owner,
        project_dtag,
        since,
    )
    .await?;
    info!(
        event_id = %event.id.to_hex()[..8],
        project = project_dtag,
        "reloaded project definition"
    );
    Ok(())
}

fn project_definition_dtag(event: &Event) -> Option<String> {
    let d_kind = TagKind::SingleLetter(SingleLetterTag::lowercase(Alphabet::D));
    event
        .tags
        .iter()
        .find(|tag| tag.kind() == d_kind)
        .and_then(|tag| tag.content().map(str::to_owned))
}

fn persist_newer_project_definition(
    shared: &RuntimeShared,
    project_dtag: &str,
    event: &Event,
) -> Result<bool> {
    let current = Project::open(project_dtag, &shared.base_dir)
        .with_context(|| format!("opening project '{}'", project_dtag))?
        .metadata()
        .with_context(|| format!("reading project metadata for '{}'", project_dtag))?;
    let incoming_created_at = event.created_at.as_secs() as i64;
    if current
        .and_then(|meta| meta.ingested_at)
        .is_some_and(|current_created_at| current_created_at >= incoming_created_at)
    {
        return Ok(false);
    }

    let path = shared
        .base_dir
        .join("projects")
        .join(project_dtag)
        .join("event.json");
    atomic::write(&path, event.as_json().as_bytes())
        .with_context(|| format!("persisting project event {}", path.display()))?;
    Ok(true)
}

async fn reload_project_membership_snapshot(
    shared: &RuntimeShared,
    subscription_ids: &RuntimeSubscriptionIds,
    authors: &[PublicKey],
    project_addr: &str,
    owner: PublicKey,
    project_dtag: &str,
    since: Timestamp,
) -> Result<()> {
    let project = Project::open(project_dtag, &shared.base_dir)
        .with_context(|| format!("opening project '{}'", project_dtag))?;
    let snapshot = RuntimeAgentSnapshot::load(&project)?;
    if snapshot.agents.is_empty() {
        anyhow::bail!(
            "project '{}' has no readable agents after project definition reload",
            project_dtag
        );
    }

    let old_pubkeys = shared.agent_pubkeys();
    let new_pubkeys = snapshot.agent_pubkeys.clone();
    {
        let mut current = shared.agent_snapshot.write().unwrap();
        *current = snapshot.clone();
    }

    subscribe_runtime_filters(
        &shared.client,
        subscription_ids,
        build_runtime_filters(authors, project_addr, owner, project_dtag, since, &snapshot),
    )
    .await?;

    let project_meta = project
        .metadata()
        .context("reading reloaded project metadata")?
        .context("reloaded project metadata is missing")?;
    publish_project_status_now(shared, &project_meta).await;

    let added = new_pubkeys.difference(&old_pubkeys).count();
    let removed = old_pubkeys.difference(&new_pubkeys).count();
    info!(
        agents = snapshot.agents.len(),
        added, removed, "reloaded project membership"
    );
    Ok(())
}

async fn handle_agent_config_update(
    shared: &RuntimeShared,
    subscription_ids: &RuntimeSubscriptionIds,
    authors: &[PublicKey],
    project_addr: &str,
    owner: PublicKey,
    project_dtag: &str,
    since: Timestamp,
    meta: &ProjectMetadata,
    event: &Event,
) -> Result<()> {
    let agent_pubkeys = shared.agent_pubkeys();
    let outcome = agent_config_update::apply_event(
        &shared.base_dir,
        event,
        project_addr,
        project_dtag,
        &agent_pubkeys,
    )?;

    if let Some(reason) = outcome.ignored_reason {
        info!(
            event_id = %event.id.to_hex()[..8],
            agent_pubkey = outcome.agent_pubkey.as_deref().unwrap_or(""),
            reason,
            "ignored agent config update"
        );
        return Ok(());
    }

    info!(
        event_id = %event.id.to_hex()[..8],
        agent_pubkey = outcome.agent_pubkey.as_deref().unwrap_or(""),
        updated = outcome.config_updated,
        reset = outcome.has_reset,
        has_model = outcome.has_model,
        skill_count = outcome.skill_count,
        mcp_count = outcome.mcp_count,
        "processed agent config update"
    );

    if outcome.config_updated {
        reload_agent_snapshot(
            shared,
            subscription_ids,
            authors,
            project_addr,
            owner,
            project_dtag,
            since,
            meta,
        )
        .await?;
    }

    Ok(())
}

async fn load_agent_snapshot_after_change(
    shared: &RuntimeShared,
    old_pubkeys: &HashSet<String>,
) -> Result<RuntimeAgentSnapshot> {
    let mut missing_existing = Vec::new();
    for attempt in 0..5 {
        let project = Project::open(&shared.project_id, &shared.base_dir)
            .with_context(|| format!("opening project '{}'", shared.project_id))?;
        let snapshot = RuntimeAgentSnapshot::load(&project)?;
        if snapshot.agents.is_empty() {
            anyhow::bail!(
                "project '{}' has no readable agents after reload",
                shared.project_id
            );
        }
        missing_existing = old_pubkeys
            .difference(&snapshot.agent_pubkeys)
            .filter(|pubkey| {
                shared
                    .base_dir
                    .join("agents")
                    .join(format!("{pubkey}.json"))
                    .exists()
            })
            .cloned()
            .collect();
        if missing_existing.is_empty() {
            return Ok(snapshot);
        }
        if attempt < 4 {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    anyhow::bail!(
        "agent config reload left existing agent files unreadable: {}",
        missing_existing.join(", ")
    )
}

async fn publish_project_status_now(shared: &RuntimeShared, meta: &ProjectMetadata) {
    let Some(keys) = shared.backend_keys.as_ref() else {
        return;
    };
    let snapshot = shared.agent_snapshot();
    let models_status = match crate::store::llms::LlmsDoc::load(&shared.base_dir) {
        Ok(llms) => project_status::collect_model_access(&llms, &snapshot.agents),
        Err(error) => {
            warn!(error = %error, "24010 model tag collection failed");
            Vec::new()
        }
    };
    match project_status::build_project_status_event(
        keys,
        meta,
        &snapshot.agents,
        &snapshot.project_agents,
        &models_status,
        &shared.whitelisted_pubkeys,
    ) {
        Ok(event) => {
            if let Err(error) = shared.client.send_event(&event).await {
                warn!(error = %error, "24010 publish failed");
            }
        }
        Err(error) => warn!(error = %error, "24010 build failed"),
    }
}

/// Handle a `DispatchTransport` request that arrived on the control socket.
///
/// Parses the synthesized event, runs `select_dispatch_target`, attaches the
/// caller's `TransportTee` to the resulting `DispatchJob`, and feeds it into
/// the same `accept_dispatch` path as a relay-originated event. Terminal
/// frames are emitted on the tee for any error path; on success, the tee
/// rides through to `run_agent` which fires `Event` frames per agent output
/// and a final `Done`/`Error` when the run exits.
async fn handle_transport_dispatch(
    shared: Arc<RuntimeShared>,
    req: control::TransportDispatchRequest,
) {
    let control::TransportDispatchRequest { event_json, tee } = req;
    let event = match Event::from_json(&event_json) {
        Ok(ev) => ev,
        Err(e) => {
            tee.send_error(format!("invalid event JSON: {e}"));
            return;
        }
    };

    if !mark_seen(&shared.seen, event.id) {
        tee.send_error("event already dispatched in this runtime".to_string());
        return;
    }

    let agent_pubkeys = shared.agent_pubkeys();
    if let Err(e) =
        register_delegation_route_if_needed(&shared.store, &event, &agent_pubkeys, None)
    {
        warn!(error = %e, "failed to register delegation route for transport dispatch");
    }

    let (agent, conv_id, completion_recipient_pubkey) =
        match select_dispatch_target(&shared, &event) {
            Ok(target) => target,
            Err(e) => {
                tee.send_error(format!("no dispatch target: {e}"));
                return;
            }
        };

    if is_agent_blocked(&shared.store, &conv_id, &agent.pubkey) {
        tee.send_error(format!(
            "agent {} is blocked in conversation {conv_id}",
            agent.slug
        ));
        return;
    }

    tee.send_accepted(conv_id.clone(), agent.pubkey.clone());

    let agent_json = shared
        .base_dir
        .join("agents")
        .join(format!("{}.json", agent.pubkey));
    let job = DispatchJob {
        event,
        agent,
        conv_id,
        agent_json,
        allow_driver_preempt: false,
        completion_recipient_pubkey,
        response_tee: Some(tee.clone()),
    };
    if let Err(e) = accept_dispatch(shared, job).await {
        // Job is dropped here without ever reaching `run_agent`. Mark the
        // tee terminal explicitly with an Error frame so the bridge sees
        // an accurate reason rather than the default `Superseded` that
        // `TransportTeeInner::Drop` would otherwise emit.
        let msg = format!("dispatch failed: {e}");
        warn!(error = %e, "transport dispatch failed");
        tee.send_error(msg);
    }
}

async fn accept_dispatch(shared: Arc<RuntimeShared>, mut job: DispatchJob) -> Result<()> {
    persist_user_message(&shared.store, &job.event, &job.conv_id)?;
    if is_agent_blocked(&shared.store, &job.conv_id, &job.agent.pubkey) {
        warn!(
            conversation_id = %job.conv_id,
            agent = %job.agent.slug,
            "skipping dispatch to blocked agent"
        );
        return Ok(());
    }
    let key = DispatchKey::new(job.agent.pubkey.clone(), job.conv_id.clone());
    let driver_busy = persisted_driver_busy(&shared.store, &key);
    let maybe_start = {
        let mut coordinator = shared.coordinator.lock().unwrap();
        coordinator.sync_driver_busy(&key, driver_busy);
        let allow_shell_intervention = shared
            .whitelisted_pubkeys
            .contains(&job.event.pubkey.to_hex())
            && shared
                .control
                .has_shell_tasks(&shared.project_id, &job.conv_id, &job.agent.pubkey);
        job.allow_driver_preempt = allow_shell_intervention;
        coordinator.dispatch_inbound(job, allow_shell_intervention)
    };

    if let Some(job) = maybe_start {
        publish_active_status(&shared, &job.conv_id).await;
        spawn_dispatch_job(shared, job);
    }
    Ok(())
}

fn spawn_dispatch_job(shared: Arc<RuntimeShared>, job: DispatchJob) {
    let key = DispatchKey::new(job.agent.pubkey.clone(), job.conv_id.clone());
    tokio::spawn(async move {
        let previous_trace = conversation_trace_carrier(&shared.store, &job.conv_id);
        let dispatch_span = info_span!(
            "tenex.runtime.dispatch",
            event.id = %job.event.id.to_hex(),
            event.pubkey = %job.event.pubkey.to_hex(),
            conversation.id = %job.conv_id,
            project.id = %shared.project_id,
            agent.slug = %job.agent.slug,
            agent.pubkey = %job.agent.pubkey,
        );
        if let Some(carrier) = previous_trace.as_ref() {
            tenex_telemetry::add_link_to_span(
                &dispatch_span,
                carrier,
                vec![
                    (
                        "tenex.link.kind",
                        "conversation.previous_dispatch".to_string(),
                    ),
                    ("conversation.id", job.conv_id.clone()),
                    ("agent.pubkey", job.agent.pubkey.clone()),
                ],
            );
        }

        let run_result = async {
            if let Err(e) = remember_current_conversation_trace(&shared.store, &job) {
                warn!(
                    conversation_id = %job.conv_id,
                    error = %e,
                    "failed to persist conversation trace context"
                );
            }
            run_agent(shared.clone(), job.clone(), key.clone()).await
        }
        .instrument(dispatch_span)
        .await;
        if let Err(e) = run_result {
            warn!(
                event_id = %job.event.id.to_hex()[..8],
                agent = %job.agent.slug,
                error = %e,
                "agent run failed"
            );
        }

        let consumed = consumed_message_event_ids(&shared.store, &job.conv_id, &job.agent.pubkey);
        let maybe_next = {
            let mut coordinator = shared.coordinator.lock().unwrap();
            coordinator
                .drop_queued_matching(&key, |queued| consumed.contains(&queued.event.id.to_hex()));
            coordinator.finish_run(&key)
        };
        publish_active_status(&shared, &job.conv_id).await;
        if let Some(next) = maybe_next {
            publish_active_status(&shared, &next.conv_id).await;
            spawn_dispatch_job(shared, next);
        }
    });
}

fn select_dispatch_target(
    shared: &RuntimeShared,
    event: &Event,
) -> Result<(Agent, String, Option<String>)> {
    let snapshot = shared.agent_snapshot();
    if let Some(route) = delegation_route_for_completion(&shared.store, event)? {
        if let Some(agent) = snapshot
            .agents
            .iter()
            .find(|agent| agent.pubkey == route.parent_agent_pubkey)
        {
            return Ok((
                agent.clone(),
                route.parent_conversation_id,
                Some(route.parent_completion_recipient_pubkey),
            ));
        }
        warn!(
            parent_agent = %route.parent_agent_pubkey,
            child_conversation = %route.child_conversation_id,
            "delegation completion parent agent is not in this runtime"
        );
    }

    if !event_matches_project_scope(event, &shared.project_addr) {
        anyhow::bail!("event project a-tag does not match this runtime");
    }

    if has_p_tags(event)
        && !targets_project_agent(event, &snapshot.agent_pubkeys)
        && !targets_project_address(event, &shared.project_addr)
    {
        anyhow::bail!("directed event does not target a current project agent");
    }

    let agent = select_agent(event, &snapshot.agents, &snapshot.project_agents)?.clone();
    Ok((agent, conversation_id_from_event(event), None))
}

async fn dispatch_project_agent_target(
    shared: Arc<RuntimeShared>,
    event: &Event,
    parent_job: Option<&DispatchJob>,
) -> Result<()> {
    let agent_pubkeys = shared.agent_pubkeys();
    if !event_matches_project_scope(event, &shared.project_addr) {
        return Ok(());
    }
    if !targets_project_agent(event, &agent_pubkeys) {
        return Ok(());
    }
    if !mark_seen(&shared.seen, event.id) {
        return Ok(());
    }

    register_delegation_route_if_needed(&shared.store, event, &agent_pubkeys, parent_job)?;

    let (agent, conv_id, completion_recipient_pubkey) = select_dispatch_target(&shared, event)?;
    let agent_json = shared
        .base_dir
        .join("agents")
        .join(format!("{}.json", agent.pubkey));
    accept_dispatch(
        shared,
        DispatchJob {
            event: event.clone(),
            agent,
            conv_id,
            agent_json,
            allow_driver_preempt: false,
            completion_recipient_pubkey,
            response_tee: None,
        },
    )
    .await
}

async fn handle_stop_command(shared: Arc<RuntimeShared>, event: &Event) -> Result<()> {
    let conversation_ids = e_tag_event_ids(event);
    let agent_pubkeys = p_tag_pubkeys(event);
    if conversation_ids.is_empty() || agent_pubkeys.is_empty() {
        warn!(
            event_id = %event.id.to_hex()[..8],
            e_tags = conversation_ids.len(),
            p_tags = agent_pubkeys.len(),
            "stop command missing target tags"
        );
        return Ok(());
    }

    let reason = format!("stop signal from {}", &event.pubkey.to_hex()[..8]);
    for conversation_id in conversation_ids {
        for agent_pubkey in &agent_pubkeys {
            set_agent_blocked(&shared.store, &conversation_id, agent_pubkey)?;
            let result = shared.control.kill_agent_conversation(
                &conversation_id,
                Some(agent_pubkey),
                &reason,
            );
            info!(
                conversation_id = %conversation_id,
                agent_pubkey = %agent_pubkey,
                killed_count = result.killed_count,
                "processed stop command"
            );
        }
        publish_active_status(&shared, &conversation_id).await;
    }
    Ok(())
}

fn mark_seen(seen: &Arc<Mutex<HashSet<EventId>>>, event_id: EventId) -> bool {
    let mut seen = seen.lock().unwrap();
    seen.insert(event_id)
}

fn conversation_trace_carrier(
    store: &Arc<Mutex<ConversationStore>>,
    conv_id: &str,
) -> Option<tenex_telemetry::TraceCarrier> {
    let Ok(conversation) = store.lock().unwrap().get_conversation(conv_id) else {
        return None;
    };
    trace_carrier_from_runtime_state(&conversation?.runtime_state)
}

fn remember_current_conversation_trace(
    store: &Arc<Mutex<ConversationStore>>,
    job: &DispatchJob,
) -> Result<()> {
    let Some(carrier) = tenex_telemetry::current_trace_context() else {
        return Ok(());
    };
    let event_id = job.event.id.to_hex();
    let mut store = store.lock().unwrap();
    store.update_runtime_state(&job.conv_id, |state| {
        write_trace_carrier_to_runtime_state(state, &carrier, &event_id, &job.agent.pubkey);
    })?;
    Ok(())
}

fn trace_carrier_from_runtime_state(state: &Value) -> Option<tenex_telemetry::TraceCarrier> {
    let trace = state
        .get("rustRuntime")?
        .get("telemetry")?
        .get("lastTrace")?;
    let traceparent = trace.get("traceparent")?.as_str()?.to_string();
    let tracestate = trace
        .get("tracestate")
        .and_then(Value::as_str)
        .map(str::to_string);
    Some(tenex_telemetry::TraceCarrier {
        traceparent,
        tracestate,
    })
}

fn write_trace_carrier_to_runtime_state(
    state: &mut Value,
    carrier: &tenex_telemetry::TraceCarrier,
    trigger_event_id: &str,
    agent_pubkey: &str,
) {
    let state = ensure_json_object(state);
    let rust_runtime = ensure_child_object(state, "rustRuntime");
    let telemetry = ensure_child_object(rust_runtime, "telemetry");

    let mut trace = Map::new();
    trace.insert(
        "traceparent".to_string(),
        Value::String(carrier.traceparent.clone()),
    );
    if let Some(tracestate) = carrier.tracestate.clone() {
        trace.insert("tracestate".to_string(), Value::String(tracestate));
    }
    trace.insert(
        "triggerEventId".to_string(),
        Value::String(trigger_event_id.to_string()),
    );
    trace.insert(
        "agentPubkey".to_string(),
        Value::String(agent_pubkey.to_string()),
    );
    trace.insert("updatedAt".to_string(), Value::Number(now_ms().into()));

    telemetry.insert("lastTrace".to_string(), Value::Object(trace));
}

fn ensure_json_object(value: &mut Value) -> &mut Map<String, Value> {
    if !value.is_object() {
        *value = Value::Object(Map::new());
    }
    value.as_object_mut().expect("value just set to object")
}

fn ensure_child_object<'a>(
    object: &'a mut Map<String, Value>,
    key: &str,
) -> &'a mut Map<String, Value> {
    let value = object
        .entry(key.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    ensure_json_object(value)
}

async fn publish_active_status(shared: &RuntimeShared, conv_id: &str) {
    let Some(keys) = shared.backend_keys.as_ref() else {
        return;
    };
    let active = {
        let coordinator = shared.coordinator.lock().unwrap();
        coordinator.active_agent_pubkeys()
    };
    let refs: Vec<&str> = active.iter().map(String::as_str).collect();
    send_operations_status(
        &shared.client,
        keys,
        conv_id,
        &shared.project_addr,
        &shared.whitelisted_pubkeys,
        &refs,
    )
    .await;
}

fn persist_user_message(
    store: &Arc<Mutex<ConversationStore>>,
    event: &Event,
    conv_id: &str,
) -> Result<()> {
    let ts = event.created_at.as_secs() as i64;
    let targeted_pubkeys = p_tag_pubkeys(event);
    let s = store.lock().unwrap();
    s.ensure_conversation(conv_id)?;
    s.append_message(
        conv_id,
        &NewMessage {
            record_id: format!("event:{}", event.id.to_hex()),
            nostr_event_id: Some(event.id.to_hex()),
            author_pubkey: event.pubkey.to_hex(),
            sender_pubkey: None,
            ral: None,
            message_type: "text".to_string(),
            role: Some("user".to_string()),
            content: event.content.clone(),
            timestamp: Some(ts),
            targeted_pubkeys: if targeted_pubkeys.is_empty() {
                None
            } else {
                Some(targeted_pubkeys)
            },
            sender_principal: None,
            targeted_principals: None,
            tool_data: None,
            delegation_marker: None,
            human_readable: None,
            transcript_tool_attributes: None,
        },
    )?;
    Ok(())
}

fn p_tag_pubkeys(event: &Event) -> Vec<String> {
    event
        .tags
        .iter()
        .filter_map(|tag| {
            let parts = tag.as_slice();
            if parts.first().is_some_and(|head| head == "p") {
                parts.get(1).cloned()
            } else {
                None
            }
        })
        .collect()
}

fn e_tag_event_ids(event: &Event) -> Vec<String> {
    event
        .tags
        .iter()
        .filter_map(|tag| {
            let parts = tag.as_slice();
            if parts.first().is_some_and(|head| head == "e") {
                parts.get(1).cloned()
            } else {
                None
            }
        })
        .collect()
}

fn register_delegation_route_if_needed(
    store: &Arc<Mutex<ConversationStore>>,
    event: &Event,
    agent_pubkeys: &HashSet<String>,
    parent_job: Option<&DispatchJob>,
) -> Result<Option<DelegationRoute>> {
    let Some(child_agent_pubkey) = fresh_delegation_target(event, agent_pubkeys) else {
        return Ok(None);
    };

    let parent_agent_pubkey = parent_job
        .map(|job| job.agent.pubkey.clone())
        .unwrap_or_else(|| event.pubkey.to_hex());
    let parent_conversation_id = parent_job
        .map(|job| job.conv_id.clone())
        .or_else(|| delegation_parent_conversation_id(event));
    let Some(parent_conversation_id) = parent_conversation_id else {
        return Ok(None);
    };
    let parent_completion_recipient_pubkey = parent_job
        .and_then(|job| job.completion_recipient_pubkey.clone())
        .or_else(|| parent_job.map(|job| job.event.pubkey.to_hex()))
        .or_else(|| {
            first_conversation_author(store, &parent_conversation_id)
                .ok()
                .flatten()
        })
        .unwrap_or_else(|| parent_agent_pubkey.clone());

    let child_conversation_id = event.id.to_hex();
    let route = DelegationRoute {
        parent_agent_pubkey,
        parent_conversation_id,
        parent_completion_recipient_pubkey,
        child_agent_pubkey,
        child_conversation_id: child_conversation_id.clone(),
        delegation_event_id: child_conversation_id.clone(),
        created_at: now_ms(),
    };

    {
        let mut store = store.lock().unwrap();
        store.update_runtime_state(&child_conversation_id, |state| {
            write_delegation_route(state, &route);
        })?;
    }

    info!(
        parent_agent = %route.parent_agent_pubkey,
        parent_conversation = %route.parent_conversation_id,
        child_agent = %route.child_agent_pubkey,
        child_conversation = %route.child_conversation_id,
        "registered delegation route"
    );

    Ok(Some(route))
}

fn fresh_delegation_target(event: &Event, agent_pubkeys: &HashSet<String>) -> Option<String> {
    if event.kind != Kind::TextNote {
        return None;
    }
    if !agent_pubkeys.contains(&event.pubkey.to_hex()) {
        return None;
    }
    if has_any_tag(event, "e")
        || has_any_tag(event, "tool")
        || has_any_tag(event, "status")
        || has_any_tag(event, "intent")
        || has_any_tag(event, "reasoning")
        || has_any_tag(event, "error")
    {
        return None;
    }
    p_tag_pubkeys(event)
        .into_iter()
        .find(|pubkey| agent_pubkeys.contains(pubkey))
}

fn delegation_route_for_completion(
    store: &Arc<Mutex<ConversationStore>>,
    event: &Event,
) -> Result<Option<DelegationRoute>> {
    if !is_completion_event(event) {
        return Ok(None);
    }

    let child_conversation_id = conversation_id_from_event(event);
    let Some(route) = read_delegation_route(store, &child_conversation_id)? else {
        return Ok(None);
    };
    if route.child_conversation_id != child_conversation_id {
        return Ok(None);
    }
    if event.pubkey.to_hex() != route.child_agent_pubkey {
        return Ok(None);
    }
    if !p_tag_pubkeys(event).contains(&route.parent_agent_pubkey) {
        return Ok(None);
    }

    Ok(Some(route))
}

fn read_delegation_route(
    store: &Arc<Mutex<ConversationStore>>,
    child_conversation_id: &str,
) -> Result<Option<DelegationRoute>> {
    let store = store.lock().unwrap();
    let Some(conversation) = store.get_conversation(child_conversation_id)? else {
        return Ok(None);
    };
    Ok(delegation_route_from_runtime_state(
        &conversation.runtime_state,
    ))
}

fn delegation_route_from_runtime_state(state: &Value) -> Option<DelegationRoute> {
    serde_json::from_value(state.get("rustRuntime")?.get("delegation")?.clone()).ok()
}

fn write_delegation_route(state: &mut Value, route: &DelegationRoute) {
    let state = ensure_json_object(state);
    let rust_runtime = ensure_child_object(state, "rustRuntime");
    rust_runtime.insert(
        "delegation".to_string(),
        serde_json::to_value(route).unwrap_or_else(|_| Value::Object(Map::new())),
    );
}

fn first_conversation_author(
    store: &Arc<Mutex<ConversationStore>>,
    conversation_id: &str,
) -> Result<Option<String>> {
    let store = store.lock().unwrap();
    Ok(store
        .list_messages(
            conversation_id,
            MessageQuery {
                limit: Some(1),
                ..Default::default()
            },
        )?
        .into_iter()
        .next()
        .map(|message| message.author_pubkey))
}

fn delegation_parent_conversation_id(event: &Event) -> Option<String> {
    event.tags.iter().find_map(|tag| {
        let parts = tag.as_slice();
        if parts.first().is_some_and(|head| head == "delegation") {
            parts.get(1).cloned()
        } else {
            None
        }
    })
}

fn is_completion_event(event: &Event) -> bool {
    event.kind == Kind::TextNote && has_tag(event, "status", "completed")
}

fn has_tag(event: &Event, tag_name: &str, tag_value: &str) -> bool {
    event.tags.iter().any(|tag| {
        let parts = tag.as_slice();
        parts.first().is_some_and(|head| head == tag_name)
            && parts.get(1).is_some_and(|value| value == tag_value)
    })
}

fn has_any_tag(event: &Event, tag_name: &str) -> bool {
    event
        .tags
        .iter()
        .any(|tag| tag.as_slice().first().is_some_and(|head| head == tag_name))
}

fn is_agent_blocked(
    store: &Arc<Mutex<ConversationStore>>,
    conversation_id: &str,
    agent_pubkey: &str,
) -> bool {
    store
        .lock()
        .unwrap()
        .get_agent_context_state(conversation_id, agent_pubkey)
        .ok()
        .flatten()
        .is_some_and(|state| state.is_blocked)
}

fn set_agent_blocked(
    store: &Arc<Mutex<ConversationStore>>,
    conversation_id: &str,
    agent_pubkey: &str,
) -> Result<()> {
    let store = store.lock().unwrap();
    let existing = store.get_agent_context_state(conversation_id, agent_pubkey)?;
    let state = AgentContextState {
        conversation_id: conversation_id.to_string(),
        agent_pubkey: agent_pubkey.to_string(),
        next_prompt_sequence: existing
            .as_ref()
            .map(|s| s.next_prompt_sequence)
            .unwrap_or(0),
        cache_anchored: existing.as_ref().is_some_and(|s| s.cache_anchored),
        seen_message_ids: existing
            .as_ref()
            .map(|s| s.seen_message_ids.clone())
            .unwrap_or_default(),
        compaction_state: existing.as_ref().and_then(|s| s.compaction_state.clone()),
        reminder_state: existing.as_ref().and_then(|s| s.reminder_state.clone()),
        reminder_delta_state: existing
            .as_ref()
            .and_then(|s| s.reminder_delta_state.clone()),
        todos: existing.as_ref().and_then(|s| s.todos.clone()),
        self_applied_skills: existing
            .as_ref()
            .and_then(|s| s.self_applied_skills.clone()),
        meta_model_variant: existing.as_ref().and_then(|s| s.meta_model_variant.clone()),
        is_blocked: true,
        todo_nudged: existing.as_ref().is_some_and(|s| s.todo_nudged),
        updated_at: now_ms(),
    };
    store.upsert_agent_context_state(&state)?;
    Ok(())
}

fn consumed_message_event_ids(
    store: &Arc<Mutex<ConversationStore>>,
    conv_id: &str,
    agent_pubkey: &str,
) -> HashSet<String> {
    let Ok(conversation) = store.lock().unwrap().get_conversation(conv_id) else {
        return HashSet::new();
    };
    let Some(conversation) = conversation else {
        return HashSet::new();
    };
    conversation
        .runtime_state
        .get("rustRuntime")
        .and_then(|v| v.get("consumedMessages"))
        .and_then(serde_json::Value::as_object)
        .map(|messages| {
            messages
                .iter()
                .filter_map(|(event_id, meta)| {
                    let same_agent = meta.get("agentPubkey").and_then(serde_json::Value::as_str)
                        == Some(agent_pubkey);
                    let same_conversation = meta
                        .get("conversationId")
                        .and_then(serde_json::Value::as_str)
                        == Some(conv_id);
                    if same_agent && same_conversation {
                        Some(event_id.clone())
                    } else {
                        None
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

fn persisted_driver_busy(store: &Arc<Mutex<ConversationStore>>, key: &DispatchKey) -> bool {
    let Ok(conversation) = store.lock().unwrap().get_conversation(&key.conversation_id) else {
        return false;
    };
    let Some(conversation) = conversation else {
        return false;
    };
    runtime_state_driver_busy(&conversation.runtime_state, key)
}

fn runtime_state_driver_busy(state: &Value, key: &DispatchKey) -> bool {
    let Some(driver) = state.get("rustRuntime").and_then(|v| v.get("driver")) else {
        return false;
    };
    let same_agent = driver
        .get("agentPubkey")
        .and_then(serde_json::Value::as_str)
        == Some(key.agent_pubkey.as_str());
    let same_conversation = driver
        .get("conversationId")
        .and_then(serde_json::Value::as_str)
        == Some(key.conversation_id.as_str());
    let stale = driver
        .get("acquiredAt")
        .and_then(serde_json::Value::as_i64)
        .is_some_and(|ts| now_ms().saturating_sub(ts) > DRIVER_STALE_AFTER_MS);

    same_agent && same_conversation && !stale
}

async fn handle_agent_runtime_signal(shared: Arc<RuntimeShared>, key: &DispatchKey, event: &Event) {
    if event.kind == Kind::Custom(24135) {
        let mut coordinator = shared.coordinator.lock().unwrap();
        coordinator.mark_driver_busy(key);
        return;
    }

    if event_has_tag(event, "tool") {
        let mut coordinator = shared.coordinator.lock().unwrap();
        coordinator.mark_driver_free(key);
    }
}

fn event_has_tag(event: &Event, tag_name: &str) -> bool {
    event
        .tags
        .iter()
        .any(|tag| tag.as_slice().first().is_some_and(|head| head == tag_name))
}

fn targets_project_agent(event: &Event, agent_pubkeys: &HashSet<String>) -> bool {
    let p_kind = TagKind::SingleLetter(SingleLetterTag::lowercase(Alphabet::P));
    event
        .tags
        .iter()
        .filter(|tag| tag.kind() == p_kind)
        .filter_map(|tag| tag.content())
        .any(|pubkey| agent_pubkeys.contains(pubkey))
}

fn has_p_tags(event: &Event) -> bool {
    let p_kind = TagKind::SingleLetter(SingleLetterTag::lowercase(Alphabet::P));
    event.tags.iter().any(|tag| tag.kind() == p_kind)
}

fn targets_project_address(event: &Event, project_addr: &str) -> bool {
    let a_kind = TagKind::SingleLetter(SingleLetterTag::lowercase(Alphabet::A));
    event
        .tags
        .iter()
        .filter(|tag| tag.kind() == a_kind)
        .filter_map(|tag| tag.content())
        .any(|addr| addr == project_addr)
}

fn event_matches_project_scope(event: &Event, project_addr: &str) -> bool {
    let project_addresses = project_address_tags(event);
    project_addresses.is_empty() || project_addresses.iter().any(|addr| *addr == project_addr)
}

fn project_address_tags<'a>(event: &'a Event) -> Vec<&'a str> {
    let a_kind = TagKind::SingleLetter(SingleLetterTag::lowercase(Alphabet::A));
    event
        .tags
        .iter()
        .filter(|tag| tag.kind() == a_kind)
        .filter_map(|tag| tag.content())
        .filter(|addr| addr.starts_with("31933:"))
        .collect()
}

fn select_agent<'a>(
    event: &Event,
    agents: &'a [Agent],
    project_agents: &[ProjectAgent],
) -> Result<&'a Agent> {
    let p_kind = TagKind::SingleLetter(SingleLetterTag::lowercase(Alphabet::P));
    let p_tags: Vec<String> = event
        .tags
        .iter()
        .filter(|t| t.kind() == p_kind)
        .filter_map(|t| t.content().map(|s| s.to_string()))
        .collect();

    // Direct mention: find the first agent whose pubkey is in the #p tags.
    if let Some(agent) = agents.iter().find(|a| p_tags.contains(&a.pubkey)) {
        return Ok(agent);
    }

    // No #p match: fall back to the PM agent (handles project-wide events).
    let pm_pubkey = project_agents
        .iter()
        .find(|pa| pa.is_pm)
        .map(|pa| &pa.agent_pubkey);

    if let Some(pk) = pm_pubkey {
        return agents
            .iter()
            .find(|a| &a.pubkey == pk)
            .context("PM agent pubkey not found in agents list");
    }

    anyhow::bail!(
        "no agent matched #p tags {:?} and no PM agent configured",
        p_tags
    )
}

async fn run_agent(shared: Arc<RuntimeShared>, job: DispatchJob, key: DispatchKey) -> Result<()> {
    let job = refresh_job_agent(&shared, job)?;
    if !job.agent_json.exists() {
        anyhow::bail!("agent JSON not found: {}", job.agent_json.display());
    }

    let runtime_kind = agent_runtime_kind(&job.agent, &shared.base_dir)?;
    let binary = match runtime_kind {
        AgentRuntimeKind::Tenex => &shared.agent_binary,
        AgentRuntimeKind::Acp => &shared.agent_acp_binary,
    };
    let execution_id = uuid::Uuid::new_v4().to_string();
    let mut command = tokio::process::Command::new(binary);
    command
        .arg(&job.agent_json)
        .env("TENEX_PROJECT_ID", &shared.project_id)
        .env("TENEX_BASE_DIR", &shared.base_dir)
        .env("TENEX_EXECUTION_ID", &execution_id)
        .env("TENEX_RUNTIME_CONTROL_SOCKET", shared.control.socket_path())
        .current_dir(&shared.project_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .process_group(0)
        .kill_on_drop(false);
    command.env("TENEX_CONVERSATION_ID", &job.conv_id);
    if let Some(recipient) = job.completion_recipient_pubkey.as_deref() {
        command.env("TENEX_COMPLETION_RECIPIENT_PUBKEY", recipient);
    }
    if job.allow_driver_preempt {
        command.env("TENEX_RUNTIME_DRIVER_PREEMPT", "1");
    }
    if let Some(carrier) = tenex_telemetry::current_trace_context() {
        command.env("TRACEPARENT", carrier.traceparent);
        if let Some(tracestate) = carrier.tracestate {
            command.env("TRACESTATE", tracestate);
        }
    }
    let mcp_bridge = if runtime_kind == AgentRuntimeKind::Tenex {
        start_mcp_bridge_for_run(&shared, &job, &execution_id, &mut command).await?
    } else {
        None
    };

    let agent_result: Result<()> = async {
        let mut child = command
            .spawn()
            .with_context(|| format!("failed to spawn {}", binary.display()))?;
        let pid = child.id().context("agent child has no pid")?;
        let _run_guard = shared.control.register_agent_run(
            job.conv_id.clone(),
            job.agent.pubkey.clone(),
            execution_id.clone(),
            pid,
        );

        // Write the triggering event JSON to stdin; closing stdin signals EOF to the agent.
        {
            let stdin = child.stdin.take().context("child has no stdin")?;
            let mut w = BufWriter::new(stdin);
            w.write_all(job.event.as_json().as_bytes()).await?;
            w.write_all(b"\n").await?;
            w.flush().await?;
        }

        // Forward each signed event from the agent's stdout to the relay,
        // and persist it to the conversation store.
        let stdout = child.stdout.take().context("child has no stdout")?;
        let mut lines = BufReader::new(stdout).lines();
        while let Some(line) = lines.next_line().await? {
            let line = line.trim().to_string();
            if line.is_empty() {
                continue;
            }
            match Event::from_json(&line) {
                Ok(ev) => {
                    if let Some(tee) = job.response_tee.as_ref() {
                        tee.send_event(line.clone());
                    }
                    handle_agent_runtime_signal(shared.clone(), &key, &ev).await;
                    if let Err(e) =
                        dispatch_project_agent_target(shared.clone(), &ev, Some(&job)).await
                    {
                        warn!(error = %e, "failed to dispatch agent-targeted event");
                    }

                    if !should_persist_agent_message(&ev, &job.conv_id) {
                        if let Err(e) = shared.client.send_event(&ev).await {
                            warn!(error = %e, "relay publish failed");
                        }
                        continue;
                    }
                    {
                        let s = shared.store.lock().unwrap();
                        let agent_ts = ev.created_at.as_secs() as i64;
                        if let Err(e) = s.append_message(
                            &job.conv_id,
                            &NewMessage {
                                record_id: format!("event:{}", ev.id.to_hex()),
                                nostr_event_id: Some(ev.id.to_hex()),
                                author_pubkey: ev.pubkey.to_hex(),
                                sender_pubkey: None,
                                ral: None,
                                message_type: "text".to_string(),
                                role: Some("assistant".to_string()),
                                content: ev.content.clone(),
                                timestamp: Some(agent_ts),
                                targeted_pubkeys: None,
                                sender_principal: None,
                                targeted_principals: None,
                                tool_data: None,
                                delegation_marker: None,
                                human_readable: None,
                                transcript_tool_attributes: None,
                            },
                        ) {
                            warn!(error = %e, "failed to persist agent event");
                        }
                    }
                    if let Err(e) = shared.client.send_event(&ev).await {
                        warn!(error = %e, "relay publish failed");
                    }
                }
                Err(e) => {
                    warn!(error = %e, "ignoring unparseable agent output line");
                }
            }
        }

        let status = child.wait().await?;
        if !status.success() {
            warn!(code = ?status.code(), "tenex-agent exited non-zero");
        }

        Ok(())
    }
    .await;

    if let Some(bridge) = mcp_bridge {
        bridge.shutdown().await;
    }

    if let Some(tee) = job.response_tee.as_ref() {
        match agent_result.as_ref() {
            Ok(()) => tee.send_done(),
            Err(e) => tee.send_error(e.to_string()),
        }
    }

    agent_result
}

fn refresh_job_agent(shared: &RuntimeShared, mut job: DispatchJob) -> Result<DispatchJob> {
    let snapshot = shared.agent_snapshot();
    let Some(agent) = snapshot
        .agents
        .iter()
        .find(|agent| agent.pubkey == job.agent.pubkey)
    else {
        anyhow::bail!(
            "agent '{}' is no longer available in project '{}'",
            job.agent.slug,
            shared.project_id
        );
    };
    job.agent = agent.clone();
    Ok(job)
}

fn agent_runtime_kind(agent: &Agent, base_dir: &std::path::Path) -> Result<AgentRuntimeKind> {
    let Some(default_json) = agent.default_config_json.as_deref() else {
        return Ok(AgentRuntimeKind::Tenex);
    };
    let default: Value = serde_json::from_str(default_json)
        .with_context(|| format!("parsing default config for {}", agent.slug))?;
    let Some(model_name) = default.get("model").and_then(Value::as_str) else {
        return Ok(AgentRuntimeKind::Tenex);
    };
    let llms =
        tenex_llm_config::resolver::load_llms(base_dir).with_context(|| "loading llms.json")?;
    let Some(config) = llms.configurations.get(model_name) else {
        return Ok(AgentRuntimeKind::Tenex);
    };
    if config.get("provider").and_then(Value::as_str) == Some("acp") {
        Ok(AgentRuntimeKind::Acp)
    } else {
        Ok(AgentRuntimeKind::Tenex)
    }
}

async fn start_mcp_bridge_for_run(
    shared: &Arc<RuntimeShared>,
    job: &DispatchJob,
    execution_id: &str,
    command: &mut tokio::process::Command,
) -> Result<Option<ActiveMcpBridge>> {
    let allowed_slugs =
        tenex_mcp::mcp_access_from_default_json(job.agent.default_config_json.as_deref())
            .with_context(|| format!("reading MCP access for agent '{}'", job.agent.slug))?;
    let manifest = shared
        .mcp_runtime
        .prepare_manifest(&allowed_slugs)
        .await
        .with_context(|| format!("preparing MCP tools for agent '{}'", job.agent.slug))?;
    if manifest.is_empty() {
        return Ok(None);
    }

    let run_id: String = execution_id
        .chars()
        .filter(|ch| *ch != '-')
        .take(16)
        .collect();
    let run_dir = shared.base_dir.join("runtime").join("mcp");
    tokio::fs::create_dir_all(&run_dir).await?;
    let manifest_path = run_dir.join(format!("{run_id}.manifest.json"));
    let socket_path = run_dir.join(format!("{run_id}.sock"));
    tokio::fs::write(&manifest_path, serde_json::to_vec(&manifest)?).await?;

    let server = match tenex_mcp::bind_socket(SocketServerConfig {
        socket_path: socket_path.clone(),
        allowed_tools: manifest.tool_names(),
    })
    .await
    {
        Ok(server) => server,
        Err(error) => {
            let _ = tokio::fs::remove_file(&manifest_path).await;
            return Err(error);
        }
    };

    let (shutdown, shutdown_rx) = tokio::sync::oneshot::channel();
    let runtime = shared.mcp_runtime.clone();
    let task = tokio::spawn(async move {
        if let Err(error) = server.serve(runtime, shutdown_rx).await {
            warn!(error = %error, "MCP bridge socket stopped with error");
        }
    });

    command
        .env("TENEX_MCP_MANIFEST", &manifest_path)
        .env("TENEX_MCP_SOCKET", &socket_path);

    Ok(Some(ActiveMcpBridge {
        manifest_path,
        socket_path,
        shutdown,
        task,
    }))
}

fn should_persist_agent_message(event: &Event, conversation_id: &str) -> bool {
    if event.kind != Kind::TextNote {
        return false;
    }
    if event.content.trim().is_empty() {
        return false;
    }

    let mut has_conversation_ref = false;

    for tag in event.tags.iter() {
        let parts = tag.as_slice();
        let head = parts.first().map(|s| s.as_str()).unwrap_or("");
        match head {
            "e" => {
                let tagged_event = parts.get(1).map(|s| s.as_str());
                let marker = parts.get(3).map(|s| s.as_str());
                if tagged_event == Some(conversation_id)
                    && matches!(marker, Some("root") | Some("reply") | None | Some(""))
                {
                    has_conversation_ref = true;
                }
            }
            "tool" | "intent" | "reasoning" | "error" => return false,
            _ => {}
        }
    }

    has_conversation_ref
}

fn conversation_id_from_event(event: &Event) -> String {
    let e_kind = TagKind::SingleLetter(SingleLetterTag::lowercase(Alphabet::E));
    let mut first_unmarked: Option<String> = None;

    for tag in event.tags.iter() {
        if tag.kind() != e_kind {
            continue;
        }
        let parts = tag.as_slice();
        // parts[0]="e", parts[1]=event-id, parts[2]=relay, parts[3]=marker
        let Some(event_id) = parts.get(1) else {
            continue;
        };
        let marker = parts.get(3).map(|s| s.as_str());
        match marker {
            Some("root") => return event_id.clone(),
            None | Some("") if first_unmarked.is_none() => {
                first_unmarked = Some(event_id.clone());
            }
            None | Some("") => {}
            _ => {}
        }
    }

    first_unmarked.unwrap_or_else(|| event.id.to_hex())
}

async fn send_operations_status(
    client: &Client,
    backend_keys: &Keys,
    conv_id: &str,
    project_ref: &str,
    whitelisted_pubkeys: &[String],
    active_agent_pubkeys: &[&str],
) {
    match operations_status::build_operations_status_event(
        backend_keys,
        conv_id,
        project_ref,
        whitelisted_pubkeys,
        active_agent_pubkeys,
    ) {
        Ok(ev) => {
            if let Err(e) = client.send_event(&ev).await {
                warn!(error = %e, "24133 publish failed");
            }
        }
        Err(e) => warn!(error = %e, "24133 build failed"),
    }
}

fn find_agent_binary() -> PathBuf {
    find_sibling_binary("tenex-agent")
}

fn find_agent_acp_binary() -> PathBuf {
    find_sibling_binary("tenex-agent-acp")
}

fn find_sibling_binary(name: &str) -> PathBuf {
    // Prefer a sibling binary (same install dir as the current process).
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let sibling = dir.join(name);
            if sibling.exists() {
                return sibling;
            }
        }
    }
    PathBuf::from(name)
}

// ─── Per-project runtime lockfile ──────────────────────────────────────────

#[derive(Serialize, Deserialize)]
struct LockInfo {
    pid: i32,
    #[serde(rename = "startedAt")]
    started_at: u64,
}

struct RuntimeLockfile {
    path: PathBuf,
}

impl RuntimeLockfile {
    fn acquire(dir: &Path) -> Result<Self> {
        let path = dir.join("runtime.lock");

        if path.exists() {
            let bytes = std::fs::read(&path)?;
            if let Ok(info) = serde_json::from_slice::<LockInfo>(&bytes) {
                if process_alive(info.pid) {
                    anyhow::bail!(
                        "tenex runtime already running for this project (pid {})",
                        info.pid
                    );
                }
            }
            std::fs::remove_file(&path).ok();
        }

        let started_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let info = LockInfo {
            pid: std::process::id() as i32,
            started_at,
        };
        std::fs::write(&path, serde_json::to_vec(&info)?)?;
        Ok(Self { path })
    }
}

impl Drop for RuntimeLockfile {
    fn drop(&mut self) {
        if let Err(e) = std::fs::remove_file(&self.path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                warn!(error = %e, "failed to remove runtime lockfile");
            }
        }
    }
}

fn process_alive(pid: i32) -> bool {
    // SAFETY: kill(pid, 0) is a probe — no signal is delivered.
    let rc = unsafe { libc::kill(pid, 0) };
    if rc == 0 {
        return true;
    }
    // EPERM means the process exists but we lack permission to signal it.
    let errno = unsafe { *libc::__errno_location() };
    errno == libc::EPERM
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signed_event_from(keys: &Keys, kind: Kind, content: &str, tags: Vec<Tag>) -> Event {
        EventBuilder::new(kind, content)
            .tags(tags)
            .sign_with_keys(keys)
            .unwrap()
    }

    fn signed_event(kind: Kind, content: &str, tags: Vec<Tag>) -> Event {
        let keys = Keys::generate();
        signed_event_from(&keys, kind, content, tags)
    }

    fn root_id() -> String {
        signed_event(Kind::TextNote, "root", Vec::new()).id.to_hex()
    }

    fn tag(parts: &[&str]) -> Tag {
        Tag::parse(parts.iter().copied()).unwrap()
    }

    fn agent(pubkey: &str) -> Agent {
        Agent {
            pubkey: pubkey.to_string(),
            slug: pubkey.to_string(),
            name: pubkey.to_string(),
            role: None,
            description: None,
            instructions: None,
            use_criteria: None,
            category: None,
            inferred_category: None,
            signer_ref: None,
            event_id: None,
            status: None,
            default_config_json: None,
            telegram_config_json: None,
            mcp_servers_json: None,
        }
    }

    fn dispatch_job(agent_pubkey: &str, conv_id: &str, content: &str) -> DispatchJob {
        DispatchJob {
            event: signed_event(Kind::TextNote, content, Vec::new()),
            agent: agent(agent_pubkey),
            conv_id: conv_id.to_string(),
            agent_json: PathBuf::from("agent.json"),
            allow_driver_preempt: false,
            completion_recipient_pubkey: None,
            response_tee: None,
        }
    }

    #[test]
    fn runtime_state_trace_carrier_round_trips_without_clobbering_existing_state() {
        let carrier = tenex_telemetry::TraceCarrier {
            traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01".to_string(),
            tracestate: Some("vendor=value".to_string()),
        };
        let mut state = serde_json::json!({
            "rustRuntime": {
                "consumedMessages": {
                    "event1": {"agentPubkey": "agent1", "conversationId": "conv1"}
                }
            }
        });

        write_trace_carrier_to_runtime_state(&mut state, &carrier, "event2", "agent2");

        assert_eq!(trace_carrier_from_runtime_state(&state), Some(carrier));
        assert!(state
            .get("rustRuntime")
            .and_then(|v| v.get("consumedMessages"))
            .and_then(|v| v.get("event1"))
            .is_some());
    }

    #[test]
    fn dispatch_queues_while_driver_busy_and_runs_newest_when_run_finishes() {
        let mut coordinator = DispatchCoordinator::default();
        let first = dispatch_job("agent1", "conv1", "first");
        let second = dispatch_job("agent1", "conv1", "second");
        let third = dispatch_job("agent1", "conv1", "third");
        let key = DispatchKey::new("agent1", "conv1");

        assert_eq!(
            coordinator
                .dispatch_inbound(first, false)
                .unwrap()
                .event
                .content,
            "first"
        );
        assert!(coordinator.dispatch_inbound(second, false).is_none());
        assert!(coordinator.dispatch_inbound(third, false).is_none());

        coordinator.mark_driver_free(&key);
        let resumed = coordinator.finish_run(&key).unwrap();

        assert_eq!(resumed.event.content, "third");
    }

    #[test]
    fn dispatch_drops_queued_messages_consumed_by_current_run() {
        let mut coordinator = DispatchCoordinator::default();
        let first = dispatch_job("agent1", "conv1", "first");
        let second = dispatch_job("agent1", "conv1", "second");
        let key = DispatchKey::new("agent1", "conv1");

        assert!(coordinator.dispatch_inbound(first, false).is_some());
        assert!(coordinator.dispatch_inbound(second, false).is_none());
        coordinator.drop_queued_matching(&key, |job| job.event.content == "second");

        assert!(coordinator.finish_run(&key).is_none());
    }

    #[test]
    fn dispatch_starts_concurrent_run_when_existing_run_is_in_tool() {
        let mut coordinator = DispatchCoordinator::default();
        let first = dispatch_job("agent1", "conv1", "first");
        let second = dispatch_job("agent1", "conv1", "second");
        let key = DispatchKey::new("agent1", "conv1");

        assert!(coordinator.dispatch_inbound(first, false).is_some());
        coordinator.mark_driver_free(&key);

        assert_eq!(
            coordinator
                .dispatch_inbound(second, false)
                .unwrap()
                .event
                .content,
            "second"
        );
    }

    #[test]
    fn dispatch_can_preempt_busy_driver_for_shell_intervention() {
        let mut coordinator = DispatchCoordinator::default();
        let first = dispatch_job("agent1", "conv1", "first");
        let second = dispatch_job("agent1", "conv1", "second");

        assert!(coordinator.dispatch_inbound(first, false).is_some());
        assert_eq!(
            coordinator
                .dispatch_inbound(second, true)
                .unwrap()
                .event
                .content,
            "second"
        );
    }

    #[test]
    fn dispatch_queues_when_persisted_driver_was_reacquired() {
        let mut coordinator = DispatchCoordinator::default();
        let first = dispatch_job("agent1", "conv1", "first");
        let second = dispatch_job("agent1", "conv1", "second");
        let key = DispatchKey::new("agent1", "conv1");

        assert!(coordinator.dispatch_inbound(first, false).is_some());
        coordinator.mark_driver_free(&key);
        coordinator.sync_driver_busy(&key, true);

        assert!(coordinator.dispatch_inbound(second, false).is_none());
    }

    #[test]
    fn runtime_state_driver_busy_matches_current_agent_conversation() {
        let key = DispatchKey::new("agent1", "conv1");
        let state = serde_json::json!({
            "rustRuntime": {
                "driver": {
                    "agentPubkey": "agent1",
                    "conversationId": "conv1",
                    "executionId": "exec1",
                    "acquiredAt": now_ms()
                }
            }
        });

        assert!(runtime_state_driver_busy(&state, &key));
    }

    #[test]
    fn runtime_state_driver_busy_ignores_stale_driver() {
        let key = DispatchKey::new("agent1", "conv1");
        let state = serde_json::json!({
            "rustRuntime": {
                "driver": {
                    "agentPubkey": "agent1",
                    "conversationId": "conv1",
                    "executionId": "exec1",
                    "acquiredAt": now_ms() - DRIVER_STALE_AFTER_MS - 1
                }
            }
        });

        assert!(!runtime_state_driver_busy(&state, &key));
    }

    #[test]
    fn p_tag_pubkeys_extracts_direct_targets() {
        let recipient = Keys::generate().public_key().to_hex();
        let event = signed_event(
            Kind::TextNote,
            "direct",
            vec![tag(&["p", recipient.as_str()])],
        );

        assert_eq!(p_tag_pubkeys(&event), vec![recipient]);
    }

    #[test]
    fn agent_authored_delegation_targets_project_agent() {
        let worker = Keys::generate().public_key().to_hex();
        let event = signed_event(Kind::TextNote, "delegated task", vec![tag(&["p", &worker])]);
        let agent_pubkeys = HashSet::from([worker]);

        assert!(targets_project_agent(&event, &agent_pubkeys));
    }

    #[test]
    fn agent_authored_plain_message_does_not_target_project_agent() {
        let worker = Keys::generate().public_key().to_hex();
        let event = signed_event(Kind::TextNote, "plain reply", Vec::new());
        let agent_pubkeys = HashSet::from([worker]);

        assert!(!targets_project_agent(&event, &agent_pubkeys));
    }

    #[test]
    fn foreign_project_a_tag_blocks_routing_even_when_p_tag_matches_agent() {
        let local_owner = Keys::generate().public_key().to_hex();
        let foreign_owner = Keys::generate().public_key().to_hex();
        let agent_pubkey = Keys::generate().public_key().to_hex();
        let local_project = format!("31933:{local_owner}:local-project");
        let foreign_project = format!("31933:{foreign_owner}:foreign-project");
        let event = signed_event(
            Kind::TextNote,
            "direct",
            vec![tag(&["a", &foreign_project]), tag(&["p", &agent_pubkey])],
        );
        let agent_pubkeys = HashSet::from([agent_pubkey]);

        assert!(targets_project_agent(&event, &agent_pubkeys));
        assert!(!event_matches_project_scope(&event, &local_project));
    }

    #[test]
    fn local_project_a_tag_allows_routing() {
        let owner = Keys::generate().public_key().to_hex();
        let project = format!("31933:{owner}:local-project");
        let event = signed_event(Kind::TextNote, "direct", vec![tag(&["a", &project])]);

        assert!(event_matches_project_scope(&event, &project));
    }

    #[test]
    fn unscoped_and_non_project_a_tags_do_not_block_direct_routing() {
        let unscoped = signed_event(Kind::TextNote, "direct", Vec::new());
        let article_ref = signed_event(
            Kind::TextNote,
            "direct",
            vec![tag(&[
                "a",
                "30023:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:note",
            ])],
        );
        let project = "31933:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:demo";

        assert!(event_matches_project_scope(&unscoped, project));
        assert!(event_matches_project_scope(&article_ref, project));
    }

    #[test]
    fn delegation_route_maps_child_completion_back_to_parent_context() {
        let store = Arc::new(Mutex::new(ConversationStore::open_in_memory().unwrap()));
        let user_keys = Keys::generate();
        let parent_keys = Keys::generate();
        let child_keys = Keys::generate();
        let parent_pubkey = parent_keys.public_key().to_hex();
        let child_pubkey = child_keys.public_key().to_hex();
        let parent_conversation_id =
            signed_event_from(&user_keys, Kind::TextNote, "root task", Vec::new())
                .id
                .to_hex();
        let parent_trigger = signed_event_from(
            &user_keys,
            Kind::TextNote,
            "delegate this",
            vec![tag(&["e", &parent_conversation_id, "", "root"])],
        );
        let parent_job = DispatchJob {
            event: parent_trigger.clone(),
            agent: agent(&parent_pubkey),
            conv_id: parent_conversation_id.clone(),
            agent_json: PathBuf::from("agent.json"),
            allow_driver_preempt: false,
            completion_recipient_pubkey: None,
            response_tee: None,
        };
        let delegation = signed_event_from(
            &parent_keys,
            Kind::TextNote,
            "@worker choose a color",
            vec![
                tag(&["p", &child_pubkey]),
                tag(&["delegation", &parent_conversation_id]),
            ],
        );
        let agent_pubkeys = HashSet::from([parent_pubkey.clone(), child_pubkey.clone()]);

        let route = register_delegation_route_if_needed(
            &store,
            &delegation,
            &agent_pubkeys,
            Some(&parent_job),
        )
        .unwrap()
        .expect("route registered");

        assert_eq!(route.parent_agent_pubkey, parent_pubkey);
        assert_eq!(route.parent_conversation_id, parent_conversation_id);
        assert_eq!(
            route.parent_completion_recipient_pubkey,
            parent_trigger.pubkey.to_hex()
        );
        assert_eq!(route.child_agent_pubkey, child_pubkey);
        assert_eq!(route.child_conversation_id, delegation.id.to_hex());

        let completion = signed_event_from(
            &child_keys,
            Kind::TextNote,
            "Worker picked blue.",
            vec![
                tag(&["e", &delegation.id.to_hex(), "", "root"]),
                tag(&["p", &route.parent_agent_pubkey]),
                tag(&["status", "completed"]),
            ],
        );
        let completion_route = delegation_route_for_completion(&store, &completion)
            .unwrap()
            .expect("completion route");

        assert_eq!(
            completion_route.parent_conversation_id,
            parent_conversation_id
        );
        assert_eq!(
            completion_route.child_conversation_id,
            delegation.id.to_hex()
        );

        let followup = signed_event_from(
            &parent_keys,
            Kind::TextNote,
            "@worker use blue if available",
            vec![
                tag(&["e", &delegation.id.to_hex(), "", "root"]),
                tag(&["p", &child_pubkey]),
            ],
        );

        assert!(register_delegation_route_if_needed(
            &store,
            &followup,
            &agent_pubkeys,
            Some(&parent_job)
        )
        .unwrap()
        .is_none());
        assert_eq!(
            conversation_id_from_event(&followup),
            delegation.id.to_hex()
        );
    }

    #[test]
    fn persists_plain_conversation_event_for_current_root() {
        let root = root_id();
        let event = signed_event(
            Kind::TextNote,
            "visible reply",
            vec![tag(&["e", &root, "", "root"])],
        );

        assert!(should_persist_agent_message(&event, &root));
    }

    #[test]
    fn rejects_stream_delta_events() {
        let root = root_id();
        let event = signed_event(
            Kind::Custom(24135),
            "partial",
            vec![tag(&["e", &root, "", "root"])],
        );

        assert!(!should_persist_agent_message(&event, &root));
    }

    #[test]
    fn rejects_tool_use_events() {
        let root = root_id();
        let event = signed_event(
            Kind::TextNote,
            "tool call",
            vec![tag(&["e", &root, "", "root"]), tag(&["tool", "shell"])],
        );

        assert!(!should_persist_agent_message(&event, &root));
    }

    #[test]
    fn persists_completion_events_with_recipients() {
        let root = root_id();
        let recipient = Keys::generate().public_key().to_hex();
        let event = signed_event(
            Kind::TextNote,
            "The worker picked blue.",
            vec![
                tag(&["e", &root, "", "root"]),
                tag(&["p", recipient.as_str()]),
                tag(&["status", "completed"]),
            ],
        );

        assert!(should_persist_agent_message(&event, &root));
    }

    #[test]
    fn rejects_fresh_delegation_events_without_current_root() {
        let parent_root = root_id();
        let recipient = Keys::generate().public_key().to_hex();
        let event = signed_event(
            Kind::TextNote,
            "@worker do this",
            vec![
                tag(&["delegation", &parent_root]),
                tag(&["p", recipient.as_str()]),
            ],
        );

        assert!(!should_persist_agent_message(&event, &parent_root));
    }

    #[test]
    fn rejects_empty_conversation_events() {
        let root = root_id();
        let event = signed_event(Kind::TextNote, "   ", vec![tag(&["e", &root, "", "root"])]);

        assert!(!should_persist_agent_message(&event, &root));
    }
}
