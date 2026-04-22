//! Multiplexing Telegram delivery publisher keyed by agent pubkey.
//!
//! A TENEX deployment may run multiple agents, each owning a distinct bot
//! token. Every outbox record carries the agent pubkey that authored it
//! under [`TelegramSenderIdentity::agent_pubkey`]; the registry routes each
//! record to the publisher bound to that agent's token.
//!
//! Construction reads `$TENEX_BASE_DIR/agents/*.json` through the same
//! [`read_agent_gateway_bots`] path used by the ingress gateway, which
//! guarantees the outbound publisher and the inbound long-poll supervisor
//! agree on which agents are wired for Telegram.
//!
//! An empty registry is valid (no agents carry a bot token). Callers must
//! check [`TelegramPublisherRegistry::is_empty`] and fall back to the
//! drain-less maintenance path; routing a record through an empty registry
//! returns a permanent failure because there is no bot token that could
//! have produced it.
//!
//! The registry is not thread-safe: it is intended to be owned by the
//! daemon foreground loop and touched only from that thread. Each drain
//! pass borrows it mutably through [`WithTelegramPublisher`].
//!
//! [`TelegramSenderIdentity::agent_pubkey`]: crate::telegram_outbox::TelegramSenderIdentity::agent_pubkey
//! [`WithTelegramPublisher`]: crate::daemon_maintenance::WithTelegramPublisher

use std::collections::HashMap;
use std::path::Path;

use thiserror::Error;

use crate::telegram::agent_config::{AgentTelegramConfigError, read_agent_gateway_bots};
use crate::telegram::client::{TelegramBotClient, TelegramBotClientConfig, TelegramClientError};
use crate::telegram::delivery::TelegramBotDeliveryPublisher;
use crate::telegram_outbox::{
    TelegramDeliveryPublisher, TelegramDeliveryResult, TelegramErrorClass, TelegramOutboxRecord,
};

#[derive(Debug, Error)]
pub enum TelegramPublisherRegistryError {
    #[error("agent telegram config scan failed: {0}")]
    AgentConfig(#[from] AgentTelegramConfigError),
    #[error("telegram bot client construction failed for agent {agent_pubkey}: {source}")]
    Client {
        agent_pubkey: String,
        #[source]
        source: TelegramClientError,
    },
}

/// Multiplexes [`TelegramBotDeliveryPublisher`] instances keyed by agent
/// pubkey. Two agents sharing a bot token still get distinct publisher
/// entries so each record is delivered under its owning agent's identity.
pub struct TelegramPublisherRegistry {
    publishers: HashMap<String, TelegramBotDeliveryPublisher>,
}

impl TelegramPublisherRegistry {
    /// Build a registry from `$TENEX_BASE_DIR/agents/*.json`. Returns an
    /// empty registry when no agent carries a bot token — callers inspect
    /// [`Self::is_empty`] and fall back to the drain-less maintenance path.
    pub fn from_agent_config(
        tenex_base_dir: &Path,
    ) -> Result<Self, TelegramPublisherRegistryError> {
        let bots = read_agent_gateway_bots(tenex_base_dir)?;
        let mut publishers: HashMap<String, TelegramBotDeliveryPublisher> =
            HashMap::with_capacity(bots.len());
        for bot in bots {
            let mut config = TelegramBotClientConfig::new(bot.bot_token);
            if let Some(base_url) = bot.api_base_url {
                config = config.with_api_base_url(base_url);
            }
            let client = TelegramBotClient::new(config).map_err(|source| {
                TelegramPublisherRegistryError::Client {
                    agent_pubkey: bot.agent_pubkey.clone(),
                    source,
                }
            })?;
            publishers.insert(bot.agent_pubkey, TelegramBotDeliveryPublisher::new(client));
        }
        Ok(Self { publishers })
    }

    /// Test-only constructor accepting pre-built publishers keyed by agent
    /// pubkey. Lets integration tests wire mock HTTP servers without
    /// rebuilding the filesystem surface.
    #[cfg(test)]
    pub fn from_publishers(publishers: HashMap<String, TelegramBotDeliveryPublisher>) -> Self {
        Self { publishers }
    }

