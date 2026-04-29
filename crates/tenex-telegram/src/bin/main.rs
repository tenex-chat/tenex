//! `tenex-telegram` daemon — polls Telegram Bot API and publishes backend-signed
//! kind:1 Nostr events addressed to the appropriate agent.
//!
//! Lifecycle:
//!   1. Load ~/.tenex/config.json (backend nsec + relays).
//!   2. Scan all ~/.tenex/projects/<d-tag>/event.json to discover agents.
//!   3. For each agent whose agent.json carries a `telegram` block, start a
//!      polling loop under that bot token.
//!   4. On each inbound user message, look up the session store to find (or
//!      start) a conversation, then publish a backend-signed kind:1 Nostr event
//!      p-tagging the agent and carrying `telegram-*` tags.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result};
use nostr_sdk::prelude::*;
use tenex_project::Project;
use tenex_telegram::client::BotClient;
use tenex_telegram::config::{parse_agent_config, TelegramAgentConfig};
use tenex_telegram::session::SessionStore;
use tenex_telegram::types::TelegramMessage;
use tracing::{error, info, warn};

const POLL_TIMEOUT_SECS: u64 = 20;
const POLL_LIMIT: u32 = 50;
const NEW_CONVERSATION_MSG: &str = "Started a new conversation. What would you like to work on?";

#[derive(Debug, Clone)]
struct AgentBinding {
    pubkey: String,
    project_id: String,
    config: TelegramAgentConfig,
}

#[derive(Debug)]
struct DaemonConfig {
    relays: Vec<String>,
    backend_nsec: String,
}

fn load_config() -> Result<DaemonConfig> {
    let path = dirs_next::home_dir()
        .context("no home dir")?
        .join(".tenex/config.json");
    let raw = std::fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
    let val: serde_json::Value =
        serde_json::from_str(&raw).with_context(|| format!("parse {}", path.display()))?;

    let backend_nsec = val
        .get("tenexPrivateKey")
        .and_then(|v| v.as_str())
        .context("no tenexPrivateKey in ~/.tenex/config.json")?
        .to_string();

    let relays: Vec<String> = val
        .get("relays")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .filter(|s| s.starts_with("ws://") || s.starts_with("wss://"))
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default();

    let relays = if relays.is_empty() {
        vec!["wss://relay.tenex.chat".to_string()]
    } else {
        relays
    };

    Ok(DaemonConfig {
        relays,
        backend_nsec,
    })
}

fn discover_bindings() -> Vec<AgentBinding> {
    let base = dirs_next::home_dir()
        .map(|h| h.join(".tenex"))
        .unwrap_or_else(|| PathBuf::from(".tenex"));

    let projects_dir = base.join("projects");
    let mut bindings = Vec::new();

    let entries = match std::fs::read_dir(&projects_dir) {
        Ok(e) => e,
        Err(e) => {
            warn!(error = %e, "cannot read projects dir");
            return bindings;
        }
    };

    for entry in entries.flatten() {
        let d_tag = entry.file_name().to_string_lossy().to_string();
        let project = match Project::open_default(&d_tag) {
            Ok(p) => p,
            Err(e) => {
                warn!(d_tag = %d_tag, error = %e, "skipping project");
                continue;
            }
        };

        let agents = match project.agents() {
            Ok(a) => a,
            Err(e) => {
                warn!(d_tag = %d_tag, error = %e, "cannot read agents");
                continue;
            }
        };

        for agent in agents {
            let cfg_json = match agent.telegram_config_json {
                Some(ref s) => s.clone(),
                None => continue,
            };
            let cfg = match parse_agent_config(&cfg_json) {
                Some(c) => c,
                None => {
                    warn!(pubkey = %agent.pubkey, "invalid telegram config JSON, skipping");
                    continue;
                }
            };
            if cfg.bot_token.is_empty() {
                continue;
            }
            bindings.push(AgentBinding {
                pubkey: agent.pubkey.clone(),
                project_id: d_tag.clone(),
                config: cfg,
            });
        }
    }

    bindings
}

struct Poller {
    binding: AgentBinding,
    client: BotClient,
    nostr: Client,
    backend_keys: Keys,
    sessions: Arc<Mutex<SessionStore>>,
    next_offset: Option<i64>,
}

