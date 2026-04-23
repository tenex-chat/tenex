use std::fmt;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tracing;

use thiserror::Error;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, connect};
use url::Url;

use crate::nostr_classification::DaemonNostrEventClass;
use crate::nostr_subscription_tick::{
    NostrSubscriptionTickDiagnostics, NostrSubscriptionTickDispatch, NostrSubscriptionTickError,
    NostrSubscriptionTickIgnoredFrame, NostrSubscriptionTickInput,
    NostrSubscriptionTickProcessedEvent, run_nostr_subscription_intake_tick,
};
use crate::project_agent_whitelist::ingress::WhitelistIngress;
use crate::project_boot_state::ProjectBootState;
use crate::project_event_index::ProjectEventIndex;
use crate::relay_publisher::{
    RelayAuthSigner, RelayPublishError, build_auth_message, build_relay_auth_event,
};
use crate::subscription_filters::{
    NostrFilter, RelaySubscriptionFrame, build_close_message, build_req_message,
    parse_relay_subscription_message,
};
use crate::subscription_runtime::{
    NostrSubscriptionPlan, NostrSubscriptionPlanError, NostrSubscriptionPlanInput,
    build_nostr_subscription_plan,
};

pub const DEFAULT_SUBSCRIPTION_ID: &str = "tenex-main";
pub const DEFAULT_RELAY_READ_TIMEOUT: Duration = Duration::from_secs(5);
pub const DEFAULT_RECONNECT_BACKOFF: Duration = Duration::from_secs(2);

#[derive(Clone)]
pub struct NostrSubscriptionGatewayConfig {
    pub tenex_base_dir: PathBuf,
    pub daemon_dir: PathBuf,
    pub plan: NostrSubscriptionPlan,
    pub subscription_id: String,
    pub writer_version: String,
    pub relay_read_timeout: Duration,
    pub reconnect_backoff: Duration,
    pub auth_signer: Option<Arc<dyn RelayAuthSigner + Send + Sync>>,
    pub whitelist_ingress: Option<Arc<WhitelistIngress>>,
    pub project_boot_state: Arc<Mutex<ProjectBootState>>,
    pub project_event_index: Arc<Mutex<ProjectEventIndex>>,
}

impl NostrSubscriptionGatewayConfig {
    pub fn new(tenex_base_dir: PathBuf, daemon_dir: PathBuf, plan: NostrSubscriptionPlan) -> Self {
        Self {
            tenex_base_dir,
            daemon_dir,
            plan,
            subscription_id: DEFAULT_SUBSCRIPTION_ID.to_string(),
            writer_version: format!("tenex-daemon@{}", env!("CARGO_PKG_VERSION")),
            relay_read_timeout: DEFAULT_RELAY_READ_TIMEOUT,
            reconnect_backoff: DEFAULT_RECONNECT_BACKOFF,
            auth_signer: None,
            whitelist_ingress: None,
            project_boot_state: Arc::new(Mutex::new(ProjectBootState::new())),
            project_event_index: Arc::new(Mutex::new(ProjectEventIndex::new())),
        }
    }

    pub fn with_auth_signer<S>(mut self, auth_signer: S) -> Self
    where
        S: RelayAuthSigner + Send + Sync + 'static,
    {
        self.auth_signer = Some(Arc::new(auth_signer));
        self
    }

    pub fn with_whitelist_ingress(mut self, whitelist_ingress: Arc<WhitelistIngress>) -> Self {
        self.whitelist_ingress = Some(whitelist_ingress);
        self
    }

    pub fn with_project_boot_state(
        mut self,
        project_boot_state: Arc<Mutex<ProjectBootState>>,
    ) -> Self {
        self.project_boot_state = project_boot_state;
        self
    }
}

impl fmt::Debug for NostrSubscriptionGatewayConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NostrSubscriptionGatewayConfig")
            .field("tenex_base_dir", &self.tenex_base_dir)
            .field("daemon_dir", &self.daemon_dir)
            .field("plan", &self.plan)
            .field("subscription_id", &self.subscription_id)
            .field("writer_version", &self.writer_version)
            .field("relay_read_timeout", &self.relay_read_timeout)
            .field("reconnect_backoff", &self.reconnect_backoff)
            .field("auth_signer_configured", &self.auth_signer.is_some())
            .field(
                "whitelist_ingress_configured",
                &self.whitelist_ingress.is_some(),
            )
            .finish()
    }
}

pub trait NostrSubscriptionObserver: Send + Sync {
    fn on_tick(&self, _relay_url: &str, _diagnostics: &NostrSubscriptionTickDiagnostics) {}
    fn on_batch(&self, relay_url: &str, diagnostics: NostrSubscriptionTickDiagnostics);
    fn on_error(&self, relay_url: &str, error: &NostrSubscriptionRelayError);
}

pub struct NoopNostrSubscriptionObserver;

impl NostrSubscriptionObserver for NoopNostrSubscriptionObserver {
    fn on_batch(&self, _relay_url: &str, _diagnostics: NostrSubscriptionTickDiagnostics) {}
    fn on_error(&self, _relay_url: &str, _error: &NostrSubscriptionRelayError) {}
}

#[derive(Debug, Error)]
pub enum NostrSubscriptionGatewayStartError {
    #[error("nostr subscription plan has no relay urls")]
    NoRelays,
    #[error("nostr subscription plan has no filters")]
    NoFilters,
    #[error("relay url must use ws:// or wss://: {url}")]
    InvalidRelayUrl { url: String },
}

