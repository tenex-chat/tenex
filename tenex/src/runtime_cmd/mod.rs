use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use clap::Parser;
use nostr::JsonUtil;
use nostr_sdk::prelude::*;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter};
use tracing::{info, warn};

use tenex_conversations::{ConversationStore, NewMessage, Project as ConversationsProject};
use tenex_project::{Agent, Project, models::ProjectAgent};

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

    let store = Mutex::new(
        ConversationsProject::open_conversations(&meta.d_tag, &base_dir)
            .context("opening conversation store")?,
    );

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
    let filter_p = Filter::new()
        .kind(Kind::TextNote)
        .authors(authors)
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
    // Deduplicate across the two overlapping subscriptions.
    let mut seen: HashSet<EventId> = HashSet::new();

    let mut sigterm =
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let mut notifications = client.notifications();

    loop {
        tokio::select! {
            result = notifications.recv() => {
                match result {
                    Ok(RelayPoolNotification::Event { event, .. }) => {
                        if !seen.insert(event.id) {
                            continue;
                        }
                        if agent_pubkeys.contains(&event.pubkey.to_hex()) {
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

                                if let Some(ref keys) = backend_keys {
                                    send_operations_status(
                                        &client,
                                        keys,
                                        &conv_id,
                                        &project_addr,
                                        &cfg.whitelisted_pubkeys,
                                        &[agent.pubkey.as_str()],
                                    )
                                    .await;
                                }

                                if let Err(e) = run_agent(
                                    &client,
                                    &event,
                                    &agent_json,
                                    &meta.d_tag,
                                    &agent_binary,
                                    &store,
                                )
                                .await
                                {
                                    warn!(event_id = short, agent = %agent.slug, error = %e, "agent run failed");
                                }

                                if let Some(ref keys) = backend_keys {
                                    send_operations_status(
                                        &client,
                                        keys,
                                        &conv_id,
                                        &project_addr,
                                        &cfg.whitelisted_pubkeys,
                                        &[],
                                    )
                                    .await;
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

async fn run_agent(
    client: &Client,
    event: &Event,
    agent_json: &Path,
    project_id: &str,
    agent_binary: &Path,
    store: &Mutex<ConversationStore>,
) -> Result<()> {
    if !agent_json.exists() {
        anyhow::bail!("agent JSON not found: {}", agent_json.display());
    }

    let conv_id = conversation_id_from_event(event);
    let ts = event.created_at.as_secs() as i64;

    {
        let s = store.lock().unwrap();
        s.ensure_conversation(&conv_id)?;
        s.append_message(
            &conv_id,
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
                targeted_pubkeys: None,
                sender_principal: None,
                targeted_principals: None,
                tool_data: None,
                delegation_marker: None,
                human_readable: None,
                transcript_tool_attributes: None,
            },
        )?;
    }

    let mut child = tokio::process::Command::new(agent_binary)
        .arg(agent_json)
        .env("TENEX_PROJECT_ID", project_id)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .context("failed to spawn tenex-agent")?;

    // Write the triggering event JSON to stdin; closing stdin signals EOF to the agent.
    {
        let stdin = child.stdin.take().context("child has no stdin")?;
        let mut w = BufWriter::new(stdin);
        w.write_all(event.as_json().as_bytes()).await?;
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
                {
                    let s = store.lock().unwrap();
                    let agent_ts = ev.created_at.as_secs() as i64;
                    if let Err(e) = s.append_message(
                        &conv_id,
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
                if let Err(e) = client.send_event(&ev).await {
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

fn conversation_id_from_event(event: &Event) -> String {
    let e_kind = TagKind::SingleLetter(SingleLetterTag::lowercase(Alphabet::E));
    let mut first_unmarked: Option<String> = None;

    for tag in event.tags.iter() {
        if tag.kind() != e_kind {
            continue;
        }
        let parts = tag.as_slice();
        // parts[0]="e", parts[1]=event-id, parts[2]=relay, parts[3]=marker
        let Some(event_id) = parts.get(1) else { continue };
        let marker = parts.get(3).map(|s| s.as_str());
        match marker {
            Some("root") => return event_id.clone(),
            None | Some("") => {
                if first_unmarked.is_none() {
                    first_unmarked = Some(event_id.clone());
                }
            }
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
        let info = LockInfo { pid: std::process::id() as i32, started_at };
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
