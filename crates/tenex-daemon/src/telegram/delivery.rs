//! Outbox-drain publisher that bridges [`TelegramOutboxRecord`] payloads to
//! the synchronous [`crate::telegram::client::TelegramBotClient`].
//!
//! This is the single place where Bot API responses translate into
//! [`TelegramDeliveryResult`] values the outbox can persist. It preserves
//! two TS behaviors verbatim:
//!
//! - `TelegramDeliveryService.sendMessageWithHtmlRetry` (src/services/telegram/TelegramDeliveryService.ts:244-285):
//!   if `parse_mode=HTML` is rejected with a parse failure, retry once with
//!   the content as raw text (no parse mode). Failure of the plain-text
//!   retry surfaces the retry's error, not the original.
//! - Voice marker semantics from `extractTelegramVoiceReply`
//!   (TelegramDeliveryService.ts:23-45): absolute-path only, read the file
//!   at delivery time, surface `Permanent` when missing.
//!
//! The publisher is stateless beyond its embedded client; it can be shared
//! across drain passes without coordination.

use std::path::PathBuf;

use crate::telegram::client::{
    ChatId, ParseMode, SendMessageParams, SendVoiceParams, TelegramBotClient, TelegramClientError,
};
use crate::telegram_outbox::{
    TelegramDeliveryPayload, TelegramDeliveryPublisher, TelegramDeliveryResult, TelegramErrorClass,
    TelegramOutboxRecord,
};

/// Delivery publisher backed by a real Bot API client. Constructed per
/// bot token; the outbox drains one bot's pending records in a single pass.
pub struct TelegramBotDeliveryPublisher {
    client: TelegramBotClient,
    clock: DeliveryClock,
}

/// Source of delivery timestamps (`delivered_at`). The outbox caller passes
/// its own `attempted_at`; the delivered-at stamp here defaults to the
/// system clock so success records carry an accurate wallclock receipt.
/// Tests inject a fixed clock.
#[derive(Clone)]
pub struct DeliveryClock(std::sync::Arc<dyn Fn() -> u64 + Send + Sync>);

impl std::fmt::Debug for DeliveryClock {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeliveryClock").finish()
    }
}

impl DeliveryClock {
    pub fn system() -> Self {
        Self(std::sync::Arc::new(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0)
        }))
    }

    pub fn fixed(value: u64) -> Self {
        Self(std::sync::Arc::new(move || value))
    }

    fn now(&self) -> u64 {
        (self.0)()
    }
}

impl TelegramBotDeliveryPublisher {
    pub fn new(client: TelegramBotClient) -> Self {
        Self {
            client,
            clock: DeliveryClock::system(),
        }
    }

    pub fn with_clock(mut self, clock: DeliveryClock) -> Self {
        self.clock = clock;
        self
    }

    fn publish_html_text(
        &self,
        record: &TelegramOutboxRecord,
        html: &str,
    ) -> TelegramDeliveryResult {
        match self.send_html(record, html) {
            Ok(message_id) => self.delivered(message_id),
            Err(TelegramClientError::HtmlParseError(description)) => {
                // Plain-text retry: exactly TS behavior — retry once without
                // parse_mode, sending the original record text as raw.
                match self.send_plain(record, html) {
                    Ok(message_id) => self.delivered(message_id),
                    Err(retry_error) => classify_error(
                        retry_error,
                        Some(format!("html parse failure then: {description}")),
                    ),
                }
            }
            Err(error) => classify_error(error, None),
        }
    }

    fn publish_plain_text(
        &self,
        record: &TelegramOutboxRecord,
        text: &str,
    ) -> TelegramDeliveryResult {
        match self.send_plain(record, text) {
            Ok(message_id) => self.delivered(message_id),
            Err(error) => classify_error(error, None),
        }
    }