#[derive(Debug)]
pub struct NostrSubscriptionGatewaySupervisor {
    handles: Vec<JoinHandle<()>>,
    stop_flag: Arc<AtomicBool>,
}

impl NostrSubscriptionGatewaySupervisor {
    pub fn request_stop(&self) {
        self.stop_flag.store(true, Ordering::SeqCst);
    }

    pub fn join(mut self) {
        let handles = std::mem::take(&mut self.handles);
        for handle in handles {
            let _ = handle.join();
        }
    }

    pub fn stop_flag(&self) -> Arc<AtomicBool> {
        self.stop_flag.clone()
    }
}

impl Drop for NostrSubscriptionGatewaySupervisor {
    fn drop(&mut self) {
        self.stop_flag.store(true, Ordering::SeqCst);
    }
}

pub fn start_nostr_subscription_gateway<O>(
    config: NostrSubscriptionGatewayConfig,
    observer: O,
) -> Result<NostrSubscriptionGatewaySupervisor, NostrSubscriptionGatewayStartError>
where
    O: NostrSubscriptionObserver + 'static,
{
    if config.plan.relay_urls.is_empty() {
        return Err(NostrSubscriptionGatewayStartError::NoRelays);
    }
    if config.plan.filters.is_empty() {
        return Err(NostrSubscriptionGatewayStartError::NoFilters);
    }

    for relay_url in &config.plan.relay_urls {
        validate_relay_url(relay_url)?;
    }

    let stop_flag = Arc::new(AtomicBool::new(false));
    let observer: Arc<dyn NostrSubscriptionObserver> = Arc::new(observer);
    let mut handles = Vec::with_capacity(config.plan.relay_urls.len());

    for relay_url in &config.plan.relay_urls {
        let handle = spawn_relay_thread(
            relay_url.clone(),
            config.clone(),
            observer.clone(),
            stop_flag.clone(),
        );
        handles.push(handle);
    }

    Ok(NostrSubscriptionGatewaySupervisor { handles, stop_flag })
}

fn spawn_relay_thread(
    relay_url: String,
    config: NostrSubscriptionGatewayConfig,
    observer: Arc<dyn NostrSubscriptionObserver>,
    stop_flag: Arc<AtomicBool>,
) -> JoinHandle<()> {
    thread::Builder::new()
        .name(format!("nostr-subscription:{relay_url}"))
        .spawn(move || run_relay_loop(relay_url, config, observer, stop_flag))
        .expect("spawn nostr subscription gateway thread")
}

fn run_relay_loop(
    relay_url: String,
    config: NostrSubscriptionGatewayConfig,
    observer: Arc<dyn NostrSubscriptionObserver>,
    stop_flag: Arc<AtomicBool>,
) {
    tracing::info!(relay_url = %relay_url, "nostr relay thread started");
    while !stop_flag.load(Ordering::SeqCst) {
        let _span = tracing::info_span!("relay.connect", relay_url = %relay_url).entered();
        let result = run_nostr_subscription_relay_once(NostrSubscriptionRelayInput {
            tenex_base_dir: &config.tenex_base_dir,
            daemon_dir: &config.daemon_dir,
            relay_url: &relay_url,
            subscription_id: &config.subscription_id,
            filters: &config.plan.filters,
            writer_version: &config.writer_version,
            read_timeout: config.relay_read_timeout,
            stop_after_eose: false,
            max_messages: None,
            auth_signer: config
                .auth_signer
                .as_ref()
                .map(|signer| signer.as_ref() as &dyn RelayAuthSigner),
            stop_flag: &stop_flag,
            whitelist_ingress: config.whitelist_ingress.as_deref(),
            project_boot_state: Some(&config.project_boot_state),
            project_event_index: &config.project_event_index,
            observer: Some(observer.as_ref()),
        });
        drop(_span);

        match result {
            Ok(diagnostics) => {
                tracing::debug!(
                    relay_url = %relay_url,
                    raw_message_count = diagnostics.raw_message_count,
                    processed_events = diagnostics.processed_events.len(),
                    "relay session ended cleanly"
                );
                observer.on_batch(&relay_url, diagnostics);
            }
            Err(error) => {
                tracing::warn!(
                    relay_url = %relay_url,
                    backoff_ms = config.reconnect_backoff.as_millis(),
                    error = %error,
                    "relay disconnected, reconnecting after backoff"
                );
                observer.on_error(&relay_url, &error);
            }
        }

        sleep_with_stop(&stop_flag, config.reconnect_backoff);
    }
    tracing::info!(relay_url = %relay_url, "nostr relay thread stopped");
}

#[derive(Clone, Copy)]
pub struct NostrSubscriptionRelayInput<'a> {
    pub tenex_base_dir: &'a Path,
    pub daemon_dir: &'a Path,
    pub relay_url: &'a str,
    pub subscription_id: &'a str,
    pub filters: &'a [NostrFilter],
    pub writer_version: &'a str,
    pub read_timeout: Duration,
    pub stop_after_eose: bool,
    pub max_messages: Option<usize>,
    pub auth_signer: Option<&'a dyn RelayAuthSigner>,
    pub stop_flag: &'a AtomicBool,
    pub whitelist_ingress: Option<&'a WhitelistIngress>,
    pub project_boot_state: Option<&'a Arc<Mutex<ProjectBootState>>>,
    pub project_event_index: &'a Arc<Mutex<ProjectEventIndex>>,
    pub observer: Option<&'a dyn NostrSubscriptionObserver>,
}