    /// True when no agent carried a bot token at construction time.
    pub fn is_empty(&self) -> bool {
        self.publishers.is_empty()
    }

    pub fn len(&self) -> usize {
        self.publishers.len()
    }
}

impl TelegramDeliveryPublisher for TelegramPublisherRegistry {
    fn deliver(&mut self, record: &TelegramOutboxRecord) -> TelegramDeliveryResult {
        let agent_pubkey = record.sender_identity.agent_pubkey.as_str();
        match self.publishers.get_mut(agent_pubkey) {
            Some(publisher) => publisher.deliver(record),
            None => TelegramDeliveryResult::PermanentFailure {
                error_class: TelegramErrorClass::Unauthorized,
                error_detail: format!(
                    "no telegram bot token configured for agent pubkey {agent_pubkey}"
                ),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::telegram::delivery::DeliveryClock;
    use crate::telegram_outbox::{
        TELEGRAM_OUTBOX_RECORD_SCHEMA_VERSION, TELEGRAM_OUTBOX_WRITER, TelegramChannelBinding,
        TelegramDeliveryPayload, TelegramDeliveryReason, TelegramOutboxRecord,
        TelegramOutboxStatus, TelegramProjectBinding, TelegramSenderIdentity,
    };
    use std::fs;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};
    use std::thread::{self, JoinHandle};
    use std::time::Duration;

    struct MockServer {
        url: String,
        captured: Arc<Mutex<Vec<CapturedRequest>>>,
        handle: Option<JoinHandle<()>>,
    }

    #[derive(Debug, Clone)]
    struct CapturedRequest {
        path: String,
        body: Vec<u8>,
    }

    #[derive(Debug, Clone)]
    struct ScriptedResponse {
        status: u16,
        body: String,
    }

    impl MockServer {
        fn start(script: Vec<ScriptedResponse>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").expect("mock http bind");
            let url = format!(
                "http://{}",
                listener.local_addr().expect("mock http local addr")
            );
            let captured: Arc<Mutex<Vec<CapturedRequest>>> = Arc::new(Mutex::new(Vec::new()));
            let captured_clone = captured.clone();
            let handle = thread::spawn(move || {
                for response in script {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            serve_one(
                                stream,
                                response.status,
                                &response.body,
                                captured_clone.clone(),
                            );
                        }
                        Err(_) => break,
                    }
                }
            });
            Self {
                url,
                captured,
                handle: Some(handle),
            }
        }

        fn captured(&self) -> Vec<CapturedRequest> {
            self.captured.lock().expect("captured lock").clone()
        }
    }

    impl Drop for MockServer {
        fn drop(&mut self) {
            if let Some(handle) = self.handle.take() {
                let _ = handle.join();
            }
        }
    }

    fn serve_one(
        mut stream: std::net::TcpStream,
        status: u16,
        body: &str,
        captured: Arc<Mutex<Vec<CapturedRequest>>>,
    ) {
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .expect("read timeout");
        let mut reader = BufReader::new(stream.try_clone().expect("clone stream"));
        let mut request_line = String::new();
        reader.read_line(&mut request_line).expect("request line");
        let path = request_line
            .split_whitespace()
            .nth(1)
            .unwrap_or("")
            .to_string();

        let mut content_length: usize = 0;
        loop {
            let mut line = String::new();
            let n = reader.read_line(&mut line).expect("header line");
            if n == 0 || line == "\r\n" || line == "\n" {
                break;
            }
            let line = line.trim_end().to_string();
            if let Some((name, value)) = line.split_once(':')
                && name.trim().eq_ignore_ascii_case("content-length")
            {
                content_length = value.trim().parse().unwrap_or(0);
            }
        }

        let mut body_bytes = vec![0u8; content_length];
        if content_length > 0 {
            reader.read_exact(&mut body_bytes).expect("read body");
        }

        captured
            .lock()
            .expect("captured lock")
            .push(CapturedRequest {
                path,
                body: body_bytes,
            });

        let status_text = match status {
            200 => "OK",
            400 => "Bad Request",
            401 => "Unauthorized",
            _ => "OK",
        };
        let response = format!(
            "HTTP/1.1 {status} {status_text}\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
            body.len()
        );
        stream
            .write_all(response.as_bytes())
            .expect("write response");
        stream.flush().expect("flush");
    }