    fn publish_reserved_voice(
        &self,
        record: &TelegramOutboxRecord,
        marker: &str,
    ) -> TelegramDeliveryResult {
        let voice_path = PathBuf::from(marker);
        if !voice_path.is_absolute() {
            return TelegramDeliveryResult::PermanentFailure {
                error_class: TelegramErrorClass::BadRequest,
                error_detail: format!(
                    "telegram_voice marker path is not absolute: {}",
                    voice_path.display()
                ),
            };
        }
        if !voice_path.exists() {
            return TelegramDeliveryResult::PermanentFailure {
                error_class: TelegramErrorClass::BadRequest,
                error_detail: format!(
                    "telegram_voice marker path does not exist: {}",
                    voice_path.display()
                ),
            };
        }
        match self.client.send_voice(SendVoiceParams {
            chat_id: ChatId::Numeric(record.channel_binding.chat_id),
            voice_path,
            reply_to_message_id: record.reply_to_telegram_message_id,
            message_thread_id: record.channel_binding.message_thread_id,
            caption: None,
            parse_mode: None,
        }) {
            Ok(sent) => self.delivered(sent.message_id),
            Err(error) => classify_error(error, None),
        }
    }

    fn send_html(
        &self,
        record: &TelegramOutboxRecord,
        html: &str,
    ) -> Result<i64, TelegramClientError> {
        let sent = self.client.send_message(SendMessageParams {
            chat_id: ChatId::Numeric(record.channel_binding.chat_id),
            text: html.to_string(),
            parse_mode: Some(ParseMode::Html),
            reply_to_message_id: record.reply_to_telegram_message_id,
            message_thread_id: record.channel_binding.message_thread_id,
            disable_link_preview: true,
        })?;
        Ok(sent.message_id)
    }

    fn send_plain(
        &self,
        record: &TelegramOutboxRecord,
        text: &str,
    ) -> Result<i64, TelegramClientError> {
        let sent = self.client.send_message(SendMessageParams {
            chat_id: ChatId::Numeric(record.channel_binding.chat_id),
            text: strip_html(text),
            parse_mode: None,
            reply_to_message_id: record.reply_to_telegram_message_id,
            message_thread_id: record.channel_binding.message_thread_id,
            disable_link_preview: true,
        })?;
        Ok(sent.message_id)
    }

    fn delivered(&self, telegram_message_id: i64) -> TelegramDeliveryResult {
        TelegramDeliveryResult::Delivered {
            telegram_message_id,
            delivered_at: self.clock.now(),
        }
    }
}

impl TelegramDeliveryPublisher for TelegramBotDeliveryPublisher {
    fn deliver(&mut self, record: &TelegramOutboxRecord) -> TelegramDeliveryResult {
        match &record.payload {
            TelegramDeliveryPayload::HtmlText { html } => self.publish_html_text(record, html),
            TelegramDeliveryPayload::PlainText { text } => self.publish_plain_text(record, text),
            TelegramDeliveryPayload::AskError { html } => self.publish_html_text(record, html),
            TelegramDeliveryPayload::ReservedVoice { marker } => {
                self.publish_reserved_voice(record, marker)
            }
        }
    }
}