impl fmt::Debug for NostrSubscriptionRelayInput<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NostrSubscriptionRelayInput")
            .field("tenex_base_dir", &self.tenex_base_dir)
            .field("daemon_dir", &self.daemon_dir)
            .field("relay_url", &self.relay_url)
            .field("subscription_id", &self.subscription_id)
            .field("filters", &self.filters)
            .field("writer_version", &self.writer_version)
            .field("read_timeout", &self.read_timeout)
            .field("stop_after_eose", &self.stop_after_eose)
            .field("max_messages", &self.max_messages)
            .field("auth_signer_configured", &self.auth_signer.is_some())
            .field(
                "whitelist_ingress_configured",
                &self.whitelist_ingress.is_some(),
            )
            .field("observer_configured", &self.observer.is_some())
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Error)]
pub enum NostrSubscriptionRelayError {
    #[error("relay url must use ws:// or wss://: {url}")]
    InvalidRelayUrl { url: String },
    #[error("nostr subscription has no filters")]
    EmptyFilters,
    #[error("websocket error: {0}")]
    WebSocket(#[from] tungstenite::Error),
    #[error("nostr subscription frame json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("nostr subscription tick failed: {0}")]
    Tick(#[from] NostrSubscriptionTickError),
    #[error("nostr subscription plan refresh failed: {0}")]
    Plan(#[from] NostrSubscriptionPlanError),
    #[error("relay requires AUTH but no relay auth signer is configured")]
    AuthRequiredWithoutSigner,
    #[error("relay AUTH failed: {0}")]
    RelayAuth(#[from] RelayPublishError),
}

pub fn run_nostr_subscription_relay_once(
    input: NostrSubscriptionRelayInput<'_>,
) -> Result<NostrSubscriptionTickDiagnostics, NostrSubscriptionRelayError> {
    validate_relay_url(input.relay_url).map_err(|_| {
        NostrSubscriptionRelayError::InvalidRelayUrl {
            url: input.relay_url.to_string(),
        }
    })?;
    if input.filters.is_empty() {
        return Err(NostrSubscriptionRelayError::EmptyFilters);
    }

    tracing::debug!(relay_url = %input.relay_url, subscription_id = %input.subscription_id, "connecting to relay");
    let (mut socket, _) = connect(input.relay_url)?;
    set_stream_timeouts(socket.get_mut(), input.read_timeout);
    let mut active_filters = input.filters.to_vec();
    let refresh_since = subscription_refresh_since(&active_filters);
    socket.send(Message::text(build_req_message(
        input.subscription_id,
        &active_filters,
    )?))?;

    // NIP-42 AUTH state machine. Khatru-based relays handle each incoming
    // websocket message in a separate goroutine, so the post-AUTH REQ races
    // the AUTH event commit. If the REQ is processed before the AUTH commit,
    // the relay's `GetAuthed(ctx)` returns "" and the historical-query replay
    // guard records the same key as the pre-AUTH (rejected) REQ; the next
    // identical REQ — including the authenticated one — is then treated as a
    // duplicate and served zero stored events for restricted kinds (e.g.
    // kind:31933). To avoid that race, we send the AUTH event on the first
    // challenge, wait for the relay's OK acknowledgement (which is emitted
    // synchronously from the AUTH-handling goroutine after `AuthedPublicKey`
    // is set), and only then re-send the REQ. Subsequent AUTH challenges on
    // the same connection are ignored — one AUTH suffices for all filters.
    enum AuthState {
        NotChallenged,
        AwaitingOk { auth_event_id: String },
        Authenticated,
    }
    let mut auth_state = AuthState::NotChallenged;

    let mut diagnostics = empty_diagnostics(input.subscription_id, input.relay_url);

    while !input.stop_flag.load(Ordering::SeqCst)
        && input
            .max_messages
            .is_none_or(|max| diagnostics.raw_message_count < max)
    {
        let message = match socket.read() {
            Ok(message) => message,
            Err(error) if is_timeout_error(&error) => continue,
            Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => {
                break;
            }
            Err(error) => return Err(NostrSubscriptionRelayError::WebSocket(error)),
        };

        match message {
            Message::Text(text) => {
                let auth_challenge = auth_challenge_from_text_frame(text.as_str());
                let stop_after_this_frame = should_stop_after_text_frame(
                    text.as_str(),
                    input.subscription_id,
                    input.stop_after_eose,
                );
                let frame_index = diagnostics.raw_message_count;
                let raw_message = text.to_string();
                let raw_messages = [raw_message.as_str()];
                let tick = run_nostr_subscription_intake_tick(NostrSubscriptionTickInput {
                    tenex_base_dir: input.tenex_base_dir,
                    daemon_dir: input.daemon_dir,
                    planned_subscription_id: input.subscription_id,
                    source_relay: input.relay_url,
                    raw_messages: &raw_messages,
                    timestamp: current_unix_time_ms(),
                    writer_version: input.writer_version,
                    whitelist_ingress: input.whitelist_ingress,
                    project_boot_state: input.project_boot_state,
                    project_event_index: input.project_event_index,
                })?;
                if let Some(observer) = input.observer {
                    observer.on_tick(input.relay_url, &tick);
                }
                for event in &tick.processed_events {
                    tracing::debug!(
                        relay_url = %input.relay_url,
                        event_id = %event.event_id,
                        event_kind = event.kind,
                        event_pubkey = %event.pubkey,
                        class = ?event.class,
                        "nostr event received"
                    );
                }
                for dispatch in &tick.dispatches {
                    match dispatch {
                        crate::nostr_subscription_tick::NostrSubscriptionTickDispatch::Queued {
                            event_id,
                            dispatch_id,
                            project_id,
                            agent_pubkey,
                            conversation_id,
                            queued,
                            already_existed,
                            ..
                        } => {
                            tracing::info!(
                                relay_url = %input.relay_url,
                                event_id = %event_id,
                                dispatch_id = %dispatch_id,
                                project_id = %project_id,
                                agent_pubkey = %agent_pubkey,
                                conversation_id = %conversation_id,
                                queued = *queued,
                                already_existed = *already_existed,
                                "inbound nostr event dispatched"
                            );
                        }
                        crate::nostr_subscription_tick::NostrSubscriptionTickDispatch::Ignored {
                            event_id,
                            code,
                            detail,
                            class,
                            project_id,
                            pubkeys,
                            dispatch_id,
                            ..
                        } => {
                            tracing::info!(
                                relay_url = %input.relay_url,
                                event_id = %event_id,
                                code = %code,
                                detail = %detail,
                                class = ?class,
                                project_id = ?project_id,
                                pubkeys = ?pubkeys,
                                dispatch_id = ?dispatch_id,
                                "inbound nostr event ignored"
                            );
                        }
                    }
                }
                if let Some(challenge) = auth_challenge {
                    match &auth_state {
                        AuthState::NotChallenged => {
                            tracing::debug!(relay_url = %input.relay_url, "relay sent AUTH challenge, authenticating");
                            let auth_signer = input
                                .auth_signer
                                .ok_or(NostrSubscriptionRelayError::AuthRequiredWithoutSigner)?;
                            let auth_event = build_relay_auth_event(
                                input.relay_url,
                                &challenge,
                                auth_signer,
                                current_unix_time_ms() / 1_000,
                            )?;
                            let auth_event_id = auth_event.id.clone();
                            socket.send(Message::text(build_auth_message(&auth_event)?))?;
                            auth_state = AuthState::AwaitingOk { auth_event_id };
                        }
                        AuthState::AwaitingOk { .. } | AuthState::Authenticated => {
                            tracing::debug!(
                                relay_url = %input.relay_url,
                                "ignoring duplicate AUTH challenge"
                            );
                        }
                    }
                }
                if let AuthState::AwaitingOk { auth_event_id } = &auth_state
                    && is_ok_frame_for(text.as_str(), auth_event_id)
                {
                    socket.send(Message::text(build_req_message(
                        input.subscription_id,
                        &active_filters,
                    )?))?;
                    auth_state = AuthState::Authenticated;
                    tracing::info!(relay_url = %input.relay_url, "relay authenticated, resubscribed");
                }
                if should_refresh_subscription_filters(&tick) {
                    refresh_subscription_filters(
                        &mut socket,
                        input,
                        &mut active_filters,
                        refresh_since,
                    )?;
                }
                append_tick_diagnostics(&mut diagnostics, tick, frame_index);
                if stop_after_this_frame {
                    break;
                }
            }
            Message::Ping(payload) => {
                socket.send(Message::Pong(payload))?;
            }
            Message::Close(_) => break,
            Message::Binary(_) | Message::Pong(_) | Message::Frame(_) => {}
        }
    }

    let _ = socket.send(Message::text(build_close_message(input.subscription_id)?));
    let _ = socket.close(None);

    Ok(diagnostics)
}

fn refresh_subscription_filters(
    socket: &mut tungstenite::WebSocket<MaybeTlsStream<TcpStream>>,
    input: NostrSubscriptionRelayInput<'_>,
    active_filters: &mut Vec<NostrFilter>,
    since: Option<u64>,
) -> Result<(), NostrSubscriptionRelayError> {
    let refreshed = build_nostr_subscription_plan(NostrSubscriptionPlanInput {
        tenex_base_dir: input.tenex_base_dir,
        since,
        lesson_definition_ids: &[],
        project_event_index: input.project_event_index,
    })?;
    if refreshed.filters.is_empty() || refreshed.filters == *active_filters {
        return Ok(());
    }

    socket.send(Message::text(build_close_message(input.subscription_id)?))?;
    socket.send(Message::text(build_req_message(
        input.subscription_id,
        &refreshed.filters,
    )?))?;

    tracing::info!(
        relay_url = %input.relay_url,
        subscription_id = %input.subscription_id,
        old_filter_count = active_filters.len(),
        new_filter_count = refreshed.filters.len(),
        project_address_count = refreshed.project_addresses.len(),
        agent_pubkey_count = refreshed.agent_pubkeys.len(),
        "nostr subscription filters refreshed"
    );

    *active_filters = refreshed.filters;
    Ok(())
}

fn should_refresh_subscription_filters(tick: &NostrSubscriptionTickDiagnostics) -> bool {
    tick.processed_events.iter().any(|event| {
        matches!(
            event.class,
            DaemonNostrEventClass::Project
                | DaemonNostrEventClass::AgentCreate
                | DaemonNostrEventClass::ConfigUpdate
        )
    })
}

fn subscription_refresh_since(filters: &[NostrFilter]) -> Option<u64> {
    filters.iter().filter_map(|filter| filter.since).min()
}

fn auth_challenge_from_text_frame(message: &str) -> Option<String> {
    match parse_relay_subscription_message(message) {
        Ok(RelaySubscriptionFrame::Auth { challenge }) => Some(challenge),
        _ => None,
    }
}

/// Returns true when `message` is a NIP-20 `["OK", <event_id>, true, ...]`
/// acknowledgement for the given event id. The relay emits this synchronously
/// from the same goroutine that commits `AuthedPublicKey` for an `AUTH`
/// envelope, so observing the OK is a sufficient signal that subsequent
/// queries on the same connection will see the authenticated identity.
fn is_ok_frame_for(message: &str, expected_event_id: &str) -> bool {
    let value: serde_json::Value = match serde_json::from_str(message) {
        Ok(value) => value,
        Err(_) => return false,
    };
    let frame = match value.as_array() {
        Some(frame) => frame,
        None => return false,
    };
    if frame.first().and_then(serde_json::Value::as_str) != Some("OK") {
        return false;
    }
    if frame.get(1).and_then(serde_json::Value::as_str) != Some(expected_event_id) {
        return false;
    }
    frame.get(2).and_then(serde_json::Value::as_bool) == Some(true)
}

fn empty_diagnostics(subscription_id: &str, relay_url: &str) -> NostrSubscriptionTickDiagnostics {
    NostrSubscriptionTickDiagnostics {
        planned_subscription_id: subscription_id.to_string(),
        source_relay: relay_url.to_string(),
        raw_message_count: 0,
        processed_events: Vec::new(),
        ignored_frames: Vec::new(),
        dispatches: Vec::new(),
    }
}

fn append_tick_diagnostics(
    diagnostics: &mut NostrSubscriptionTickDiagnostics,
    tick: NostrSubscriptionTickDiagnostics,
    frame_offset: usize,
) {
    diagnostics.raw_message_count += tick.raw_message_count;
    diagnostics.processed_events.extend(
        tick.processed_events
            .into_iter()
            .map(|event| shift_processed_event(event, frame_offset)),
    );
    diagnostics.ignored_frames.extend(
        tick.ignored_frames
            .into_iter()
            .map(|frame| shift_ignored_frame(frame, frame_offset)),
    );
    diagnostics.dispatches.extend(
        tick.dispatches
            .into_iter()
            .map(|dispatch| shift_dispatch(dispatch, frame_offset)),
    );
}

fn shift_processed_event(
    mut event: NostrSubscriptionTickProcessedEvent,
    frame_offset: usize,
) -> NostrSubscriptionTickProcessedEvent {
    event.frame_index += frame_offset;
    event
}

fn shift_ignored_frame(
    mut frame: NostrSubscriptionTickIgnoredFrame,
    frame_offset: usize,
) -> NostrSubscriptionTickIgnoredFrame {
    frame.frame_index += frame_offset;
    frame
}

fn shift_dispatch(
    dispatch: NostrSubscriptionTickDispatch,
    frame_offset: usize,
) -> NostrSubscriptionTickDispatch {
    match dispatch {
        NostrSubscriptionTickDispatch::Queued {
            frame_index,
            event_id,
            dispatch_id,
            project_id,
            agent_pubkey,
            conversation_id,
            queued,
            already_existed,
        } => NostrSubscriptionTickDispatch::Queued {
            frame_index: frame_index + frame_offset,
            event_id,
            dispatch_id,
            project_id,
            agent_pubkey,
            conversation_id,
            queued,
            already_existed,
        },
        NostrSubscriptionTickDispatch::Ignored {
            frame_index,
            event_id,
            code,
            detail,
            class,
            project_id,
            pubkeys,
            dispatch_id,
        } => NostrSubscriptionTickDispatch::Ignored {
            frame_index: frame_index + frame_offset,
            event_id,
            code,
            detail,
            class,
            project_id,
            pubkeys,
            dispatch_id,
        },
    }
}

fn should_stop_after_text_frame(
    message: &str,
    subscription_id: &str,
    stop_after_eose: bool,
) -> bool {
    if !stop_after_eose {
        return false;
    }

    matches!(
        parse_relay_subscription_message(message),
        Ok(RelaySubscriptionFrame::Eose {
            subscription_id: frame_subscription_id
        }) if frame_subscription_id == subscription_id
    )
}

fn validate_relay_url(relay_url: &str) -> Result<(), NostrSubscriptionGatewayStartError> {
    let parsed =
        Url::parse(relay_url).map_err(|_| NostrSubscriptionGatewayStartError::InvalidRelayUrl {
            url: relay_url.to_string(),
        })?;
    if parsed.host_str().is_none() || !matches!(parsed.scheme(), "ws" | "wss") {
        return Err(NostrSubscriptionGatewayStartError::InvalidRelayUrl {
            url: relay_url.to_string(),
        });
    }
    Ok(())
}

fn set_stream_timeouts(stream: &mut MaybeTlsStream<TcpStream>, timeout: Duration) {
    match stream {
        MaybeTlsStream::Plain(tcp_stream) => {
            let _ = tcp_stream.set_read_timeout(Some(timeout));
            let _ = tcp_stream.set_write_timeout(Some(timeout));
        }
        MaybeTlsStream::Rustls(tls_stream) => {
            let _ = tls_stream.sock.set_read_timeout(Some(timeout));
            let _ = tls_stream.sock.set_write_timeout(Some(timeout));
        }
        _ => {}
    }
}

fn is_timeout_error(error: &tungstenite::Error) -> bool {
    matches!(
        error,
        tungstenite::Error::Io(io_error)
            if matches!(
                io_error.kind(),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
            )
    )
}

fn sleep_with_stop(stop_flag: &AtomicBool, duration: Duration) {
    let poll_interval = Duration::from_millis(100);
    let mut slept = Duration::ZERO;
    while slept < duration && !stop_flag.load(Ordering::SeqCst) {
        let remaining = duration.saturating_sub(slept);
        let step = remaining.min(poll_interval);
        thread::sleep(step);
        slept += step;
    }
}

fn current_unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend_signer::HexBackendSigner;
    use crate::dispatch_queue::replay_dispatch_queue;
    use crate::nostr_event::{
        NormalizedNostrEvent, SignedNostrEvent, canonical_payload, event_hash_hex,
        verify_signed_event,
    };
    use secp256k1::{Keypair, Secp256k1, SecretKey};
    use serde_json::{Value, json};
    use std::fs;
    use std::net::TcpListener;
    use std::sync::mpsc::{Receiver, channel};
    use std::time::Duration;
    use tempfile::tempdir;

    const TEST_SECRET_KEY_HEX: &str =
        "0101010101010101010101010101010101010101010101010101010101010101";
    const AUTH_CHALLENGE: &str = "subscription-auth-challenge-01";

    #[test]
    fn relay_once_sends_req_consumes_event_and_closes_subscription() {
        let temp_dir = tempdir().expect("temp dir must create");
        let base_dir = temp_dir.path();
        let daemon_dir = base_dir.join("daemon");
        let owner = pubkey_hex(0x11);
        let agent = pubkey_hex(0x21);
        write_project(base_dir, "project-alpha", &owner, "/repo/alpha");
        write_agent_index(base_dir, "project-alpha", &[&agent]);
        write_agent(base_dir, &agent, "alpha-agent");

        let event = signed_event(
            0x31,
            1,
            vec![vec!["p".to_string(), agent.clone()]],
            "hello from relay",
            1_710_001_100,
        );
        let relay = MockSubscriptionRelay::start(vec![
            json!(["EVENT", DEFAULT_SUBSCRIPTION_ID, event.clone()]),
            json!(["EOSE", DEFAULT_SUBSCRIPTION_ID]),
        ]);
        let stop_flag = AtomicBool::new(false);

        let diagnostics = run_nostr_subscription_relay_once(NostrSubscriptionRelayInput {
            tenex_base_dir: base_dir,
            daemon_dir: &daemon_dir,
            relay_url: &relay.url,
            subscription_id: DEFAULT_SUBSCRIPTION_ID,
            filters: &[NostrFilter {
                pubkeys: vec![agent.clone()],
                ..NostrFilter::default()
            }],
            writer_version: "nostr-subscription-gateway-test@0",
            read_timeout: Duration::from_secs(2),
            stop_after_eose: true,
            max_messages: None,
            auth_signer: None,
            stop_flag: &stop_flag,
            whitelist_ingress: None,
            project_boot_state: None,
            observer: None,
        })
        .expect("relay subscription must drain");

        assert_eq!(diagnostics.raw_message_count, 2);
        assert_eq!(diagnostics.processed_events.len(), 1);
        assert_eq!(diagnostics.processed_events[0].event_id, event.id);
        assert_eq!(diagnostics.ignored_frames.len(), 1);
        assert_eq!(diagnostics.ignored_frames[0].code, "eose");

        let queue = replay_dispatch_queue(&daemon_dir).expect("dispatch queue must replay");
        assert_eq!(queue.queued.len(), 1);
        assert_eq!(queue.queued[0].triggering_event_id, event.id);

        let captured = relay.join();
        assert_eq!(captured.req[0], "REQ");
        assert_eq!(captured.req[1], DEFAULT_SUBSCRIPTION_ID);
        assert_eq!(
            captured.close,
            Some(json!(["CLOSE", DEFAULT_SUBSCRIPTION_ID]))
        );
    }

    #[test]
    fn relay_once_authenticates_and_resubscribes_after_auth_challenge() {
        let temp_dir = tempdir().expect("temp dir must create");
        let base_dir = temp_dir.path();
        let daemon_dir = base_dir.join("daemon");
        let owner = pubkey_hex(0x11);
        let agent = pubkey_hex(0x21);
        write_project(base_dir, "project-alpha", &owner, "/repo/alpha");
        write_agent_index(base_dir, "project-alpha", &[&agent]);
        write_agent(base_dir, &agent, "alpha-agent");

        let event = signed_event(
            0x31,
            1,
            vec![vec!["p".to_string(), agent.clone()]],
            "hello after auth",
            1_710_001_100,
        );
        let relay = MockAuthSubscriptionRelay::start(vec![
            json!(["EVENT", DEFAULT_SUBSCRIPTION_ID, event.clone()]),
            json!(["EOSE", DEFAULT_SUBSCRIPTION_ID]),
        ]);
        let relay_url = relay.url.clone();
        let stop_flag = AtomicBool::new(false);
        let signer = HexBackendSigner::from_private_key_hex(TEST_SECRET_KEY_HEX)
            .expect("test signer must load");

        let diagnostics = run_nostr_subscription_relay_once(NostrSubscriptionRelayInput {
            tenex_base_dir: base_dir,
            daemon_dir: &daemon_dir,
            relay_url: &relay.url,
            subscription_id: DEFAULT_SUBSCRIPTION_ID,
            filters: &[NostrFilter {
                pubkeys: vec![agent.clone()],
                ..NostrFilter::default()
            }],
            writer_version: "nostr-subscription-gateway-test@0",
            read_timeout: Duration::from_secs(2),
            stop_after_eose: true,
            max_messages: None,
            auth_signer: Some(&signer),
            stop_flag: &stop_flag,
            whitelist_ingress: None,
            project_boot_state: None,
            observer: None,
        })
        .expect("relay subscription must authenticate and drain");

        assert_eq!(diagnostics.raw_message_count, 3);
        assert_eq!(diagnostics.processed_events.len(), 1);
        assert_eq!(diagnostics.processed_events[0].event_id, event.id);
        assert_eq!(diagnostics.ignored_frames.len(), 2);
        assert!(
            diagnostics
                .ignored_frames
                .iter()
                .any(|frame| frame.code == "auth")
        );
        assert!(
            diagnostics
                .ignored_frames
                .iter()
                .any(|frame| frame.code == "eose")
        );

        let queue = replay_dispatch_queue(&daemon_dir).expect("dispatch queue must replay");
        assert_eq!(queue.queued.len(), 1);
        assert_eq!(queue.queued[0].triggering_event_id, event.id);

        let captured = relay.join();
        assert_eq!(captured.initial_req[0], "REQ");
        assert_eq!(captured.initial_req[1], DEFAULT_SUBSCRIPTION_ID);
        assert_eq!(captured.retried_req, captured.initial_req);
        assert_eq!(captured.auth[0], "AUTH");
        let auth_event: SignedNostrEvent =
            serde_json::from_value(captured.auth[1].clone()).expect("AUTH event must decode");
        assert_eq!(auth_event.pubkey, signer.pubkey_hex());
        assert_eq!(auth_event.kind, 22242);
        assert_eq!(auth_event.content, "");
        assert!(
            auth_event
                .tags
                .contains(&vec!["relay".to_string(), relay_url])
        );
        assert!(
            auth_event
                .tags
                .contains(&vec!["challenge".to_string(), AUTH_CHALLENGE.to_string()])
        );
        verify_signed_event(&auth_event).expect("AUTH event signature must verify");
        assert_eq!(
            captured.close,
            Some(json!(["CLOSE", DEFAULT_SUBSCRIPTION_ID]))
        );
    }

    #[test]
    fn start_gateway_rejects_empty_plan() {
        let temp_dir = tempdir().expect("temp dir must create");
        let base_dir = temp_dir.path().to_path_buf();
        let plan = NostrSubscriptionPlan {
            relay_urls: vec!["ws://127.0.0.1:1".to_string()],
            whitelisted_pubkeys: Vec::new(),
            project_addresses: Vec::new(),
            agent_pubkeys: Vec::new(),
            filters: Vec::new(),
            static_filters: Vec::new(),
            project_tagged_filter: None,
            agent_mentions_filter: None,
            project_agent_snapshot_filter: None,
            nip46_reply_filter: None,
            lesson_filters: Vec::new(),
        };

        let error = start_nostr_subscription_gateway(
            NostrSubscriptionGatewayConfig::new(base_dir.clone(), base_dir.join("daemon"), plan),
            NoopNostrSubscriptionObserver,
        )
        .expect_err("empty filters must not start");

        assert!(matches!(
            error,
            NostrSubscriptionGatewayStartError::NoFilters
        ));
    }

    struct CapturedRelayFrames {
        req: Value,
        close: Option<Value>,
    }

    struct CapturedAuthRelayFrames {
        initial_req: Value,
        auth: Value,
        retried_req: Value,
        close: Option<Value>,
    }

    struct MockSubscriptionRelay {
        url: String,
        captured: Receiver<CapturedRelayFrames>,
        handle: JoinHandle<()>,
    }

    struct MockAuthSubscriptionRelay {
        url: String,
        captured: Receiver<CapturedAuthRelayFrames>,
        handle: JoinHandle<()>,
    }

    impl MockSubscriptionRelay {
        fn start(frames_to_send: Vec<Value>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").expect("mock relay must bind");
            let url = format!(
                "ws://{}",
                listener.local_addr().expect("mock relay addr must exist")
            );
            let (sender, receiver) = channel();
            let handle = thread::spawn(move || {
                let (stream, _) = listener.accept().expect("mock relay must accept");
                let mut websocket =
                    tungstenite::accept(stream).expect("mock relay handshake must succeed");
                let req_message = websocket.read().expect("mock relay must read REQ");
                let req = serde_json::from_str(
                    req_message.to_text().expect("mock relay REQ must be text"),
                )
                .expect("mock relay REQ must be json");
                for frame in frames_to_send {
                    websocket
                        .send(Message::text(
                            serde_json::to_string(&frame).expect("frame must serialize"),
                        ))
                        .expect("mock relay must send frame");
                }
                let close_message = websocket
                    .read()
                    .expect("mock relay must read CLOSE before websocket close");
                let close = close_message
                    .to_text()
                    .ok()
                    .and_then(|text| serde_json::from_str(text).ok());
                sender
                    .send(CapturedRelayFrames { req, close })
                    .expect("captured frames must send");
            });

            Self {
                url,
                captured: receiver,
                handle,
            }
        }

        fn join(self) -> CapturedRelayFrames {
            let captured = self
                .captured
                .recv_timeout(Duration::from_secs(2))
                .expect("mock relay must capture frames");
            self.handle.join().expect("mock relay thread must join");
            captured
        }
    }

    impl MockAuthSubscriptionRelay {
        fn start(frames_to_send: Vec<Value>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").expect("mock relay must bind");
            let url = format!(
                "ws://{}",
                listener.local_addr().expect("mock relay addr must exist")
            );
            let (sender, receiver) = channel();
            let handle = thread::spawn(move || {
                let (stream, _) = listener.accept().expect("mock relay must accept");
                let mut websocket =
                    tungstenite::accept(stream).expect("mock relay handshake must succeed");
                let initial_req = read_mock_relay_json_message(&mut websocket);
                websocket
                    .send(Message::text(
                        serde_json::to_string(&json!(["AUTH", AUTH_CHALLENGE]))
                            .expect("AUTH challenge must serialize"),
                    ))
                    .expect("mock relay must send AUTH challenge");
                let auth = read_mock_relay_json_message(&mut websocket);
                let retried_req = read_mock_relay_json_message(&mut websocket);
                for frame in frames_to_send {
                    websocket
                        .send(Message::text(
                            serde_json::to_string(&frame).expect("frame must serialize"),
                        ))
                        .expect("mock relay must send frame");
                }
                let close_message = websocket
                    .read()
                    .expect("mock relay must read CLOSE before websocket close");
                let close = close_message
                    .to_text()
                    .ok()
                    .and_then(|text| serde_json::from_str(text).ok());
                sender
                    .send(CapturedAuthRelayFrames {
                        initial_req,
                        auth,
                        retried_req,
                        close,
                    })
                    .expect("captured frames must send");
            });

            Self {
                url,
                captured: receiver,
                handle,
            }
        }

        fn join(self) -> CapturedAuthRelayFrames {
            let captured = self
                .captured
                .recv_timeout(Duration::from_secs(2))
                .expect("mock relay must capture frames");
            self.handle.join().expect("mock relay thread must join");
            captured
        }
    }

    fn read_mock_relay_json_message(websocket: &mut tungstenite::WebSocket<TcpStream>) -> Value {
        let message = websocket.read().expect("mock relay must read message");
        serde_json::from_str(message.to_text().expect("mock relay message must be text"))
            .expect("mock relay message must be json")
    }

    fn signed_event(
        secret_seed: u8,
        kind: u64,
        tags: Vec<Vec<String>>,
        content: &str,
        created_at: u64,
    ) -> SignedNostrEvent {
        let secret = SecretKey::from_byte_array([secret_seed; 32]).expect("valid secret");
        let secp = Secp256k1::new();
        let keypair = Keypair::from_secret_key(&secp, &secret);
        let (xonly, _) = keypair.x_only_public_key();
        let pubkey = hex::encode(xonly.serialize());
        let normalized = NormalizedNostrEvent {
            kind,
            content: content.to_string(),
            tags,
            pubkey: Some(pubkey.clone()),
            created_at: Some(created_at),
        };
        let canonical = canonical_payload(&normalized).expect("canonical payload must serialize");
        let id = event_hash_hex(&canonical);
        let digest: [u8; 32] = hex::decode(&id)
            .expect("event id must decode")
            .try_into()
            .expect("event id must be 32 bytes");
        let sig = secp.sign_schnorr_no_aux_rand(digest.as_slice(), &keypair);

        SignedNostrEvent {
            id,
            pubkey,
            created_at,
            kind,
            tags: normalized.tags,
            content: normalized.content,
            sig: hex::encode(sig.to_byte_array()),
        }
    }

    fn write_project(base_dir: &Path, project_id: &str, owner: &str, project_base_path: &str) {
        let project_dir = base_dir.join("projects").join(project_id);
        fs::create_dir_all(&project_dir).expect("project dir must create");
        fs::write(
            project_dir.join("project.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "projectOwnerPubkey": owner,
                "projectDTag": project_id,
                "projectBasePath": project_base_path,
                "status": "active"
            }))
            .expect("project json must serialize"),
        )
        .expect("project descriptor must write");
    }

    fn write_agent_index(base_dir: &Path, project_id: &str, pubkeys: &[&str]) {
        let agents_dir = base_dir.join("agents");
        fs::create_dir_all(&agents_dir).expect("agents dir must create");
        fs::write(
            agents_dir.join("index.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "byProject": {
                    project_id: pubkeys,
                }
            }))
            .expect("agent index must serialize"),
        )
        .expect("agent index must write");
    }

    fn write_agent(base_dir: &Path, pubkey: &str, slug: &str) {
        let agents_dir = base_dir.join("agents");
        fs::create_dir_all(&agents_dir).expect("agents dir must create");
        fs::write(
            agents_dir.join(format!("{pubkey}.json")),
            serde_json::to_vec_pretty(&serde_json::json!({
                "slug": slug,
                "status": "active",
                "default": {}
            }))
            .expect("agent json must serialize"),
        )
        .expect("agent file must write");
    }

    fn pubkey_hex(fill_byte: u8) -> String {
        let secret_bytes = [fill_byte; 32];
        let secret = SecretKey::from_byte_array(secret_bytes).expect("valid secret");
        let secp = Secp256k1::new();
        let keypair = Keypair::from_secret_key(&secp, &secret);
        let (xonly, _) = keypair.x_only_public_key();
        hex::encode(xonly.serialize())
    }
}