    fn pubkey_of(byte: u8) -> String {
        std::iter::repeat_n(char::from_digit(u32::from(byte % 16), 16).unwrap(), 64).collect()
    }

    fn write_agent_file(agents_dir: &Path, pubkey: &str, contents: serde_json::Value) {
        fs::write(
            agents_dir.join(format!("{pubkey}.json")),
            contents.to_string(),
        )
        .expect("agent file write");
    }

    fn record_for(agent_pubkey: &str, chat_id: i64) -> TelegramOutboxRecord {
        TelegramOutboxRecord {
            schema_version: TELEGRAM_OUTBOX_RECORD_SCHEMA_VERSION,
            writer: TELEGRAM_OUTBOX_WRITER.to_string(),
            writer_version: "test".to_string(),
            record_id: format!("rec-{agent_pubkey}"),
            status: TelegramOutboxStatus::Pending,
            created_at: 1_710_001_000_000,
            updated_at: 1_710_001_000_000,
            nostr_event_id: "event".to_string(),
            correlation_id: "corr".to_string(),
            project_binding: TelegramProjectBinding {
                project_d_tag: "demo".to_string(),
                backend_pubkey: "backend".to_string(),
            },
            channel_binding: TelegramChannelBinding {
                chat_id,
                message_thread_id: None,
                channel_label: None,
            },
            sender_identity: TelegramSenderIdentity {
                agent_pubkey: agent_pubkey.to_string(),
                display_name: None,
            },
            delivery_reason: TelegramDeliveryReason::FinalReply,
            reply_to_telegram_message_id: None,
            payload: TelegramDeliveryPayload::PlainText {
                text: "hi".to_string(),
            },
            attempts: Vec::new(),
        }
    }

    #[test]
    fn from_agent_config_without_agents_is_empty() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let registry =
            TelegramPublisherRegistry::from_agent_config(tmp.path()).expect("registry ok");
        assert!(registry.is_empty());
        assert_eq!(registry.len(), 0);
    }

