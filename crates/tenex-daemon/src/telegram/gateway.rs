//! Long-poll gateway supervisor: one `std::thread` per configured bot token.
//!
//! Each thread loops `getUpdates(offset, timeout, allowed_updates)` against
//! the Bot API, refreshes the durable chat-context snapshot, records the
//! sender as a seen participant, downloads any media attachment, then hands
//! the raw Bot API update off to
//! [`crate::telegram::ingress_runtime::process_telegram_update`] which
//! normalises, authorises and enqueues the inbound dispatch.
//!
//! Key gateway invariants:
//!
//! - Backlog skip runs once per bot on startup so we never re-process
//!   updates that accumulated while the daemon was down.
//! - `offset` advances past an update even if processing that update errors
//!   (otherwise a single bad message pins the entire loop).
//! - Bot API `401 Unauthorized` / [`TelegramClientError::InvalidToken`]
//!   fails the bot closed: we stop its thread, never retry, log once, and
//!   leave the rest of the daemon (including other bots) running.
//! - Network / 5xx / timeout errors use exponential backoff starting at 1 s
//!   and capped at 60 s, matching the TS `errorBackoffMs` approach but
//!   upgraded from a constant to exponential to avoid hammering the API
//!   during Bot API outages.
//! - The stop flag is checked between polls and between per-update
//!   processing steps; a pending poll is not interrupted but is also
//!   short-circuited when possible.
//!
//! The gateway is stateless beyond the per-bot thread state. All durable
//! state (chat context snapshots, identity bindings, transport bindings,
//! project catalog) lives in files and is read on each iteration.
//! Observation of per-update outcomes is exposed via
//! [`IngressObserver`] for diagnostics and tests; production wiring passes
//! [`NoopIngressObserver`] and relies on the inbound-dispatch log.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::Value;
use thiserror::Error;
use tracing;

use crate::backend_events::heartbeat::BackendSigner;
use crate::telegram::chat_context::{
    ChatContextError, ChatContextSnapshot, DEFAULT_API_SYNC_TTL_MS, RefreshChatContextInput,
    SeenUser, record_seen_participant, refresh_chat_context,
};
use crate::telegram::client::{
    GetUpdatesParams, TelegramBotClient, TelegramBotClientConfig, TelegramClientError, Update,
};
use crate::telegram::commands::{
    CommandBotClient, CommandContext, CommandDispatchResult, dispatch_callback_query,
    dispatch_command,
};
use crate::telegram::inbound::{InboundMediaInfo, InboundMediaType};
use crate::telegram::ingress_runtime::{
    TelegramIngressRuntimeError, TelegramIngressRuntimeInput, TelegramIngressRuntimeOutcome,
    process_telegram_update,
};
use crate::telegram::media::{MediaDownloadError, MediaDownloadRequest, download_telegram_media};

/// Default long-poll timeout (seconds) passed to `getUpdates`.
pub const DEFAULT_LONG_POLL_TIMEOUT_SECONDS: u64 = 30;
/// Maximum batch size requested per `getUpdates` call.
pub const DEFAULT_POLL_LIMIT: u32 = 100;
/// Starting backoff for transient failures.
pub const INITIAL_ERROR_BACKOFF: Duration = Duration::from_secs(1);
/// Cap on the exponential backoff growth.
pub const MAX_ERROR_BACKOFF: Duration = Duration::from_secs(60);
/// How long we sleep between stop-flag checks during backoff so a shutdown
/// doesn't wait a full minute. Must divide `MAX_ERROR_BACKOFF` cleanly.
const STOP_POLL_INTERVAL: Duration = Duration::from_millis(500);

/// Per-bot configuration the gateway needs to spawn a poll thread.
#[derive(Debug, Clone)]
pub struct GatewayBot {
    /// Stable label for logs. Typically the agent's slug or pubkey prefix.
    pub label: String,
    /// The agent pubkey that owns this bot token. Becomes the single
    /// recipient of every envelope built from this bot's updates.
    pub agent_pubkey: String,
    /// Human-readable display name of the agent. Surfaced into
    /// `PrincipalRef.displayName` on recipient entries.
    pub agent_name: String,
    /// Bot API token (`12345:ABCDE...`). Never logged.
    pub bot_token: String,
    /// API base URL. `None` means use the client's default.
    pub api_base_url: Option<String>,
}

/// Whole-supervisor configuration.
pub struct GatewayConfig {
    pub tenex_base_dir: PathBuf,
    pub daemon_dir: PathBuf,
    /// Directory that contains `transport-bindings.json` /
    /// `identity-bindings.json`. Typically
    /// `$TENEX_BASE_DIR/<data>` (resolved by the TS
    /// `ConfigService.getConfigPath("data")`).
    pub data_dir: PathBuf,
    pub writer_version: String,
    pub bots: Vec<GatewayBot>,
    pub long_poll_timeout_seconds: u64,
    pub poll_limit: u32,
    pub chat_context_api_sync_ttl_ms: u64,
    /// Backend signer used to publish agent-config updates from
    /// `/model`/`/config` callback flows. `None` disables Nostr publishing
    /// for callbacks — the menus themselves still render but save/select
    /// operations return an alert instead of emitting an event. Production
    /// wiring always provides a signer; the `None` case keeps tests that
    /// don't exercise Nostr publishing terse.
    pub signer: Option<Arc<dyn BackendSigner + Send + Sync>>,
    pub project_event_index: Arc<std::sync::Mutex<crate::project_event_index::ProjectEventIndex>>,
}

impl std::fmt::Debug for GatewayConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GatewayConfig")
            .field("tenex_base_dir", &self.tenex_base_dir)
            .field("daemon_dir", &self.daemon_dir)
            .field("data_dir", &self.data_dir)
            .field("writer_version", &self.writer_version)
            .field("bots", &self.bots)
            .field("long_poll_timeout_seconds", &self.long_poll_timeout_seconds)
            .field("poll_limit", &self.poll_limit)
            .field(
                "chat_context_api_sync_ttl_ms",
                &self.chat_context_api_sync_ttl_ms,
            )
            .field("signer_present", &self.signer.is_some())
            .finish()
    }
}

