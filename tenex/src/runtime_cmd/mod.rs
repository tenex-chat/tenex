use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use clap::Parser;
use nostr::JsonUtil;
use nostr_sdk::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter};
use tracing::{info, info_span, warn, Instrument};

use tenex_conversations::{ConversationStore, NewMessage, Project as ConversationsProject};
use tenex_project::{models::ProjectAgent, Agent, Project};

use crate::daemon::config;
use crate::nostr_pub::{backend_signer, operations_status, project_status};
use crate::store::resolve_base_dir;

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
    base_dir: PathBuf,
    agent_binary: PathBuf,
    agents: Arc<Vec<Agent>>,
    project_agents: Arc<Vec<ProjectAgent>>,
    agent_pubkeys: Arc<HashSet<String>>,
    store: Arc<Mutex<ConversationStore>>,
    coordinator: Arc<Mutex<DispatchCoordinator>>,
    seen: Arc<Mutex<HashSet<EventId>>>,
}

#[derive(Clone)]
struct DispatchJob {
    event: Event,
    agent: Agent,
    conv_id: String,
    agent_json: PathBuf,
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
    fn dispatch_inbound(&mut self, job: DispatchJob) -> Option<DispatchJob> {
        let key = DispatchKey::new(job.agent.pubkey.clone(), job.conv_id.clone());
        let entry = self.entries.entry(key).or_default();

        if entry.active_runs == 0 {
            entry.active_runs = 1;
            entry.driver_busy = true;
            return Some(job);
        }

        if entry.driver_busy {
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
    let agents = project.agents()?;
    let project_agents = project.project_agents()?;

    if agents.is_empty() {
        anyhow::bail!("project '{}' has no agents", meta.d_tag);
    }

    let store = Arc::new(Mutex::new(
        ConversationsProject::open_conversations(&meta.d_tag, &base_dir)
            .context("opening conversation store")?,
    ));

    // Loop prevention: ignore events authored by any project agent.
    let agent_pubkeys: HashSet<String> = agents.iter().map(|a| a.pubkey.clone()).collect();

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
    let project_addr = format!("31933:{}:{}", owner_pubkey, meta.d_tag);

    let backend_keys = match backend_signer::ensure_backend_keys(&base_dir) {
        Ok(keys) => Some(keys),
        Err(e) => {
            warn!(error = %e, "backend keys unavailable; status events (24010/24133) will not be published");
            None
        }
    };

    // kind:1 events #a-tagging this project (initial messages to the project)
    let filter_a = Filter::new()
        .kind(Kind::TextNote)
        .authors(authors.clone())
        .custom_tags(
            SingleLetterTag::lowercase(Alphabet::A),
            [project_addr.as_str()],
        )
        .since(since);

    // kind:1 events #p-tagging any agent in this project (replies, directed messages)
    let agent_keys: Vec<PublicKey> = agents
        .iter()
        .filter_map(|a| PublicKey::from_hex(&a.pubkey).ok())
        .collect();
    let mut p_authors = authors.clone();
    p_authors.extend(agent_keys.iter().copied());
    let filter_p = Filter::new()
        .kind(Kind::TextNote)
        .authors(p_authors)
        .pubkeys(agent_keys)
        .since(since);

    client
        .subscribe_with_id(SubscriptionId::generate(), filter_a, None)
        .await?;
    client
        .subscribe_with_id(SubscriptionId::generate(), filter_p, None)
        .await?;
    info!("subscriptions active");

    // Publish project status (kind:24010) immediately and every 30 seconds.
    if let Some(ref keys) = backend_keys {
        let client_status = client.clone();
        let keys_status = keys.clone();
        let meta_status = meta.clone();
        let agents_status = agents.clone();
        let pa_status = project_agents.clone();
        let whitelist_status = cfg.whitelisted_pubkeys.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(30));
            loop {
                interval.tick().await;
                match project_status::build_project_status_event(
                    &keys_status,
                    &meta_status,
                    &agents_status,
                    &pa_status,
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
    let coordinator = Arc::new(Mutex::new(DispatchCoordinator::default()));
    let shared = Arc::new(RuntimeShared {
        client: client.clone(),
        backend_keys: backend_keys.clone(),
        project_addr: project_addr.clone(),
        whitelisted_pubkeys: cfg.whitelisted_pubkeys.clone(),
        project_id: meta.d_tag.clone(),
        base_dir: base_dir.clone(),
        agent_binary,
        agents: Arc::new(agents.clone()),
        project_agents: Arc::new(project_agents.clone()),
        agent_pubkeys: Arc::new(agent_pubkeys.clone()),
        store: store.clone(),
        coordinator,
        seen: Arc::new(Mutex::new(HashSet::new())),
    });

    let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let mut notifications = client.notifications();

    loop {
        tokio::select! {
            result = notifications.recv() => {
                match result {
                    Ok(RelayPoolNotification::Event { event, .. }) => {
                        if !mark_seen(&shared.seen, event.id) {
                            continue;
                        }
                        if shared.agent_pubkeys.contains(&event.pubkey.to_hex())
                            && !targets_project_agent(&event, shared.agent_pubkeys.as_ref())
                        {
                            continue;
                        }
                        let short = &event.id.to_hex()[..8];
                        info!(event_id = short, "received event");
                        match select_agent(&event, &agents, &project_agents) {
                            Ok(agent) => {
                                info!(event_id = short, agent = %agent.slug, "dispatching");
                                let conv_id = conversation_id_from_event(&event);
                                let agent_json = base_dir
                                    .join("agents")
                                    .join(format!("{}.json", agent.pubkey));
                                let job = DispatchJob {
                                    event: *event,
                                    agent: agent.clone(),
                                    conv_id,
                                    agent_json,
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

    client.disconnect().await;
    Ok(())
}

async fn accept_dispatch(shared: Arc<RuntimeShared>, job: DispatchJob) -> Result<()> {
    persist_user_message(&shared.store, &job.event, &job.conv_id)?;
    let maybe_start = {
        let mut coordinator = shared.coordinator.lock().unwrap();
        coordinator.dispatch_inbound(job)
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

async fn dispatch_project_agent_target(shared: Arc<RuntimeShared>, event: &Event) -> Result<()> {
    if !targets_project_agent(event, shared.agent_pubkeys.as_ref()) {
        return Ok(());
    }
    if !mark_seen(&shared.seen, event.id) {
        return Ok(());
    }

    let agent = select_agent(event, &shared.agents, &shared.project_agents)?.clone();
    let conv_id = conversation_id_from_event(event);
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
        },
    )
    .await
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
    if !job.agent_json.exists() {
        anyhow::bail!("agent JSON not found: {}", job.agent_json.display());
    }

    let execution_id = uuid::Uuid::new_v4().to_string();
    let mut command = tokio::process::Command::new(&shared.agent_binary);
    command
        .arg(&job.agent_json)
        .env("TENEX_PROJECT_ID", &shared.project_id)
        .env("TENEX_BASE_DIR", &shared.base_dir)
        .env("TENEX_EXECUTION_ID", &execution_id)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    if let Some(carrier) = tenex_telemetry::current_trace_context() {
        command.env("TRACEPARENT", carrier.traceparent);
        if let Some(tracestate) = carrier.tracestate {
            command.env("TRACESTATE", tracestate);
        }
    }
    let mut child = command.spawn().context("failed to spawn tenex-agent")?;

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
                handle_agent_runtime_signal(shared.clone(), &key, &ev).await;
                if let Err(e) = dispatch_project_agent_target(shared.clone(), &ev).await {
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

fn should_persist_agent_message(event: &Event, conversation_id: &str) -> bool {
    if event.kind != Kind::TextNote {
        return false;
    }

    let mut has_conversation_ref = false;
    let mut has_recipient = false;

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
            "p" => has_recipient = true,
            "tool" | "status" | "intent" | "reasoning" | "error" => return false,
            _ => {}
        }
    }

    has_conversation_ref && !has_recipient
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
    // Prefer a sibling binary (same install dir as the current process).
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let sibling = dir.join("tenex-agent");
            if sibling.exists() {
                return sibling;
            }
        }
    }
    PathBuf::from("tenex-agent")
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

    fn signed_event(kind: Kind, content: &str, tags: Vec<Tag>) -> Event {
        let keys = Keys::generate();
        EventBuilder::new(kind, content)
            .tags(tags)
            .sign_with_keys(&keys)
            .unwrap()
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
            coordinator.dispatch_inbound(first).unwrap().event.content,
            "first"
        );
        assert!(coordinator.dispatch_inbound(second).is_none());
        assert!(coordinator.dispatch_inbound(third).is_none());

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

        assert!(coordinator.dispatch_inbound(first).is_some());
        assert!(coordinator.dispatch_inbound(second).is_none());
        coordinator.drop_queued_matching(&key, |job| job.event.content == "second");

        assert!(coordinator.finish_run(&key).is_none());
    }

    #[test]
    fn dispatch_starts_concurrent_run_when_existing_run_is_in_tool() {
        let mut coordinator = DispatchCoordinator::default();
        let first = dispatch_job("agent1", "conv1", "first");
        let second = dispatch_job("agent1", "conv1", "second");
        let key = DispatchKey::new("agent1", "conv1");

        assert!(coordinator.dispatch_inbound(first).is_some());
        coordinator.mark_driver_free(&key);

        assert_eq!(
            coordinator.dispatch_inbound(second).unwrap().event.content,
            "second"
        );
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
            "",
            vec![tag(&["e", &root, "", "root"]), tag(&["tool", "shell"])],
        );

        assert!(!should_persist_agent_message(&event, &root));
    }

    #[test]
    fn rejects_delegation_events() {
        let root = root_id();
        let recipient = Keys::generate().public_key().to_hex();
        let event = signed_event(
            Kind::TextNote,
            "@worker do this",
            vec![
                tag(&["e", &root, "", "root"]),
                tag(&["p", recipient.as_str()]),
            ],
        );

        assert!(!should_persist_agent_message(&event, &root));
    }
}
