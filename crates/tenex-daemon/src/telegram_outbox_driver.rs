//! Async driver for the Telegram outbox. Replaces the
//! `telegram_publisher.run_maintenance` call inside `daemon_maintenance.rs`.
//!
//! The driver wakes on two signals:
//! - `telegram_enqueued_rx`: a new record was written to the pending directory.
//! - A per-failure `sleep_until` timer for the earliest retryable failure.
//!
//! On each wake it calls `run_telegram_outbox_maintenance` (drain + requeue) if
//! a publisher registry is available, or
//! `run_telegram_outbox_maintenance_without_drain` (requeue only) otherwise.
//! Both paths preserve the existing retry policy exactly — this is a mechanical
//! relocation, not a behaviour change.

use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::sync::{mpsc, watch};
use tokio::time::Instant;

use crate::daemon_signals::TelegramEnqueued;
use crate::telegram::publisher_registry::TelegramPublisherRegistry;
use crate::telegram_outbox::{
    inspect_telegram_outbox, run_telegram_outbox_maintenance,
    run_telegram_outbox_maintenance_without_drain,
};

pub struct TelegramOutboxDriverDeps {
    pub daemon_dir: PathBuf,
    /// When `Some` and non-empty, the driver drains the pending outbox through
    /// the registry. When `None` or empty, it only requeues due failed records.
    pub publisher_registry: Option<TelegramPublisherRegistry>,
}

pub async fn run_telegram_outbox_driver(
    mut deps: TelegramOutboxDriverDeps,
    mut telegram_enqueued_rx: mpsc::UnboundedReceiver<TelegramEnqueued>,
    mut shutdown_rx: watch::Receiver<bool>,
) {
    // On startup: drain immediately if there are pending records (written
    // before the daemon started, e.g. by a worker process that exited) or if
    // there are retryable failed records whose retry deadline has passed.
    let mut retry_at: Option<Instant> = compute_startup_retry_instant(&deps.daemon_dir);

    loop {
        tokio::select! {
            _ = shutdown_rx.changed() => break,
            _ = telegram_enqueued_rx.recv() => {
                retry_at = run_drain(&mut deps).await;
            }
            _ = sleep_until_optional(retry_at) => {
                retry_at = run_drain(&mut deps).await;
            }
        }
    }
}

async fn run_drain(deps: &mut TelegramOutboxDriverDeps) -> Option<Instant> {
    let daemon_dir = deps.daemon_dir.clone();

    let next_retry_ms = match deps.publisher_registry.take() {
        Some(mut registry) if !registry.is_empty() => {
            let result = tokio::task::spawn_blocking(move || {
                let now_ms = current_unix_time_ms();
                let report =
                    run_telegram_outbox_maintenance(&daemon_dir, &mut registry, now_ms)?;
                Ok::<_, crate::telegram_outbox::TelegramOutboxError>((
                    report.diagnostics_after.next_retry_at,
                    registry,
                ))
            })
            .await;

            match result {
                Ok(Ok((next_retry_ms, registry))) => {
                    deps.publisher_registry = Some(registry);
                    next_retry_ms
                }
                Ok(Err(error)) => {
                    // Registry is consumed; rebuild from disk on next wake.
                    // The outbox records are safely on disk so no data is lost.
                    tracing::warn!(
                        error = %error,
                        "telegram outbox driver: maintenance with publisher failed; will retry on next signal"
                    );
                    None
                }
                Err(join_error) => {
                    tracing::warn!(
                        error = %join_error,
                        "telegram outbox driver: spawn_blocking panicked; will retry on next signal"
                    );
                    None
                }
            }
        }
        publisher_registry => {
            // Restore whatever we took (None or empty registry).
            deps.publisher_registry = publisher_registry;
            let daemon_dir_clone = daemon_dir.clone();
            let result = tokio::task::spawn_blocking(move || {
                let now_ms = current_unix_time_ms();
                run_telegram_outbox_maintenance_without_drain(&daemon_dir_clone, now_ms)
            })
            .await;

            match result {
                Ok(Ok(report)) => report.diagnostics_after.next_retry_at,
                Ok(Err(error)) => {
                    tracing::warn!(
                        error = %error,
                        "telegram outbox driver: drain-less maintenance failed; will retry on next signal"
                    );
                    None
                }
                Err(join_error) => {
                    tracing::warn!(
                        error = %join_error,
                        "telegram outbox driver: spawn_blocking panicked; will retry on next signal"
                    );
                    None
                }
            }
        }
    };

    next_retry_ms.map(ms_to_instant)
}

/// Returns a future that resolves at `instant` when `Some`, or never when `None`.
async fn sleep_until_optional(instant: Option<Instant>) {
    match instant {
        Some(instant) => tokio::time::sleep_until(instant).await,
        None => std::future::pending().await,
    }
}

