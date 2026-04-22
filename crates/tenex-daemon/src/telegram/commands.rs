//! Rust-native handler for Telegram slash-commands and callback queries.
//!
//! The gateway long-poll loop delegates to this module for two update
//! shapes:
//!
//! 1. Messages whose `text` (or `caption`) starts with `/` — dispatched to
//!    a command handler by name.
//! 2. `callback_query` updates — dispatched to the active session's
//!    picker handler by the button's `callback_data`.
//!
//! Commands never become [`crate::inbound_envelope::InboundEnvelope`]s —
//! they're meta-UI, not agent conversation content.
//!
//! The command set:
//!
//! | command        | behavior                                                     |
//! | -------------- | ------------------------------------------------------------ |
//! | `/start <tok>` | consume a pending-binding token, persist chat → project link |
//! | `/model`       | open the LLM model picker                                    |
//! | `/config`, `/tools` | open the tool allowlist editor                          |
//! | `/new`         | acknowledge; reset conversation state for this chat          |
//!
//! Callback queries use the `tgcfg:<session-id>:<action>[:<index>]` data
//! format. Actions:
//!
//! - `cancel` / `next` / `prev` / `save`
//! - `sm:<index>` — select model
//! - `tt:<index>` — toggle tool
//!
//! Message/button text matches the TS oracle (`TelegramConfigCommandService`)
//! so operators see the same UX across the transition.

use std::io;
use std::path::Path;

use secp256k1::XOnlyPublicKey;
use serde_json::Value;
use thiserror::Error;

use crate::backend_events::heartbeat::BackendSigner;
use crate::nostr_event::{
    NormalizedNostrEvent, NostrEventError, SignedNostrEvent, canonical_payload, event_hash_hex,
};
use crate::project_status_sources::{ProjectStatusSourceError, read_global_llm_model_keys};
use crate::publish_outbox::{
    BackendPublishOutboxInput, PublishOutboxError, accept_backend_signed_publish_event,
};
use crate::telegram::bindings::{
    RuntimeTransport, TransportBindingReadError, TransportBindingWriteError,
    write_transport_binding,
};
use crate::telegram::client::{
    AnswerCallbackQueryParams, ChatId, EditMessageTextParams, InlineKeyboardButton,
    InlineKeyboardMarkup, SendMessageParams, TelegramClientError,
};
use crate::telegram::config_session_store::{
    ConfigSessionKind, ConfigSessionRecord, ConfigSessionError, DEFAULT_CONFIG_SESSION_TTL_MS,
    clear_session, find_session_by_id, save_session,
};
use crate::telegram::pending_binding_store::{
    DEFAULT_PENDING_BINDING_TTL_MS, PendingBindingError, take_pending,
};

/// Kind value for TENEX agent-config update events (matches the TS
/// `NDKKind.TenexAgentConfigUpdate` constant).
pub const TENEX_AGENT_CONFIG_UPDATE_KIND: u64 = 24020;
/// Callback-data prefix. Matches the TS `CALLBACK_PREFIX` constant so
/// operator muscle-memory stays intact.
pub const CALLBACK_PREFIX: &str = "tgcfg";
/// Page size for the paginated model / tools pickers. Matches TS.
pub const PAGE_SIZE: usize = 6;
/// Default client-tag attached to tagging the published agent-config
/// update event. Matches TS.
pub const CLIENT_TAG: &str = "tenex-telegram";

pub const TELEGRAM_NEW_CONVERSATION_SUCCESS_MESSAGE: &str =
    "Started a new conversation. Send your next message to begin fresh.";
pub const TELEGRAM_NEW_CONVERSATION_USAGE_MESSAGE: &str =
    "Telegram `/new` does not take arguments yet. Send `/new`, then your next message.";
pub const TELEGRAM_MODEL_USAGE_MESSAGE: &str =
    "Telegram `/model` does not take arguments yet. Use the buttons in the picker.";
pub const TELEGRAM_CONFIG_USAGE_MESSAGE: &str =
    "Telegram `/config` does not take arguments yet. Use the buttons in the picker.";

