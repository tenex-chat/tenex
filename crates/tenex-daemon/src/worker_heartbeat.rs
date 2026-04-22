use serde_json::Value;
use thiserror::Error;

use crate::ral_journal::RalJournalIdentity;
use crate::worker_protocol::{
    WorkerProtocolDirection, WorkerProtocolError, validate_agent_worker_protocol_message,
};

pub const DEFAULT_WORKER_HEARTBEAT_INTERVAL_MS: u64 = 5_000;
pub const DEFAULT_MISSED_WORKER_HEARTBEAT_THRESHOLD: u64 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerHeartbeatState {
    Starting,
    Streaming,
    Acting,
    Waiting,
    Idle,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerHeartbeatContext {
    pub worker_id: String,
    pub observed_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerHeartbeatSnapshot {
    pub worker_id: String,
    pub correlation_id: String,
    pub sequence: u64,
    pub worker_timestamp: u64,
    pub observed_at: u64,
    pub identity: RalJournalIdentity,
    pub state: WorkerHeartbeatState,
    pub active_tool_count: u64,
    pub accumulated_runtime_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkerHeartbeatFreshnessConfig {
    pub interval_ms: u64,
    pub missed_threshold: u64,
}

impl Default for WorkerHeartbeatFreshnessConfig {
    fn default() -> Self {
        Self {
            interval_ms: DEFAULT_WORKER_HEARTBEAT_INTERVAL_MS,
            missed_threshold: DEFAULT_MISSED_WORKER_HEARTBEAT_THRESHOLD,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerHeartbeatFreshness {
    Fresh { deadline_at: u64, remaining_ms: u64 },
    Missed { deadline_at: u64, missed_by_ms: u64 },
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum WorkerHeartbeatError {
    #[error("worker protocol error: {0}")]
    Protocol(#[from] WorkerProtocolError),
    #[error("worker heartbeat had invalid direction {0:?}")]
    InvalidDirection(WorkerProtocolDirection),
    #[error("worker message type {message_type} is not heartbeat")]
    NonHeartbeatMessage { message_type: String },
    #[error("worker heartbeat field is missing or invalid: {0}")]
    InvalidField(&'static str),
}

pub fn plan_worker_heartbeat_snapshot(
    message: &Value,
    context: WorkerHeartbeatContext,
) -> Result<WorkerHeartbeatSnapshot, WorkerHeartbeatError> {
    let direction = validate_agent_worker_protocol_message(message)?;
    if direction != WorkerProtocolDirection::WorkerToDaemon {
        return Err(WorkerHeartbeatError::InvalidDirection(direction));
    }

    let message_type = required_string(message, "type")?;
    if message_type != "heartbeat" {
        return Err(WorkerHeartbeatError::NonHeartbeatMessage {
            message_type: message_type.to_string(),
        });
    }

    Ok(WorkerHeartbeatSnapshot {
        worker_id: context.worker_id,
        correlation_id: required_string(message, "correlationId")?.to_string(),
        sequence: required_u64(message, "sequence")?,
        worker_timestamp: required_u64(message, "timestamp")?,
        observed_at: context.observed_at,
        identity: RalJournalIdentity {
            project_id: required_string(message, "projectId")?.to_string(),
            agent_pubkey: required_string(message, "agentPubkey")?.to_string(),
            conversation_id: required_string(message, "conversationId")?.to_string(),
            ral_number: required_u64(message, "ralNumber")?,
        },
        state: parse_heartbeat_state(required_string(message, "state")?)?,
        active_tool_count: required_u64(message, "activeToolCount")?,
        accumulated_runtime_ms: required_u64(message, "accumulatedRuntimeMs")?,
    })
}

pub fn classify_worker_heartbeat_freshness(
    snapshot: &WorkerHeartbeatSnapshot,
    now: u64,
    config: WorkerHeartbeatFreshnessConfig,
) -> WorkerHeartbeatFreshness {
    let allowed_gap = config.interval_ms.saturating_mul(config.missed_threshold);
    let deadline_at = snapshot.observed_at.saturating_add(allowed_gap);

    if now <= deadline_at {
        WorkerHeartbeatFreshness::Fresh {
            deadline_at,
            remaining_ms: deadline_at.saturating_sub(now),
        }
    } else {
        WorkerHeartbeatFreshness::Missed {
            deadline_at,
            missed_by_ms: now.saturating_sub(deadline_at),
        }
    }
}

fn parse_heartbeat_state(state: &str) -> Result<WorkerHeartbeatState, WorkerHeartbeatError> {
    match state {
        "starting" => Ok(WorkerHeartbeatState::Starting),
        "streaming" => Ok(WorkerHeartbeatState::Streaming),
        "acting" => Ok(WorkerHeartbeatState::Acting),
        "waiting" => Ok(WorkerHeartbeatState::Waiting),
        "idle" => Ok(WorkerHeartbeatState::Idle),
        _ => Err(WorkerHeartbeatError::InvalidField("state")),
    }
}

fn required_string<'a>(
    message: &'a Value,
    field: &'static str,
) -> Result<&'a str, WorkerHeartbeatError> {
    message
        .get(field)
        .and_then(Value::as_str)
        .ok_or(WorkerHeartbeatError::InvalidField(field))
}

fn required_u64(message: &Value, field: &'static str) -> Result<u64, WorkerHeartbeatError> {
    message
        .get(field)
        .and_then(Value::as_u64)
        .ok_or(WorkerHeartbeatError::InvalidField(field))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const WORKER_PROTOCOL_FIXTURE: &str = include_str!(
        "../../../src/test-utils/fixtures/worker-protocol/agent-execution.compat.json"
    );

    #[test]
    fn plans_heartbeat_snapshot_from_shared_fixture() {
        let snapshot = plan_worker_heartbeat_snapshot(
            &fixture_valid_message("heartbeat"),
            WorkerHeartbeatContext {
                worker_id: "worker-alpha".to_string(),
                observed_at: 1_710_000_403_000,
            },
        )
        .expect("heartbeat snapshot must plan");

        assert_eq!(snapshot.worker_id, "worker-alpha");
        assert_eq!(snapshot.correlation_id, "exec_01hzzzzzzzzzzzzzzzzzzzzzzz");
        assert_eq!(snapshot.sequence, 20);
        assert_eq!(snapshot.worker_timestamp, 1_710_000_402_900);
        assert_eq!(snapshot.observed_at, 1_710_000_403_000);
        assert_eq!(snapshot.state, WorkerHeartbeatState::Streaming);
        assert_eq!(snapshot.active_tool_count, 0);
        assert_eq!(snapshot.accumulated_runtime_ms, 700);
        assert_eq!(
            snapshot.identity,
            RalJournalIdentity {
                project_id: "project-alpha".to_string(),
                agent_pubkey: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                    .to_string(),
                conversation_id: "conversation-alpha".to_string(),
                ral_number: 3,
            }
        );
    }

    #[test]
    fn rejects_non_heartbeat_and_wrong_direction_messages() {
        assert_eq!(
            plan_worker_heartbeat_snapshot(
                &fixture_valid_message("complete"),
                context(1_710_000_403_000)
            ),
            Err(WorkerHeartbeatError::NonHeartbeatMessage {
                message_type: "complete".to_string()
            })
        );

        assert_eq!(
            plan_worker_heartbeat_snapshot(
                &fixture_valid_message("publish-result"),
                context(1_710_000_403_000)
            ),
            Err(WorkerHeartbeatError::InvalidDirection(
                WorkerProtocolDirection::DaemonToWorker
            ))
        );
    }

    #[test]
    fn classifies_heartbeat_freshness_from_daemon_observed_time() {
        let snapshot = plan_worker_heartbeat_snapshot(
            &fixture_valid_message("heartbeat"),
            context(1_710_000_403_000),
        )
        .expect("heartbeat snapshot must plan");

        assert_eq!(
            classify_worker_heartbeat_freshness(
                &snapshot,
                1_710_000_417_999,
                WorkerHeartbeatFreshnessConfig::default(),
            ),
            WorkerHeartbeatFreshness::Fresh {
                deadline_at: 1_710_000_418_000,
                remaining_ms: 1,
            }
        );
        assert_eq!(
            classify_worker_heartbeat_freshness(
                &snapshot,
                1_710_000_418_001,
                WorkerHeartbeatFreshnessConfig::default(),
            ),
            WorkerHeartbeatFreshness::Missed {
                deadline_at: 1_710_000_418_000,
                missed_by_ms: 1,
            }
        );
    }

    #[test]
    fn custom_freshness_config_controls_missed_deadline() {
        let snapshot = plan_worker_heartbeat_snapshot(
            &fixture_valid_message("heartbeat"),
            context(1_710_000_403_000),
        )
        .expect("heartbeat snapshot must plan");

        assert_eq!(
            classify_worker_heartbeat_freshness(
                &snapshot,
                1_710_000_405_001,
                WorkerHeartbeatFreshnessConfig {
                    interval_ms: 1_000,
                    missed_threshold: 2,
                },
            ),
            WorkerHeartbeatFreshness::Missed {
                deadline_at: 1_710_000_405_000,
                missed_by_ms: 1,
            }
        );
    }

    fn fixture_valid_message(name: &str) -> Value {
        let fixture: Value =
            serde_json::from_str(WORKER_PROTOCOL_FIXTURE).expect("fixture must parse");
        fixture["validMessages"]
            .as_array()
            .expect("validMessages must be an array")
            .iter()
            .find(|message| message["name"] == name)
            .unwrap_or_else(|| panic!("fixture message {name} must exist"))["message"]
            .clone()
    }

    fn context(observed_at: u64) -> WorkerHeartbeatContext {
        WorkerHeartbeatContext {
            worker_id: "worker-alpha".to_string(),
            observed_at,
        }
    }
}