impl Poller {
    async fn new(
        binding: AgentBinding,
        backend_keys: Keys,
        relays: &[String],
        session_path: PathBuf,
    ) -> Result<Self> {
        let client = BotClient::new(
            binding.config.bot_token.clone(),
            binding.config.api_base_url.clone(),
        );

        let nostr = Client::new(backend_keys.clone());
        for relay in relays {
            nostr
                .add_relay(relay.as_str())
                .await
                .with_context(|| format!("add relay {relay}"))?;
        }
        nostr.connect().await;

        let sessions = Arc::new(Mutex::new(SessionStore::open(session_path)));

        Ok(Self {
            binding,
            client,
            nostr,
            backend_keys,
            sessions,
            next_offset: None,
        })
    }

    async fn run_once(&mut self) -> Result<()> {
        let updates = self
            .client
            .get_updates(self.next_offset, POLL_TIMEOUT_SECS, POLL_LIMIT)
            .await?;

        for update in updates {
            if let Some(next) = self.next_offset {
                if update.update_id < next {
                    continue;
                }
            }
            self.next_offset = Some(update.update_id + 1);

            // Silently ignore edited messages
            if update.edited_message.is_some() {
                continue;
            }

            if let Some(msg) = update.message {
                if let Err(e) = self.process_message(msg).await {
                    warn!(update_id = update.update_id, error = %e, "process message failed");
                }
            }
        }

        Ok(())
    }

    async fn process_message(&mut self, msg: TelegramMessage) -> Result<()> {
        // Drop bot-authored messages
        if msg.from.as_ref().map(|u| u.is_bot).unwrap_or(false) {
            return Ok(());
        }

        let sender = match &msg.from {
            Some(u) => u.clone(),
            None => return Ok(()),
        };

        // Only DMs and group/supergroup
        let chat_type = msg.chat.chat_type.as_str();
        match chat_type {
            "private" | "group" | "supergroup" => {}
            _ => return Ok(()),
        }

        // DM allowance check
        if chat_type == "private" && !self.binding.config.allows_dms() {
            return Ok(());
        }
        if (chat_type == "group" || chat_type == "supergroup")
            && !self.binding.config.allows_groups()
        {
            return Ok(());
        }

        let chat_id = msg.chat.id.to_string();
        let message_id = msg.message_id.to_string();
        let thread_id = msg.message_thread_id.map(|t| t.to_string());
        let channel_key = SessionStore::channel_key(&chat_id, thread_id.as_deref());

        let text = match &msg.text {
            Some(t) => t.trim().to_string(),
            None => return Ok(()),
        };

        // /new command: reset session
        let is_new = text == "/new" || text.starts_with("/new ") || text.starts_with("/new@");
        if is_new {
            let _ = self.clear_session(&channel_key);
            if let Err(e) = self
                .client
                .send_message(
                    &chat_id,
                    NEW_CONVERSATION_MSG,
                    None,
                    Some(&message_id),
                    thread_id.as_deref(),
                )
                .await
            {
                warn!(error = %e, "failed to send /new acknowledgement");
            }
            return Ok(());
        }

        // Look up existing session
        let root_event_id = self.session_root(&channel_key);

        let agent_pubkey =
            PublicKey::from_hex(&self.binding.pubkey).context("parse agent pubkey")?;

        // Build tags
        let mut tags = vec![
            Tag::public_key(agent_pubkey),
            Tag::custom(
                TagKind::Custom("telegram-chat-id".into()),
                vec![chat_id.clone()],
            ),
            Tag::custom(
                TagKind::Custom("telegram-message-id".into()),
                vec![message_id.clone()],
            ),
        ];
        if let Some(ref tid) = thread_id {
            tags.push(Tag::custom(
                TagKind::Custom("telegram-thread-id".into()),
                vec![tid.clone()],
            ));
        }

        // If existing session, add root e-tag
        let new_root = if let Some(ref root_hex) = root_event_id {
            if let Ok(root_id) = EventId::from_hex(root_hex) {
                tags.push(Tag::from_standardized_without_cell(TagStandard::Event {
                    event_id: root_id,
                    relay_url: None,
                    marker: Some(Marker::Root),
                    public_key: None,
                    uppercase: false,
                }));
                false
            } else {
                true
            }
        } else {
            true
        };

        // Attach project a-tag
        if let Ok(project) = Project::open_default(&self.binding.project_id) {
            if let Ok(Some(meta)) = project.metadata() {
                if let Some(owner) = &meta.owner_pubkey {
                    let coord = format!("31933:{owner}:{}", meta.d_tag);
                    tags.push(Tag::custom(TagKind::Custom("a".into()), vec![coord]));
                }
            }
        }

        // Build event
        let user_info = format!(
            "[Telegram user {} ({})]",
            sender.first_name,
            sender
                .username
                .as_deref()
                .map(|u| format!("@{u}"))
                .unwrap_or_else(|| sender.id.to_string())
        );
        let content = format!("{user_info} {text}");

        let event = EventBuilder::new(Kind::TextNote, content)
            .tags(tags)
            .sign_with_keys(&self.backend_keys)
            .context("sign event")?;

        let event_id = event.id;

        self.nostr
            .send_event(&event)
            .await
            .context("publish Nostr event")?;

        info!(
            agent = %self.binding.pubkey,
            event_id = %event_id,
            chat_id = %chat_id,
            project = %self.binding.project_id,
            "published Telegram message to Nostr"
        );

        // Update session if this is a new conversation root
        if new_root {
            let _ = self.set_session_root(channel_key, event_id.to_hex());
        }

        Ok(())
    }

