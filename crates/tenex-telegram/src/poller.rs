use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use anyhow::Result;
use nostr_sdk::prelude::*;
use tracing::{info, warn};

use crate::binding::BindingStore;
use crate::client::BotClient;
use crate::discovery::{AgentRegistration, ProjectRoute};
use crate::event_synth::{synthesize_telegram_event, TelegramEventInput};
use crate::forward::{send_to_telegram, telegram_text_for_event, TelegramChatRef};
use crate::pending_selection_store::{PendingProjectOption, PendingSelectionStore};
use crate::runtime_client::{dispatch_via_runtime, DispatchOutcome};
use crate::selection::{parse_project_selection, project_selection_prompt};
use crate::session::SessionStore;
use crate::types::{TelegramBotCommand, TelegramMessage};

const POLL_TIMEOUT_SECS: u64 = 20;
const POLL_LIMIT: u32 = 50;
const NEW_CONVERSATION_MSG: &str =
    "Started a new conversation. Send your next message to begin fresh.";

pub struct Poller {
    registration: AgentRegistration,
    client: BotClient,
    backend_keys: Keys,
    base_dir: PathBuf,
    sessions: Arc<Mutex<SessionStore>>,
    channel_bindings: Arc<Mutex<BindingStore>>,
    pending_selections: Arc<Mutex<PendingSelectionStore>>,
    next_offset: Option<i64>,
}

impl Poller {
    pub async fn new(
        registration: AgentRegistration,
        backend_keys: Keys,
        base_dir: PathBuf,
        session_path: PathBuf,
        channel_bindings: Arc<Mutex<BindingStore>>,
        pending_selections: Arc<Mutex<PendingSelectionStore>>,
    ) -> Result<Self> {
        let client = BotClient::new(
            registration.config.bot_token.clone(),
            registration.config.api_base_url.clone(),
        );

        Ok(Self {
            registration,
            client,
            backend_keys,
            base_dir,
            sessions: Arc::new(Mutex::new(SessionStore::open(session_path))),
            channel_bindings,
            pending_selections,
            next_offset: None,
        })
    }

    pub fn agent_pubkey(&self) -> &str {
        &self.registration.pubkey
    }

    pub async fn prepare(&mut self) {
        let commands = vec![TelegramBotCommand {
            command: "new".to_string(),
            description: "Start a new conversation".to_string(),
        }];
        if let Err(e) = self.client.set_my_commands(&commands).await {
            warn!(error = %e, "failed to register bot commands");
        }
        if let Err(e) = self.skip_backlog().await {
            warn!(error = %e, "failed to skip backlog");
        }
    }