#[derive(Debug, Error)]
pub enum CommandError {
    #[error("telegram client error: {0}")]
    Client(#[from] TelegramClientError),
    #[error("config session error: {0}")]
    ConfigSession(#[from] ConfigSessionError),
    #[error("pending binding error: {0}")]
    PendingBinding(#[from] PendingBindingError),
    #[error("transport binding write error: {0}")]
    BindingWrite(#[from] TransportBindingWriteError),
    #[error("transport binding read error: {0}")]
    BindingRead(#[from] TransportBindingReadError),
    #[error("llm configuration read error: {0}")]
    Llms(#[from] ProjectStatusSourceError),
    #[error("publish outbox enqueue error: {0}")]
    PublishOutbox(#[from] PublishOutboxError),
    #[error("nostr event encoding error: {0}")]
    NostrEvent(#[from] NostrEventError),
    #[error("nostr signing error: {0}")]
    Signing(#[from] secp256k1::Error),
    #[error("io error: {0}")]
    Io(#[from] io::Error),
    #[error("invalid command arguments: {0}")]
    InvalidArguments(String),
}

/// Dispatch outcome reported back to the gateway.
#[derive(Debug)]
pub enum CommandDispatchResult {
    /// The command / callback was recognised; the gateway should stop
    /// processing this update.
    Handled,
    /// The message did not start with a recognised command; the gateway
    /// proceeds with normal inbound routing.
    NotACommand,
    /// The handler failed internally. The gateway logs and continues.
    Error(CommandError),
}

/// Client surface the commands module uses. Trait-based so tests can drive
/// it without an HTTP server. The production implementation is
/// [`crate::telegram::client::TelegramBotClient`].
pub trait CommandBotClient {
    fn send_message(
        &self,
        params: SendMessageParams,
    ) -> Result<crate::telegram::client::SentMessage, TelegramClientError>;

    fn edit_message_text(
        &self,
        params: EditMessageTextParams,
    ) -> Result<crate::telegram::client::SentMessage, TelegramClientError>;

    fn answer_callback_query(
        &self,
        params: AnswerCallbackQueryParams,
    ) -> Result<(), TelegramClientError>;
}

impl CommandBotClient for crate::telegram::client::TelegramBotClient {
    fn send_message(
        &self,
        params: SendMessageParams,
    ) -> Result<crate::telegram::client::SentMessage, TelegramClientError> {
        crate::telegram::client::TelegramBotClient::send_message(self, params)
    }

    fn edit_message_text(
        &self,
        params: EditMessageTextParams,
    ) -> Result<crate::telegram::client::SentMessage, TelegramClientError> {
        crate::telegram::client::TelegramBotClient::edit_message_text(self, params)
    }

    fn answer_callback_query(
        &self,
        params: AnswerCallbackQueryParams,
    ) -> Result<(), TelegramClientError> {
        crate::telegram::client::TelegramBotClient::answer_callback_query(self, params)
    }
}

/// Everything a command / callback handler needs. Constructed per update by
/// the gateway so commands remain stateless.
pub struct CommandContext<'a, C: CommandBotClient + ?Sized, S: BackendSigner + ?Sized> {
    pub daemon_dir: &'a Path,
    pub tenex_base_dir: &'a Path,
    pub data_dir: &'a Path,
    pub agent_pubkey: &'a str,
    pub agent_name: &'a str,
    pub bot_username: Option<&'a str>,
    pub client: &'a C,
    pub signer: &'a S,
    pub writer_version: &'a str,
    pub now_ms: u64,
    pub now_seconds: u64,
}

/// Dispatch the message half of the command surface. Returns
/// [`CommandDispatchResult::NotACommand`] when the message doesn't carry
/// a recognised slash-command.
pub fn dispatch_command<C, S>(
    ctx: &CommandContext<'_, C, S>,
    update: &Value,
) -> CommandDispatchResult
where
    C: CommandBotClient + ?Sized,
    S: BackendSigner + ?Sized,
{
    let Some(facts) = extract_message_facts(update) else {
        return CommandDispatchResult::NotACommand;
    };
    let Some(command) = parse_command_token(&facts.content, ctx.bot_username) else {
        return CommandDispatchResult::NotACommand;
    };

    let outcome = match command.name {
        CommandName::Start => handle_start(ctx, &facts, command.remainder),
        CommandName::Model => handle_config_menu(ctx, &facts, ConfigSessionKind::Model, command.remainder),
        CommandName::Config => handle_config_menu(ctx, &facts, ConfigSessionKind::Tools, command.remainder),
        CommandName::New => handle_new(ctx, &facts, command.remainder),
    };
    match outcome {
        Ok(()) => CommandDispatchResult::Handled,
        Err(error) => CommandDispatchResult::Error(error),
    }
}

/// Dispatch a callback-query update to the session owner.
pub fn dispatch_callback_query<C, S>(
    ctx: &CommandContext<'_, C, S>,
    update: &Value,
) -> CommandDispatchResult
where
    C: CommandBotClient + ?Sized,
    S: BackendSigner + ?Sized,
{
    let Some(callback) = update.get("callback_query").and_then(Value::as_object) else {
        return CommandDispatchResult::NotACommand;
    };
    let Some(id) = callback.get("id").and_then(Value::as_str) else {
        return CommandDispatchResult::NotACommand;
    };
    let data = callback.get("data").and_then(Value::as_str).unwrap_or_default();
    let Some((session_id, action)) = parse_callback_data(data) else {
        return CommandDispatchResult::NotACommand;
    };
    let sender_id = callback
        .get("from")
        .and_then(Value::as_object)
        .and_then(|from| from.get("id").and_then(Value::as_i64));

    let outcome = handle_callback(ctx, id, session_id.as_str(), &action, sender_id);
    match outcome {
        Ok(()) => CommandDispatchResult::Handled,
        Err(error) => CommandDispatchResult::Error(error),
    }
}

// -----------------------------------------------------------------------
// Message parsing
// -----------------------------------------------------------------------

#[derive(Debug)]
struct MessageFacts {
    chat_id: i64,
    chat_id_str: String,
    message_id: i64,
    message_thread_id: Option<i64>,
    sender_id: i64,
    content: String,
}

fn extract_message_facts(update: &Value) -> Option<MessageFacts> {
    let obj = update.as_object()?;
    let message = obj
        .get("message")
        .filter(|value| !value.is_null())
        .or_else(|| obj.get("edited_message").filter(|value| !value.is_null()))
        .and_then(Value::as_object)?;
    let from = message.get("from").and_then(Value::as_object)?;
    let sender_id = from.get("id").and_then(Value::as_i64)?;
    let is_bot = from.get("is_bot").and_then(Value::as_bool).unwrap_or(false);
    if is_bot {
        return None;
    }
    let chat = message.get("chat").and_then(Value::as_object)?;
    let chat_id = chat.get("id").and_then(Value::as_i64)?;
    let chat_type = chat.get("type").and_then(Value::as_str).unwrap_or("");
    if chat_type == "channel" {
        return None;
    }
    let message_id = message.get("message_id").and_then(Value::as_i64)?;
    let message_thread_id = message.get("message_thread_id").and_then(Value::as_i64);
    let raw = message
        .get("text")
        .and_then(Value::as_str)
        .or_else(|| message.get("caption").and_then(Value::as_str))
        .unwrap_or("")
        .trim()
        .to_string();
    if raw.is_empty() {
        return None;
    }
    Some(MessageFacts {
        chat_id,
        chat_id_str: chat_id.to_string(),
        message_id,
        message_thread_id,
        sender_id,
        content: raw,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CommandName {
    Start,
    Model,
    Config,
    New,
}

struct ParsedCommand<'a> {
    name: CommandName,
    remainder: &'a str,
}

fn parse_command_token<'a>(content: &'a str, bot_username: Option<&str>) -> Option<ParsedCommand<'a>> {
    if !content.starts_with('/') {
        return None;
    }
    // Split into `/command[@bot] <rest>`.
    let (head, remainder) = match content.find(char::is_whitespace) {
        Some(index) => (&content[..index], content[index..].trim_start()),
        None => (content, ""),
    };
    let head = head.strip_prefix('/')?;
    let (name_raw, username) = match head.split_once('@') {
        Some((name, username)) => (name, Some(username)),
        None => (head, None),
    };
    if let (Some(uname), Some(bot)) = (username, bot_username)
        && !uname.eq_ignore_ascii_case(bot)
    {
        return None;
    }
    let name_lower = name_raw.to_ascii_lowercase();
    let name = match name_lower.as_str() {
        "start" => CommandName::Start,
        "model" => CommandName::Model,
        // Accept both `/config` (TS oracle alias) and `/tools` (spec alias).
        "config" | "tools" => CommandName::Config,
        "new" => CommandName::New,
        _ => return None,
    };
    Some(ParsedCommand { name, remainder })
}

// -----------------------------------------------------------------------
// Callback parsing
// -----------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
enum CallbackAction {
    Cancel,
    Next,
    Previous,
    Save,
    SelectModel { index: usize },
    ToggleTool { index: usize },
}

fn parse_callback_data(data: &str) -> Option<(String, CallbackAction)> {
    if data.is_empty() {
        return None;
    }
    let mut parts = data.split(':');
    let prefix = parts.next()?;
    if prefix != CALLBACK_PREFIX {
        return None;
    }
    let session_id = parts.next()?.to_string();
    let action_token = parts.next()?;
    let index_token = parts.next();
    let action = match action_token {
        "cancel" => CallbackAction::Cancel,
        "next" => CallbackAction::Next,
        "prev" => CallbackAction::Previous,
        "save" => CallbackAction::Save,
        "sm" => {
            let index = index_token?.parse::<usize>().ok()?;
            CallbackAction::SelectModel { index }
        }
        "tt" => {
            let index = index_token?.parse::<usize>().ok()?;
            CallbackAction::ToggleTool { index }
        }
        _ => return None,
    };
    Some((session_id, action))
}

fn build_callback_data(session_id: &str, action: &str, index: Option<usize>) -> String {
    match index {
        Some(index) => format!("{CALLBACK_PREFIX}:{session_id}:{action}:{index}"),
        None => format!("{CALLBACK_PREFIX}:{session_id}:{action}"),
    }
}

// -----------------------------------------------------------------------
// Command handlers
// -----------------------------------------------------------------------

fn handle_new<C, S>(
    ctx: &CommandContext<'_, C, S>,
    facts: &MessageFacts,
    remainder: &str,
) -> Result<(), CommandError>
where
    C: CommandBotClient + ?Sized,
    S: BackendSigner + ?Sized,
{
    let text = if remainder.trim().is_empty() {
        // Clear any active picker: starting a new conversation discards any
        // in-flight configuration menu for the same chat.
        clear_session(ctx.daemon_dir, &facts.chat_id_str)?;
        TELEGRAM_NEW_CONVERSATION_SUCCESS_MESSAGE.to_string()
    } else {
        TELEGRAM_NEW_CONVERSATION_USAGE_MESSAGE.to_string()
    };
    reply_plain(ctx, facts, &text)?;
    Ok(())
}

fn handle_start<C, S>(
    ctx: &CommandContext<'_, C, S>,
    facts: &MessageFacts,
    remainder: &str,
) -> Result<(), CommandError>
where
    C: CommandBotClient + ?Sized,
    S: BackendSigner + ?Sized,
{
    let token = remainder.trim();
    if token.is_empty() {
        reply_plain(
            ctx,
            facts,
            "Usage: /start <token>. Generate a token from the TENEX CLI and paste it here.",
        )?;
        return Ok(());
    }

    let pending = take_pending(
        ctx.daemon_dir,
        ctx.writer_version,
        DEFAULT_PENDING_BINDING_TTL_MS,
        ctx.now_ms,
        token,
    )?;
    let Some(pending) = pending else {
        reply_plain(
            ctx,
            facts,
            "That token is unknown or has expired. Generate a new one and try again.",
        )?;
        return Ok(());
    };

    if pending.agent_pubkey != ctx.agent_pubkey {
        reply_plain(
            ctx,
            facts,
            "That token belongs to a different agent. Generate a new token from the agent that owns this chat.",
        )?;
        return Ok(());
    }

    let channel_id =
        create_telegram_channel_id(&facts.chat_id_str, facts.message_thread_id);
    write_transport_binding(
        ctx.data_dir,
        RuntimeTransport::Telegram,
        &pending.agent_pubkey,
        &channel_id,
        &pending.project_id,
        ctx.now_ms,
    )?;

    let project_label = pending
        .project_title
        .as_deref()
        .unwrap_or(pending.project_id.as_str());
    let text = format!("Bound this chat to project {project_label}.");
    reply_plain(ctx, facts, &text)?;
    Ok(())
}

fn handle_config_menu<C, S>(
    ctx: &CommandContext<'_, C, S>,
    facts: &MessageFacts,
    kind: ConfigSessionKind,
    remainder: &str,
) -> Result<(), CommandError>
where
    C: CommandBotClient + ?Sized,
    S: BackendSigner + ?Sized,
{
    if !remainder.trim().is_empty() {
        let text = match kind {
            ConfigSessionKind::Model => TELEGRAM_MODEL_USAGE_MESSAGE,
            ConfigSessionKind::Tools => TELEGRAM_CONFIG_USAGE_MESSAGE,
        };
        reply_plain(ctx, facts, text)?;
        return Ok(());
    }

    let Some(binding_project) = resolve_project_binding(ctx, facts)? else {
        reply_plain(
            ctx,
            facts,
            "This chat is not bound to a project yet. Run /start <token> first.",
        )?;
        return Ok(());
    };

    let available_models = read_global_llm_model_keys(ctx.tenex_base_dir)?;
    let available_tools = available_project_tools(ctx.tenex_base_dir, &binding_project.project_id);
    let current_agent = load_current_agent_snapshot(
        ctx.tenex_base_dir,
        ctx.agent_pubkey,
        &binding_project.project_id,
    )?;

    let (list, empty_text) = match kind {
        ConfigSessionKind::Model => (
            available_models.clone(),
            "No models are available for this project.",
        ),
        ConfigSessionKind::Tools => (
            available_tools.clone(),
            "No configurable tools are available for this project.",
        ),
    };
    if list.is_empty() {
        reply_plain(ctx, facts, empty_text)?;
        return Ok(());
    }

    let session_id = new_session_id(ctx.now_ms);
    let selected_tools: Vec<String> = available_tools
        .iter()
        .filter(|tool| current_agent.tools.iter().any(|t| t == *tool))
        .cloned()
        .collect();
    let mut session = ConfigSessionRecord {
        id: session_id,
        kind,
        chat_id: facts.chat_id_str.clone(),
        message_thread_id: facts.message_thread_id.map(|id| id.to_string()),
        channel_id: create_telegram_channel_id(&facts.chat_id_str, facts.message_thread_id),
        message_id: None,
        agent_pubkey: ctx.agent_pubkey.to_string(),
        agent_name: ctx.agent_name.to_string(),
        principal_id: format!("telegram:user:{}", facts.sender_id),
        project_id: binding_project.project_id.clone(),
        project_title: binding_project.project_id.clone(),
        project_binding: binding_project.project_binding.clone(),
        current_page: 0,
        available_models,
        available_tools,
        selected_model: current_agent.model.unwrap_or_else(String::new),
        selected_tools,
    };

    let rendered = render_session(&session);
    let sent = ctx.client.send_message(SendMessageParams {
        chat_id: ChatId::Numeric(facts.chat_id),
        text: rendered.text,
        parse_mode: None,
        reply_to_message_id: Some(facts.message_id),
        message_thread_id: facts.message_thread_id,
        disable_link_preview: true,
        reply_markup: Some(rendered.reply_markup),
    })?;
    session.message_id = Some(sent.message_id);
    save_session(ctx.daemon_dir, ctx.writer_version, ctx.now_ms, session)?;
    Ok(())
}

fn handle_callback<C, S>(
    ctx: &CommandContext<'_, C, S>,
    callback_query_id: &str,
    session_id: &str,
    action: &CallbackAction,
    sender_id: Option<i64>,
) -> Result<(), CommandError>
where
    C: CommandBotClient + ?Sized,
    S: BackendSigner + ?Sized,
{
    let Some(mut session) = find_session_by_id(
        ctx.daemon_dir,
        session_id,
        DEFAULT_CONFIG_SESSION_TTL_MS,
        ctx.now_ms,
    )?
    else {
        ctx.client.answer_callback_query(AnswerCallbackQueryParams {
            callback_query_id: callback_query_id.to_string(),
            text: Some("This config menu expired. Run the command again.".to_string()),
            show_alert: true,
        })?;
        return Ok(());
    };

    if let Some(sender) = sender_id
        && format!("telegram:user:{sender}") != session.principal_id
    {
        ctx.client.answer_callback_query(AnswerCallbackQueryParams {
            callback_query_id: callback_query_id.to_string(),
            text: Some("Only the user who opened this menu can use it.".to_string()),
            show_alert: true,
        })?;
        return Ok(());
    }

    match action {
        CallbackAction::Cancel => {
            clear_session(ctx.daemon_dir, &session.chat_id)?;
            ctx.client.answer_callback_query(AnswerCallbackQueryParams {
                callback_query_id: callback_query_id.to_string(),
                text: Some("Cancelled".to_string()),
                show_alert: false,
            })?;
            edit_terminal(ctx, &session, "Configuration menu cancelled.")?;
        }
        CallbackAction::Next | CallbackAction::Previous => {
            let delta: i64 = if matches!(action, CallbackAction::Next) {
                1
            } else {
                -1
            };
            let list_len = match session.kind {
                ConfigSessionKind::Model => session.available_models.len(),
                ConfigSessionKind::Tools => session.available_tools.len(),
            };
            let max_page = list_len.div_ceil(PAGE_SIZE).saturating_sub(1) as i64;
            let next_page = (session.current_page as i64 + delta).clamp(0, max_page.max(0));
            session.current_page = next_page as u32;
            save_session(ctx.daemon_dir, ctx.writer_version, ctx.now_ms, session.clone())?;
            ctx.client.answer_callback_query(AnswerCallbackQueryParams {
                callback_query_id: callback_query_id.to_string(),
                text: None,
                show_alert: false,
            })?;
            edit_session(ctx, &session)?;
        }
        CallbackAction::SelectModel { index } => {
            let Some(next_model) = session.available_models.get(*index).cloned() else {
                ctx.client.answer_callback_query(AnswerCallbackQueryParams {
                    callback_query_id: callback_query_id.to_string(),
                    text: Some("That model is no longer available.".to_string()),
                    show_alert: true,
                })?;
                return Ok(());
            };
            publish_agent_config_update(
                ctx,
                &session.project_binding,
                &session.agent_pubkey,
                &next_model,
                &session.selected_tools,
            )?;
            clear_session(ctx.daemon_dir, &session.chat_id)?;
            ctx.client.answer_callback_query(AnswerCallbackQueryParams {
                callback_query_id: callback_query_id.to_string(),
                text: Some(format!("Applied model: {next_model}")),
                show_alert: false,
            })?;
            let text = format!(
                "Updated {}.\nModel: {}\nTools: {}",
                session.agent_name,
                next_model,
                summarize_tools(&session.selected_tools)
            );
            edit_terminal(ctx, &session, &text)?;
        }
        CallbackAction::ToggleTool { index } => {
            let Some(tool_name) = session.available_tools.get(*index).cloned() else {
                ctx.client.answer_callback_query(AnswerCallbackQueryParams {
                    callback_query_id: callback_query_id.to_string(),
                    text: Some("That tool is no longer available.".to_string()),
                    show_alert: true,
                })?;
                return Ok(());
            };
            let currently_selected = session.selected_tools.iter().any(|t| *t == tool_name);
            let mut next_set: Vec<String> = session
                .selected_tools
                .iter()
                .filter(|existing| **existing != tool_name)
                .cloned()
                .collect();
            if !currently_selected {
                next_set.push(tool_name.clone());
            }
            // Re-order to match availability list order (matches TS).
            session.selected_tools = session
                .available_tools
                .iter()
                .filter(|available| next_set.iter().any(|entry| entry == *available))
                .cloned()
                .collect();
            save_session(ctx.daemon_dir, ctx.writer_version, ctx.now_ms, session.clone())?;
            let is_enabled_now = session.selected_tools.iter().any(|t| *t == tool_name);
            let toast = if is_enabled_now {
                format!("Enabled {tool_name}")
            } else {
                format!("Disabled {tool_name}")
            };
            ctx.client.answer_callback_query(AnswerCallbackQueryParams {
                callback_query_id: callback_query_id.to_string(),
                text: Some(toast),
                show_alert: false,
            })?;
            edit_session(ctx, &session)?;
        }
        CallbackAction::Save => {
            publish_agent_config_update(
                ctx,
                &session.project_binding,
                &session.agent_pubkey,
                &session.selected_model,
                &session.selected_tools,
            )?;
            clear_session(ctx.daemon_dir, &session.chat_id)?;
            ctx.client.answer_callback_query(AnswerCallbackQueryParams {
                callback_query_id: callback_query_id.to_string(),
                text: Some("Saved".to_string()),
                show_alert: false,
            })?;
            let text = format!(
                "Updated {}.\nModel: {}\nTools: {}",
                session.agent_name,
                session.selected_model,
                summarize_tools(&session.selected_tools)
            );
            edit_terminal(ctx, &session, &text)?;
        }
    }
    Ok(())
}

// -----------------------------------------------------------------------
// Rendering (TS oracle behaviour)
// -----------------------------------------------------------------------

struct RenderedSession {
    text: String,
    reply_markup: InlineKeyboardMarkup,
}

fn render_session(session: &ConfigSessionRecord) -> RenderedSession {
    match session.kind {
        ConfigSessionKind::Model => render_model_menu(session),
        ConfigSessionKind::Tools => render_tools_menu(session),
    }
}

fn render_model_menu(session: &ConfigSessionRecord) -> RenderedSession {
    let start = (session.current_page as usize) * PAGE_SIZE;
    let end = (start + PAGE_SIZE).min(session.available_models.len());
    let mut rows: Vec<Vec<InlineKeyboardButton>> = Vec::new();
    for (offset, model_name) in session.available_models[start..end].iter().enumerate() {
        let text = if *model_name == session.selected_model {
            format!("• {model_name}")
        } else {
            model_name.clone()
        };
        rows.push(vec![InlineKeyboardButton {
            text,
            callback_data: Some(build_callback_data(&session.id, "sm", Some(start + offset))),
        }]);
    }
    let pagination = build_page_buttons(session, session.available_models.len());
    if !pagination.is_empty() {
        rows.push(pagination);
    }
    rows.push(vec![InlineKeyboardButton {
        text: "Cancel".to_string(),
        callback_data: Some(build_callback_data(&session.id, "cancel", None)),
    }]);

    let total_pages = session.available_models.len().div_ceil(PAGE_SIZE).max(1);
    let text = format!(
        "Model picker for {}\nCurrent model: {}\nPage {} of {}\n\nTap a model to apply it immediately.",
        session.agent_name,
        session.selected_model,
        session.current_page + 1,
        total_pages
    );
    RenderedSession {
        text,
        reply_markup: InlineKeyboardMarkup {
            inline_keyboard: rows,
        },
    }
}

fn render_tools_menu(session: &ConfigSessionRecord) -> RenderedSession {
    let start = (session.current_page as usize) * PAGE_SIZE;
    let end = (start + PAGE_SIZE).min(session.available_tools.len());
    let mut rows: Vec<Vec<InlineKeyboardButton>> = Vec::new();
    for (offset, tool_name) in session.available_tools[start..end].iter().enumerate() {
        let enabled = session.selected_tools.iter().any(|t| t == tool_name);
        let marker = if enabled { "[x]" } else { "[ ]" };
        rows.push(vec![InlineKeyboardButton {
            text: format!("{marker} {tool_name}"),
            callback_data: Some(build_callback_data(&session.id, "tt", Some(start + offset))),
        }]);
    }
    let pagination = build_page_buttons(session, session.available_tools.len());
    if !pagination.is_empty() {
        rows.push(pagination);
    }
    rows.push(vec![
        InlineKeyboardButton {
            text: "Save".to_string(),
            callback_data: Some(build_callback_data(&session.id, "save", None)),
        },
        InlineKeyboardButton {
            text: "Cancel".to_string(),
            callback_data: Some(build_callback_data(&session.id, "cancel", None)),
        },
    ]);
    let total_pages = session.available_tools.len().div_ceil(PAGE_SIZE).max(1);
    let text = format!(
        "Tool picker for {}\nCurrent model: {}\nSelected tools: {}\nPage {} of {}\n\nToggle tools, then tap Save.",
        session.agent_name,
        session.selected_model,
        session.selected_tools.len(),
        session.current_page + 1,
        total_pages
    );
    RenderedSession {
        text,
        reply_markup: InlineKeyboardMarkup {
            inline_keyboard: rows,
        },
    }
}

fn build_page_buttons(
    session: &ConfigSessionRecord,
    item_count: usize,
) -> Vec<InlineKeyboardButton> {
    let mut buttons = Vec::new();
    let max_page = item_count.div_ceil(PAGE_SIZE).saturating_sub(1);
    if session.current_page > 0 {
        buttons.push(InlineKeyboardButton {
            text: "Prev".to_string(),
            callback_data: Some(build_callback_data(&session.id, "prev", None)),
        });
    }
    if (session.current_page as usize) < max_page {
        buttons.push(InlineKeyboardButton {
            text: "Next".to_string(),
            callback_data: Some(build_callback_data(&session.id, "next", None)),
        });
    }
    buttons
}

fn summarize_tools(tools: &[String]) -> String {
    if tools.is_empty() {
        return "no configurable tools".to_string();
    }
    if tools.len() <= 5 {
        return tools.join(", ");
    }
    format!(
        "{} (+{} more)",
        tools.iter().take(5).cloned().collect::<Vec<_>>().join(", "),
        tools.len() - 5
    )
}

// -----------------------------------------------------------------------
// Supporting helpers
// -----------------------------------------------------------------------

fn reply_plain<C, S>(
    ctx: &CommandContext<'_, C, S>,
    facts: &MessageFacts,
    text: &str,
) -> Result<(), CommandError>
where
    C: CommandBotClient + ?Sized,
    S: BackendSigner + ?Sized,
{
    ctx.client.send_message(SendMessageParams {
        chat_id: ChatId::Numeric(facts.chat_id),
        text: text.to_string(),
        parse_mode: None,
        reply_to_message_id: Some(facts.message_id),
        message_thread_id: facts.message_thread_id,
        disable_link_preview: true,
        reply_markup: None,
    })?;
    Ok(())
}

fn edit_session<C, S>(
    ctx: &CommandContext<'_, C, S>,
    session: &ConfigSessionRecord,
) -> Result<(), CommandError>
where
    C: CommandBotClient + ?Sized,
    S: BackendSigner + ?Sized,
{
    let Some(message_id) = session.message_id else {
        return Ok(());
    };
    let rendered = render_session(session);
    ctx.client.edit_message_text(EditMessageTextParams {
        chat_id: chat_id_from_session(session)?,
        message_id,
        text: rendered.text,
        parse_mode: None,
        reply_markup: Some(rendered.reply_markup),
    })?;
    Ok(())
}

fn edit_terminal<C, S>(
    ctx: &CommandContext<'_, C, S>,
    session: &ConfigSessionRecord,
    text: &str,
) -> Result<(), CommandError>
where
    C: CommandBotClient + ?Sized,
    S: BackendSigner + ?Sized,
{
    let Some(message_id) = session.message_id else {
        return Ok(());
    };
    ctx.client.edit_message_text(EditMessageTextParams {
        chat_id: chat_id_from_session(session)?,
        message_id,
        text: text.to_string(),
        parse_mode: None,
        reply_markup: None,
    })?;
    Ok(())
}

fn chat_id_from_session(session: &ConfigSessionRecord) -> Result<ChatId, CommandError> {
    let numeric = session.chat_id.parse::<i64>().map_err(|source| {
        CommandError::InvalidArguments(format!(
            "session chat id {:?} is not numeric: {}",
            session.chat_id, source
        ))
    })?;
    Ok(ChatId::Numeric(numeric))
}

fn create_telegram_channel_id(chat_id: &str, thread_id: Option<i64>) -> String {
    match thread_id {
        Some(thread_id) => format!("telegram:group:{chat_id}:topic:{thread_id}"),
        None => format!("telegram:chat:{chat_id}"),
    }
}

fn new_session_id(now_ms: u64) -> String {
    // 8 chars of base32-alphabet from a hash of `now_ms` + pid. Good enough
    // for callback-data uniqueness; the session file keys on chat_id, so
    // collisions would have to happen inside a single chat inside 1 ms —
    // not a concern.
    let pid = std::process::id();
    let input = format!("{now_ms}:{pid}");
    let mut digest: u64 = 1469598103934665603;
    for byte in input.bytes() {
        digest ^= u64::from(byte);
        digest = digest.wrapping_mul(1099511628211);
    }
    let charset = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut out = String::with_capacity(8);
    for _ in 0..8 {
        let index = (digest & 0x1f) as usize;
        out.push(charset[index] as char);
        digest >>= 5;
    }
    out
}

#[derive(Debug, Clone)]
struct ProjectBinding {
    project_id: String,
    project_binding: String,
}

fn resolve_project_binding<C, S>(
    ctx: &CommandContext<'_, C, S>,
    facts: &MessageFacts,
) -> Result<Option<ProjectBinding>, CommandError>
where
    C: CommandBotClient + ?Sized,
    S: BackendSigner + ?Sized,
{
    use crate::telegram::bindings::{find_binding, read_transport_bindings};
    let bindings = read_transport_bindings(ctx.data_dir)?;
    let channel_id = create_telegram_channel_id(&facts.chat_id_str, facts.message_thread_id);
    let Some(binding) = find_binding(
        &bindings,
        ctx.agent_pubkey,
        &channel_id,
        RuntimeTransport::Telegram,
    ) else {
        return Ok(None);
    };
    let project_binding = build_project_binding_reference(ctx.tenex_base_dir, &binding.project_id)?;
    Ok(Some(ProjectBinding {
        project_id: binding.project_id.clone(),
        project_binding,
    }))
}

/// Build the `kind:pubkey:d-tag` reference used in the `a` tag on published
/// agent-config update events. Reads the project descriptor to recover the
/// project owner pubkey (the NIP-33 addressable event author).
fn build_project_binding_reference(
    tenex_base_dir: &Path,
    project_d_tag: &str,
) -> Result<String, CommandError> {
    let path = tenex_base_dir
        .join("projects")
        .join(project_d_tag)
        .join("project.json");
    let content = std::fs::read_to_string(&path).map_err(|source| {
        CommandError::InvalidArguments(format!(
            "project descriptor {:?} could not be read: {source}",
            path
        ))
    })?;
    let value: Value = serde_json::from_str(&content).map_err(|source| {
        CommandError::InvalidArguments(format!(
            "project descriptor {:?} is not valid JSON: {source}",
            path
        ))
    })?;
    let owner = value
        .get("projectOwnerPubkey")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            CommandError::InvalidArguments(format!(
                "project descriptor {:?} is missing projectOwnerPubkey",
                path
            ))
        })?;
    Ok(format!("31933:{owner}:{project_d_tag}"))
}

#[derive(Debug, Clone)]
struct AgentSnapshot {
    model: Option<String>,
    tools: Vec<String>,
}

fn load_current_agent_snapshot(
    tenex_base_dir: &Path,
    agent_pubkey: &str,
    project_d_tag: &str,
) -> Result<AgentSnapshot, CommandError> {
    let path = tenex_base_dir
        .join("agents")
        .join(format!("{agent_pubkey}.json"));
    let content = match std::fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(AgentSnapshot {
                model: None,
                tools: Vec::new(),
            });
        }
        Err(source) => return Err(CommandError::Io(source)),
    };
    let value: Value = serde_json::from_str(&content).map_err(|source| {
        CommandError::InvalidArguments(format!(
            "agent descriptor {path:?} is not valid JSON: {source}"
        ))
    })?;
    let default_model = value
        .get("default")
        .and_then(|v| v.get("model"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let default_tools = value
        .get("default")
        .and_then(|v| v.get("tools"))
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let project_override = value
        .get("projectOverrides")
        .and_then(|v| v.get(project_d_tag));
    let model = project_override
        .and_then(|config| config.get("model").and_then(Value::as_str).map(str::to_string))
        .or(default_model);
    let tools = match project_override.and_then(|config| config.get("tools").and_then(Value::as_array)) {
        Some(values) => values
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
        None => default_tools,
    };
    Ok(AgentSnapshot { model, tools })
}

fn available_project_tools(tenex_base_dir: &Path, project_d_tag: &str) -> Vec<String> {
    use crate::project_status_agent_sources::read_project_status_agent_sources;
    match read_project_status_agent_sources(tenex_base_dir, project_d_tag) {
        Ok(report) => {
            let mut tools: Vec<String> = report.tools.into_iter().map(|t| t.name).collect();
            tools.sort();
            tools.dedup();
            tools
        }
        Err(_) => Vec::new(),
    }
}

fn publish_agent_config_update<C, S>(
    ctx: &CommandContext<'_, C, S>,
    project_binding: &str,
    agent_pubkey: &str,
    model: &str,
    tools: &[String],
) -> Result<(), CommandError>
where
    C: CommandBotClient + ?Sized,
    S: BackendSigner + ?Sized,
{
    let event = encode_agent_config_update(
        ctx.signer,
        ctx.now_seconds,
        project_binding,
        agent_pubkey,
        model,
        tools,
    )?;
    let input = BackendPublishOutboxInput {
        request_id: format!("telegram-config-{}-{}", agent_pubkey, ctx.now_ms),
        request_sequence: ctx.now_ms,
        request_timestamp: ctx.now_ms,
        correlation_id: format!("telegram-config-{}", ctx.now_ms),
        project_id: extract_project_d_tag(project_binding)
            .unwrap_or_else(|| project_binding.to_string()),
        conversation_id: format!("telegram-config-{}", ctx.now_ms),
        publisher_pubkey: ctx.signer.xonly_pubkey_hex(),
        ral_number: 0,
        wait_for_relay_ok: false,
        timeout_ms: 15_000,
        event,
    };
    accept_backend_signed_publish_event(ctx.daemon_dir, input, ctx.now_ms)?;
    Ok(())
}

fn extract_project_d_tag(project_binding: &str) -> Option<String> {
    let mut parts = project_binding.splitn(3, ':');
    parts.next()?;
    parts.next()?;
    parts.next().map(str::to_string)
}

fn encode_agent_config_update<S: BackendSigner + ?Sized>(
    signer: &S,
    created_at_seconds: u64,
    project_binding: &str,
    agent_pubkey: &str,
    model: &str,
    tools: &[String],
) -> Result<SignedNostrEvent, CommandError> {
    // Defensive hex validation — matches heartbeat encoder's pattern.
    XOnlyPublicKey::from_str(agent_pubkey).map_err(|source| {
        CommandError::InvalidArguments(format!("agent pubkey must be x-only hex: {source}"))
    })?;
    let pubkey = signer.xonly_pubkey_hex();
    let mut tags: Vec<Vec<String>> = vec![
        vec!["a".to_string(), project_binding.to_string()],
        vec!["client".to_string(), CLIENT_TAG.to_string()],
        vec!["p".to_string(), agent_pubkey.to_string()],
        vec!["model".to_string(), model.to_string()],
    ];
    for tool in tools {
        tags.push(vec!["tool".to_string(), tool.clone()]);
    }
    let normalized = NormalizedNostrEvent {
        kind: TENEX_AGENT_CONFIG_UPDATE_KIND,
        content: String::new(),
        tags: tags.clone(),
        pubkey: Some(pubkey.clone()),
        created_at: Some(created_at_seconds),
    };
    let canonical = canonical_payload(&normalized)?;
    let id = event_hash_hex(&canonical);
    let digest: [u8; 32] = hex::decode(&id)
        .map_err(NostrEventError::from)?
        .try_into()
        .map_err(|bytes: Vec<u8>| NostrEventError::InvalidDigestLength {
            field: "event id",
            actual: bytes.len(),
        })?;
    let sig = signer.sign_schnorr(&digest)?;
    Ok(SignedNostrEvent {
        id,
        pubkey,
        created_at: created_at_seconds,
        kind: TENEX_AGENT_CONFIG_UPDATE_KIND,
        tags,
        content: String::new(),
        sig,
    })
}

use std::str::FromStr;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::telegram::client::SentChat;
    use crate::telegram::pending_binding_store::{
        PendingBindingRecord, remember_pending,
    };
    use secp256k1::{Keypair, Secp256k1, SecretKey, Signing};
    use serde_json::json;
    use std::cell::RefCell;
    use std::fs;
    use tempfile::{TempDir, tempdir};

    const TEST_SECRET_KEY_HEX: &str =
        "0101010101010101010101010101010101010101010101010101010101010101";

    struct TestSigner<C: Signing> {
        secp: Secp256k1<C>,
        keypair: Keypair,
        xonly_hex: String,
    }

    impl<C: Signing> TestSigner<C> {
        fn new(secp: Secp256k1<C>) -> Self {
            let secret = SecretKey::from_str(TEST_SECRET_KEY_HEX).unwrap();
            let keypair = Keypair::from_secret_key(&secp, &secret);
            let (xonly, _) = keypair.x_only_public_key();
            Self {
                secp,
                keypair,
                xonly_hex: hex::encode(xonly.serialize()),
            }
        }
    }

    impl<C: Signing> BackendSigner for TestSigner<C> {
        fn xonly_pubkey_hex(&self) -> String {
            self.xonly_hex.clone()
        }
        fn sign_schnorr(&self, digest: &[u8; 32]) -> Result<String, secp256k1::Error> {
            let sig = self
                .secp
                .sign_schnorr_no_aux_rand(digest.as_slice(), &self.keypair);
            Ok(hex::encode(sig.to_byte_array()))
        }
    }

    #[derive(Debug, Clone)]
    struct SendCall {
        params: SendMessageParams,
    }
    #[derive(Debug, Clone)]
    struct EditCall {
        params: EditMessageTextParams,
    }
    #[derive(Debug, Clone)]
    struct AnswerCall {
        params: AnswerCallbackQueryParams,
    }

    #[derive(Default)]
    struct RecordingClient {
        next_message_id: RefCell<i64>,
        sends: RefCell<Vec<SendCall>>,
        edits: RefCell<Vec<EditCall>>,
        answers: RefCell<Vec<AnswerCall>>,
    }

    impl RecordingClient {
        fn new() -> Self {
            let c = RecordingClient::default();
            *c.next_message_id.borrow_mut() = 100;
            c
        }
    }

    impl CommandBotClient for RecordingClient {
        fn send_message(
            &self,
            params: SendMessageParams,
        ) -> Result<crate::telegram::client::SentMessage, TelegramClientError> {
            let message_id = {
                let mut counter = self.next_message_id.borrow_mut();
                let value = *counter;
                *counter += 1;
                value
            };
            let chat_id = match &params.chat_id {
                ChatId::Numeric(id) => *id,
                ChatId::Username(_) => 0,
            };
            self.sends.borrow_mut().push(SendCall {
                params: params.clone(),
            });
            Ok(crate::telegram::client::SentMessage {
                message_id,
                chat: SentChat {
                    id: chat_id,
                    chat_type: "private".to_string(),
                    title: None,
                    username: None,
                },
                message_thread_id: params.message_thread_id,
                date: None,
                text: Some(params.text.clone()),
                caption: None,
            })
        }

        fn edit_message_text(
            &self,
            params: EditMessageTextParams,
        ) -> Result<crate::telegram::client::SentMessage, TelegramClientError> {
            let chat_id = match &params.chat_id {
                ChatId::Numeric(id) => *id,
                ChatId::Username(_) => 0,
            };
            let message_id = params.message_id;
            let text = params.text.clone();
            self.edits.borrow_mut().push(EditCall {
                params: params.clone(),
            });
            Ok(crate::telegram::client::SentMessage {
                message_id,
                chat: SentChat {
                    id: chat_id,
                    chat_type: "private".to_string(),
                    title: None,
                    username: None,
                },
                message_thread_id: None,
                date: None,
                text: Some(text),
                caption: None,
            })
        }

        fn answer_callback_query(
            &self,
            params: AnswerCallbackQueryParams,
        ) -> Result<(), TelegramClientError> {
            self.answers.borrow_mut().push(AnswerCall { params });
            Ok(())
        }
    }

    struct TestEnv {
        _tmp: TempDir,
        daemon_dir: std::path::PathBuf,
        tenex_base_dir: std::path::PathBuf,
        data_dir: std::path::PathBuf,
    }

    fn prepare_project_and_agent(agent_pubkey: &str, project_d_tag: &str, owner: &str) -> TestEnv {
        let tmp = tempdir().expect("tempdir");
        let daemon_dir = tmp.path().join("daemon");
        let tenex_base_dir = tmp.path().join("base");
        let data_dir = tmp.path().join("data");
        fs::create_dir_all(&daemon_dir).unwrap();
        fs::create_dir_all(&data_dir).unwrap();
        fs::create_dir_all(tenex_base_dir.join("projects").join(project_d_tag)).unwrap();
        fs::write(
            tenex_base_dir
                .join("projects")
                .join(project_d_tag)
                .join("project.json"),
            json!({
                "projectOwnerPubkey": owner,
                "projectDTag": project_d_tag,
                "projectBasePath": "/repo",
                "status": "active",
            })
            .to_string(),
        )
        .unwrap();
        fs::create_dir_all(tenex_base_dir.join("agents")).unwrap();
        fs::write(
            tenex_base_dir.join("agents").join("index.json"),
            json!({ "byProject": { project_d_tag: [agent_pubkey] } }).to_string(),
        )
        .unwrap();
        fs::write(
            tenex_base_dir
                .join("agents")
                .join(format!("{agent_pubkey}.json")),
            json!({
                "slug": "alpha",
                "status": "active",
                "default": {
                    "model": "model-a",
                    "tools": ["fs_read", "shell"],
                }
            })
            .to_string(),
        )
        .unwrap();
        fs::write(
            tenex_base_dir.join("llms.json"),
            json!({ "configurations": { "model-a": {}, "model-b": {} } }).to_string(),
        )
        .unwrap();
        TestEnv {
            _tmp: tmp,
            daemon_dir,
            tenex_base_dir,
            data_dir,
        }
    }

    fn pubkey_hex(fill: u8) -> String {
        let secret_bytes = [fill; 32];
        let secret = SecretKey::from_byte_array(secret_bytes).expect("valid secret");
        let secp = Secp256k1::new();
        let keypair = Keypair::from_secret_key(&secp, &secret);
        let (xonly, _) = keypair.x_only_public_key();
        hex::encode(xonly.serialize())
    }

    fn message_update(chat_id: i64, sender_id: i64, text: &str) -> Value {
        json!({
            "update_id": 1,
            "message": {
                "message_id": 10,
                "date": 1,
                "from": { "id": sender_id, "is_bot": false, "first_name": "Alice" },
                "chat": { "id": chat_id, "type": "private" },
                "text": text
            }
        })
    }

    fn callback_update(session_id: &str, action: &str, index: Option<usize>, sender_id: i64) -> Value {
        let data = match index {
            Some(i) => format!("{CALLBACK_PREFIX}:{session_id}:{action}:{i}"),
            None => format!("{CALLBACK_PREFIX}:{session_id}:{action}"),
        };
        json!({
            "update_id": 2,
            "callback_query": {
                "id": "cb-1",
                "from": { "id": sender_id, "is_bot": false, "first_name": "Alice" },
                "data": data,
            }
        })
    }

    #[test]
    fn parse_command_token_handles_bot_suffix_and_casing() {
        let parsed = parse_command_token("/MODEL@Tenex_Bot hi", Some("tenex_bot"))
            .expect("casing must match case-insensitively");
        assert_eq!(parsed.name, CommandName::Model);
        assert_eq!(parsed.remainder, "hi");

        assert!(parse_command_token("/model@other_bot", Some("tenex_bot")).is_none());
        assert!(parse_command_token("hello", None).is_none());
        assert_eq!(
            parse_command_token("/config", None).map(|p| p.name),
            Some(CommandName::Config)
        );
        assert_eq!(
            parse_command_token("/tools", None).map(|p| p.name),
            Some(CommandName::Config)
        );
        assert_eq!(
            parse_command_token("/start token-abc", None).map(|p| p.remainder),
            Some("token-abc")
        );
    }

    #[test]
    fn dispatch_command_ignores_non_command_text() {
        let env = prepare_project_and_agent(&pubkey_hex(0x02), "project-alpha", &pubkey_hex(0x01));
        let client = RecordingClient::new();
        let secp = Secp256k1::new();
        let signer = TestSigner::new(secp);
        let ctx = CommandContext {
            daemon_dir: &env.daemon_dir,
            tenex_base_dir: &env.tenex_base_dir,
            data_dir: &env.data_dir,
            agent_pubkey: &pubkey_hex(0x02),
            agent_name: "Alpha",
            bot_username: Some("tenex_bot"),
            client: &client,
            signer: &signer,
            writer_version: "test@0.1.0",
            now_ms: 1_000,
            now_seconds: 1,
        };
        let update = message_update(1001, 42, "hello not a command");
        let result = dispatch_command(&ctx, &update);
        assert!(matches!(result, CommandDispatchResult::NotACommand));
        assert!(client.sends.borrow().is_empty());
    }

    #[test]
    fn new_command_without_args_acks_with_success_message() {
        let env = prepare_project_and_agent(&pubkey_hex(0x02), "project-alpha", &pubkey_hex(0x01));
        let client = RecordingClient::new();
        let secp = Secp256k1::new();
        let signer = TestSigner::new(secp);
        let ctx = CommandContext {
            daemon_dir: &env.daemon_dir,
            tenex_base_dir: &env.tenex_base_dir,
            data_dir: &env.data_dir,
            agent_pubkey: &pubkey_hex(0x02),
            agent_name: "Alpha",
            bot_username: None,
            client: &client,
            signer: &signer,
            writer_version: "test@0.1.0",
            now_ms: 1_000,
            now_seconds: 1,
        };
        let update = message_update(1001, 42, "/new");
        let result = dispatch_command(&ctx, &update);
        assert!(matches!(result, CommandDispatchResult::Handled));
        let sends = client.sends.borrow();
        assert_eq!(sends.len(), 1);
        assert_eq!(sends[0].params.text, TELEGRAM_NEW_CONVERSATION_SUCCESS_MESSAGE);
    }

    #[test]
    fn new_command_with_args_returns_usage_message() {
        let env = prepare_project_and_agent(&pubkey_hex(0x02), "project-alpha", &pubkey_hex(0x01));
        let client = RecordingClient::new();
        let secp = Secp256k1::new();
        let signer = TestSigner::new(secp);
        let ctx = CommandContext {
            daemon_dir: &env.daemon_dir,
            tenex_base_dir: &env.tenex_base_dir,
            data_dir: &env.data_dir,
            agent_pubkey: &pubkey_hex(0x02),
            agent_name: "Alpha",
            bot_username: None,
            client: &client,
            signer: &signer,
            writer_version: "test@0.1.0",
            now_ms: 1_000,
            now_seconds: 1,
        };
        let update = message_update(1001, 42, "/new something");
        let _ = dispatch_command(&ctx, &update);
        let sends = client.sends.borrow();
        assert_eq!(sends.len(), 1);
        assert_eq!(sends[0].params.text, TELEGRAM_NEW_CONVERSATION_USAGE_MESSAGE);
    }

    #[test]
    fn start_with_valid_token_writes_transport_binding() {
        let agent = pubkey_hex(0x02);
        let owner = pubkey_hex(0x01);
        let env = prepare_project_and_agent(&agent, "project-alpha", &owner);
        remember_pending(
            &env.daemon_dir,
            "test@0.1.0",
            DEFAULT_PENDING_BINDING_TTL_MS,
            1_000,
            PendingBindingRecord {
                token: "tok-42".to_string(),
                agent_pubkey: agent.clone(),
                project_id: "project-alpha".to_string(),
                project_title: Some("Project Alpha".to_string()),
                requested_at: 1_000,
            },
        )
        .expect("seed pending");
        let client = RecordingClient::new();
        let secp = Secp256k1::new();
        let signer = TestSigner::new(secp);
        let ctx = CommandContext {
            daemon_dir: &env.daemon_dir,
            tenex_base_dir: &env.tenex_base_dir,
            data_dir: &env.data_dir,
            agent_pubkey: &agent,
            agent_name: "Alpha",
            bot_username: None,
            client: &client,
            signer: &signer,
            writer_version: "test@0.1.0",
            now_ms: 1_500,
            now_seconds: 1,
        };
        let update = message_update(1001, 42, "/start tok-42");
        let result = dispatch_command(&ctx, &update);
        assert!(matches!(result, CommandDispatchResult::Handled));
        assert!(
            client.sends.borrow()[0]
                .params
                .text
                .starts_with("Bound this chat")
        );

        let bindings = crate::telegram::bindings::read_transport_bindings(&env.data_dir)
            .expect("read bindings");
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].channel_id, "telegram:chat:1001");
        assert_eq!(bindings[0].project_id, "project-alpha");
        assert_eq!(bindings[0].transport, RuntimeTransport::Telegram);

        // Token is consumed: a second /start should tell the user the token is unknown.
        let second = dispatch_command(&ctx, &update);
        assert!(matches!(second, CommandDispatchResult::Handled));
        let latest = {
            let sends = client.sends.borrow();
            sends[sends.len() - 1].params.text.clone()
        };
        assert!(latest.contains("unknown") || latest.contains("expired"));
    }

    #[test]
    fn start_rejects_unknown_token() {
        let agent = pubkey_hex(0x02);
        let owner = pubkey_hex(0x01);
        let env = prepare_project_and_agent(&agent, "project-alpha", &owner);
        let client = RecordingClient::new();
        let secp = Secp256k1::new();
        let signer = TestSigner::new(secp);
        let ctx = CommandContext {
            daemon_dir: &env.daemon_dir,
            tenex_base_dir: &env.tenex_base_dir,
            data_dir: &env.data_dir,
            agent_pubkey: &agent,
            agent_name: "Alpha",
            bot_username: None,
            client: &client,
            signer: &signer,
            writer_version: "test@0.1.0",
            now_ms: 1_500,
            now_seconds: 1,
        };
        let update = message_update(1001, 42, "/start bogus");
        let _ = dispatch_command(&ctx, &update);
        let sends = client.sends.borrow();
        assert!(
            sends[0].params.text.contains("unknown") || sends[0].params.text.contains("expired")
        );
    }

    fn with_project_binding(env: &TestEnv, agent: &str, project_d_tag: &str) {
        write_transport_binding(
            &env.data_dir,
            RuntimeTransport::Telegram,
            agent,
            "telegram:chat:1001",
            project_d_tag,
            1_000,
        )
        .unwrap();
    }

    #[test]
    fn model_command_opens_picker_with_buttons_for_each_model() {
        let agent = pubkey_hex(0x02);
        let owner = pubkey_hex(0x01);
        let env = prepare_project_and_agent(&agent, "project-alpha", &owner);
        with_project_binding(&env, &agent, "project-alpha");
        let client = RecordingClient::new();
        let secp = Secp256k1::new();
        let signer = TestSigner::new(secp);
        let ctx = CommandContext {
            daemon_dir: &env.daemon_dir,
            tenex_base_dir: &env.tenex_base_dir,
            data_dir: &env.data_dir,
            agent_pubkey: &agent,
            agent_name: "Alpha",
            bot_username: None,
            client: &client,
            signer: &signer,
            writer_version: "test@0.1.0",
            now_ms: 1_500,
            now_seconds: 1,
        };
        let update = message_update(1001, 42, "/model");
        let result = dispatch_command(&ctx, &update);
        assert!(matches!(result, CommandDispatchResult::Handled));
        let sends = client.sends.borrow();
        assert_eq!(sends.len(), 1);
        let markup = sends[0].params.reply_markup.as_ref().expect("reply markup");
        assert!(markup.inline_keyboard.len() >= 2);
        assert!(sends[0].params.text.contains("Model picker for Alpha"));
        // Selected-model marker is rendered.
        let first_row_text = &markup.inline_keyboard[0][0].text;
        assert!(first_row_text.starts_with("• "));
    }

    #[test]
    fn model_command_reports_when_chat_is_unbound() {
        let agent = pubkey_hex(0x02);
        let owner = pubkey_hex(0x01);
        let env = prepare_project_and_agent(&agent, "project-alpha", &owner);
        // no transport binding written
        let client = RecordingClient::new();
        let secp = Secp256k1::new();
        let signer = TestSigner::new(secp);
        let ctx = CommandContext {
            daemon_dir: &env.daemon_dir,
            tenex_base_dir: &env.tenex_base_dir,
            data_dir: &env.data_dir,
            agent_pubkey: &agent,
            agent_name: "Alpha",
            bot_username: None,
            client: &client,
            signer: &signer,
            writer_version: "test@0.1.0",
            now_ms: 1_500,
            now_seconds: 1,
        };
        let update = message_update(1001, 42, "/model");
        let _ = dispatch_command(&ctx, &update);
        let sends = client.sends.borrow();
        assert!(sends[0].params.text.contains("/start"));
    }

    #[test]
    fn callback_select_model_persists_config_update_and_sends_terminal_edit() {
        let agent = pubkey_hex(0x02);
        let owner = pubkey_hex(0x01);
        let env = prepare_project_and_agent(&agent, "project-alpha", &owner);
        with_project_binding(&env, &agent, "project-alpha");
        let client = RecordingClient::new();
        let secp = Secp256k1::new();
        let signer = TestSigner::new(secp);
        let ctx = CommandContext {
            daemon_dir: &env.daemon_dir,
            tenex_base_dir: &env.tenex_base_dir,
            data_dir: &env.data_dir,
            agent_pubkey: &agent,
            agent_name: "Alpha",
            bot_username: None,
            client: &client,
            signer: &signer,
            writer_version: "test@0.1.0",
            now_ms: 1_500,
            now_seconds: 1,
        };
        // Seed the menu.
        let open = message_update(1001, 42, "/model");
        assert!(matches!(
            dispatch_command(&ctx, &open),
            CommandDispatchResult::Handled
        ));
        // Find the session id.
        let session_dir = env.daemon_dir.join("telegram/config-sessions");
        let entry = fs::read_dir(&session_dir).unwrap().next().unwrap().unwrap();
        let snapshot_path = entry.path();
        let snapshot: crate::telegram::config_session_store::ConfigSessionSnapshot =
            serde_json::from_str(&fs::read_to_string(&snapshot_path).unwrap()).unwrap();
        let session_id = snapshot.session.id.clone();
        // Select model-b (index 1).
        let callback = callback_update(&session_id, "sm", Some(1), 42);
        let result = dispatch_callback_query(&ctx, &callback);
        assert!(matches!(result, CommandDispatchResult::Handled));

        let answers = client.answers.borrow();
        assert_eq!(answers.len(), 1);
        assert_eq!(answers[0].params.text.as_deref(), Some("Applied model: model-b"));
        let edits = client.edits.borrow();
        assert_eq!(edits.len(), 1);
        assert!(edits[0].params.text.contains("Updated Alpha"));
        assert!(edits[0].params.text.contains("Model: model-b"));

        // Session cleared.
        assert!(!snapshot_path.exists());

        // Publish outbox has a new accepted record.
        let pending = crate::publish_outbox::pending_publish_outbox_dir(&env.daemon_dir);
        let entries: Vec<_> = fs::read_dir(&pending)
            .unwrap()
            .filter_map(|e| e.ok())
            .collect();
        assert_eq!(entries.len(), 1);
    }

    #[test]
    fn callback_from_different_user_is_rejected_with_alert() {
        let agent = pubkey_hex(0x02);
        let owner = pubkey_hex(0x01);
        let env = prepare_project_and_agent(&agent, "project-alpha", &owner);
        with_project_binding(&env, &agent, "project-alpha");
        let client = RecordingClient::new();
        let secp = Secp256k1::new();
        let signer = TestSigner::new(secp);
        let ctx = CommandContext {
            daemon_dir: &env.daemon_dir,
            tenex_base_dir: &env.tenex_base_dir,
            data_dir: &env.data_dir,
            agent_pubkey: &agent,
            agent_name: "Alpha",
            bot_username: None,
            client: &client,
            signer: &signer,
            writer_version: "test@0.1.0",
            now_ms: 1_500,
            now_seconds: 1,
        };
        let open = message_update(1001, 42, "/model");
        let _ = dispatch_command(&ctx, &open);
        let session_dir = env.daemon_dir.join("telegram/config-sessions");
        let entry = fs::read_dir(&session_dir).unwrap().next().unwrap().unwrap();
        let snapshot: crate::telegram::config_session_store::ConfigSessionSnapshot =
            serde_json::from_str(&fs::read_to_string(entry.path()).unwrap()).unwrap();
        let session_id = snapshot.session.id.clone();

        let callback = callback_update(&session_id, "sm", Some(1), 9999);
        let result = dispatch_callback_query(&ctx, &callback);
        assert!(matches!(result, CommandDispatchResult::Handled));
        let answers = client.answers.borrow();
        assert_eq!(answers.len(), 1);
        assert!(answers[0].params.show_alert);
        assert!(answers[0].params.text.as_deref().unwrap().contains("Only the user"));
    }

    #[test]
    fn callback_for_missing_session_alerts_and_does_not_publish() {
        let agent = pubkey_hex(0x02);
        let owner = pubkey_hex(0x01);
        let env = prepare_project_and_agent(&agent, "project-alpha", &owner);
        with_project_binding(&env, &agent, "project-alpha");
        let client = RecordingClient::new();
        let secp = Secp256k1::new();
        let signer = TestSigner::new(secp);
        let ctx = CommandContext {
            daemon_dir: &env.daemon_dir,
            tenex_base_dir: &env.tenex_base_dir,
            data_dir: &env.data_dir,
            agent_pubkey: &agent,
            agent_name: "Alpha",
            bot_username: None,
            client: &client,
            signer: &signer,
            writer_version: "test@0.1.0",
            now_ms: 1_500,
            now_seconds: 1,
        };
        let callback = callback_update("missing-session", "save", None, 42);
        let result = dispatch_callback_query(&ctx, &callback);
        assert!(matches!(result, CommandDispatchResult::Handled));
        let answers = client.answers.borrow();
        assert_eq!(answers.len(), 1);
        assert!(
            answers[0].params.text.as_deref().unwrap().contains("expired"),
            "expected expired alert, got {:?}",
            answers[0].params.text
        );
    }

    #[test]
    fn callback_save_publishes_full_tool_set_for_tools_session() {
        let agent = pubkey_hex(0x02);
        let owner = pubkey_hex(0x01);
        let env = prepare_project_and_agent(&agent, "project-alpha", &owner);
        with_project_binding(&env, &agent, "project-alpha");
        let client = RecordingClient::new();
        let secp = Secp256k1::new();
        let signer = TestSigner::new(secp);
        let ctx = CommandContext {
            daemon_dir: &env.daemon_dir,
            tenex_base_dir: &env.tenex_base_dir,
            data_dir: &env.data_dir,
            agent_pubkey: &agent,
            agent_name: "Alpha",
            bot_username: None,
            client: &client,
            signer: &signer,
            writer_version: "test@0.1.0",
            now_ms: 1_500,
            now_seconds: 1,
        };
        // Seed a tools session manually.
        let session = ConfigSessionRecord {
            id: "abc12345".to_string(),
            kind: ConfigSessionKind::Tools,
            chat_id: "1001".to_string(),
            message_thread_id: None,
            channel_id: "telegram:chat:1001".to_string(),
            message_id: Some(200),
            agent_pubkey: agent.clone(),
            agent_name: "Alpha".to_string(),
            principal_id: "telegram:user:42".to_string(),
            project_id: "project-alpha".to_string(),
            project_title: "project-alpha".to_string(),
            project_binding: format!("31933:{owner}:project-alpha"),
            current_page: 0,
            available_models: vec!["model-a".to_string()],
            available_tools: vec!["fs_read".to_string(), "shell".to_string()],
            selected_model: "model-a".to_string(),
            selected_tools: vec!["fs_read".to_string()],
        };
        save_session(&env.daemon_dir, "test@0.1.0", 1_500, session).expect("save");
        let callback = callback_update("abc12345", "save", None, 42);
        let result = dispatch_callback_query(&ctx, &callback);
        assert!(matches!(result, CommandDispatchResult::Handled));

        let pending = crate::publish_outbox::pending_publish_outbox_dir(&env.daemon_dir);
        let entries: Vec<_> = fs::read_dir(&pending)
            .unwrap()
            .filter_map(|e| e.ok())
            .collect();
        assert_eq!(entries.len(), 1);
        let raw = fs::read_to_string(entries[0].path()).unwrap();
        // Inspect tags — must contain model + tool entries.
        assert!(raw.contains("\"model\""));
        assert!(raw.contains("\"fs_read\""));
    }

    #[test]
    fn callback_toggle_tool_flips_selection_and_re_renders() {
        let agent = pubkey_hex(0x02);
        let owner = pubkey_hex(0x01);
        let env = prepare_project_and_agent(&agent, "project-alpha", &owner);
        with_project_binding(&env, &agent, "project-alpha");
        let client = RecordingClient::new();
        let secp = Secp256k1::new();
        let signer = TestSigner::new(secp);
        let ctx = CommandContext {
            daemon_dir: &env.daemon_dir,
            tenex_base_dir: &env.tenex_base_dir,
            data_dir: &env.data_dir,
            agent_pubkey: &agent,
            agent_name: "Alpha",
            bot_username: None,
            client: &client,
            signer: &signer,
            writer_version: "test@0.1.0",
            now_ms: 1_500,
            now_seconds: 1,
        };
        let session = ConfigSessionRecord {
            id: "abc12345".to_string(),
            kind: ConfigSessionKind::Tools,
            chat_id: "1001".to_string(),
            message_thread_id: None,
            channel_id: "telegram:chat:1001".to_string(),
            message_id: Some(200),
            agent_pubkey: agent.clone(),
            agent_name: "Alpha".to_string(),
            principal_id: "telegram:user:42".to_string(),
            project_id: "project-alpha".to_string(),
            project_title: "project-alpha".to_string(),
            project_binding: format!("31933:{owner}:project-alpha"),
            current_page: 0,
            available_models: vec!["model-a".to_string()],
            available_tools: vec!["fs_read".to_string(), "shell".to_string()],
            selected_model: "model-a".to_string(),
            selected_tools: vec!["fs_read".to_string()],
        };
        save_session(&env.daemon_dir, "test@0.1.0", 1_500, session).expect("save");
        let callback = callback_update("abc12345", "tt", Some(1), 42);
        let _ = dispatch_callback_query(&ctx, &callback);
        let answers = client.answers.borrow();
        assert_eq!(answers.len(), 1);
        assert_eq!(
            answers[0].params.text.as_deref(),
            Some("Enabled shell"),
            "toast must announce the toggle"
        );
        let loaded = find_session_by_id(
            &env.daemon_dir,
            "abc12345",
            DEFAULT_CONFIG_SESSION_TTL_MS,
            1_500,
        )
        .expect("find")
        .expect("present");
        assert_eq!(loaded.selected_tools, vec!["fs_read", "shell"]);
        let edits = client.edits.borrow();
        assert_eq!(edits.len(), 1, "re-render after toggle");
    }

    #[test]
    fn encode_agent_config_update_signs_verifiable_event_with_expected_tag_shape() {
        let secp = Secp256k1::new();
        let signer = TestSigner::new(secp);
        let agent_pub = pubkey_hex(0x03);
        let tools = vec!["fs_read".to_string(), "shell".to_string()];
        let event = encode_agent_config_update(
            &signer,
            1_700_000_000,
            "31933:ownerpk:project-alpha",
            &agent_pub,
            "model-b",
            &tools,
        )
        .expect("encode");
        assert_eq!(event.kind, TENEX_AGENT_CONFIG_UPDATE_KIND);
        assert_eq!(event.pubkey, signer.xonly_pubkey_hex());
        assert_eq!(event.tags[0], vec!["a", "31933:ownerpk:project-alpha"]);
        assert_eq!(event.tags[1], vec!["client", CLIENT_TAG]);
        assert_eq!(event.tags[2], vec!["p", agent_pub.as_str()]);
        assert_eq!(event.tags[3], vec!["model", "model-b"]);
        assert_eq!(event.tags[4], vec!["tool", "fs_read"]);
        assert_eq!(event.tags[5], vec!["tool", "shell"]);
        crate::nostr_event::verify_signed_event(&event).expect("signature verifies");
    }

    #[test]
    fn parse_callback_data_rejects_unknown_action_tokens() {
        assert!(parse_callback_data("").is_none());
        assert!(parse_callback_data("tgcfg:abc:zzz").is_none());
        assert!(parse_callback_data("other:abc:save").is_none());
        assert!(parse_callback_data("tgcfg:abc:sm").is_none());
        assert_eq!(
            parse_callback_data("tgcfg:abc:sm:2"),
            Some(("abc".to_string(), CallbackAction::SelectModel { index: 2 }))
        );
    }

    #[test]
    fn summarize_tools_truncates_after_five_entries() {
        assert_eq!(summarize_tools(&[]), "no configurable tools");
        let all = vec![
            "a".to_string(),
            "b".to_string(),
            "c".to_string(),
            "d".to_string(),
            "e".to_string(),
            "f".to_string(),
            "g".to_string(),
        ];
        assert_eq!(summarize_tools(&all), "a, b, c, d, e (+2 more)");
    }
}
