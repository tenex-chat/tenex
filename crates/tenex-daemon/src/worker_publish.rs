use std::path::Path;

use serde_json::Value;
use thiserror::Error;

use crate::publish_outbox::{
    PublishOutboxError, PublishOutboxRecord, accept_worker_publish_request,
    build_accepted_publish_result,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerPublishAcceptanceInput<'a> {
    pub daemon_dir: &'a Path,
    pub message: &'a Value,
    pub accepted_at: u64,
    pub result_sequence: u64,
    pub result_timestamp: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerPublishAcceptance {
    pub record: PublishOutboxRecord,
    pub publish_result: Value,
}

#[derive(Debug, Error)]
pub enum WorkerPublishError {
    #[error("worker publish field is missing or invalid: {0}")]
    InvalidField(&'static str),
    #[error(
        "publish_result sequence {result_sequence} must be greater than publish_request sequence {request_sequence}"
    )]
    PublishResultSequenceNotAfterRequest {
        request_sequence: u64,
        result_sequence: u64,
    },
    #[error("publish outbox acceptance failed: {0}")]
    Outbox(#[from] PublishOutboxError),
}

pub fn accept_worker_publish_and_build_result(
    input: WorkerPublishAcceptanceInput<'_>,
) -> Result<WorkerPublishAcceptance, WorkerPublishError> {
    let request_sequence = input
        .message
        .get("sequence")
        .and_then(Value::as_u64)
        .ok_or(WorkerPublishError::InvalidField("sequence"))?;

    if input.result_sequence <= request_sequence {
        return Err(WorkerPublishError::PublishResultSequenceNotAfterRequest {
            request_sequence,
            result_sequence: input.result_sequence,
        });
    }

    let record = accept_worker_publish_request(input.daemon_dir, input.message, input.accepted_at)?;
    let publish_result =
        build_accepted_publish_result(&record, input.result_sequence, input.result_timestamp);

    Ok(WorkerPublishAcceptance {
        record,
        publish_result,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nostr_event::Nip01EventFixture;
    use crate::publish_outbox::{
        read_pending_publish_outbox_record, read_published_publish_outbox_record,
    };
    use crate::worker_protocol::{
        AGENT_WORKER_PROTOCOL_VERSION, WorkerProtocolDirection,
        validate_agent_worker_protocol_message,
    };
    use serde_json::json;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    const STREAM_TEXT_DELTA_FIXTURE: &str =
        include_str!("../../../src/test-utils/fixtures/nostr/stream-text-delta.compat.json");
    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn accepts_worker_publish_request_and_builds_correlated_result() {
        let daemon_dir = unique_temp_daemon_dir();
        let fixture = signed_event_fixture();
        let message = publish_request_message(&fixture, 41, 1710001000000);

        let accepted = accept_worker_publish_and_build_result(WorkerPublishAcceptanceInput {
            daemon_dir: &daemon_dir,
            message: &message,
            accepted_at: 1710001000100,
            result_sequence: 900,
            result_timestamp: 1710001000200,
        })
        .expect("publish request must accept");

        assert_eq!(accepted.record.request.request_sequence, 41);
        assert_eq!(
            accepted.record.request.correlation_id,
            "rust_worker_publish"
        );
        assert_eq!(accepted.record.event.id, fixture.signed.id);
        assert_eq!(accepted.publish_result["type"], "publish_result");
        assert_eq!(
            accepted.publish_result["correlationId"],
            "rust_worker_publish"
        );
        assert_eq!(accepted.publish_result["sequence"], 900);
        assert_eq!(accepted.publish_result["timestamp"], 1710001000200_u64);
        assert_eq!(accepted.publish_result["requestId"], "publish-fixture-01");
        assert_eq!(accepted.publish_result["requestSequence"], 41);
        assert_eq!(accepted.publish_result["status"], "accepted");
        assert_eq!(
            accepted.publish_result["eventIds"],
            json!([fixture.signed.id])
        );
        assert_eq!(
            validate_agent_worker_protocol_message(&accepted.publish_result)
                .expect("publish_result must validate"),
            WorkerProtocolDirection::DaemonToWorker
        );

        assert!(
            read_pending_publish_outbox_record(&daemon_dir, &accepted.record.event.id)
                .expect("pending record read must succeed")
                .is_some()
        );
        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn duplicate_publish_request_returns_existing_pending_record_and_result() {
        let daemon_dir = unique_temp_daemon_dir();
        let fixture = signed_event_fixture();
        let message = publish_request_message(&fixture, 41, 1710001000000);

        let first = accept_worker_publish_and_build_result(WorkerPublishAcceptanceInput {
            daemon_dir: &daemon_dir,
            message: &message,
            accepted_at: 1710001000100,
            result_sequence: 900,
            result_timestamp: 1710001000200,
        })
        .expect("first publish request must accept");
        let duplicate = accept_worker_publish_and_build_result(WorkerPublishAcceptanceInput {
            daemon_dir: &daemon_dir,
            message: &message,
            accepted_at: 1710001000300,
            result_sequence: 901,
            result_timestamp: 1710001000400,
        })
        .expect("duplicate publish request must accept idempotently");

        assert_eq!(duplicate.record, first.record);
        assert_eq!(duplicate.publish_result["sequence"], 901);
        assert_eq!(
            duplicate.publish_result["eventIds"],
            first.publish_result["eventIds"]
        );

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn rejects_non_advancing_publish_result_sequence_before_persisting() {
        let daemon_dir = unique_temp_daemon_dir();
        let fixture = signed_event_fixture();
        let message = publish_request_message(&fixture, 41, 1710001000000);

        let error = accept_worker_publish_and_build_result(WorkerPublishAcceptanceInput {
            daemon_dir: &daemon_dir,
            message: &message,
            accepted_at: 1710001000100,
            result_sequence: 41,
            result_timestamp: 1710001000200,
        })
        .expect_err("non-advancing result sequence must fail");

        match error {
            WorkerPublishError::PublishResultSequenceNotAfterRequest {
                request_sequence,
                result_sequence,
            } => {
                assert_eq!(request_sequence, 41);
                assert_eq!(result_sequence, 41);
            }
            other => panic!("expected sequence error, got {other:?}"),
        }
        assert!(
            read_published_publish_outbox_record(&daemon_dir, &fixture.signed.id)
                .expect("published record read must succeed")
                .is_none()
        );
        assert!(
            read_pending_publish_outbox_record(&daemon_dir, &fixture.signed.id)
                .expect("pending record read must succeed")
                .is_none()
        );

        if daemon_dir.exists() {
            fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
        }
    }

    fn publish_request_message(
        fixture: &Nip01EventFixture,
        sequence: u64,
        timestamp: u64,
    ) -> Value {
        json!({
            "version": AGENT_WORKER_PROTOCOL_VERSION,
            "type": "publish_request",
            "correlationId": "rust_worker_publish",
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

    fn unique_temp_daemon_dir() -> PathBuf {
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("tenex-worker-publish-test-{nanos}-{counter}"))
    }
}