impl GatewayConfig {
    pub fn new(tenex_base_dir: PathBuf, daemon_dir: PathBuf, data_dir: PathBuf) -> Self {
        Self {
            tenex_base_dir,
            daemon_dir,
            data_dir,
            writer_version: format!("tenex-daemon@{}", env!("CARGO_PKG_VERSION")),
            bots: Vec::new(),
            long_poll_timeout_seconds: DEFAULT_LONG_POLL_TIMEOUT_SECONDS,
            poll_limit: DEFAULT_POLL_LIMIT,
            chat_context_api_sync_ttl_ms: DEFAULT_API_SYNC_TTL_MS,
            signer: None,
            project_event_index: Arc::new(std::sync::Mutex::new(
                crate::project_event_index::ProjectEventIndex::new(),
            )),
        }
    }

    pub fn with_bot(mut self, bot: GatewayBot) -> Self {
        self.bots.push(bot);
        self
    }

    pub fn with_signer(mut self, signer: Arc<dyn BackendSigner + Send + Sync>) -> Self {
        self.signer = Some(signer);
        self
    }
}

/// Minimal Bot API surface the gateway uses. Behind a trait so tests can
/// drive the gateway against a fake client without starting an HTTP server.
pub trait GatewayBotApi: Send + Sync {
    fn get_me(&self) -> Result<BotIdentity, TelegramClientError>;
    fn get_updates(&self, params: GetUpdatesParams) -> Result<Vec<Update>, TelegramClientError>;
    fn download_media(
        &self,
        daemon_dir: &Path,
        request: MediaDownloadRequest<'_>,
    ) -> Result<PathBuf, MediaDownloadError>;
    fn chat_context_refresh(
        &self,
        daemon_dir: &Path,
        input: &RefreshChatContextInput<'_>,
    ) -> Result<ChatContextSnapshot, ChatContextError>;
    /// Command/callback handlers send Bot API messages (the chat reply to
    /// `/start`, the inline-keyboard menu for `/model`, `editMessageText`
    /// on a callback). Exposing a typed command-client view keeps the
    /// command module independent of the long-poll trait shape.
    fn command_client(&self) -> &dyn CommandBotClient;
}

/// The piece of `getMe` the gateway cares about — used to drop the bot's
/// own echoed messages and stamp metadata.
#[derive(Debug, Clone)]
pub struct BotIdentity {
    pub id: u64,
    pub username: Option<String>,
}

/// Real `GatewayBotApi` backed by [`TelegramBotClient`] plus
/// [`download_telegram_media`] and [`refresh_chat_context`].
pub struct TelegramClientGatewayApi {
    client: TelegramBotClient,
}

impl TelegramClientGatewayApi {
    pub fn new(client: TelegramBotClient) -> Self {
        Self { client }
    }

    pub fn client(&self) -> &TelegramBotClient {
        &self.client
    }
}

impl GatewayBotApi for TelegramClientGatewayApi {
    fn get_me(&self) -> Result<BotIdentity, TelegramClientError> {
        let bot = self.client.get_me()?;
        let id_u64 = u64::try_from(bot.id).map_err(|_| TelegramClientError::ApiError {
            error_code: 0,
            description: "getMe returned a negative bot id".to_string(),
            retry_after: None,
        })?;
        Ok(BotIdentity {
            id: id_u64,
            username: bot.username,
        })
    }

    fn get_updates(&self, params: GetUpdatesParams) -> Result<Vec<Update>, TelegramClientError> {
        self.client.get_updates(params)
    }

    fn download_media(
        &self,
        daemon_dir: &Path,
        request: MediaDownloadRequest<'_>,
    ) -> Result<PathBuf, MediaDownloadError> {
        let outcome = download_telegram_media(daemon_dir, &self.client, request)?;
        Ok(outcome.local_path)
    }

    fn chat_context_refresh(
        &self,
        daemon_dir: &Path,
        input: &RefreshChatContextInput<'_>,
    ) -> Result<ChatContextSnapshot, ChatContextError> {
        refresh_chat_context(daemon_dir, &self.client, input)
    }

    fn command_client(&self) -> &dyn CommandBotClient {
        &self.client
    }
}

/// Observer invoked for every processed update. Useful for diagnostics and
/// tests; production wiring can safely pass [`NoopIngressObserver`].
pub trait IngressObserver: Send + Sync {
    fn on_processed(&self, label: &str, outcome: TelegramIngressRuntimeOutcome);
    fn on_error(&self, label: &str, error: &TelegramIngressRuntimeError);
}

/// Observer that discards everything.
pub struct NoopIngressObserver;

impl IngressObserver for NoopIngressObserver {
    fn on_processed(&self, _label: &str, _outcome: TelegramIngressRuntimeOutcome) {}
    fn on_error(&self, _label: &str, _error: &TelegramIngressRuntimeError) {}
}

/// Errors surfaced by [`start_telegram_gateway`].
#[derive(Debug, Error)]
pub enum GatewayStartError {
    #[error("no telegram bots configured")]
    NoBots,
    #[error("gateway bot client creation failed: {0}")]
    ClientCreation(#[from] TelegramClientError),
}

/// Supervisor owning the per-bot poll threads. Dropping it without calling
/// [`TelegramGatewaySupervisor::join`] signals stop and detaches.
#[derive(Debug)]
pub struct TelegramGatewaySupervisor {
    handles: Vec<JoinHandle<()>>,
    stop_flag: Arc<AtomicBool>,
}

impl TelegramGatewaySupervisor {
    /// Signal all bot threads to stop. They finish their current poll and
    /// exit between iterations; callers should follow with [`Self::join`].
    pub fn request_stop(&self) {
        self.stop_flag.store(true, Ordering::SeqCst);
    }

    /// Block until every poll thread exits.
    pub fn join(mut self) {
        let handles = std::mem::take(&mut self.handles);
        for handle in handles {
            let _ = handle.join();
        }
    }