    pub async fn run_once(&mut self) -> Result<()> {
        let updates = self
            .client
            .get_updates(self.next_offset, POLL_TIMEOUT_SECS, POLL_LIMIT)
            .await?;

        for update in updates {
            if self.next_offset.is_some_and(|next| update.update_id < next) {
                continue;
            }
            self.next_offset = Some(update.update_id + 1);

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
        if msg.from.as_ref().map(|u| u.is_bot).unwrap_or(false) {
            return Ok(());
        }

        let sender = match &msg.from {
            Some(u) => u.clone(),
            None => return Ok(()),
        };

        let chat_type = msg.chat.chat_type.as_str();
        match chat_type {
            "private" | "group" | "supergroup" => {}
            _ => return Ok(()),
        }

        if chat_type == "private" && !self.registration.config.allows_dms() {
            return Ok(());
        }
        if (chat_type == "group" || chat_type == "supergroup")
            && !self.registration.config.allows_groups()
        {
            return Ok(());
        }

        let chat_id = msg.chat.id.to_string();
        let message_id = msg.message_id.to_string();
        let thread_id = msg.message_thread_id.map(|t| t.to_string());
        let channel_id = SessionStore::channel_key(&chat_id, thread_id.as_deref());

        let text = match &msg.text {
            Some(t) => t.trim().to_string(),
            None => return Ok(()),
        };

        let is_new = text == "/new" || text.starts_with("/new ") || text.starts_with("/new@");
        if is_new {
            let _ = self.clear_session(&channel_id);
            let _ = self
                .pending_selections
                .lock()
                .unwrap()
                .clear(&self.registration.pubkey, &channel_id);
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

        let Some(project) = self
            .resolve_project_for_channel(
                &channel_id,
                &text,
                &chat_id,
                &message_id,
                thread_id.as_deref(),
            )
            .await?
        else {
            return Ok(());
        };

        let synthesized = synthesize_telegram_event(TelegramEventInput {
            agent_pubkey: &self.registration.pubkey,
            project: &project,
            backend_keys: &self.backend_keys,
            root_event_id: self.session_root(&channel_id),
            sender_first_name: &sender.first_name,
            sender_username: sender.username.as_deref(),
            sender_id: sender.id,
            chat_id: &chat_id,
            message_id: &message_id,
            thread_id: thread_id.as_deref(),
            channel_id: &channel_id,
            text: &text,
        })?;

        let event_id = synthesized.event.id.to_hex();
        info!(
            agent = %self.registration.pubkey,
            event_id = %event_id,
            channel = %&channel_id,
            project = %project.project_id,
            "dispatching Telegram message to runtime"
        );

        let publish_conversation = self
            .registration
            .config
            .publish_conversation_to_telegram
            .unwrap_or(false);
        let bot_client = self.client.clone();
        let chat = TelegramChatRef {
            chat_id: &chat_id,
            message_id: &message_id,
            thread_id: thread_id.as_deref(),
        };

        // Pulse the "typing…" indicator while the agent is processing. Bot API
        // chat actions auto-expire after ~5 seconds, so re-send on a short
        // interval. The task is aborted as soon as `dispatch_via_runtime`
        // returns (terminal frame received or transport error).
        let typing_handle = {
            let bot_client = bot_client.clone();
            let chat_id = chat_id.clone();
            let thread_id = thread_id.clone();
            tokio::spawn(async move {
                let mut tick = tokio::time::interval(std::time::Duration::from_secs(4));
                loop {
                    tick.tick().await;
                    if let Err(e) = bot_client
                        .send_chat_action(&chat_id, "typing", thread_id.as_deref())
                        .await
                    {
                        tracing::debug!(error = %e, "typing chat action failed");
                    }
                }
            })
        };

        let outcome = dispatch_via_runtime(
            &self.base_dir,
            &project.project_id,
            &synthesized.event,
            |ev| {
                if let Some(text) = telegram_text_for_event(ev, publish_conversation) {
                    let bot_client = bot_client.clone();
                    let chat_id = chat.chat_id.to_string();
                    let message_id = chat.message_id.to_string();
                    let thread_id = chat.thread_id.map(str::to_string);
                    tokio::spawn(async move {
                        let chat = TelegramChatRef {
                            chat_id: &chat_id,
                            message_id: &message_id,
                            thread_id: thread_id.as_deref(),
                        };
                        if let Err(e) = send_to_telegram(&bot_client, &chat, &text).await {
                            warn!(error = %e, "Telegram delivery failed");
                        }
                    });
                }
            },
        )
        .await;
        typing_handle.abort();
        let outcome = outcome?;

        match outcome {
            DispatchOutcome::Completed => {
                if synthesized.new_root {
                    let _ = self.set_session_root(channel_id, event_id);
                }
            }
            DispatchOutcome::Superseded => {
                info!(
                    agent = %self.registration.pubkey,
                    project = %project.project_id,
                    "transport dispatch superseded by newer message"
                );
            }
            DispatchOutcome::Failed(message) => {
                warn!(
                    agent = %self.registration.pubkey,
                    project = %project.project_id,
                    error = %message,
                    "transport dispatch failed"
                );
            }
        }

        Ok(())
    }

    async fn resolve_project_for_channel(
        &mut self,
        channel_id: &str,
        text: &str,
        chat_id: &str,
        message_id: &str,
        thread_id: Option<&str>,
    ) -> Result<Option<ProjectRoute>> {
        let pending_opts = self
            .pending_selections
            .lock()
            .unwrap()
            .get(&self.registration.pubkey, channel_id);

        if let Some(opts) = pending_opts {
            let pending_routes: Vec<ProjectRoute> = opts
                .iter()
                .map(|o| ProjectRoute {
                    project_id: o.project_id.clone(),
                    title: o.title.clone(),
                    owner_pubkey: None,
                })
                .collect();

            if let Some(selected) = parse_project_selection(text, &pending_routes) {
                self.remember_channel_binding(channel_id, &selected.project_id)?;
                let _ = self
                    .pending_selections
                    .lock()
                    .unwrap()
                    .clear(&self.registration.pubkey, channel_id);
                let _ = self.clear_session(channel_id);
                let response = format!(
                    "Bound this chat to project \"{}\". Send your next message to continue.",
                    selected.display_title()
                );
                self.client
                    .send_message(chat_id, &response, None, Some(message_id), thread_id)
                    .await?;
                return Ok(None);
            }

            self.send_project_selection_prompt(
                chat_id,
                message_id,
                thread_id,
                &pending_routes,
                true,
            )
            .await?;
            return Ok(None);
        }

        let bound_project = {
            self.channel_bindings
                .lock()
                .unwrap()
                .get_telegram(&self.registration.pubkey, channel_id)
                .map(|binding| binding.project_id.clone())
        };
        if let Some(project_id) = bound_project {
            if let Some(project) = self.project_by_id(&project_id) {
                return Ok(Some(project));
            }

            let _ = self
                .channel_bindings
                .lock()
                .unwrap()
                .clear_telegram(&self.registration.pubkey, channel_id);
            let _ = self.clear_session(channel_id);
        }

        match self.registration.projects.as_slice() {
            [] => Ok(None),
            [project] => {
                self.remember_channel_binding(channel_id, &project.project_id)?;
                Ok(Some(project.clone()))
            }
            projects => {
                let opts: Vec<PendingProjectOption> = projects
                    .iter()
                    .map(|p| PendingProjectOption {
                        project_id: p.project_id.clone(),
                        title: p.title.clone(),
                    })
                    .collect();
                let routes = projects.to_vec();
                self.send_project_selection_prompt(chat_id, message_id, thread_id, &routes, false)
                    .await?;
                self.pending_selections.lock().unwrap().set(
                    &self.registration.pubkey,
                    channel_id,
                    opts,
                )?;
                Ok(None)
            }
        }
    }

    fn project_by_id(&self, project_id: &str) -> Option<ProjectRoute> {
        self.registration
            .projects
            .iter()
            .find(|project| project.project_id == project_id)
            .cloned()
    }

    fn remember_channel_binding(&self, channel_id: &str, project_id: &str) -> Result<()> {
        self.channel_bindings.lock().unwrap().remember_telegram(
            &self.registration.pubkey,
            channel_id,
            project_id,
        )
    }

    async fn send_project_selection_prompt(
        &self,
        chat_id: &str,
        message_id: &str,
        thread_id: Option<&str>,
        projects: &[ProjectRoute],
        is_reminder: bool,
    ) -> Result<()> {
        let prompt = project_selection_prompt(projects, is_reminder);
        self.client
            .send_message(chat_id, &prompt, None, Some(message_id), thread_id)
            .await?;
        Ok(())
    }

    fn clear_session(&self, channel_id: &str) -> Result<()> {
        self.sessions.lock().unwrap().clear(channel_id)
    }

    fn session_root(&self, channel_id: &str) -> Option<String> {
        self.sessions
            .lock()
            .unwrap()
            .get(channel_id)
            .map(ToString::to_string)
    }

    fn set_session_root(&self, channel_id: String, event_id: String) -> Result<()> {
        self.sessions.lock().unwrap().set(channel_id, event_id)
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
                agent = %self.registration.pubkey,
                skipped = updates.len(),
                "skipped backlog"
            );
        }
        Ok(())
    }
}
