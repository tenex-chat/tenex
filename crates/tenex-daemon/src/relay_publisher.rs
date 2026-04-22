use std::collections::HashSet;
use std::net::TcpStream;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};
use thiserror::Error;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, connect};
use url::Url;

use crate::backend_events::heartbeat::BackendSigner;
use crate::nostr_event::{
    NormalizedNostrEvent, NostrEventError, SignedNostrEvent, canonical_payload, event_hash_hex,
};
use crate::publish_outbox::{
    PublishOutboxRelayPublisher, PublishRelayError, PublishRelayReport, PublishRelayResult,
};

pub const DEFAULT_RELAY_URLS: &[&str] = &["wss://relay.tenex.chat"];

#[derive(Debug, Error)]
pub enum RelayPublisherConfigError {
    #[error("relay url must use ws:// or wss://: {url}")]
    InvalidRelayUrl { url: String },
    #[error("at least one relay url is required")]
    EmptyRelayList,
}

#[derive(Debug, Error)]
pub enum RelayPublishError {
    #[error("relay url must use ws:// or wss://: {url}")]
    InvalidRelayUrl { url: String },
    #[error("websocket error: {0}")]
    WebSocket(#[from] tungstenite::Error),
    #[error("relay event json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("relay connection closed before OK for event {event_id}")]
    ClosedBeforeOk { event_id: String },
    #[error("relay sent OK for event {actual_event_id}, expected {expected_event_id}")]
    MismatchedOkEventId {
        expected_event_id: String,
        actual_event_id: String,
    },
    #[error("relay OK frame is invalid: {0}")]
    InvalidOkFrame(String),
    #[error("relay AUTH frame is invalid: {0}")]
    InvalidAuthFrame(String),
    #[error("relay AUTH event id digest is invalid: expected 32 bytes, got {actual}")]
    InvalidAuthEventIdDigest { actual: usize },
    #[error("relay AUTH signing error: {0}")]
    AuthSigning(#[from] secp256k1::Error),
    #[error("relay AUTH event encode error: {0}")]
    AuthEvent(#[from] NostrEventError),
    #[error("relay rejected AUTH event {event_id}: {message}")]
    AuthRejected { event_id: String, message: String },
    #[error("relay requires AUTH but no relay auth signer is configured")]
    AuthRequiredWithoutSigner,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayPublisherConfig {
    pub relay_urls: Vec<String>,
    pub response_timeout: Duration,
}

impl RelayPublisherConfig {
    pub fn new(
        relay_urls: Vec<String>,
        response_timeout: Duration,
    ) -> Result<Self, RelayPublisherConfigError> {
        let relay_urls = relay_urls
            .into_iter()
            .map(|relay_url| validate_relay_url(&relay_url).map(|()| relay_url))
            .collect::<Result<Vec<_>, _>>()?;

        if relay_urls.is_empty() {
            return Err(RelayPublisherConfigError::EmptyRelayList);
        }

        Ok(Self {
            relay_urls,
            response_timeout,
        })
    }

    pub fn from_env_or_default(
        env_relays: Option<&str>,
        response_timeout: Duration,
    ) -> Result<Self, RelayPublisherConfigError> {
        let env_relay_urls = env_relays
            .map(parse_relay_url_list)
            .filter(|relay_urls| !relay_urls.is_empty());
        let relay_urls = env_relay_urls.unwrap_or_else(|| {
            DEFAULT_RELAY_URLS
                .iter()
                .map(|relay_url| relay_url.to_string())
                .collect()
        });

        Self::new(relay_urls, response_timeout)
    }
}

pub struct NostrRelayPublisher {
    config: RelayPublisherConfig,
    auth_signer: Option<Box<dyn RelayAuthSigner + Send + Sync>>,
}

impl NostrRelayPublisher {
    pub fn new(config: RelayPublisherConfig) -> Self {
        Self {
            config,
            auth_signer: None,
        }
    }

    pub fn with_auth_signer<S>(config: RelayPublisherConfig, auth_signer: S) -> Self
    where
        S: RelayAuthSigner + Send + Sync + 'static,
    {
        Self {
            config,
            auth_signer: Some(Box::new(auth_signer)),
        }
    }

    pub fn config(&self) -> &RelayPublisherConfig {
        &self.config
    }
}

pub trait RelayAuthSigner {
    fn xonly_pubkey_hex(&self) -> String;
    fn sign_schnorr(&self, digest: &[u8; 32]) -> Result<String, secp256k1::Error>;
}

impl<T: BackendSigner> RelayAuthSigner for T {
    fn xonly_pubkey_hex(&self) -> String {
        BackendSigner::xonly_pubkey_hex(self)
    }

    fn sign_schnorr(&self, digest: &[u8; 32]) -> Result<String, secp256k1::Error> {
        BackendSigner::sign_schnorr(self, digest)
    }
}

impl PublishOutboxRelayPublisher for NostrRelayPublisher {
    fn publish_signed_event(
        &mut self,
        event: &SignedNostrEvent,
    ) -> Result<PublishRelayReport, PublishRelayError> {
        let mut relay_results = Vec::with_capacity(self.config.relay_urls.len());

        for relay_url in &self.config.relay_urls {
            let auth_signer = self
                .auth_signer
                .as_ref()
                .map(|signer| signer.as_ref() as &dyn RelayAuthSigner);
            let result = match publish_signed_event_to_relay_with_auth_signer(
                relay_url,
                event,
                self.config.response_timeout,
                auth_signer,
            ) {
                Ok(result) => result,
                Err(error) => PublishRelayResult {
                    relay_url: relay_url.clone(),
                    accepted: false,
                    message: Some(error.to_string()),
                },
            };
            relay_results.push(result);
        }

        Ok(PublishRelayReport { relay_results })
    }
}

pub fn publish_signed_event_to_relay(
    relay_url: &str,
    event: &SignedNostrEvent,
    response_timeout: Duration,
) -> Result<PublishRelayResult, RelayPublishError> {
    publish_signed_event_to_relay_with_auth_signer(relay_url, event, response_timeout, None)
}

pub fn publish_signed_event_to_relay_with_auth_signer(
    relay_url: &str,
    event: &SignedNostrEvent,
    response_timeout: Duration,
    auth_signer: Option<&dyn RelayAuthSigner>,
) -> Result<PublishRelayResult, RelayPublishError> {
    validate_relay_url(relay_url).map_err(|_| RelayPublishError::InvalidRelayUrl {
        url: relay_url.to_string(),
    })?;

    let (mut socket, _) = connect(relay_url)?;
    set_stream_timeouts(socket.get_mut(), response_timeout);

    socket.send(Message::text(build_event_message(event)?))?;
    let mut pending_auth_event_ids = HashSet::new();
    let mut resend_event_after_auth = false;

    loop {
        let message = socket.read()?;
        match message {
            Message::Text(text) => {
                let value: Value = serde_json::from_str(text.as_str())?;
                if let Some(challenge) = parse_auth_challenge(&value)? {
                    let auth_signer =
                        auth_signer.ok_or(RelayPublishError::AuthRequiredWithoutSigner)?;
                    let auth_event = build_relay_auth_event(
                        relay_url,
                        &challenge,
                        auth_signer,
                        now_unix_secs(),
                    )?;
                    pending_auth_event_ids.insert(auth_event.id.clone());
                    socket.send(Message::text(build_auth_message(&auth_event)?))?;
                    resend_event_after_auth = true;
                    continue;
                }

                if let Some(ok_frame) = parse_ok_frame(&value)? {
                    if ok_frame.event_id == event.id {
                        if ok_frame.accepted
                            || !is_auth_required_message(ok_frame.message.as_deref())
                        {
                            return Ok(PublishRelayResult {
                                relay_url: relay_url.to_string(),
                                accepted: ok_frame.accepted,
                                message: ok_frame.message,
                            });
                        }
                        if auth_signer.is_none() {
                            return Err(RelayPublishError::AuthRequiredWithoutSigner);
                        }
                        continue;
                    }

                    if pending_auth_event_ids.remove(&ok_frame.event_id) {
                        if !ok_frame.accepted {
                            return Err(RelayPublishError::AuthRejected {
                                event_id: ok_frame.event_id,
                                message: ok_frame.message.unwrap_or_default(),
                            });
                        }
                        if resend_event_after_auth {
                            socket.send(Message::text(build_event_message(event)?))?;
                            resend_event_after_auth = false;
                        }
                        continue;
                    }

                    return Err(RelayPublishError::MismatchedOkEventId {
                        expected_event_id: event.id.clone(),
                        actual_event_id: ok_frame.event_id,
                    });
                }
            }
            Message::Close(_) => {
                return Err(RelayPublishError::ClosedBeforeOk {
                    event_id: event.id.clone(),
                });
            }
            Message::Binary(_) | Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => {}
        }
    }
}

pub fn build_event_message(event: &SignedNostrEvent) -> Result<String, serde_json::Error> {
    serde_json::to_string(&json!(["EVENT", event]))
}

pub fn build_auth_message(event: &SignedNostrEvent) -> Result<String, serde_json::Error> {
    serde_json::to_string(&json!(["AUTH", event]))
}

pub fn parse_relay_url_list(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|relay_url| validate_relay_url(relay_url).is_ok())
        .map(str::to_string)
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RelayOkFrame {
    event_id: String,
    accepted: bool,
    message: Option<String>,
}

fn parse_ok_frame(value: &Value) -> Result<Option<RelayOkFrame>, RelayPublishError> {
    let frame = match value.as_array() {
        Some(frame) => frame,
        None => return Ok(None),
    };

    if frame.first().and_then(Value::as_str) != Some("OK") {
        return Ok(None);
    }

    let event_id = frame
        .get(1)
        .and_then(Value::as_str)
        .ok_or_else(|| RelayPublishError::InvalidOkFrame("missing event id".to_string()))?;
    let accepted = frame
        .get(2)
        .and_then(Value::as_bool)
        .ok_or_else(|| RelayPublishError::InvalidOkFrame("missing accepted flag".to_string()))?;
    let message = frame.get(3).and_then(Value::as_str).map(str::to_string);

    Ok(Some(RelayOkFrame {
        event_id: event_id.to_string(),
        accepted,
        message,
    }))
}

fn parse_auth_challenge(value: &Value) -> Result<Option<String>, RelayPublishError> {
    let frame = match value.as_array() {
        Some(frame) => frame,
        None => return Ok(None),
    };

    if frame.first().and_then(Value::as_str) != Some("AUTH") {
        return Ok(None);
    }

    frame
        .get(1)
        .and_then(Value::as_str)
        .map(|challenge| Some(challenge.to_string()))
        .ok_or_else(|| RelayPublishError::InvalidAuthFrame("missing challenge".to_string()))
}

pub fn build_relay_auth_event(
    relay_url: &str,
    challenge: &str,
    signer: &dyn RelayAuthSigner,
    created_at: u64,
) -> Result<SignedNostrEvent, RelayPublishError> {
    let pubkey = signer.xonly_pubkey_hex();
    let event = NormalizedNostrEvent {
        kind: 22242,
        content: String::new(),
        tags: vec![
            vec!["relay".to_string(), relay_url.to_string()],
            vec!["challenge".to_string(), challenge.to_string()],
        ],
        pubkey: Some(pubkey.clone()),
        created_at: Some(created_at),
    };
    let canonical = canonical_payload(&event)?;
    let id = event_hash_hex(&canonical);
    let digest = decode_auth_event_id_digest(&id)?;
    let sig = signer.sign_schnorr(&digest)?;

    Ok(SignedNostrEvent {
        id,
        pubkey,
        created_at,
        kind: event.kind,
        tags: event.tags,
        content: event.content,
        sig,
    })
}

fn decode_auth_event_id_digest(value: &str) -> Result<[u8; 32], RelayPublishError> {
    let bytes = hex::decode(value).map_err(|err| {
        RelayPublishError::InvalidAuthFrame(format!("event id is not hex: {err}"))
    })?;
    bytes.try_into().map_err(
        |bytes: Vec<u8>| RelayPublishError::InvalidAuthEventIdDigest {
            actual: bytes.len(),
        },
    )
}

fn is_auth_required_message(message: Option<&str>) -> bool {
    matches!(message, Some(message) if message.starts_with("auth-required"))
}

fn now_unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn validate_relay_url(relay_url: &str) -> Result<(), RelayPublisherConfigError> {
    let parsed = Url::parse(relay_url).map_err(|_| RelayPublisherConfigError::InvalidRelayUrl {
        url: relay_url.to_string(),
    })?;
    if parsed.host_str().is_none() || !matches!(parsed.scheme(), "ws" | "wss") {
        return Err(RelayPublisherConfigError::InvalidRelayUrl {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend_signer::HexBackendSigner;
    use crate::nostr_event::Nip01EventFixture;
    use crate::nostr_event::verify_signed_event;
    use crate::publish_outbox::{
        accept_worker_publish_request, drain_pending_publish_outbox,
        read_published_publish_outbox_record,
    };
    use crate::worker_protocol::AGENT_WORKER_PROTOCOL_VERSION;
    use serde_json::json;
    use std::fs;
    use std::net::TcpListener;
    use std::path::PathBuf;
    use std::sync::mpsc;
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

    const STREAM_TEXT_DELTA_FIXTURE: &str =
        include_str!("../../../src/test-utils/fixtures/nostr/stream-text-delta.compat.json");
    const AUTH_CHALLENGE: &str = "relay-auth-challenge-01";

    #[test]
    fn parses_env_relay_list_like_typescript_relay_config() {
        assert_eq!(
            parse_relay_url_list("wss://relay-one.test, nope, ws://127.0.0.1:1234, http://bad"),
            vec![
                "wss://relay-one.test".to_string(),
                "ws://127.0.0.1:1234".to_string()
            ]
        );
    }

    #[test]
    fn uses_default_relay_when_env_relays_are_missing_or_invalid() {
        let config = RelayPublisherConfig::from_env_or_default(
            Some("http://invalid,not-a-url"),
            Duration::from_millis(250),
        )
        .expect("config must fall back to default relays");

        assert_eq!(
            config.relay_urls,
            vec!["wss://relay.tenex.chat".to_string()]
        );
        assert_eq!(config.response_timeout, Duration::from_millis(250));
    }

    #[test]
    fn publishes_exact_signed_event_and_reports_relay_ok() {
        let fixture = signed_event_fixture();
        let response = json!(["OK", fixture.signed.id, true, "stored"]);
        let mock_relay = MockRelay::start(response);

        let result =
            publish_signed_event_to_relay(&mock_relay.url, &fixture.signed, Duration::from_secs(2))
                .expect("mock relay publish must succeed");

        let published_frame = mock_relay
            .published_frame
            .recv()
            .expect("mock relay must receive one frame");
        assert_eq!(published_frame[0], "EVENT");
        assert_eq!(published_frame[1], json!(fixture.signed));
        assert_eq!(
            result,
            PublishRelayResult {
                relay_url: mock_relay.url.clone(),
                accepted: true,
                message: Some("stored".to_string()),
            }
        );

        mock_relay.join();
    }

    #[test]
    fn reports_relay_rejection_without_changing_event_identity() {
        let fixture = signed_event_fixture();
        let response = json!([
            "OK",
            fixture.signed.id,
            false,
            "duplicate: already have this"
        ]);
        let mock_relay = MockRelay::start(response);

        let result =
            publish_signed_event_to_relay(&mock_relay.url, &fixture.signed, Duration::from_secs(2))
                .expect("mock relay publish must return relay OK");
        let published_frame = mock_relay
            .published_frame
            .recv()
            .expect("mock relay must receive one frame");

        assert_eq!(published_frame[1]["id"], fixture.signed.id);
        assert_eq!(published_frame[1]["sig"], fixture.signed.sig);
        assert!(!result.accepted);
        assert_eq!(
            result.message.as_deref(),
            Some("duplicate: already have this")
        );

        mock_relay.join();
    }

    #[test]
    fn publishes_after_nip42_auth_challenge_with_configured_signer() {
        let fixture = signed_event_fixture();
        let signer = HexBackendSigner::from_private_key_hex(&fixture.secret_key_hex)
            .expect("fixture private key must create relay auth signer");
        let mock_relay = AuthRequiredMockRelay::start(fixture.signed.id.clone());
        let config =
            RelayPublisherConfig::new(vec![mock_relay.url.clone()], Duration::from_secs(2))
                .expect("mock relay config must be valid");
        let relay_url = mock_relay.url.clone();
        let mut publisher = NostrRelayPublisher::with_auth_signer(config, signer);

        let report = publisher
            .publish_signed_event(&fixture.signed)
            .expect("publish report must be returned");

        assert_eq!(report.relay_results.len(), 1);
        assert_eq!(
            report.relay_results[0],
            PublishRelayResult {
                relay_url: relay_url.clone(),
                accepted: true,
                message: Some("stored after auth".to_string()),
            }
        );
        let published_frames = mock_relay
            .published_frames
            .recv()
            .expect("mock relay must capture auth flow frames");
        assert_eq!(published_frames.initial_event_frame[0], "EVENT");
        assert_eq!(
            published_frames.initial_event_frame[1],
            json!(fixture.signed)
        );
        assert_eq!(published_frames.auth_frame[0], "AUTH");
        let auth_event: SignedNostrEvent =
            serde_json::from_value(published_frames.auth_frame[1].clone())
                .expect("auth frame must carry a signed event");
        assert_eq!(auth_event.pubkey, fixture.pubkey);
        assert_eq!(auth_event.kind, 22242);
        assert_eq!(auth_event.content, "");
        assert!(
            auth_event
                .tags
                .contains(&vec!["relay".to_string(), relay_url.clone()])
        );
        assert!(
            auth_event
                .tags
                .contains(&vec!["challenge".to_string(), AUTH_CHALLENGE.to_string()])
        );
        verify_signed_event(&auth_event).expect("AUTH event signature must verify");
        assert_eq!(published_frames.retried_event_frame[0], "EVENT");
        assert_eq!(
            published_frames.retried_event_frame[1],
            json!(fixture.signed)
        );

        mock_relay.join();
    }

    #[test]
    fn rejects_auth_challenge_without_configured_signer() {
        let fixture = signed_event_fixture();
        let mock_relay = AuthChallengeOnlyMockRelay::start();

        let error =
            publish_signed_event_to_relay(&mock_relay.url, &fixture.signed, Duration::from_secs(2))
                .expect_err("AUTH challenge without signer must fail explicitly");

        assert!(matches!(
            error,
            RelayPublishError::AuthRequiredWithoutSigner
        ));
        let initial_frame = mock_relay
            .initial_event_frame
            .recv()
            .expect("mock relay must capture initial EVENT frame");
        assert_eq!(initial_frame[0], "EVENT");
        assert_eq!(initial_frame[1], json!(fixture.signed));

        mock_relay.join();
    }

    #[test]
    fn drains_outbox_through_real_websocket_relay_publisher() {
        let fixture = signed_event_fixture();
        let daemon_dir = unique_temp_daemon_dir();
        let message = publish_request_message(&fixture, 41, 1710001000000);
        accept_worker_publish_request(&daemon_dir, &message, 1710001000100)
            .expect("publish request must be accepted");
        let mock_relay = MockRelay::start(json!(["OK", fixture.signed.id, true, "stored"]));
        let config =
            RelayPublisherConfig::new(vec![mock_relay.url.clone()], Duration::from_secs(2))
                .expect("mock relay config must be valid");
        let mut publisher = NostrRelayPublisher::new(config);

        let outcomes = drain_pending_publish_outbox(&daemon_dir, &mut publisher, 1710001000200)
            .expect("outbox drain must publish through mock relay");

        assert_eq!(outcomes.len(), 1);
        assert_eq!(outcomes[0].event_id, fixture.signed.id);
        let published = read_published_publish_outbox_record(&daemon_dir, &fixture.signed.id)
            .expect("published record read must succeed")
            .expect("published record must exist");
        assert_eq!(published.event, fixture.signed);
        assert!(published.attempts[0].relay_results[0].accepted);

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
        mock_relay.join();
    }

    fn publish_request_message(
        fixture: &Nip01EventFixture,
        sequence: u64,
        timestamp: u64,
    ) -> Value {
        json!({
            "version": AGENT_WORKER_PROTOCOL_VERSION,
            "type": "publish_request",
            "correlationId": "rust_relay_publisher",
            "sequence": sequence,
            "timestamp": timestamp,
            "projectId": "project-alpha",
            "agentPubkey": fixture.pubkey,
            "conversationId": "conversation-alpha",
            "ralNumber": 7,
            "requestId": "publish-fixture-01",
            "waitForRelayOk": true,
            "timeoutMs": 30000,
            "runtimeEventClass": "complete",
            "event": fixture.signed,
        })
    }

    fn signed_event_fixture() -> Nip01EventFixture {
        serde_json::from_str(STREAM_TEXT_DELTA_FIXTURE).expect("fixture must parse")
    }

    struct MockRelay {
        url: String,
        published_frame: mpsc::Receiver<Value>,
        handle: thread::JoinHandle<()>,
    }

    impl MockRelay {
        fn start(response: Value) -> Self {
            let listener =
                TcpListener::bind("127.0.0.1:0").expect("mock relay must bind local port");
            let url = format!(
                "ws://{}",
                listener
                    .local_addr()
                    .expect("mock relay must expose local addr")
            );
            let (sender, published_frame) = mpsc::channel();

            let handle = thread::spawn(move || {
                let (stream, _) = listener.accept().expect("mock relay must accept client");
                let mut websocket =
                    tungstenite::accept(stream).expect("mock relay handshake must succeed");
                let message = websocket.read().expect("mock relay must read event");
                let value: Value = serde_json::from_str(
                    message
                        .to_text()
                        .expect("mock relay event message must be text"),
                )
                .expect("mock relay event message must be json");
                sender
                    .send(value)
                    .expect("mock relay must send captured frame");
                websocket
                    .send(Message::text(
                        serde_json::to_string(&response).expect("mock response must serialize"),
                    ))
                    .expect("mock relay must send OK frame");
            });

            Self {
                url,
                published_frame,
                handle,
            }
        }

        fn join(self) {
            self.handle.join().expect("mock relay thread must join");
        }
    }

    struct AuthRequiredMockRelay {
        url: String,
        published_frames: mpsc::Receiver<AuthRelayFrames>,
        handle: thread::JoinHandle<()>,
    }

    struct AuthRelayFrames {
        initial_event_frame: Value,
        auth_frame: Value,
        retried_event_frame: Value,
    }

    struct AuthChallengeOnlyMockRelay {
        url: String,
        initial_event_frame: mpsc::Receiver<Value>,
        handle: thread::JoinHandle<()>,
    }

    impl AuthRequiredMockRelay {
        fn start(event_id: String) -> Self {
            let listener =
                TcpListener::bind("127.0.0.1:0").expect("mock relay must bind local port");
            let url = format!(
                "ws://{}",
                listener
                    .local_addr()
                    .expect("mock relay must expose local addr")
            );
            let (sender, published_frames) = mpsc::channel();

            let handle = thread::spawn(move || {
                let (stream, _) = listener.accept().expect("mock relay must accept client");
                let mut websocket =
                    tungstenite::accept(stream).expect("mock relay handshake must succeed");

                let initial_event_frame = read_mock_relay_json_message(&mut websocket);
                websocket
                    .send(Message::text(
                        serde_json::to_string(&json!(["AUTH", AUTH_CHALLENGE]))
                            .expect("AUTH challenge must serialize"),
                    ))
                    .expect("mock relay must send AUTH challenge");

                let auth_frame = read_mock_relay_json_message(&mut websocket);
                let auth_event: SignedNostrEvent = serde_json::from_value(
                    auth_frame
                        .get(1)
                        .expect("AUTH frame must include signed event")
                        .clone(),
                )
                .expect("AUTH frame event must deserialize");
                websocket
                    .send(Message::text(
                        serde_json::to_string(&json!(["OK", auth_event.id, true, ""]))
                            .expect("AUTH OK must serialize"),
                    ))
                    .expect("mock relay must send AUTH OK");

                let retried_event_frame = read_mock_relay_json_message(&mut websocket);
                websocket
                    .send(Message::text(
                        serde_json::to_string(&json!(["OK", event_id, true, "stored after auth"]))
                            .expect("event OK must serialize"),
                    ))
                    .expect("mock relay must send event OK");
                sender
                    .send(AuthRelayFrames {
                        initial_event_frame,
                        auth_frame,
                        retried_event_frame,
                    })
                    .expect("mock relay must send captured frames");
            });

            Self {
                url,
                published_frames,
                handle,
            }
        }

        fn join(self) {
            self.handle.join().expect("mock relay thread must join");
        }
    }

    impl AuthChallengeOnlyMockRelay {
        fn start() -> Self {
            let listener =
                TcpListener::bind("127.0.0.1:0").expect("mock relay must bind local port");
            let url = format!(
                "ws://{}",
                listener
                    .local_addr()
                    .expect("mock relay must expose local addr")
            );
            let (sender, initial_event_frame) = mpsc::channel();

            let handle = thread::spawn(move || {
                let (stream, _) = listener.accept().expect("mock relay must accept client");
                let mut websocket =
                    tungstenite::accept(stream).expect("mock relay handshake must succeed");
                let event_frame = read_mock_relay_json_message(&mut websocket);
                websocket
                    .send(Message::text(
                        serde_json::to_string(&json!(["AUTH", AUTH_CHALLENGE]))
                            .expect("AUTH challenge must serialize"),
                    ))
                    .expect("mock relay must send AUTH challenge");
                sender
                    .send(event_frame)
                    .expect("mock relay must send captured frame");
            });

            Self {
                url,
                initial_event_frame,
                handle,
            }
        }

        fn join(self) {
            self.handle.join().expect("mock relay thread must join");
        }
    }

    fn read_mock_relay_json_message(websocket: &mut tungstenite::WebSocket<TcpStream>) -> Value {
        let message = websocket.read().expect("mock relay must read message");
        serde_json::from_str(message.to_text().expect("mock relay message must be text"))
            .expect("mock relay message must be json")
    }

    fn unique_temp_daemon_dir() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be after UNIX_EPOCH")
            .as_nanos();
        let daemon_dir = std::env::temp_dir().join(format!(
            "tenex-relay-publisher-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&daemon_dir).expect("temp daemon dir must be created");
        daemon_dir
    }
}