    /// Access the stop flag so callers can check status from the outside.
    pub fn stop_flag(&self) -> Arc<AtomicBool> {
        self.stop_flag.clone()
    }
}

impl Drop for TelegramGatewaySupervisor {
    fn drop(&mut self) {
        self.stop_flag.store(true, Ordering::SeqCst);
    }
}

/// Launch one poll thread per configured bot token.
///
/// The supervisor owns every thread handle. Network errors inside an
/// individual thread are handled locally (exponential backoff); an
/// `Unauthorized` Bot API response fails that single bot closed.
pub fn start_telegram_gateway<O>(
    config: GatewayConfig,
    observer: O,
) -> Result<TelegramGatewaySupervisor, GatewayStartError>
where
    O: IngressObserver + 'static,
{
    if config.bots.is_empty() {
        return Err(GatewayStartError::NoBots);
    }
    let stop_flag = Arc::new(AtomicBool::new(false));
    let observer: Arc<dyn IngressObserver> = Arc::new(observer);
    let mut handles = Vec::with_capacity(config.bots.len());

    for bot in &config.bots {
        let api_base_url = bot.api_base_url.clone();
        let mut client_config = TelegramBotClientConfig::new(bot.bot_token.clone())
            .with_http_timeout(Duration::from_secs(
                config.long_poll_timeout_seconds.saturating_add(10),
            ));
        if let Some(base_url) = api_base_url {
            client_config = client_config.with_api_base_url(base_url);
        }
        let client = TelegramBotClient::new(client_config)?;
        let api = Arc::new(TelegramClientGatewayApi::new(client));
        let handle = spawn_gateway_thread(
            bot.clone(),
            api,
            observer.clone(),
            stop_flag.clone(),
            GatewayThreadConfig {
                tenex_base_dir: config.tenex_base_dir.clone(),
                daemon_dir: config.daemon_dir.clone(),
                data_dir: config.data_dir.clone(),
                writer_version: config.writer_version.clone(),
                long_poll_timeout_seconds: config.long_poll_timeout_seconds,
                poll_limit: config.poll_limit,
                chat_context_api_sync_ttl_ms: config.chat_context_api_sync_ttl_ms,
                signer: config.signer.clone(),
                project_event_index: config.project_event_index.clone(),
            },
        );
        handles.push(handle);
    }
    Ok(TelegramGatewaySupervisor { handles, stop_flag })
}

#[derive(Clone)]
struct GatewayThreadConfig {
    tenex_base_dir: PathBuf,
    daemon_dir: PathBuf,
    data_dir: PathBuf,
    writer_version: String,
    long_poll_timeout_seconds: u64,
    poll_limit: u32,
    chat_context_api_sync_ttl_ms: u64,
    signer: Option<Arc<dyn BackendSigner + Send + Sync>>,
    project_event_index: Arc<std::sync::Mutex<crate::project_event_index::ProjectEventIndex>>,
}

fn spawn_gateway_thread<A>(
    bot: GatewayBot,
    api: Arc<A>,
    observer: Arc<dyn IngressObserver>,
    stop_flag: Arc<AtomicBool>,
    config: GatewayThreadConfig,
) -> JoinHandle<()>
where
    A: GatewayBotApi + 'static,
{
    thread::Builder::new()
        .name(format!("telegram-gateway:{}", bot.label))
        .spawn(move || run_gateway_loop(bot, api, observer, stop_flag, config))
        .expect("spawn telegram gateway thread")
}

fn run_gateway_loop<A>(
    bot: GatewayBot,
    api: Arc<A>,
    observer: Arc<dyn IngressObserver>,
    stop_flag: Arc<AtomicBool>,
    config: GatewayThreadConfig,
) where
    A: GatewayBotApi,
{
    tracing::info!(bot = %bot.label, agent_pubkey = %bot.agent_pubkey, "telegram gateway thread started");

    let identity = match api.get_me() {
        Ok(identity) => identity,
        Err(TelegramClientError::InvalidToken) => {
            log_invalid_token(&bot.label);
            return;
        }
        Err(error) => {
            log_bot_warning(
                &bot.label,
                &format!("getMe failed, continuing with placeholder: {error}"),
            );
            BotIdentity {
                id: 0,
                username: None,
            }
        }
    };

    let mut next_offset =
        match skip_backlog(&bot.label, api.as_ref(), config.poll_limit, &stop_flag) {
            Ok(offset) => offset,
            Err(BacklogSkipError::InvalidToken) => {
                log_invalid_token(&bot.label);
                return;
            }
            Err(BacklogSkipError::Client(error)) => {
                log_bot_warning(
                    &bot.label,
                    &format!("backlog skip failed, starting from None: {error}"),
                );
                None
            }
            Err(BacklogSkipError::Stopped) => return,
        };

    let mut backoff = INITIAL_ERROR_BACKOFF;

    while !stop_flag.load(Ordering::SeqCst) {
        let params = GetUpdatesParams {
            offset: next_offset,
            timeout_seconds: Some(config.long_poll_timeout_seconds),
            limit: Some(config.poll_limit),
            allowed_updates: Some(vec![
                "message".to_string(),
                "edited_message".to_string(),
                "callback_query".to_string(),
            ]),
        };
        let _poll_span = tracing::debug_span!(
            "telegram.poll",
            bot = %bot.label,
            offset = ?next_offset
        )
        .entered();
        match api.get_updates(params) {
            Ok(updates) => {
                backoff = INITIAL_ERROR_BACKOFF;
                let count = updates.len();
                if count > 0 {
                    tracing::debug!(bot = %bot.label, update_count = count, "telegram updates received");
                }
                for update in updates {
                    let update_id = update.update_id;
                    tracing::debug!(bot = %bot.label, update_id = update_id, "processing telegram update");
                    process_one(&bot, &identity, &update, &api, &observer, &config);
                    next_offset = Some(update_id.saturating_add(1));
                    if stop_flag.load(Ordering::SeqCst) {
                        break;
                    }
                }
            }
            Err(TelegramClientError::InvalidToken) => {
                log_invalid_token(&bot.label);
                return;
            }
            Err(error) => {
                if !stop_flag.load(Ordering::SeqCst) {
                    tracing::warn!(
                        bot = %bot.label,
                        backoff_secs = backoff.as_secs(),
                        error = %error,
                        "telegram getUpdates failed, backing off"
                    );
                }
                if !sleep_with_stop(&stop_flag, backoff) {
                    break;
                }
                backoff = next_backoff(backoff);
            }
        }
        drop(_poll_span);
    }
    tracing::info!(bot = %bot.label, "telegram gateway thread stopped");
}

#[derive(Debug)]
enum BacklogSkipError {
    InvalidToken,
    Client(TelegramClientError),
    Stopped,
}

fn skip_backlog<A>(
    label: &str,
    api: &A,
    limit: u32,
    stop_flag: &AtomicBool,
) -> Result<Option<i64>, BacklogSkipError>
where
    A: GatewayBotApi,
{
    let mut next_offset: Option<i64> = None;
    let mut skipped = 0usize;
    loop {
        if stop_flag.load(Ordering::SeqCst) {
            return Err(BacklogSkipError::Stopped);
        }
        let updates = api.get_updates(GetUpdatesParams {
            offset: next_offset,
            timeout_seconds: Some(0),
            limit: Some(limit),
            allowed_updates: Some(vec![
                "message".to_string(),
                "edited_message".to_string(),
                "callback_query".to_string(),
            ]),
        });
        let updates = match updates {
            Ok(updates) => updates,
            Err(TelegramClientError::InvalidToken) => {
                return Err(BacklogSkipError::InvalidToken);
            }
            Err(error) => return Err(BacklogSkipError::Client(error)),
        };
        if updates.is_empty() {
            if skipped > 0 {
                log_bot_info(label, &format!("skipped {skipped} backlog update(s)"));
            }
            return Ok(next_offset);
        }
        skipped += updates.len();
        if let Some(last) = updates.last() {
            next_offset = Some(last.update_id.saturating_add(1));
        }
    }
}

fn next_backoff(current: Duration) -> Duration {
    let doubled = current.saturating_mul(2);
    if doubled > MAX_ERROR_BACKOFF {
        MAX_ERROR_BACKOFF
    } else {
        doubled
    }
}

/// Sleep for `duration` while checking `stop_flag` every
/// [`STOP_POLL_INTERVAL`]. Returns `false` if the stop flag triggered
/// during the sleep.
fn sleep_with_stop(stop_flag: &AtomicBool, duration: Duration) -> bool {
    let mut remaining = duration;
    while remaining > Duration::ZERO {
        if stop_flag.load(Ordering::SeqCst) {
            return false;
        }
        let step = if remaining > STOP_POLL_INTERVAL {
            STOP_POLL_INTERVAL
        } else {
            remaining
        };
        thread::sleep(step);
        remaining = remaining.saturating_sub(step);
    }
    !stop_flag.load(Ordering::SeqCst)
}

/// Process a single update end-to-end: refresh the chat context, record the
/// sender, download any media attachment, then hand the update off to
/// [`process_telegram_update`] (which performs the transport-binding check,
/// authorization gate, and inbound-dispatch enqueue). All errors are
/// logged and forwarded to the observer; we never let a single bad update
/// abort the poll loop.
fn process_one<A>(
    bot: &GatewayBot,
    identity: &BotIdentity,
    update: &Update,
    api: &Arc<A>,
    observer: &Arc<dyn IngressObserver>,
    config: &GatewayThreadConfig,
) where
    A: GatewayBotApi,
{
    let update_json = update_to_json(update);

    // Commands and callback queries are meta-UI: they never become
    // envelopes. Dispatch them first and short-circuit the rest of the
    // pipeline when recognised.
    if try_dispatch_meta(bot, identity, &update_json, api, config) {
        return;
    }

    // Refresh chat context + record sender when the update carries a
    // routable message. These are best-effort: the main dispatch still
    // runs if these fail.
    if let Some((chat_id, thread_id, is_private, sender_info)) = extract_chat_metadata(&update_json)
    {
        let chat_id_str = chat_id.to_string();
        if let Err(error) = api.chat_context_refresh(
            &config.daemon_dir,
            &RefreshChatContextInput {
                chat_id: &chat_id_str,
                is_private,
                thread_id,
                writer_version: &config.writer_version,
                api_sync_ttl_ms: config.chat_context_api_sync_ttl_ms,
                now_ms: now_ms(),
                force: false,
            },
        ) {
            log_bot_warning(
                &bot.label,
                &format!("chat_context_refresh failed for chat {chat_id_str}: {error}"),
            );
        }
        if let Err(error) = record_seen_participant(
            &config.daemon_dir,
            &chat_id_str,
            &config.writer_version,
            SeenUser {
                user_id: &sender_info.id.to_string(),
                display_name: sender_info.display_name.as_deref(),
                username: sender_info.username.as_deref(),
                is_bot: sender_info.is_bot,
            },
            now_ms(),
        ) {
            log_bot_warning(
                &bot.label,
                &format!(
                    "record_seen_participant failed for sender {}: {error}",
                    sender_info.id
                ),
            );
        }
    }

    // Download media if present. Failures drop the attachment but keep the
    // text-bearing envelope.
    let media = extract_media_target(&update_json);
    let media_info_owned = match media {
        Some(target) => match api.download_media(
            &config.daemon_dir,
            MediaDownloadRequest {
                file_id: &target.file_id,
                file_unique_id: &target.file_unique_id,
                mime_type: target.mime_type.as_deref(),
                expected_size: target.file_size,
            },
        ) {
            Ok(local_path) => Some(OwnedMediaInfo {
                local_path,
                media_type: target.media_type,
                duration: target.duration,
                file_name: target.file_name,
            }),
            Err(error) => {
                log_bot_warning(
                    &bot.label,
                    &format!("media download failed, dropping attachment: {error}"),
                );
                None
            }
        },
        None => None,
    };
    let media_info_ref = media_info_owned.as_ref().map(OwnedMediaInfo::as_info);

    let now = now_ms();
    let result = process_telegram_update(TelegramIngressRuntimeInput {
        daemon_dir: &config.daemon_dir,
        tenex_base_dir: &config.tenex_base_dir,
        data_dir: &config.data_dir,
        agent_pubkey: &bot.agent_pubkey,
        agent_name: Some(&bot.agent_name),
        update: &update_json,
        bot_id: identity.id,
        bot_username: identity.username.as_deref(),
        media_info: media_info_ref.as_ref(),
        session_reply_to_native_id: None,
        timestamp: now,
        writer_version: &config.writer_version,
        project_event_index: &config.project_event_index,
    });

    match result {
        Ok(outcome) => observer.on_processed(&bot.label, outcome),
        Err(error) => {
            log_bot_warning(
                &bot.label,
                &format!("process_telegram_update failed: {error}"),
            );
            observer.on_error(&bot.label, &error);
        }
    }
}

/// Try to dispatch a command (`/...`) or callback query via
/// [`crate::telegram::commands`]. Returns `true` when the pipeline should
/// stop (the update was handled as meta-UI, or attempting to handle it
/// produced an error that still means "don't feed this to the normalizer").
fn try_dispatch_meta<A>(
    bot: &GatewayBot,
    identity: &BotIdentity,
    update: &Value,
    api: &Arc<A>,
    config: &GatewayThreadConfig,
) -> bool
where
    A: GatewayBotApi,
{
    // Shortcut: quickly decide whether this update is a command or callback
    // query. Non-commands get the fast path out; the command module does
    // its own stricter parsing below.
    let is_callback_query = update
        .as_object()
        .map(|obj| obj.contains_key("callback_query"))
        .unwrap_or(false);
    let starts_with_slash = update_starts_with_slash(update);
    if !is_callback_query && !starts_with_slash {
        return false;
    }

    let Some(signer) = config.signer.clone() else {
        log_bot_warning(
            &bot.label,
            "received a command/callback update but no backend signer is configured — ignoring",
        );
        return true;
    };

    let ctx = CommandContext {
        daemon_dir: &config.daemon_dir,
        tenex_base_dir: &config.tenex_base_dir,
        data_dir: &config.data_dir,
        agent_pubkey: &bot.agent_pubkey,
        agent_name: &bot.agent_name,
        bot_username: identity.username.as_deref(),
        client: api.command_client(),
        signer: signer.as_ref(),
        writer_version: &config.writer_version,
        now_ms: now_ms(),
        now_seconds: now_ms() / 1_000,
    };

    let result = if is_callback_query {
        dispatch_callback_query(&ctx, update)
    } else {
        dispatch_command(&ctx, update)
    };

    match result {
        CommandDispatchResult::Handled => true,
        CommandDispatchResult::NotACommand => false,
        CommandDispatchResult::Error(error) => {
            log_bot_warning(&bot.label, &format!("command dispatch failed: {error}"));
            // Treat the error as "meta-UI handled" so the normalizer
            // doesn't re-process a `/model` typed into an agent chat.
            true
        }
    }
}

fn update_starts_with_slash(update: &Value) -> bool {
    let Some(obj) = update.as_object() else {
        return false;
    };
    let message = obj
        .get("message")
        .filter(|value| !value.is_null())
        .or_else(|| obj.get("edited_message").filter(|value| !value.is_null()))
        .and_then(Value::as_object);
    let Some(message) = message else {
        return false;
    };
    let text = message
        .get("text")
        .and_then(Value::as_str)
        .or_else(|| message.get("caption").and_then(Value::as_str))
        .unwrap_or("")
        .trim_start();
    text.starts_with('/')
}

fn update_to_json(update: &Update) -> Value {
    let mut map = serde_json::Map::new();
    map.insert("update_id".to_string(), update.update_id.into());
    if let Some(message) = &update.message {
        map.insert("message".to_string(), message.clone());
    }
    if let Some(edited) = &update.edited_message {
        map.insert("edited_message".to_string(), edited.clone());
    }
    if let Some(callback) = &update.callback_query {
        map.insert("callback_query".to_string(), callback.clone());
    }
    Value::Object(map)
}

#[derive(Debug)]
struct SenderInfo {
    id: i64,
    is_bot: bool,
    display_name: Option<String>,
    username: Option<String>,
}

/// Returns `(chat_id, thread_id, is_private, sender)`. `None` means the
/// update carries neither a message nor an edited_message with a routable
/// chat — callback queries and channel chats fall into this bucket.
fn extract_chat_metadata(update: &Value) -> Option<(i64, Option<i64>, bool, SenderInfo)> {
    let obj = update.as_object()?;
    let message = obj
        .get("message")
        .filter(|value| !value.is_null())
        .or_else(|| obj.get("edited_message").filter(|value| !value.is_null()))?;
    let message = message.as_object()?;
    let chat = message.get("chat")?.as_object()?;
    let chat_id = chat.get("id")?.as_i64()?;
    let chat_type = chat.get("type").and_then(Value::as_str).unwrap_or("");
    // Channel chats are dropped by the normalizer — no reason to refresh
    // their context or download their media.
    if chat_type == "channel" {
        return None;
    }
    let is_private = chat_type == "private";
    let thread_id = message.get("message_thread_id").and_then(Value::as_i64);
    let from = message.get("from")?.as_object()?;
    let sender_id = from.get("id")?.as_i64()?;
    let is_bot = from.get("is_bot").and_then(Value::as_bool).unwrap_or(false);
    let display_name = telegram_display_name(from);
    let username = from
        .get("username")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    Some((
        chat_id,
        thread_id,
        is_private,
        SenderInfo {
            id: sender_id,
            is_bot,
            display_name,
            username,
        },
    ))
}

fn telegram_display_name(from: &serde_json::Map<String, Value>) -> Option<String> {
    let first = from.get("first_name").and_then(Value::as_str).unwrap_or("");
    let last = from.get("last_name").and_then(Value::as_str).unwrap_or("");
    let combined = [first, last]
        .into_iter()
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let trimmed = combined.trim().to_string();
    if !trimmed.is_empty() {
        return Some(trimmed);
    }
    from.get("username")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

#[derive(Debug)]
struct MediaTarget {
    file_id: String,
    file_unique_id: String,
    mime_type: Option<String>,
    media_type: InboundMediaType,
    duration: Option<u64>,
    file_name: Option<String>,
    file_size: Option<u64>,
}

/// Extract the highest-priority media attachment from a message.
/// Priority:
/// voice → audio → document → video → largest photo.
fn extract_media_target(update: &Value) -> Option<MediaTarget> {
    let obj = update.as_object()?;
    let message = obj
        .get("message")
        .filter(|value| !value.is_null())
        .or_else(|| obj.get("edited_message").filter(|value| !value.is_null()))?;
    let message = message.as_object()?;
    if let Some(voice) = message.get("voice").and_then(Value::as_object) {
        return Some(media_target_from(
            voice,
            InboundMediaType::Voice,
            None,
            None,
        ));
    }
    if let Some(audio) = message.get("audio").and_then(Value::as_object) {
        return Some(media_target_from(
            audio,
            InboundMediaType::Audio,
            None,
            None,
        ));
    }
    if let Some(document) = message.get("document").and_then(Value::as_object) {
        let file_name = document
            .get("file_name")
            .and_then(Value::as_str)
            .map(str::to_string);
        return Some(media_target_from(
            document,
            InboundMediaType::Document,
            file_name,
            None,
        ));
    }
    if let Some(video) = message.get("video").and_then(Value::as_object) {
        return Some(media_target_from(
            video,
            InboundMediaType::Video,
            None,
            None,
        ));
    }
    if let Some(photo_array) = message.get("photo").and_then(Value::as_array) {
        let last = photo_array.last()?.as_object()?;
        return Some(media_target_from(
            last,
            InboundMediaType::Photo,
            None,
            Some("image/jpeg".to_string()),
        ));
    }
    None
}

fn media_target_from(
    media: &serde_json::Map<String, Value>,
    media_type: InboundMediaType,
    file_name: Option<String>,
    mime_override: Option<String>,
) -> MediaTarget {
    let file_id = media
        .get("file_id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let file_unique_id = media
        .get("file_unique_id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let mime_type = mime_override.or_else(|| {
        media
            .get("mime_type")
            .and_then(Value::as_str)
            .map(str::to_string)
    });
    let duration = media.get("duration").and_then(Value::as_u64).or_else(|| {
        media
            .get("duration")
            .and_then(Value::as_i64)
            .map(|v| v as u64)
    });
    let file_size = media.get("file_size").and_then(Value::as_u64).or_else(|| {
        media
            .get("file_size")
            .and_then(Value::as_i64)
            .map(|v| v as u64)
    });
    MediaTarget {
        file_id,
        file_unique_id,
        mime_type,
        media_type,
        duration,
        file_name,
        file_size,
    }
}

/// `InboundMediaInfo` takes `&str` fields; this struct owns the paths so
/// the borrowed view stays valid while the normalizer runs.
struct OwnedMediaInfo {
    local_path: PathBuf,
    media_type: InboundMediaType,
    duration: Option<u64>,
    file_name: Option<String>,
}

impl OwnedMediaInfo {
    fn as_info(&self) -> InboundMediaInfo<'_> {
        InboundMediaInfo {
            local_path: self.local_path.to_str().unwrap_or_default(),
            media_type: self.media_type,
            duration_seconds: self.duration,
            file_name: self.file_name.as_deref(),
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn log_bot_info(label: &str, message: &str) {
    tracing::info!(bot = %label, "{message}");
}

fn log_bot_warning(label: &str, message: &str) {
    tracing::warn!(bot = %label, "{message}");
}

fn log_invalid_token(label: &str) {
    tracing::error!(
        bot = %label,
        "bot API rejected token (401), stopping this bot; other bots continue"
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::telegram::chat_context::{
        TELEGRAM_CHAT_CONTEXT_SCHEMA_VERSION, TELEGRAM_CHAT_CONTEXT_WRITER,
    };
    use serde_json::json;
    use std::sync::Mutex;

    struct FakeBotApi {
        bot_id: u64,
        username: Option<String>,
        scripted_updates: Mutex<Vec<Vec<Update>>>,
        scripted_errors: Mutex<Vec<Option<TelegramClientError>>>,
        get_updates_calls: Mutex<usize>,
        backlog_drained: Mutex<bool>,
        fail_invalid_token: bool,
        downloads_requested: Mutex<Vec<String>>,
        refresh_calls: Mutex<usize>,
    }

    impl FakeBotApi {
        fn new(scripts: Vec<Vec<Update>>) -> Self {
            let scripted_errors = scripts.iter().map(|_| None).collect::<Vec<_>>();
            Self {
                bot_id: 999,
                username: Some("tenex_bot".to_string()),
                scripted_updates: Mutex::new(scripts),
                scripted_errors: Mutex::new(scripted_errors),
                get_updates_calls: Mutex::new(0),
                backlog_drained: Mutex::new(false),
                fail_invalid_token: false,
                downloads_requested: Mutex::new(Vec::new()),
                refresh_calls: Mutex::new(0),
            }
        }

        fn with_invalid_token() -> Self {
            let mut fake = Self::new(vec![]);
            fake.fail_invalid_token = true;
            fake
        }
    }

    impl GatewayBotApi for FakeBotApi {
        fn get_me(&self) -> Result<BotIdentity, TelegramClientError> {
            if self.fail_invalid_token {
                return Err(TelegramClientError::InvalidToken);
            }
            Ok(BotIdentity {
                id: self.bot_id,
                username: self.username.clone(),
            })
        }

        fn get_updates(
            &self,
            _params: GetUpdatesParams,
        ) -> Result<Vec<Update>, TelegramClientError> {
            let mut calls = self.get_updates_calls.lock().unwrap();
            let call_index = *calls;
            *calls += 1;

            let mut scripted = self.scripted_updates.lock().unwrap();
            let mut errors = self.scripted_errors.lock().unwrap();

            // First call when we haven't drained backlog: return an empty
            // vec so `skip_backlog` returns quickly. Afterwards we serve
            // from the scripts.
            {
                let mut drained = self.backlog_drained.lock().unwrap();
                if !*drained {
                    *drained = true;
                    return Ok(Vec::new());
                }
            }

            if scripted.is_empty() {
                // No more scripted responses: block-equivalent by returning
                // empty so the loop naturally idles.
                return Ok(Vec::new());
            }

            let error_opt = errors.remove(0);
            let updates = scripted.remove(0);
            drop(scripted);
            drop(errors);
            if let Some(error) = error_opt {
                // Put the updates back at the head for the next successful
                // attempt. (Not strictly needed for current tests.)
                self.scripted_updates.lock().unwrap().insert(0, updates);
                eprintln!("[fake] returning error on call {call_index}");
                return Err(error);
            }
            Ok(updates)
        }

        fn download_media(
            &self,
            _daemon_dir: &Path,
            request: MediaDownloadRequest<'_>,
        ) -> Result<PathBuf, MediaDownloadError> {
            self.downloads_requested
                .lock()
                .unwrap()
                .push(request.file_id.to_string());
            Ok(PathBuf::from(format!(
                "/tmp/fake-media/{}.bin",
                request.file_unique_id
            )))
        }

        fn chat_context_refresh(
            &self,
            _daemon_dir: &Path,
            input: &RefreshChatContextInput<'_>,
        ) -> Result<ChatContextSnapshot, ChatContextError> {
            *self.refresh_calls.lock().unwrap() += 1;
            Ok(ChatContextSnapshot {
                schema_version: TELEGRAM_CHAT_CONTEXT_SCHEMA_VERSION,
                writer: TELEGRAM_CHAT_CONTEXT_WRITER.to_string(),
                writer_version: input.writer_version.to_string(),
                created_at: 1,
                updated_at: input.now_ms.max(1),
                chat_id: input.chat_id.to_string(),
                chat_type: None,
                chat_title: None,
                chat_username: None,
                member_count: None,
                administrators: Vec::new(),
                seen_participants: Vec::new(),
                topic_titles: std::collections::BTreeMap::new(),
                last_api_sync_at: Some(input.now_ms),
            })
        }

        fn command_client(&self) -> &dyn CommandBotClient {
            noop_command_client()
        }
    }

    fn private_text_update(update_id: i64, message_id: i64, text: &str) -> Update {
        let value = json!({
            "message_id": message_id,
            "date": 1_700_000_000,
            "from": {
                "id": 42,
                "is_bot": false,
                "first_name": "Alice",
                "username": "alice"
            },
            "chat": { "id": 42, "type": "private" },
            "text": text
        });
        Update {
            update_id,
            message: Some(value),
            edited_message: None,
            callback_query: None,
        }
    }

    fn test_config(
        tenex_base_dir: &Path,
        daemon_dir: &Path,
        data_dir: &Path,
    ) -> GatewayThreadConfig {
        GatewayThreadConfig {
            tenex_base_dir: tenex_base_dir.to_path_buf(),
            daemon_dir: daemon_dir.to_path_buf(),
            data_dir: data_dir.to_path_buf(),
            writer_version: "test@0".to_string(),
            long_poll_timeout_seconds: 0,
            poll_limit: 100,
            chat_context_api_sync_ttl_ms: 0,
            signer: None,
        }
    }

    struct NoopCommandClient;
    impl CommandBotClient for NoopCommandClient {
        fn send_message(
            &self,
            _params: crate::telegram::client::SendMessageParams,
        ) -> Result<crate::telegram::client::SentMessage, TelegramClientError> {
            Err(TelegramClientError::Http {
                status: 500,
                description: "test stub: send_message not implemented".to_string(),
            })
        }
        fn edit_message_text(
            &self,
            _params: crate::telegram::client::EditMessageTextParams,
        ) -> Result<crate::telegram::client::SentMessage, TelegramClientError> {
            Err(TelegramClientError::Http {
                status: 500,
                description: "test stub: edit_message_text not implemented".to_string(),
            })
        }
        fn answer_callback_query(
            &self,
            _params: crate::telegram::client::AnswerCallbackQueryParams,
        ) -> Result<(), TelegramClientError> {
            Err(TelegramClientError::Http {
                status: 500,
                description: "test stub: answer_callback_query not implemented".to_string(),
            })
        }
    }
    fn noop_command_client() -> &'static dyn CommandBotClient {
        static NOOP: NoopCommandClient = NoopCommandClient;
        &NOOP
    }

    #[derive(Default)]
    struct CollectingObserver {
        processed: Mutex<Vec<TelegramIngressRuntimeOutcome>>,
        errors: Mutex<Vec<String>>,
    }

    impl IngressObserver for CollectingObserver {
        fn on_processed(&self, _label: &str, outcome: TelegramIngressRuntimeOutcome) {
            self.processed.lock().unwrap().push(outcome);
        }
        fn on_error(&self, _label: &str, error: &TelegramIngressRuntimeError) {
            self.errors.lock().unwrap().push(error.to_string());
        }
    }

    fn test_bot() -> GatewayBot {
        GatewayBot {
            label: "test-bot".to_string(),
            agent_pubkey: "a".repeat(64),
            agent_name: "Alpha Agent".to_string(),
            bot_token: "TESTTOKEN".to_string(),
            api_base_url: None,
        }
    }

    #[test]
    fn process_one_refreshes_chat_context_and_forwards_to_ingress() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let update = private_text_update(1, 5, "hello");
        let api = Arc::new(FakeBotApi::new(vec![]));
        let observer_concrete: Arc<CollectingObserver> = Arc::new(CollectingObserver::default());
        let observer: Arc<dyn IngressObserver> = observer_concrete.clone();
        let bot = test_bot();
        let identity = BotIdentity {
            id: 999,
            username: Some("tenex_bot".to_string()),
        };
        process_one(
            &bot,
            &identity,
            &update,
            &api,
            &observer,
            &test_config(tmp.path(), tmp.path(), tmp.path()),
        );
        // Private DM still calls chat_context_refresh to persist the
        // snapshot; the refresh implementation handles the TTL/is_private
        // semantics internally.
        assert_eq!(*api.refresh_calls.lock().unwrap(), 1);
        // The ingress runtime gets called, but without the channel binding
        // on disk it will return Ignored{unbound_channel}. That's fine;
        // we're validating the pipeline wiring here, not routing.
        let processed = observer_concrete.processed.lock().unwrap();
        assert_eq!(processed.len(), 1);
        match &processed[0] {
            TelegramIngressRuntimeOutcome::Ignored { reason } => {
                assert_eq!(reason.code, "unbound_channel");
            }
            TelegramIngressRuntimeOutcome::Routed { .. } => {
                panic!("expected unbound_channel ignored");
            }
        }
    }

    #[test]
    fn process_one_absorbs_callback_queries_as_meta_ui_before_ingress() {
        // Slice 5: the gateway now dispatches callback queries through the
        // command handler, not the ingress runtime. With no signer
        // configured the command handler logs a warning and short-circuits;
        // crucially the ingress observer is never called, because callback
        // queries are meta-UI and never become envelopes.
        let tmp = tempfile::tempdir().expect("tempdir");
        let callback = json!({
            "id": "cb1",
            "from": { "id": 42, "is_bot": false, "first_name": "Alice" },
            "data": "tgcfg:session:save"
        });
        let update = Update {
            update_id: 2,
            message: None,
            edited_message: None,
            callback_query: Some(callback),
        };
        let api = Arc::new(FakeBotApi::new(vec![]));
        let observer_concrete: Arc<CollectingObserver> = Arc::new(CollectingObserver::default());
        let observer: Arc<dyn IngressObserver> = observer_concrete.clone();
        let bot = test_bot();
        let identity = BotIdentity {
            id: 999,
            username: None,
        };
        process_one(
            &bot,
            &identity,
            &update,
            &api,
            &observer,
            &test_config(tmp.path(), tmp.path(), tmp.path()),
        );
        assert_eq!(*api.refresh_calls.lock().unwrap(), 0);
        let processed = observer_concrete.processed.lock().unwrap();
        assert!(
            processed.is_empty(),
            "callback queries must not reach the ingress runtime: {processed:?}"
        );
    }

    #[test]
    fn skip_backlog_returns_next_offset_after_draining() {
        struct DrainBotApi {
            calls: Mutex<u32>,
        }
        impl GatewayBotApi for DrainBotApi {
            fn get_me(&self) -> Result<BotIdentity, TelegramClientError> {
                Ok(BotIdentity {
                    id: 1,
                    username: None,
                })
            }
            fn get_updates(
                &self,
                _params: GetUpdatesParams,
            ) -> Result<Vec<Update>, TelegramClientError> {
                let mut calls = self.calls.lock().unwrap();
                *calls += 1;
                match *calls {
                    1 => Ok(vec![
                        private_text_update(11, 1, "x"),
                        private_text_update(12, 2, "x"),
                    ]),
                    2 => Ok(vec![private_text_update(15, 3, "x")]),
                    _ => Ok(Vec::new()),
                }
            }
            fn download_media(
                &self,
                _: &Path,
                _: MediaDownloadRequest<'_>,
            ) -> Result<PathBuf, MediaDownloadError> {
                unreachable!()
            }
            fn chat_context_refresh(
                &self,
                _: &Path,
                _: &RefreshChatContextInput<'_>,
            ) -> Result<ChatContextSnapshot, ChatContextError> {
                unreachable!()
            }
            fn command_client(&self) -> &dyn CommandBotClient {
                noop_command_client()
            }
        }
        let api = DrainBotApi {
            calls: Mutex::new(0),
        };
        let stop_flag = AtomicBool::new(false);
        let offset = skip_backlog("t", &api, 100, &stop_flag).expect("ok");
        assert_eq!(offset, Some(16));
        assert_eq!(*api.calls.lock().unwrap(), 3);
    }

    #[test]
    fn skip_backlog_propagates_invalid_token() {
        struct InvalidApi;
        impl GatewayBotApi for InvalidApi {
            fn get_me(&self) -> Result<BotIdentity, TelegramClientError> {
                Ok(BotIdentity {
                    id: 1,
                    username: None,
                })
            }
            fn get_updates(&self, _: GetUpdatesParams) -> Result<Vec<Update>, TelegramClientError> {
                Err(TelegramClientError::InvalidToken)
            }
            fn download_media(
                &self,
                _: &Path,
                _: MediaDownloadRequest<'_>,
            ) -> Result<PathBuf, MediaDownloadError> {
                unreachable!()
            }
            fn chat_context_refresh(
                &self,
                _: &Path,
                _: &RefreshChatContextInput<'_>,
            ) -> Result<ChatContextSnapshot, ChatContextError> {
                unreachable!()
            }
            fn command_client(&self) -> &dyn CommandBotClient {
                noop_command_client()
            }
        }
        let api = InvalidApi;
        let stop_flag = AtomicBool::new(false);
        let error = skip_backlog("t", &api, 100, &stop_flag).expect_err("invalid");
        assert!(matches!(error, BacklogSkipError::InvalidToken));
    }

    #[test]
    fn run_gateway_loop_stops_on_invalid_token_without_running_forever() {
        let bot = test_bot();
        let api = Arc::new(FakeBotApi::with_invalid_token());
        let stop_flag = Arc::new(AtomicBool::new(false));
        let observer: Arc<dyn IngressObserver> = Arc::new(NoopIngressObserver);
        let tmp = tempfile::tempdir().expect("tempdir");
        // Running synchronously: getMe fails, loop exits immediately.
        run_gateway_loop(
            bot,
            api,
            observer,
            stop_flag.clone(),
            test_config(tmp.path(), tmp.path(), tmp.path()),
        );
        // Stop flag wasn't set by anyone, but the loop still terminated.
        assert!(!stop_flag.load(Ordering::SeqCst));
    }

    #[test]
    fn next_backoff_doubles_and_caps() {
        assert_eq!(next_backoff(Duration::from_secs(1)), Duration::from_secs(2));
        assert_eq!(
            next_backoff(Duration::from_secs(32)),
            Duration::from_secs(60)
        );
        assert_eq!(
            next_backoff(Duration::from_secs(90)),
            Duration::from_secs(60)
        );
    }

    #[test]
    fn sleep_with_stop_exits_early_when_flag_set() {
        let flag = Arc::new(AtomicBool::new(false));
        let flag_clone = flag.clone();
        let handle = thread::spawn(move || {
            thread::sleep(Duration::from_millis(50));
            flag_clone.store(true, Ordering::SeqCst);
        });
        let start = std::time::Instant::now();
        let completed = sleep_with_stop(&flag, Duration::from_secs(5));
        handle.join().unwrap();
        assert!(!completed);
        // Should not have waited anywhere near the 5s requested.
        assert!(start.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn supervisor_rejects_empty_bot_list() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config = GatewayConfig::new(
            dir.path().to_path_buf(),
            dir.path().to_path_buf(),
            dir.path().to_path_buf(),
        );
        let error = start_telegram_gateway(config, NoopIngressObserver).expect_err("should refuse");
        assert!(matches!(error, GatewayStartError::NoBots));
    }

    #[test]
    fn supervisor_request_stop_transitions_flag_without_blocking() {
        // We don't start a real HTTP-backed bot here because that would need
        // a live mock server lifetime; the drop-sets-stop-flag path is
        // validated through the explicit call.
        let stop_flag = Arc::new(AtomicBool::new(false));
        let supervisor = TelegramGatewaySupervisor {
            handles: Vec::new(),
            stop_flag: stop_flag.clone(),
        };
        supervisor.request_stop();
        assert!(stop_flag.load(Ordering::SeqCst));
        supervisor.join();
    }

    #[test]
    fn extract_media_target_prefers_voice_then_document() {
        let voice_update = json!({
            "message": {
                "voice": { "file_id": "vid", "file_unique_id": "vu", "duration": 3 },
                "document": { "file_id": "did", "file_unique_id": "du", "file_name": "ignored" }
            }
        });
        let target = extract_media_target(&voice_update).expect("voice");
        assert_eq!(target.media_type, InboundMediaType::Voice);
        assert_eq!(target.file_id, "vid");

        let document_update = json!({
            "message": {
                "document": { "file_id": "did", "file_unique_id": "du", "file_name": "readme.txt", "mime_type": "text/plain" }
            }
        });
        let target = extract_media_target(&document_update).expect("doc");
        assert_eq!(target.media_type, InboundMediaType::Document);
        assert_eq!(target.file_name.as_deref(), Some("readme.txt"));
        assert_eq!(target.mime_type.as_deref(), Some("text/plain"));
    }

    #[test]
    fn extract_chat_metadata_drops_channel_chats() {
        let update = json!({
            "update_id": 1,
            "message": {
                "message_id": 1,
                "from": { "id": 7, "is_bot": false, "first_name": "X" },
                "chat": { "id": -1003, "type": "channel" },
                "text": "x"
            }
        });
        assert!(extract_chat_metadata(&update).is_none());
    }
}