    #[test]
    fn from_agent_config_without_any_bot_tokens_is_empty() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let agents_dir = tmp.path().join("agents");
        fs::create_dir_all(&agents_dir).unwrap();
        write_agent_file(
            &agents_dir,
            &pubkey_of(0xAA),
            serde_json::json!({ "slug": "no-telegram" }),
        );
        let registry =
            TelegramPublisherRegistry::from_agent_config(tmp.path()).expect("registry ok");
        assert!(registry.is_empty());
    }

    #[test]
    fn from_agent_config_includes_only_agents_with_bot_tokens() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let agents_dir = tmp.path().join("agents");
        fs::create_dir_all(&agents_dir).unwrap();
        let alpha = pubkey_of(0xAA);
        let beta = pubkey_of(0xBB);
        let gamma = pubkey_of(0xCC);
        write_agent_file(
            &agents_dir,
            &alpha,
            serde_json::json!({
                "slug": "alpha",
                "telegram": { "botToken": "111:AAA" }
            }),
        );
        write_agent_file(
            &agents_dir,
            &beta,
            serde_json::json!({
                "slug": "beta",
                "telegram": { "botToken": "222:BBB" }
            }),
        );
        write_agent_file(&agents_dir, &gamma, serde_json::json!({ "slug": "gamma" }));
        let registry =
            TelegramPublisherRegistry::from_agent_config(tmp.path()).expect("registry ok");
        assert_eq!(registry.len(), 2);
        assert!(registry.publishers.contains_key(&alpha));
        assert!(registry.publishers.contains_key(&beta));
        assert!(!registry.publishers.contains_key(&gamma));
    }

    #[test]
    fn deliver_without_matching_agent_returns_permanent_failure() {
        let registry = TelegramPublisherRegistry {
            publishers: HashMap::new(),
        };
        let mut registry = registry;
        let result = registry.deliver(&record_for("unknown-pubkey", 1));
        match result {
            TelegramDeliveryResult::PermanentFailure {
                error_class,
                error_detail,
            } => {
                assert_eq!(error_class, TelegramErrorClass::Unauthorized);
                assert!(error_detail.contains("unknown-pubkey"));
            }
            other => panic!("expected permanent failure, got {other:?}"),
        }
    }

    #[test]
    fn deliver_routes_to_the_matching_bot_publisher() {
        let alpha_pubkey = pubkey_of(0xAA);
        let beta_pubkey = pubkey_of(0xBB);

        let alpha_body = serde_json::json!({
            "ok": true,
            "result": { "message_id": 1111, "chat": { "id": 10, "type": "private" } }
        })
        .to_string();
        let beta_body = serde_json::json!({
            "ok": true,
            "result": { "message_id": 2222, "chat": { "id": 20, "type": "private" } }
        })
        .to_string();
        let alpha_server = MockServer::start(vec![ScriptedResponse {
            status: 200,
            body: alpha_body,
        }]);
        let beta_server = MockServer::start(vec![ScriptedResponse {
            status: 200,
            body: beta_body,
        }]);

        let mut publishers: HashMap<String, TelegramBotDeliveryPublisher> = HashMap::new();
        publishers.insert(
            alpha_pubkey.clone(),
            TelegramBotDeliveryPublisher::new(
                TelegramBotClient::new(
                    TelegramBotClientConfig::new("111:AAA").with_api_base_url(&alpha_server.url),
                )
                .expect("client"),
            )
            .with_clock(DeliveryClock::fixed(1_710_001_000_500)),
        );
        publishers.insert(
            beta_pubkey.clone(),
            TelegramBotDeliveryPublisher::new(
                TelegramBotClient::new(
                    TelegramBotClientConfig::new("222:BBB").with_api_base_url(&beta_server.url),
                )
                .expect("client"),
            )
            .with_clock(DeliveryClock::fixed(1_710_001_000_600)),
        );
        let mut registry = TelegramPublisherRegistry::from_publishers(publishers);

        let alpha_outcome = registry.deliver(&record_for(&alpha_pubkey, 10));
        let beta_outcome = registry.deliver(&record_for(&beta_pubkey, 20));

        match alpha_outcome {
            TelegramDeliveryResult::Delivered {
                telegram_message_id,
                ..
            } => assert_eq!(telegram_message_id, 1111),
            other => panic!("alpha expected delivered, got {other:?}"),
        }
        match beta_outcome {
            TelegramDeliveryResult::Delivered {
                telegram_message_id,
                ..
            } => assert_eq!(telegram_message_id, 2222),
            other => panic!("beta expected delivered, got {other:?}"),
        }

        let alpha_captured = alpha_server.captured();
        let beta_captured = beta_server.captured();
        assert_eq!(alpha_captured.len(), 1);
        assert_eq!(beta_captured.len(), 1);
        assert!(alpha_captured[0].path.contains("111:AAA"));
        assert!(beta_captured[0].path.contains("222:BBB"));
        let alpha_body = String::from_utf8_lossy(&alpha_captured[0].body);
        let beta_body = String::from_utf8_lossy(&beta_captured[0].body);
        assert!(alpha_body.contains("\"chat_id\":10"));
        assert!(beta_body.contains("\"chat_id\":20"));
    }

    #[test]
    fn outbox_drain_routes_records_to_owning_publisher() {
        use crate::telegram_outbox::{
            TelegramDeliveryRequest, accept_telegram_delivery_request,
            drain_pending_telegram_outbox,
        };

        let alpha_pubkey = pubkey_of(0xAA);
        let beta_pubkey = pubkey_of(0xBB);

        let alpha_body = serde_json::json!({
            "ok": true,
            "result": { "message_id": 4001, "chat": { "id": 100, "type": "private" } }
        })
        .to_string();
        let beta_body = serde_json::json!({
            "ok": true,
            "result": { "message_id": 4002, "chat": { "id": 200, "type": "private" } }
        })
        .to_string();
        let alpha_server = MockServer::start(vec![ScriptedResponse {
            status: 200,
            body: alpha_body,
        }]);
        let beta_server = MockServer::start(vec![ScriptedResponse {
            status: 200,
            body: beta_body,
        }]);

        let mut publishers: HashMap<String, TelegramBotDeliveryPublisher> = HashMap::new();
        publishers.insert(
            alpha_pubkey.clone(),
            TelegramBotDeliveryPublisher::new(
                TelegramBotClient::new(
                    TelegramBotClientConfig::new("111:AAA").with_api_base_url(&alpha_server.url),
                )
                .expect("alpha client"),
            )
            .with_clock(DeliveryClock::fixed(1_710_001_000_500)),
        );
        publishers.insert(
            beta_pubkey.clone(),
            TelegramBotDeliveryPublisher::new(
                TelegramBotClient::new(
                    TelegramBotClientConfig::new("222:BBB").with_api_base_url(&beta_server.url),
                )
                .expect("beta client"),
            )
            .with_clock(DeliveryClock::fixed(1_710_001_000_600)),
        );
        let mut registry = TelegramPublisherRegistry::from_publishers(publishers);

        let daemon_dir = tempfile::tempdir().expect("daemon dir").keep();

        let alpha_request = TelegramDeliveryRequest {
            nostr_event_id: "event-alpha".to_string(),
            correlation_id: "corr-alpha".to_string(),
            project_binding: TelegramProjectBinding {
                project_d_tag: "demo".to_string(),
                backend_pubkey: "b".repeat(64),
            },
            channel_binding: TelegramChannelBinding {
                chat_id: 100,
                message_thread_id: None,
                channel_label: None,
            },
            sender_identity: TelegramSenderIdentity {
                agent_pubkey: alpha_pubkey.clone(),
                display_name: None,
            },
            delivery_reason: TelegramDeliveryReason::FinalReply,
            reply_to_telegram_message_id: None,
            payload: TelegramDeliveryPayload::PlainText {
                text: "hello alpha".to_string(),
            },
            writer_version: "test".to_string(),
        };
        let beta_request = TelegramDeliveryRequest {
            nostr_event_id: "event-beta".to_string(),
            correlation_id: "corr-beta".to_string(),
            project_binding: TelegramProjectBinding {
                project_d_tag: "demo".to_string(),
                backend_pubkey: "b".repeat(64),
            },
            channel_binding: TelegramChannelBinding {
                chat_id: 200,
                message_thread_id: None,
                channel_label: None,
            },
            sender_identity: TelegramSenderIdentity {
                agent_pubkey: beta_pubkey.clone(),
                display_name: None,
            },
            delivery_reason: TelegramDeliveryReason::FinalReply,
            reply_to_telegram_message_id: None,
            payload: TelegramDeliveryPayload::PlainText {
                text: "hello beta".to_string(),
            },
            writer_version: "test".to_string(),
        };

        accept_telegram_delivery_request(&daemon_dir, alpha_request, 1_710_001_000_000)
            .expect("alpha pending");
        accept_telegram_delivery_request(&daemon_dir, beta_request, 1_710_001_000_000)
            .expect("beta pending");

        let outcomes = drain_pending_telegram_outbox(&daemon_dir, &mut registry, 1_710_001_000_500)
            .expect("drain");
        assert_eq!(outcomes.len(), 2);
        let mut message_ids: Vec<i64> = outcomes
            .iter()
            .map(|o| o.telegram_message_id.expect("delivered"))
            .collect();
        message_ids.sort();
        assert_eq!(message_ids, vec![4001, 4002]);

        let alpha_captured = alpha_server.captured();
        let beta_captured = beta_server.captured();
        assert_eq!(alpha_captured.len(), 1);
        assert_eq!(beta_captured.len(), 1);
        let alpha_body = String::from_utf8_lossy(&alpha_captured[0].body);
        let beta_body = String::from_utf8_lossy(&beta_captured[0].body);
        assert!(alpha_body.contains("\"chat_id\":100"));
        assert!(alpha_body.contains("hello alpha"));
        assert!(beta_body.contains("\"chat_id\":200"));
        assert!(beta_body.contains("hello beta"));

        fs::remove_dir_all(&daemon_dir).ok();
    }
}
