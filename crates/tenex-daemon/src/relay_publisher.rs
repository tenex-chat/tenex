use std::net::TcpStream;
use std::time::Duration;

use serde_json::{Value, json};
use thiserror::Error;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, connect};
use url::Url;

use crate::nostr_event::SignedNostrEvent;
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
}

impl NostrRelayPublisher {
    pub fn new(config: RelayPublisherConfig) -> Self {
        Self { config }
    }

    pub fn config(&self) -> &RelayPublisherConfig {
        &self.config
    }
}

impl PublishOutboxRelayPublisher for NostrRelayPublisher {
    fn publish_signed_event(
        &mut self,
        event: &SignedNostrEvent,
    ) -> Result<PublishRelayReport, PublishRelayError> {
        let mut relay_results = Vec::with_capacity(self.config.relay_urls.len());

        for relay_url in &self.config.relay_urls {
            let result =
                match publish_signed_event_to_relay(relay_url, event, self.config.response_timeout)
                {
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
    validate_relay_url(relay_url).map_err(|_| RelayPublishError::InvalidRelayUrl {
        url: relay_url.to_string(),
    })?;

    let (mut socket, _) = connect(relay_url)?;
    set_stream_timeouts(socket.get_mut(), response_timeout);

    socket.send(Message::text(build_event_message(event)?))?;

    loop {
        let message = socket.read()?;
        match message {
            Message::Text(text) => {
                let value: Value = serde_json::from_str(text.as_str())?;
                if let Some(result) = parse_ok_message(relay_url, &event.id, &value)? {
                    return Ok(result);
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

pub fn parse_relay_url_list(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|relay_url| validate_relay_url(relay_url).is_ok())
        .map(str::to_string)
        .collect()
}

fn parse_ok_message(
    relay_url: &str,
    expected_event_id: &str,
    value: &Value,
) -> Result<Option<PublishRelayResult>, RelayPublishError> {
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
    if event_id != expected_event_id {
        return Err(RelayPublishError::MismatchedOkEventId {
            expected_event_id: expected_event_id.to_string(),
            actual_event_id: event_id.to_string(),
        });
    }

    let accepted = frame
        .get(2)
        .and_then(Value::as_bool)
        .ok_or_else(|| RelayPublishError::InvalidOkFrame("missing accepted flag".to_string()))?;
    let message = frame.get(3).and_then(Value::as_str).map(str::to_string);

    Ok(Some(PublishRelayResult {
        relay_url: relay_url.to_string(),
        accepted,
        message,
    }))
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
    use crate::nostr_event::Nip01EventFixture;
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
            "requiresEventId": true,
            "timeoutMs": 30000,
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
