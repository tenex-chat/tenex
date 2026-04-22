use std::path::Path;

use crate::nostr_event::SignedNostrEvent;
use crate::publish_outbox::{
    BackendPublishOutboxInput, PublishOutboxDiagnostics, PublishOutboxError,
    PublishOutboxMaintenanceReport, PublishOutboxRecord, PublishOutboxRelayPublisher,
    PublishOutboxRetryPolicy, accept_backend_signed_publish_event, inspect_publish_outbox,
    run_publish_outbox_maintenance_with_retry_policy,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublishRuntimeInspectInput<'a> {
    pub daemon_dir: &'a Path,
    pub inspected_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublishRuntimeInspectOutcome {
    pub diagnostics: PublishOutboxDiagnostics,
}

pub struct PublishRuntimeMaintainInput<'a, P: PublishOutboxRelayPublisher> {
    pub daemon_dir: &'a Path,
    pub publisher: &'a mut P,
    pub now: u64,
    pub retry_policy: PublishOutboxRetryPolicy,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublishRuntimeMaintainOutcome {
    pub maintenance_report: PublishOutboxMaintenanceReport,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackendPublishRuntimeInput<'a> {
    pub daemon_dir: &'a Path,
    pub event: SignedNostrEvent,
    pub accepted_at: u64,
    pub request_id: &'a str,
    pub request_sequence: u64,
    pub request_timestamp: u64,
    pub correlation_id: &'a str,
    pub project_id: &'a str,
    pub conversation_id: &'a str,
    pub expected_publisher_pubkey: &'a str,
    pub ral_number: u64,
    pub wait_for_relay_ok: bool,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackendPublishRuntimeOutcome {
    pub record: PublishOutboxRecord,
}

pub fn inspect_publish_runtime(
    input: PublishRuntimeInspectInput<'_>,
) -> Result<PublishRuntimeInspectOutcome, PublishOutboxError> {
    let diagnostics = inspect_publish_outbox(input.daemon_dir, input.inspected_at)?;

    Ok(PublishRuntimeInspectOutcome { diagnostics })
}

pub fn maintain_publish_runtime<P: PublishOutboxRelayPublisher>(
    input: PublishRuntimeMaintainInput<'_, P>,
) -> Result<PublishRuntimeMaintainOutcome, PublishOutboxError> {
    let maintenance_report = run_publish_outbox_maintenance_with_retry_policy(
        input.daemon_dir,
        input.publisher,
        input.now,
        input.retry_policy,
    )?;

    Ok(PublishRuntimeMaintainOutcome { maintenance_report })
}

pub fn enqueue_backend_event_for_publish(
    input: BackendPublishRuntimeInput<'_>,
) -> Result<BackendPublishRuntimeOutcome, PublishOutboxError> {
    let record = accept_backend_signed_publish_event(
        input.daemon_dir,
        BackendPublishOutboxInput {
            request_id: input.request_id.to_string(),
            request_sequence: input.request_sequence,
            request_timestamp: input.request_timestamp,
            correlation_id: input.correlation_id.to_string(),
            project_id: input.project_id.to_string(),
            conversation_id: input.conversation_id.to_string(),
            publisher_pubkey: input.expected_publisher_pubkey.to_string(),
            ral_number: input.ral_number,
            wait_for_relay_ok: input.wait_for_relay_ok,
            timeout_ms: input.timeout_ms,
            event: input.event,
        },
        input.accepted_at,
    )?;

    Ok(BackendPublishRuntimeOutcome { record })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nostr_event::Nip01EventFixture;
    use crate::publish_outbox::{
        PublishRelayError, PublishRelayReport, PublishRelayResult, accept_worker_publish_request,
        drain_pending_publish_outbox, read_pending_publish_outbox_record,
    };
    use serde_json::{Value, json};
    use std::collections::VecDeque;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn inspect_publish_runtime_surfaces_publish_outbox_diagnostics() {
        let daemon_dir = unique_temp_daemon_dir();
        let fixture = signed_event_fixture();
        let message = publish_request_message(&fixture, 41, 1_710_001_000_000);
        accept_worker_publish_request(&daemon_dir, &message, 1_710_001_000_100)
            .expect("pending outbox record must persist");

        let outcome = inspect_publish_runtime(PublishRuntimeInspectInput {
            daemon_dir: &daemon_dir,
            inspected_at: 1_710_001_000_200,
        })
        .expect("runtime inspection must succeed");

        assert_eq!(outcome.diagnostics.inspected_at, 1_710_001_000_200);
        assert_eq!(outcome.diagnostics.pending_count, 1);
        assert_eq!(outcome.diagnostics.failed_count, 0);
        assert_eq!(outcome.diagnostics.published_count, 0);

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn maintain_publish_runtime_requeues_and_drains_due_records_once() {
        let daemon_dir = unique_temp_daemon_dir();
        let fixture = signed_event_fixture();
        let message = publish_request_message(&fixture, 41, 1_710_001_000_000);

        accept_worker_publish_request(&daemon_dir, &message, 1_710_001_000_100)
            .expect("pending outbox record must persist");

        let mut failing_publisher = MockRelayPublisher::new(vec![Err(PublishRelayError {
            message: "relay timeout".to_string(),
            retryable: true,
        })]);
        drain_pending_publish_outbox(&daemon_dir, &mut failing_publisher, 1_710_001_000_200)
            .expect("pending record must move to failed");
        assert_eq!(failing_publisher.published_events.len(), 1);
        assert!(
            read_pending_publish_outbox_record(&daemon_dir, &fixture.signed.id)
                .expect("pending record read must succeed")
                .is_none()
        );

        let mut succeeding_publisher = MockRelayPublisher::new(vec![Ok(PublishRelayReport {
            relay_results: vec![PublishRelayResult {
                relay_url: "wss://relay.tenex.chat".to_string(),
                accepted: true,
                message: None,
            }],
        })]);

        let outcome = maintain_publish_runtime(PublishRuntimeMaintainInput {
            daemon_dir: &daemon_dir,
            publisher: &mut succeeding_publisher,
            now: 1_710_001_001_200,
            retry_policy: PublishOutboxRetryPolicy::default(),
        })
        .expect("runtime maintenance must succeed");

        assert_eq!(
            outcome.maintenance_report.diagnostics_before.failed_count,
            1
        );
        assert_eq!(outcome.maintenance_report.requeued.len(), 1);
        assert_eq!(outcome.maintenance_report.drained.len(), 1);
        assert_eq!(
            outcome.maintenance_report.drained[0].status,
            crate::publish_outbox::PublishOutboxStatus::Published
        );
        assert_eq!(outcome.maintenance_report.diagnostics_after.failed_count, 0);
        assert_eq!(
            outcome.maintenance_report.diagnostics_after.published_count,
            1
        );
        assert_eq!(
            succeeding_publisher.published_events,
            vec![fixture.signed.clone()]
        );

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn enqueue_backend_event_for_publish_persists_expected_publisher_context() {
        let daemon_dir = unique_temp_daemon_dir();
        let fixture = signed_event_fixture();

        let outcome = enqueue_backend_event_for_publish(BackendPublishRuntimeInput {
            daemon_dir: &daemon_dir,
            event: fixture.signed.clone(),
            accepted_at: 1_710_001_100_100,
            request_id: "backend-status-01",
            request_sequence: 1,
            request_timestamp: 1_710_001_100_000,
            correlation_id: "backend-status-correlation",
            project_id: "project-alpha",
            conversation_id: "conversation-alpha",
            expected_publisher_pubkey: &fixture.pubkey,
            ral_number: 0,
            wait_for_relay_ok: false,
            timeout_ms: 0,
        })
        .expect("backend event must enqueue");

        assert_eq!(outcome.record.event, fixture.signed);
        assert_eq!(outcome.record.request.request_id, "backend-status-01");
        assert_eq!(outcome.record.request.agent_pubkey, fixture.pubkey);
        assert_eq!(outcome.record.request.ral_number, 0);
        assert!(!outcome.record.request.wait_for_relay_ok);
        assert_eq!(outcome.record.request.timeout_ms, 0);

        let persisted = read_pending_publish_outbox_record(&daemon_dir, &outcome.record.event.id)
            .expect("pending record read must succeed")
            .expect("pending backend event must persist");
        assert_eq!(persisted, outcome.record);

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn enqueue_backend_event_for_publish_rejects_unexpected_publisher() {
        let daemon_dir = unique_temp_daemon_dir();
        let fixture = signed_event_fixture();
        let unexpected_pubkey = "a".repeat(64);

        let error = enqueue_backend_event_for_publish(BackendPublishRuntimeInput {
            daemon_dir: &daemon_dir,
            event: fixture.signed.clone(),
            accepted_at: 1_710_001_100_100,
            request_id: "backend-status-01",
            request_sequence: 1,
            request_timestamp: 1_710_001_100_000,
            correlation_id: "backend-status-correlation",
            project_id: "project-alpha",
            conversation_id: "conversation-alpha",
            expected_publisher_pubkey: &unexpected_pubkey,
            ral_number: 0,
            wait_for_relay_ok: false,
            timeout_ms: 0,
        })
        .expect_err("unexpected backend publisher must be rejected");

        assert!(matches!(
            error,
            PublishOutboxError::PublisherPubkeyMismatch { .. }
        ));
        assert!(
            read_pending_publish_outbox_record(&daemon_dir, &fixture.signed.id)
                .expect("pending record read must succeed")
                .is_none()
        );

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn maintain_publish_runtime_drains_enqueued_backend_event_exactly_once() {
        let daemon_dir = unique_temp_daemon_dir();
        let fixture = signed_event_fixture();
        enqueue_backend_event_for_publish(BackendPublishRuntimeInput {
            daemon_dir: &daemon_dir,
            event: fixture.signed.clone(),
            accepted_at: 1_710_001_100_100,
            request_id: "backend-status-01",
            request_sequence: 1,
            request_timestamp: 1_710_001_100_000,
            correlation_id: "backend-status-correlation",
            project_id: "project-alpha",
            conversation_id: "conversation-alpha",
            expected_publisher_pubkey: &fixture.pubkey,
            ral_number: 0,
            wait_for_relay_ok: false,
            timeout_ms: 0,
        })
        .expect("backend event must enqueue");

        let mut publisher = MockRelayPublisher::new(vec![Ok(PublishRelayReport {
            relay_results: vec![PublishRelayResult {
                relay_url: "wss://relay.tenex.chat".to_string(),
                accepted: true,
                message: None,
            }],
        })]);

        let outcome = maintain_publish_runtime(PublishRuntimeMaintainInput {
            daemon_dir: &daemon_dir,
            publisher: &mut publisher,
            now: 1_710_001_100_200,
            retry_policy: PublishOutboxRetryPolicy::default(),
        })
        .expect("runtime maintenance must publish backend event");

        assert_eq!(outcome.maintenance_report.drained.len(), 1);
        assert_eq!(
            outcome.maintenance_report.drained[0].status,
            crate::publish_outbox::PublishOutboxStatus::Published
        );
        assert_eq!(publisher.published_events, vec![fixture.signed]);

        cleanup_temp_dir(daemon_dir);
    }

    #[derive(Debug)]
    struct MockRelayPublisher {
        outcomes: VecDeque<Result<PublishRelayReport, PublishRelayError>>,
        published_events: Vec<crate::nostr_event::SignedNostrEvent>,
    }

    impl MockRelayPublisher {
        fn new(outcomes: Vec<Result<PublishRelayReport, PublishRelayError>>) -> Self {
            Self {
                outcomes: outcomes.into(),
                published_events: Vec::new(),
            }
        }
    }

    impl PublishOutboxRelayPublisher for MockRelayPublisher {
        fn publish_signed_event(
            &mut self,
            event: &crate::nostr_event::SignedNostrEvent,
        ) -> Result<PublishRelayReport, PublishRelayError> {
            self.published_events.push(event.clone());
            self.outcomes
                .pop_front()
                .expect("mock publisher outcome must exist")
        }
    }

    fn publish_request_message(
        fixture: &Nip01EventFixture,
        sequence: u64,
        timestamp: u64,
    ) -> Value {
        json!({
            "version": crate::worker_protocol::AGENT_WORKER_PROTOCOL_VERSION,
            "type": "publish_request",
            "correlationId": "rust_publish_runtime",
            "sequence": sequence,
            "timestamp": timestamp,
            "projectId": "project-alpha",
            "agentPubkey": fixture.pubkey.clone(),
            "conversationId": "conversation-alpha",
            "ralNumber": 7,
            "requestId": "publish-fixture-01",
            "waitForRelayOk": true,
            "timeoutMs": 30_000,
            "runtimeEventClass": "complete",
            "event": fixture.signed.clone(),
        })
    }

    fn signed_event_fixture() -> Nip01EventFixture {
        serde_json::from_str(include_str!(
            "../../../src/test-utils/fixtures/nostr/stream-text-delta.compat.json"
        ))
        .expect("fixture must parse")
    }

    fn unique_temp_daemon_dir() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be after UNIX_EPOCH")
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let daemon_dir = std::env::temp_dir().join(format!(
            "tenex-publish-runtime-{}-{counter}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&daemon_dir).expect("temp daemon dir must be created");
        daemon_dir
    }

    fn cleanup_temp_dir(path: PathBuf) {
        if path.exists() {
            fs::remove_dir_all(path).expect("temp daemon dir cleanup must succeed");
        }
    }
}
