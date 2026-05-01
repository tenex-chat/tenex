use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use nostr_sdk::prelude::*;
use tokio::sync::Mutex;
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
    /// Per-poller session map. Owned directly because no other task accesses it.
    sessions: SessionStore,
    /// Shared across pollers — multiple bot tasks may write the same file.
    channel_bindings: Arc<Mutex<BindingStore>>,
    /// Shared across pollers — multiple bot tasks may write the same file.
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

        let sessions = SessionStore::open(session_path)?;

        Ok(Self {
            registration,
            client,
            backend_keys,
            base_dir,
            sessions,
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

        // A Telegram message can carry text, a photo (with optional caption),
        // a voice note, or an audio file. Bail only when there is nothing the
        // agent can act on.
        let text_str = msg
            .text
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let caption_str = msg
            .caption
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let largest_photo = msg
            .photo
            .as_ref()
            .and_then(|sizes| sizes.iter().max_by_key(|p| p.width * p.height))
            .cloned();

        if text_str.is_none()
            && caption_str.is_none()
            && largest_photo.is_none()
            && msg.voice.is_none()
            && msg.audio.is_none()
        {
            return Ok(());
        }

        // Effective user text. Caption (if any) substitutes for body when the
        // message has no body of its own; otherwise we pick a placeholder that
        // names what kind of media arrived so the conversation log reads
        // coherently.
        let placeholder = if largest_photo.is_some() {
            "[photo]"
        } else if msg.voice.is_some() {
            "[voice]"
        } else if msg.audio.is_some() {
            "[audio]"
        } else {
            ""
        };
        let text = text_str
            .clone()
            .or_else(|| caption_str.clone())
            .unwrap_or_else(|| placeholder.to_string());

        let is_new = text == "/new" || text.starts_with("/new ") || text.starts_with("/new@");
        if is_new {
            let _ = self.sessions.clear(&channel_id);
            let _ = self
                .pending_selections
                .lock()
                .await
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

        // Fetch any inbound media to the local cache. On failure we log and
        // dispatch with whatever made it through rather than dropping the turn.
        let image_urls: Vec<String> = if let Some(photo) = largest_photo.as_ref() {
            match self
                .cache_telegram_file(&photo.file_id, &photo.file_unique_id, "jpg")
                .await
            {
                Ok(path) => vec![format!("file://{}", path.display())],
                Err(error) => {
                    warn!(
                        error = %error,
                        file_id = %photo.file_id,
                        "failed to cache Telegram photo; dispatching text-only"
                    );
                    Vec::new()
                }
            }
        } else {
            Vec::new()
        };

        // Voice/audio: cache to disk and surface as a text annotation on the
        // user message. Multimodal LLMs can't consume audio directly; surfacing
        // the path lets the agent route the file to a transcription tool.
        let mut audio_annotations: Vec<String> = Vec::new();
        if let Some(voice) = msg.voice.as_ref() {
            let unique = voice.file_unique_id.as_deref().unwrap_or(&voice.file_id);
            match self
                .cache_telegram_file(&voice.file_id, unique, "ogg")
                .await
            {
                Ok(path) => audio_annotations.push(format!("[voice: file://{}]", path.display())),
                Err(error) => warn!(
                    error = %error,
                    file_id = %voice.file_id,
                    "failed to cache Telegram voice; dispatching without audio link"
                ),
            }
        }
        if let Some(audio) = msg.audio.as_ref() {
            let unique = audio.file_unique_id.as_deref().unwrap_or(&audio.file_id);
            match self
                .cache_telegram_file(&audio.file_id, unique, "mp3")
                .await
            {
                Ok(path) => audio_annotations.push(format!("[audio: file://{}]", path.display())),
                Err(error) => warn!(
                    error = %error,
                    file_id = %audio.file_id,
                    "failed to cache Telegram audio; dispatching without audio link"
                ),
            }
        }
        let text_with_audio = if audio_annotations.is_empty() {
            text.clone()
        } else {
            format!("{text} {}", audio_annotations.join(" "))
        };

        let synthesized = synthesize_telegram_event(TelegramEventInput {
            agent_pubkey: &self.registration.pubkey,
            project: &project,
            backend_keys: &self.backend_keys,
            root_event_id: self.sessions.get(&channel_id).map(ToString::to_string),
            sender_first_name: &sender.first_name,
            sender_username: sender.username.as_deref(),
            sender_id: sender.id,
            chat_id: &chat_id,
            message_id: &message_id,
            thread_id: thread_id.as_deref(),
            channel_id: &channel_id,
            text: &text_with_audio,
            image_urls: &image_urls,
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
                    let _ = self.sessions.set(channel_id, event_id);
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
            .await
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
                self.remember_channel_binding(channel_id, &selected.project_id)
                    .await?;
                let _ = self
                    .pending_selections
                    .lock()
                    .await
                    .clear(&self.registration.pubkey, channel_id);
                let _ = self.sessions.clear(channel_id);
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
                .await
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
                .await
                .clear_telegram(&self.registration.pubkey, channel_id);
            let _ = self.sessions.clear(channel_id);
        }

        match self.registration.projects.as_slice() {
            [] => Ok(None),
            [project] => {
                self.remember_channel_binding(channel_id, &project.project_id)
                    .await?;
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
                self.pending_selections.lock().await.set(
                    &self.registration.pubkey,
                    channel_id,
                    opts,
                )?;
                Ok(None)
            }
        }
    }

    /// Resolve a Telegram `file_id` via `getFile`, download its bytes, and
    /// cache them under `<base_dir>/data/telegram-media/<unique_id>.<ext>`.
    /// Returns the absolute path on disk; the caller wraps it in a `file://`
    /// URL. The extension is taken from the Telegram-reported `file_path` when
    /// present, falling back to `default_ext` (e.g. "jpg" for photos, "ogg"
    /// for voice). Re-uses the cached file when the same `unique_id` is
    /// delivered again.
    async fn cache_telegram_file(
        &self,
        file_id: &str,
        unique_id: &str,
        default_ext: &str,
    ) -> Result<PathBuf> {
        use anyhow::Context;
        let info = self.client.get_file(file_id).await?;
        let file_path = info.file_path.context("getFile returned no file_path")?;
        let ext = std::path::Path::new(&file_path)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or(default_ext);
        let cache_dir = self.base_dir.join("data").join("telegram-media");
        tokio::fs::create_dir_all(&cache_dir)
            .await
            .with_context(|| format!("create cache dir {}", cache_dir.display()))?;
        // Canonicalize so the emitted `file://` URL is absolute even when the
        // daemon was started with a relative `--base-dir` / `TENEX_BASE_DIR`.
        // The agent gates `file://` reads on an absolute prefix; without this,
        // photos cached under a relative base would be silently rejected.
        let cache_dir = cache_dir
            .canonicalize()
            .with_context(|| format!("canonicalize cache dir {}", cache_dir.display()))?;
        let dest = cache_dir.join(format!("{unique_id}.{ext}"));
        if !dest.exists() {
            let bytes = self.client.download_file_bytes(&file_path).await?;
            tokio::fs::write(&dest, &bytes)
                .await
                .with_context(|| format!("write {}", dest.display()))?;
        }
        Ok(dest)
    }

    fn project_by_id(&self, project_id: &str) -> Option<ProjectRoute> {
        self.registration
            .projects
            .iter()
            .find(|project| project.project_id == project_id)
            .cloned()
    }

    async fn remember_channel_binding(&self, channel_id: &str, project_id: &str) -> Result<()> {
        self.channel_bindings.lock().await.remember_telegram(
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