/// Strip HTML tags naively so the plain-text retry carries the prose
/// without bare angle-bracket markup. Matches what the TS service does
/// implicitly by sending the original `content` (which is the agent's
/// markdown-ish source, already tag-free) — but since our record stores
/// rendered HTML, we drop tags here.
fn strip_html(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut in_tag = false;
    for ch in input.chars() {
        match ch {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    // Decode the small set of entities the renderer emits (escape_html:
    // &amp;, &lt;, &gt;, &quot;, &#39;). Done as a single pass.
    out.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

fn classify_error(error: TelegramClientError, context: Option<String>) -> TelegramDeliveryResult {
    let classified = error.classify();
    // Convert seconds → ms; the outbox record stores retry-after in the
    // same unit as `attempted_at` (ms). See `next_attempt_at` in
    // telegram_outbox.rs.
    let retry_after_ms = classified
        .retry_after_seconds
        .map(|seconds| seconds.saturating_mul(1_000));
    let detail = match context {
        Some(extra) => format!("{error}: {extra}"),
        None => error.to_string(),
    };
    if classified.retryable {
        TelegramDeliveryResult::RetryableFailure {
            error_class: classified.class,
            error_detail: detail,
            retry_after: retry_after_ms,
        }
    } else {
        TelegramDeliveryResult::PermanentFailure {
            error_class: classified.class,
            error_detail: detail,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::telegram::client::TelegramBotClientConfig;
    use crate::telegram_outbox::{
        TELEGRAM_OUTBOX_RECORD_SCHEMA_VERSION, TELEGRAM_OUTBOX_WRITER, TelegramChannelBinding,
        TelegramDeliveryReason, TelegramOutboxRecord, TelegramOutboxStatus, TelegramProjectBinding,
        TelegramSenderIdentity,
    };
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
        #[allow(dead_code)]
        headers: Vec<(String, String)>,
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

        let mut headers: Vec<(String, String)> = Vec::new();
        let mut content_length: usize = 0;
        loop {
            let mut line = String::new();
            let n = reader.read_line(&mut line).expect("header line");
            if n == 0 || line == "\r\n" || line == "\n" {
                break;
            }
            let line = line.trim_end().to_string();
            if let Some((name, value)) = line.split_once(':') {
                let name = name.trim().to_ascii_lowercase();
                let value = value.trim().to_string();
                if name == "content-length" {
                    content_length = value.parse().unwrap_or(0);
                }
                headers.push((name, value));
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
                headers,
                body: body_bytes,
            });

        let status_text = match status {
            200 => "OK",
            400 => "Bad Request",
            401 => "Unauthorized",
            403 => "Forbidden",
            429 => "Too Many Requests",
            500 => "Internal Server Error",
            503 => "Service Unavailable",
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

    fn publisher_for(url: &str) -> TelegramBotDeliveryPublisher {
        let config = TelegramBotClientConfig::new("TESTTOKEN").with_api_base_url(url);
        let client = TelegramBotClient::new(config).expect("client");
        TelegramBotDeliveryPublisher::new(client)
            .with_clock(DeliveryClock::fixed(1_710_001_000_500))
    }

    fn record(payload: TelegramDeliveryPayload) -> TelegramOutboxRecord {
        TelegramOutboxRecord {
            schema_version: TELEGRAM_OUTBOX_RECORD_SCHEMA_VERSION,
            writer: TELEGRAM_OUTBOX_WRITER.to_string(),
            writer_version: "test".to_string(),
            record_id: "rec-01".to_string(),
            status: TelegramOutboxStatus::Pending,
            created_at: 1_710_001_000_000,
            updated_at: 1_710_001_000_000,
            nostr_event_id: "event-id".to_string(),
            correlation_id: "corr-id".to_string(),
            project_binding: TelegramProjectBinding {
                project_d_tag: "demo".to_string(),
                backend_pubkey: "backend-pubkey".to_string(),
            },
            channel_binding: TelegramChannelBinding {
                chat_id: -1001,
                message_thread_id: Some(7),
                channel_label: None,
            },
            sender_identity: TelegramSenderIdentity {
                agent_pubkey: "agent-pubkey".to_string(),
                display_name: None,
            },
            delivery_reason: TelegramDeliveryReason::FinalReply,
            reply_to_telegram_message_id: Some(42),
            payload,
            attempts: Vec::new(),
        }
    }

    #[test]
    fn html_text_success_returns_delivered() {
        let body = serde_json::json!({
            "ok": true,
            "result": {
                "message_id": 9001,
                "chat": { "id": -1001, "type": "supergroup" }
            }
        })
        .to_string();
        let server = MockServer::start(vec![ScriptedResponse { status: 200, body }]);
        let mut publisher = publisher_for(&server.url);
        let result = publisher.deliver(&record(TelegramDeliveryPayload::HtmlText {
            html: "<b>ok</b>".to_string(),
        }));
        assert!(matches!(
            result,
            TelegramDeliveryResult::Delivered {
                telegram_message_id: 9001,
                delivered_at: 1_710_001_000_500,
            }
        ));
        let requests = server.captured();
        assert_eq!(requests.len(), 1);
        let body = String::from_utf8_lossy(&requests[0].body);
        assert!(body.contains("\"parse_mode\":\"HTML\""));
    }

    #[test]
    fn html_parse_failure_retries_as_plain_text() {
        let script = vec![
            ScriptedResponse {
                status: 400,
                body: serde_json::json!({
                    "ok": false,
                    "error_code": 400,
                    "description": "Bad Request: can't parse entities: unclosed tag at byte offset 5"
                })
                .to_string(),
            },
            ScriptedResponse {
                status: 200,
                body: serde_json::json!({
                    "ok": true,
                    "result": {
                        "message_id": 9002,
                        "chat": { "id": -1001, "type": "supergroup" }
                    }
                })
                .to_string(),
            },
        ];
        let server = MockServer::start(script);
        let mut publisher = publisher_for(&server.url);
        let result = publisher.deliver(&record(TelegramDeliveryPayload::HtmlText {
            html: "<b>broken".to_string(),
        }));
        assert!(matches!(
            result,
            TelegramDeliveryResult::Delivered {
                telegram_message_id: 9002,
                ..
            }
        ));
        let requests = server.captured();
        assert_eq!(requests.len(), 2);
        let first = String::from_utf8_lossy(&requests[0].body);
        let second = String::from_utf8_lossy(&requests[1].body);
        assert!(first.contains("\"parse_mode\":\"HTML\""));
        assert!(!second.contains("parse_mode"));
        assert!(second.contains("\"text\":\"broken\""));
    }

    #[test]
    fn html_retry_failure_surfaces_retry_error() {
        let script = vec![
            ScriptedResponse {
                status: 400,
                body: serde_json::json!({
                    "ok": false,
                    "error_code": 400,
                    "description": "Bad Request: can't parse entities"
                })
                .to_string(),
            },
            ScriptedResponse {
                status: 500,
                body: serde_json::json!({
                    "ok": false,
                    "error_code": 500,
                    "description": "Internal Server Error"
                })
                .to_string(),
            },
        ];
        let server = MockServer::start(script);
        let mut publisher = publisher_for(&server.url);
        let result = publisher.deliver(&record(TelegramDeliveryPayload::HtmlText {
            html: "<b>still broken".to_string(),
        }));
        match result {
            TelegramDeliveryResult::RetryableFailure { error_class, .. } => {
                assert_eq!(error_class, TelegramErrorClass::ServerError)
            }
            other => panic!("expected retryable failure, got {other:?}"),
        }
    }

    #[test]
    fn plain_text_success_does_not_send_html() {
        let body = serde_json::json!({
            "ok": true,
            "result": {
                "message_id": 9003,
                "chat": { "id": -1001, "type": "supergroup" }
            }
        })
        .to_string();
        let server = MockServer::start(vec![ScriptedResponse { status: 200, body }]);
        let mut publisher = publisher_for(&server.url);
        let result = publisher.deliver(&record(TelegramDeliveryPayload::PlainText {
            text: "hi there".to_string(),
        }));
        assert!(matches!(result, TelegramDeliveryResult::Delivered { .. }));
        let captured = server.captured();
        assert_eq!(captured.len(), 1);
        let body = String::from_utf8_lossy(&captured[0].body);
        assert!(!body.contains("parse_mode"));
        assert!(body.contains("\"text\":\"hi there\""));
    }

    #[test]
    fn ask_error_success_delivered() {
        let body = serde_json::json!({
            "ok": true,
            "result": {
                "message_id": 9004,
                "chat": { "id": -1001, "type": "supergroup" }
            }
        })
        .to_string();
        let server = MockServer::start(vec![ScriptedResponse { status: 200, body }]);
        let mut publisher = publisher_for(&server.url);
        let result = publisher.deliver(&record(TelegramDeliveryPayload::AskError {
            html: "<i>ask</i>".to_string(),
        }));
        assert!(matches!(result, TelegramDeliveryResult::Delivered { .. }));
        let captured = server.captured();
        let body = String::from_utf8_lossy(&captured[0].body);
        assert!(body.contains("\"parse_mode\":\"HTML\""));
    }

    #[test]
    fn reserved_voice_success_uses_send_voice_endpoint() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let voice_path = tempdir.path().join("voice.ogg");
        std::fs::write(&voice_path, b"OggS\x00\x02\x00\x00\x00\x00\x00\x00\x00\x00")
            .expect("write voice");
        let body = serde_json::json!({
            "ok": true,
            "result": {
                "message_id": 9005,
                "chat": { "id": -1001, "type": "supergroup" }
            }
        })
        .to_string();
        let server = MockServer::start(vec![ScriptedResponse { status: 200, body }]);
        let mut publisher = publisher_for(&server.url);
        let result = publisher.deliver(&record(TelegramDeliveryPayload::ReservedVoice {
            marker: voice_path.to_string_lossy().to_string(),
        }));
        assert!(matches!(
            result,
            TelegramDeliveryResult::Delivered {
                telegram_message_id: 9005,
                ..
            }
        ));
        let captured = server.captured();
        assert_eq!(captured.len(), 1);
        assert!(captured[0].path.contains("sendVoice"));
    }

    #[test]
    fn reserved_voice_missing_file_is_permanent() {
        let server = MockServer::start(vec![]);
        let mut publisher = publisher_for(&server.url);
        let result = publisher.deliver(&record(TelegramDeliveryPayload::ReservedVoice {
            marker: "/definitely/does/not/exist.ogg".to_string(),
        }));
        match result {
            TelegramDeliveryResult::PermanentFailure { error_class, .. } => {
                assert_eq!(error_class, TelegramErrorClass::BadRequest);
            }
            other => panic!("expected permanent failure, got {other:?}"),
        }
    }

    #[test]
    fn reserved_voice_relative_path_rejected_without_io() {
        let server = MockServer::start(vec![]);
        let mut publisher = publisher_for(&server.url);
        let result = publisher.deliver(&record(TelegramDeliveryPayload::ReservedVoice {
            marker: "relative/voice.ogg".to_string(),
        }));
        match result {
            TelegramDeliveryResult::PermanentFailure {
                error_class,
                error_detail,
            } => {
                assert_eq!(error_class, TelegramErrorClass::BadRequest);
                assert!(error_detail.contains("not absolute"));
            }
            other => panic!("expected permanent failure, got {other:?}"),
        }
    }

    #[test]
    fn outbox_drain_round_trip_delivers_pending_record() {
        use crate::telegram_outbox::{
            TelegramDeliveryPayload, TelegramDeliveryReason, TelegramDeliveryRequest,
            accept_telegram_delivery_request, drain_pending_telegram_outbox,
        };
        let body = serde_json::json!({
            "ok": true,
            "result": {
                "message_id": 55555,
                "chat": { "id": 101, "type": "private" }
            }
        })
        .to_string();
        let server = MockServer::start(vec![ScriptedResponse { status: 200, body }]);

        let daemon_dir = tempfile::tempdir().expect("daemon dir").keep();
        let request = TelegramDeliveryRequest {
            nostr_event_id: "event-e2e-1".to_string(),
            correlation_id: "corr-e2e-1".to_string(),
            project_binding: TelegramProjectBinding {
                project_d_tag: "demo".to_string(),
                backend_pubkey: "b".repeat(64),
            },
            channel_binding: TelegramChannelBinding {
                chat_id: 101,
                message_thread_id: None,
                channel_label: None,
            },
            sender_identity: TelegramSenderIdentity {
                agent_pubkey: "a".repeat(64),
                display_name: None,
            },
            delivery_reason: TelegramDeliveryReason::FinalReply,
            reply_to_telegram_message_id: Some(1),
            payload: TelegramDeliveryPayload::HtmlText {
                html: "<b>hello</b>".to_string(),
            },
            writer_version: "test".to_string(),
        };
        accept_telegram_delivery_request(&daemon_dir, request, 1_710_001_000_000)
            .expect("accept pending");

        let mut publisher = publisher_for(&server.url);
        let outcomes =
            drain_pending_telegram_outbox(&daemon_dir, &mut publisher, 1_710_001_000_500)
                .expect("drain");
        assert_eq!(outcomes.len(), 1);
        assert_eq!(outcomes[0].telegram_message_id, Some(55555));
        std::fs::remove_dir_all(&daemon_dir).ok();
    }

    #[test]
    fn outbox_drain_retryable_then_requeue_then_delivered() {
        use crate::telegram_outbox::{
            TelegramDeliveryPayload, TelegramDeliveryReason, TelegramDeliveryRequest,
            accept_telegram_delivery_request, drain_pending_telegram_outbox,
            requeue_due_failed_telegram_outbox_records,
        };
        let script = vec![
            ScriptedResponse {
                status: 503,
                body: serde_json::json!({
                    "ok": false,
                    "error_code": 503,
                    "description": "Service Unavailable"
                })
                .to_string(),
            },
            ScriptedResponse {
                status: 200,
                body: serde_json::json!({
                    "ok": true,
                    "result": {
                        "message_id": 66666,
                        "chat": { "id": 202, "type": "private" }
                    }
                })
                .to_string(),
            },
        ];
        let server = MockServer::start(script);
        let daemon_dir = tempfile::tempdir().expect("daemon dir").keep();
        let request = TelegramDeliveryRequest {
            nostr_event_id: "event-rq".to_string(),
            correlation_id: "corr-rq".to_string(),
            project_binding: TelegramProjectBinding {
                project_d_tag: "demo".to_string(),
                backend_pubkey: "b".repeat(64),
            },
            channel_binding: TelegramChannelBinding {
                chat_id: 202,
                message_thread_id: None,
                channel_label: None,
            },
            sender_identity: TelegramSenderIdentity {
                agent_pubkey: "a".repeat(64),
                display_name: None,
            },
            delivery_reason: TelegramDeliveryReason::FinalReply,
            reply_to_telegram_message_id: None,
            payload: TelegramDeliveryPayload::HtmlText {
                html: "<b>retry me</b>".to_string(),
            },
            writer_version: "test".to_string(),
        };
        accept_telegram_delivery_request(&daemon_dir, request, 1_710_001_000_000)
            .expect("accept pending");

        let mut publisher = publisher_for(&server.url);
        let first = drain_pending_telegram_outbox(&daemon_dir, &mut publisher, 1_710_001_000_100)
            .expect("first drain");
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].status, TelegramOutboxStatus::Failed);

        let requeued = requeue_due_failed_telegram_outbox_records(&daemon_dir, 1_710_001_050_000)
            .expect("requeue");
        assert_eq!(requeued.len(), 1);

        let second = drain_pending_telegram_outbox(&daemon_dir, &mut publisher, 1_710_001_051_000)
            .expect("second drain");
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].status, TelegramOutboxStatus::Delivered);
        assert_eq!(second[0].telegram_message_id, Some(66666));
        std::fs::remove_dir_all(&daemon_dir).ok();
    }

    #[test]
    fn outbox_drain_permanent_failure_stays_failed() {
        use crate::telegram_outbox::{
            TelegramDeliveryPayload, TelegramDeliveryReason, TelegramDeliveryRequest,
            accept_telegram_delivery_request, drain_pending_telegram_outbox,
        };
        let server = MockServer::start(vec![ScriptedResponse {
            status: 403,
            body: serde_json::json!({
                "ok": false,
                "error_code": 403,
                "description": "Forbidden: bot was blocked by the user"
            })
            .to_string(),
        }]);
        let daemon_dir = tempfile::tempdir().expect("daemon dir").keep();
        let request = TelegramDeliveryRequest {
            nostr_event_id: "event-perm".to_string(),
            correlation_id: "corr-perm".to_string(),
            project_binding: TelegramProjectBinding {
                project_d_tag: "demo".to_string(),
                backend_pubkey: "b".repeat(64),
            },
            channel_binding: TelegramChannelBinding {
                chat_id: 303,
                message_thread_id: None,
                channel_label: None,
            },
            sender_identity: TelegramSenderIdentity {
                agent_pubkey: "a".repeat(64),
                display_name: None,
            },
            delivery_reason: TelegramDeliveryReason::FinalReply,
            reply_to_telegram_message_id: None,
            payload: TelegramDeliveryPayload::HtmlText {
                html: "<b>nope</b>".to_string(),
            },
            writer_version: "test".to_string(),
        };
        accept_telegram_delivery_request(&daemon_dir, request, 1_710_001_000_000)
            .expect("accept pending");
        let mut publisher = publisher_for(&server.url);
        let outcomes =
            drain_pending_telegram_outbox(&daemon_dir, &mut publisher, 1_710_001_000_500)
                .expect("drain");
        assert_eq!(outcomes.len(), 1);
        assert_eq!(outcomes[0].status, TelegramOutboxStatus::Failed);
        std::fs::remove_dir_all(&daemon_dir).ok();
    }
}