    fn clear_session(&self, channel_key: &str) -> Result<()> {
        self.sessions.lock().unwrap().clear(channel_key)
    }

    fn session_root(&self, channel_key: &str) -> Option<String> {
        self.sessions
            .lock()
            .unwrap()
            .get(channel_key)
            .map(ToString::to_string)
    }

    fn set_session_root(&self, channel_key: String, event_id: String) -> Result<()> {
        self.sessions.lock().unwrap().set(channel_key, event_id)
    }

    async fn skip_backlog(&mut self) -> Result<()> {
        let updates = self
            .client
            .get_updates(None, 0, POLL_LIMIT)
            .await
            .unwrap_or_default();
        if let Some(last) = updates.last() {
            self.next_offset = Some(last.update_id + 1);
            info!(
                agent = %self.binding.pubkey,
                skipped = updates.len(),
                "skipped backlog"
            );
        }
        Ok(())
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    install_rustls_crypto_provider();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let cfg = load_config().context("load daemon config")?;
    let backend_keys = Keys::parse(&cfg.backend_nsec).context("parse backend nsec")?;

    let bindings = discover_bindings();
    if bindings.is_empty() {
        info!("no Telegram-enabled agents found; exiting");
        return Ok(());
    }

    info!(count = bindings.len(), "discovered Telegram-enabled agents");

    // Deduplicate: one poller per bot token (a token can serve multiple projects).
    // For simplicity we start one poller per unique (token, agent_pubkey) pair.
    // A single bot token must map to a single agent pubkey.
    let mut pollers: HashMap<String, Poller> = HashMap::new();
    for binding in bindings {
        let key = binding.config.bot_token.clone();
        if pollers.contains_key(&key) {
            // Duplicate token — skip; first registration wins.
            warn!(
                token_suffix = %&key[key.len().saturating_sub(6)..],
                "duplicate bot token skipped"
            );
            continue;
        }

        let session_path = dirs_next::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(format!(
                ".tenex/telegram-sessions-{}.json",
                &binding.pubkey[..12]
            ));

        match Poller::new(
            binding.clone(),
            backend_keys.clone(),
            &cfg.relays,
            session_path,
        )
        .await
        {
            Ok(mut poller) => {
                // Register bot commands and skip backlog
                let commands = vec![tenex_telegram::types::TelegramBotCommand {
                    command: "new".to_string(),
                    description: "Start a new conversation".to_string(),
                }];
                if let Err(e) = poller.client.set_my_commands(&commands).await {
                    warn!(error = %e, "failed to register bot commands");
                }
                if let Err(e) = poller.skip_backlog().await {
                    warn!(error = %e, "failed to skip backlog");
                }
                pollers.insert(key, poller);
            }
            Err(e) => {
                error!(
                    agent = %binding.pubkey,
                    error = %e,
                    "failed to initialize poller"
                );
            }
        }
    }

    if pollers.is_empty() {
        error!("no pollers initialized; exiting");
        return Ok(());
    }

    info!(count = pollers.len(), "started pollers");

    let handles: Vec<tokio::task::JoinHandle<()>> = pollers
        .into_values()
        .map(|mut poller| {
            tokio::spawn(async move {
                loop {
                    if let Err(e) = poller.run_once().await {
                        warn!(
                            agent = %poller.binding.pubkey,
                            error = %e,
                            "poll error"
                        );
                        tokio::time::sleep(Duration::from_millis(1500)).await;
                    }
                }
            })
        })
        .collect();

    for handle in handles {
        let _ = handle.await;
    }

    Ok(())
}

fn install_rustls_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}