/// On startup, returns `Some(Instant::now())` if there are pending records
/// pre-written before the daemon started (e.g. by a worker process), so the
/// driver drains them immediately. Falls back to the failed-record retry
/// instant (same as `compute_next_retry_instant`).
fn compute_startup_retry_instant(daemon_dir: &PathBuf) -> Option<Instant> {
    let now_ms = current_unix_time_ms();
    let diagnostics = inspect_telegram_outbox(daemon_dir, now_ms).ok()?;
    if diagnostics.pending_count > 0 {
        return Some(Instant::now());
    }
    diagnostics.next_retry_at.map(ms_to_instant)
}

fn ms_to_instant(next_retry_at_ms: u64) -> Instant {
    let now_ms = current_unix_time_ms();
    let delay_ms = next_retry_at_ms.saturating_sub(now_ms);
    Instant::now() + Duration::from_millis(delay_ms)
}

fn current_unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time must be after UNIX_EPOCH")
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::telegram_outbox::{
        TelegramChannelBinding, TelegramDeliveryPayload, TelegramDeliveryReason,
        TelegramDeliveryRequest, TelegramDeliveryResult, TelegramOutboxRecord,
        TelegramProjectBinding, TelegramSenderIdentity, accept_telegram_delivery_request,
        inspect_telegram_outbox,
    };
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after epoch")
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("{prefix}-{nanos}-{counter}"))
    }

    fn make_delivery_request(nostr_event_id: &str) -> TelegramDeliveryRequest {
        TelegramDeliveryRequest {
            nostr_event_id: nostr_event_id.to_string(),
            correlation_id: format!("corr-{nostr_event_id}"),
            project_binding: TelegramProjectBinding {
                project_d_tag: "project-alpha".to_string(),
                backend_pubkey: "b".repeat(64),
            },
            channel_binding: TelegramChannelBinding {
                chat_id: -1001,
                message_thread_id: None,
                channel_label: None,
            },
            sender_identity: TelegramSenderIdentity {
                agent_pubkey: "a".repeat(64),
                display_name: None,
            },
            delivery_reason: TelegramDeliveryReason::ProactiveSend,
            reply_to_telegram_message_id: None,
            payload: TelegramDeliveryPayload::PlainText {
                text: "hello from test".to_string(),
            },
            writer_version: "test@0".to_string(),
        }
    }

    struct FakePublisher {
        result: TelegramDeliveryResult,
    }

    impl crate::telegram_outbox::TelegramDeliveryPublisher for FakePublisher {
        fn deliver(&mut self, _record: &TelegramOutboxRecord) -> TelegramDeliveryResult {
            self.result.clone()
        }
    }

    /// Smoke test: enqueue one record into the outbox, call the maintenance
    /// function with a fake delivery publisher, assert the record is delivered
    /// and the pending count drops to zero.
    #[test]
    fn driver_maintenance_drains_enqueued_record_via_fake_publisher() {
        let daemon_dir = unique_temp_dir("telegram-outbox-driver-smoke");
        let request = make_delivery_request("event-smoke-001");
        let now_ms = 1_710_001_000_000_u64;

        accept_telegram_delivery_request(&daemon_dir, request, now_ms)
            .expect("accept must succeed");

        let before = inspect_telegram_outbox(&daemon_dir, now_ms).expect("inspect must succeed");
        assert_eq!(before.pending_count, 1);
        assert_eq!(before.delivered_count, 0);

        let mut publisher = FakePublisher {
            result: TelegramDeliveryResult::Delivered {
                telegram_message_id: 999,
                delivered_at: now_ms,
            },
        };
        let report = run_telegram_outbox_maintenance(&daemon_dir, &mut publisher, now_ms)
            .expect("maintenance must succeed");

        assert_eq!(report.drained.len(), 1);
        assert_eq!(report.diagnostics_after.pending_count, 0);
        assert_eq!(report.diagnostics_after.delivered_count, 1);

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    /// When no publisher is available, pending records stay pending and the
    /// drain report is empty.
    #[test]
    fn driver_maintenance_without_drain_leaves_pending_records() {
        let daemon_dir = unique_temp_dir("telegram-outbox-driver-nodrain");
        let request = make_delivery_request("event-nodrain-001");
        let now_ms = 1_710_001_000_000_u64;

        accept_telegram_delivery_request(&daemon_dir, request, now_ms)
            .expect("accept must succeed");

        let report = run_telegram_outbox_maintenance_without_drain(&daemon_dir, now_ms)
            .expect("maintenance without drain must succeed");

        assert!(report.drained.is_empty());
        assert_eq!(report.diagnostics_after.pending_count, 1);

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    /// End-to-end test: enqueue a record, run the async driver with a recording
    /// publisher, send a `TelegramEnqueued` wake signal, and assert the outbox
    /// is drained to zero pending records.
    ///
    /// Requires `--features integration` because it binds a real TCP listener
    /// (the mock HTTP Telegram bot API server).
    #[tokio::test]
    #[cfg_attr(not(feature = "integration"), ignore)]
    async fn driver_loop_drains_record_via_publisher_registry() {
        use crate::telegram::client::{TelegramBotClient, TelegramBotClientConfig};
        use crate::telegram::delivery::{DeliveryClock, TelegramBotDeliveryPublisher};
        use crate::telegram::publisher_registry::TelegramPublisherRegistry;
        use std::collections::HashMap;
        use std::io::{BufRead, BufReader, Write};
        use std::net::TcpListener;
        use std::sync::{Arc, Mutex};
        use std::thread;
        use tokio::sync::{mpsc, watch};

        // Minimal mock Telegram API that returns a successful sendMessage response.
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock server");
        let server_url = format!("http://{}", listener.local_addr().expect("local addr"));
        let served = Arc::new(Mutex::new(0u32));
        let served_clone = Arc::clone(&served);
        let _server_thread = thread::spawn(move || {
            for stream in listener.incoming().take(5) {
                let mut stream = match stream {
                    Ok(s) => s,
                    Err(_) => break,
                };
                let mut reader = BufReader::new(stream.try_clone().expect("clone"));
                // Read request line + headers until blank line.
                let mut content_length: usize = 0;
                let mut line = String::new();
                reader.read_line(&mut line).ok();
                loop {
                    let mut h = String::new();
                    reader.read_line(&mut h).ok();
                    let trimmed = h.trim_end();
                    if trimmed.is_empty() {
                        break;
                    }
                    if let Some((name, value)) = trimmed.split_once(':')
                        && name.trim().eq_ignore_ascii_case("content-length")
                    {
                        content_length = value.trim().parse().unwrap_or(0);
                    }
                }
                let mut body = vec![0u8; content_length];
                use std::io::Read;
                reader.read_exact(&mut body).ok();
                let resp_body = r#"{"ok":true,"result":{"message_id":42,"chat":{"id":-1001,"type":"supergroup"}}}"#;
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{}",
                    resp_body.len(),
                    resp_body
                );
                stream.write_all(response.as_bytes()).ok();
                stream.flush().ok();
                *served_clone.lock().unwrap() += 1;
            }
        });

        let agent_pubkey = "a".repeat(64);
        let mut publishers: HashMap<String, TelegramBotDeliveryPublisher> = HashMap::new();
        publishers.insert(
            agent_pubkey.clone(),
            TelegramBotDeliveryPublisher::new(
                TelegramBotClient::new(
                    TelegramBotClientConfig::new("123:AAA").with_api_base_url(&server_url),
                )
                .expect("client"),
            )
            .with_clock(DeliveryClock::fixed(1_710_001_000_500)),
        );
        let registry = TelegramPublisherRegistry::from_publishers(publishers);

        let daemon_dir = unique_temp_dir("telegram-outbox-driver-e2e");
        let request = TelegramDeliveryRequest {
            nostr_event_id: "event-e2e-001".to_string(),
            correlation_id: "corr-e2e-001".to_string(),
            project_binding: TelegramProjectBinding {
                project_d_tag: "project-e2e".to_string(),
                backend_pubkey: "b".repeat(64),
            },
            channel_binding: TelegramChannelBinding {
                chat_id: -1001,
                message_thread_id: None,
                channel_label: None,
            },
            sender_identity: TelegramSenderIdentity {
                agent_pubkey: agent_pubkey.clone(),
                display_name: None,
            },
            delivery_reason: TelegramDeliveryReason::ProactiveSend,
            reply_to_telegram_message_id: None,
            payload: TelegramDeliveryPayload::PlainText {
                text: "hello e2e".to_string(),
            },
            writer_version: "test@0".to_string(),
        };

        let now_ms = 1_710_001_000_000_u64;
        accept_telegram_delivery_request(&daemon_dir, request, now_ms)
            .expect("accept must succeed");

        let before = inspect_telegram_outbox(&daemon_dir, now_ms).expect("inspect before");
        assert_eq!(before.pending_count, 1, "one record must be pending before driver runs");

        let (telegram_tx, telegram_rx) = mpsc::unbounded_channel::<TelegramEnqueued>();
        let (shutdown_tx, shutdown_rx) = watch::channel(false);

        let driver_handle = tokio::spawn(run_telegram_outbox_driver(
            TelegramOutboxDriverDeps {
                daemon_dir: daemon_dir.clone(),
                publisher_registry: Some(registry),
            },
            telegram_rx,
            shutdown_rx,
        ));

        // Wake the driver with an enqueue signal.
        telegram_tx.send(TelegramEnqueued).expect("send signal");

        // Give the driver time to drain (spawn_blocking inside).
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        // Shut down the driver.
        shutdown_tx.send(true).expect("shutdown send");
        driver_handle.await.expect("driver must not panic");

        let after = inspect_telegram_outbox(&daemon_dir, now_ms).expect("inspect after");
        assert_eq!(
            after.pending_count, 0,
            "driver must drain pending records when publisher_registry is wired"
        );
        assert_eq!(after.delivered_count, 1, "one record must be delivered");

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }
}
