use std::path::Path;

use crate::publish_outbox::{
    PublishOutboxDiagnostics, PublishOutboxError, PublishOutboxMaintenanceReport,
    PublishOutboxRelayPublisher, PublishOutboxRetryPolicy, inspect_publish_outbox,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nostr_event::CompatibilityEventFixture;
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
        fixture: &CompatibilityEventFixture,
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
            "requiresEventId": true,
            "timeoutMs": 30_000,
            "event": fixture.signed.clone(),
        })
    }

    fn signed_event_fixture() -> CompatibilityEventFixture {
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
