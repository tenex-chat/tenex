use serde_json::{Value, json};
use thiserror::Error;

use crate::ral_journal::RalJournalIdentity;
use crate::worker_heartbeat::{
    WorkerHeartbeatFreshness, WorkerHeartbeatFreshnessConfig, WorkerHeartbeatSnapshot,
    classify_worker_heartbeat_freshness,
};
use crate::worker_protocol::{
    AGENT_WORKER_PROTOCOL_VERSION, AgentWorkerShutdownMessageInput, WorkerProtocolError,
    build_agent_worker_shutdown_message, validate_agent_worker_protocol_message,
};

pub const DEFAULT_WORKER_GRACEFUL_ABORT_TIMEOUT_MS: u64 = 10_000;
pub const DEFAULT_WORKER_FORCE_KILL_TIMEOUT_MS: u64 = 5_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkerAbortConfig {
    pub heartbeat: WorkerHeartbeatFreshnessConfig,
    pub graceful_timeout_ms: u64,
    pub force_kill_timeout_ms: u64,
}

impl Default for WorkerAbortConfig {
    fn default() -> Self {
        Self {
            heartbeat: WorkerHeartbeatFreshnessConfig::default(),
            graceful_timeout_ms: DEFAULT_WORKER_GRACEFUL_ABORT_TIMEOUT_MS,
            force_kill_timeout_ms: DEFAULT_WORKER_FORCE_KILL_TIMEOUT_MS,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerAbortSignal {
    Abort,
    Shutdown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerAbortProcessStatus {
    Running,
    Missing,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerAbortDecisionInput<'a> {
    pub worker_id: String,
    pub identity: RalJournalIdentity,
    pub heartbeat: &'a WorkerHeartbeatSnapshot,
    pub process_status: WorkerAbortProcessStatus,
    pub signal: WorkerAbortSignal,
    pub graceful_signal_sent_at: Option<u64>,
    pub reason: String,
    pub now: u64,
    pub sequence: u64,
    pub timestamp: u64,
    pub correlation_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerAbortPlan {
    pub worker_id: String,
    pub identity: RalJournalIdentity,
    pub sequence: u64,
    pub timestamp: u64,
    pub correlation_id: String,
    pub action: WorkerAbortAction,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkerAbortAction {
    NoAction {
        freshness: WorkerHeartbeatFreshness,
    },
    SendGracefulSignal {
        signal: WorkerAbortSignal,
        message: Value,
        heartbeat_deadline_at: u64,
        missed_by_ms: u64,
        graceful_deadline_at: u64,
    },
    WaitForGracefulExit {
        signal: WorkerAbortSignal,
        graceful_started_at: u64,
        graceful_deadline_at: u64,
        elapsed_ms: u64,
        remaining_ms: u64,
    },
    ForceKill {
        signal: WorkerAbortSignal,
        graceful_started_at: u64,
        graceful_deadline_at: u64,
        exceeded_by_ms: u64,
        force_kill_timeout_ms: u64,
        reason: String,
    },
    MarkCrashedForReconciliation {
        reason: String,
        last_heartbeat_at: Option<u64>,
    },
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum WorkerAbortError {
    #[error("worker abort config field is invalid: {0}")]
    InvalidConfig(&'static str),
    #[error("heartbeat worker {actual} does not match expected worker {expected}")]
    WorkerMismatch { expected: String, actual: String },
    #[error("heartbeat RAL identity does not match abort identity")]
    IdentityMismatch {
        expected: Box<RalJournalIdentity>,
        actual: Box<RalJournalIdentity>,
    },
    #[error("worker protocol error: {0}")]
    Protocol(#[from] WorkerProtocolError),
}

pub type WorkerAbortResult<T> = Result<T, WorkerAbortError>;

pub fn plan_worker_abort_decision(
    input: WorkerAbortDecisionInput<'_>,
    config: WorkerAbortConfig,
) -> WorkerAbortResult<WorkerAbortPlan> {
    validate_worker_abort_config(config)?;
    validate_heartbeat_target(&input)?;

    let action = match input.process_status {
        WorkerAbortProcessStatus::Missing => WorkerAbortAction::MarkCrashedForReconciliation {
            reason: format!(
                "worker {} process was missing during abort planning",
                input.worker_id
            ),
            last_heartbeat_at: Some(input.heartbeat.observed_at),
        },
        WorkerAbortProcessStatus::Running | WorkerAbortProcessStatus::Unknown => {
            if let Some(graceful_started_at) = input.graceful_signal_sent_at {
                plan_graceful_signal_followup(&input, config, graceful_started_at)
            } else {
                plan_heartbeat_driven_signal(&input, config)?
            }
        }
    };

    Ok(WorkerAbortPlan {
        worker_id: input.worker_id,
        identity: input.identity,
        sequence: input.sequence,
        timestamp: input.timestamp,
        correlation_id: input.correlation_id,
        action,
    })
}

fn plan_heartbeat_driven_signal(
    input: &WorkerAbortDecisionInput<'_>,
    config: WorkerAbortConfig,
) -> WorkerAbortResult<WorkerAbortAction> {
    match classify_worker_heartbeat_freshness(input.heartbeat, input.now, config.heartbeat) {
        WorkerHeartbeatFreshness::Fresh {
            deadline_at,
            remaining_ms,
        } => Ok(WorkerAbortAction::NoAction {
            freshness: WorkerHeartbeatFreshness::Fresh {
                deadline_at,
                remaining_ms,
            },
        }),
        WorkerHeartbeatFreshness::Missed {
            deadline_at,
            missed_by_ms,
        } => Ok(WorkerAbortAction::SendGracefulSignal {
            signal: input.signal,
            message: build_graceful_signal_message(input, config)?,
            heartbeat_deadline_at: deadline_at,
            missed_by_ms,
            graceful_deadline_at: input.now.saturating_add(config.graceful_timeout_ms),
        }),
    }
}

fn plan_graceful_signal_followup(
    input: &WorkerAbortDecisionInput<'_>,
    config: WorkerAbortConfig,
    graceful_started_at: u64,
) -> WorkerAbortAction {
    let graceful_deadline_at = graceful_started_at.saturating_add(config.graceful_timeout_ms);
    if input.now <= graceful_deadline_at {
        return WorkerAbortAction::WaitForGracefulExit {
            signal: input.signal,
            graceful_started_at,
            graceful_deadline_at,
            elapsed_ms: input.now.saturating_sub(graceful_started_at),
            remaining_ms: graceful_deadline_at.saturating_sub(input.now),
        };
    }

    WorkerAbortAction::ForceKill {
        signal: input.signal,
        graceful_started_at,
        graceful_deadline_at,
        exceeded_by_ms: input.now.saturating_sub(graceful_deadline_at),
        force_kill_timeout_ms: config.force_kill_timeout_ms,
        reason: input.reason.clone(),
    }
}

fn build_graceful_signal_message(
    input: &WorkerAbortDecisionInput<'_>,
    config: WorkerAbortConfig,
) -> Result<Value, WorkerProtocolError> {
    match input.signal {
        WorkerAbortSignal::Shutdown => {
            build_agent_worker_shutdown_message(AgentWorkerShutdownMessageInput {
                correlation_id: input.correlation_id.clone(),
                sequence: input.sequence,
                timestamp: input.timestamp,
                reason: input.reason.clone(),
                force_kill_timeout_ms: config.force_kill_timeout_ms,
            })
        }
        WorkerAbortSignal::Abort => build_agent_worker_abort_message(input, config),
    }
}

fn build_agent_worker_abort_message(
    input: &WorkerAbortDecisionInput<'_>,
    config: WorkerAbortConfig,
) -> Result<Value, WorkerProtocolError> {
    let message = json!({
        "version": AGENT_WORKER_PROTOCOL_VERSION,
        "type": "abort",
        "correlationId": input.correlation_id,
        "sequence": input.sequence,
        "timestamp": input.timestamp,
        "projectId": input.identity.project_id,
        "agentPubkey": input.identity.agent_pubkey,
        "conversationId": input.identity.conversation_id,
        "ralNumber": input.identity.ral_number,
        "reason": input.reason,
        "gracefulTimeoutMs": config.graceful_timeout_ms,
    });

    validate_agent_worker_protocol_message(&message)?;
    Ok(message)
}

fn validate_worker_abort_config(config: WorkerAbortConfig) -> WorkerAbortResult<()> {
    if config.graceful_timeout_ms == 0 {
        return Err(WorkerAbortError::InvalidConfig("gracefulTimeoutMs"));
    }
    if config.force_kill_timeout_ms == 0 {
        return Err(WorkerAbortError::InvalidConfig("forceKillTimeoutMs"));
    }
    Ok(())
}

fn validate_heartbeat_target(input: &WorkerAbortDecisionInput<'_>) -> WorkerAbortResult<()> {
    if input.heartbeat.worker_id != input.worker_id {
        return Err(WorkerAbortError::WorkerMismatch {
            expected: input.worker_id.clone(),
            actual: input.heartbeat.worker_id.clone(),
        });
    }

    if input.heartbeat.identity != input.identity {
        return Err(WorkerAbortError::IdentityMismatch {
            expected: Box::new(input.identity.clone()),
            actual: Box::new(input.heartbeat.identity.clone()),
        });
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worker_heartbeat::WorkerHeartbeatState;

    #[test]
    fn fresh_heartbeat_plans_no_action() {
        let plan = plan_worker_abort_decision(
            input(
                WorkerAbortSignal::Shutdown,
                1_000,
                None,
                WorkerAbortProcessStatus::Running,
            ),
            config(),
        )
        .expect("fresh heartbeat should plan");

        assert_eq!(
            plan.action,
            WorkerAbortAction::NoAction {
                freshness: WorkerHeartbeatFreshness::Fresh {
                    deadline_at: 16_000,
                    remaining_ms: 15_000,
                },
            }
        );
    }

    #[test]
    fn missed_heartbeat_plans_graceful_shutdown_frame() {
        let plan = plan_worker_abort_decision(
            input(
                WorkerAbortSignal::Shutdown,
                16_001,
                None,
                WorkerAbortProcessStatus::Running,
            ),
            config(),
        )
        .expect("missed heartbeat should plan shutdown");

        match plan.action {
            WorkerAbortAction::SendGracefulSignal {
                signal,
                message,
                heartbeat_deadline_at,
                missed_by_ms,
                graceful_deadline_at,
            } => {
                assert_eq!(signal, WorkerAbortSignal::Shutdown);
                assert_eq!(heartbeat_deadline_at, 16_000);
                assert_eq!(missed_by_ms, 1);
                assert_eq!(graceful_deadline_at, 26_001);
                assert_eq!(message["type"], "shutdown");
                assert_eq!(message["correlationId"], "correlation-abort");
                assert_eq!(message["sequence"], 41);
                assert_eq!(message["timestamp"], 1_710_000_401_041_u64);
                assert_eq!(message["reason"], "missed_heartbeat");
                assert_eq!(message["forceKillTimeoutMs"], 5_000);
            }
            other => panic!("expected graceful shutdown signal, got {other:?}"),
        }
    }

    #[test]
    fn grace_exceeded_plans_force_kill_without_touching_processes() {
        let plan = plan_worker_abort_decision(
            input(
                WorkerAbortSignal::Shutdown,
                25_001,
                Some(10_000),
                WorkerAbortProcessStatus::Running,
            ),
            config(),
        )
        .expect("expired grace should plan force kill");

        assert_eq!(
            plan.action,
            WorkerAbortAction::ForceKill {
                signal: WorkerAbortSignal::Shutdown,
                graceful_started_at: 10_000,
                graceful_deadline_at: 20_000,
                exceeded_by_ms: 5_001,
                force_kill_timeout_ms: 5_000,
                reason: "missed_heartbeat".to_string(),
            }
        );
    }

    #[test]
    fn abort_frame_preserves_correlation_sequence_timestamp_and_identity() {
        let plan = plan_worker_abort_decision(
            input(
                WorkerAbortSignal::Abort,
                16_001,
                None,
                WorkerAbortProcessStatus::Unknown,
            ),
            config(),
        )
        .expect("missed heartbeat should plan abort frame");

        assert_eq!(plan.sequence, 41);
        assert_eq!(plan.timestamp, 1_710_000_401_041);
        assert_eq!(plan.correlation_id, "correlation-abort");

        match plan.action {
            WorkerAbortAction::SendGracefulSignal {
                signal, message, ..
            } => {
                assert_eq!(signal, WorkerAbortSignal::Abort);
                assert_eq!(message["type"], "abort");
                assert_eq!(message["correlationId"], "correlation-abort");
                assert_eq!(message["sequence"], 41);
                assert_eq!(message["timestamp"], 1_710_000_401_041_u64);
                assert_eq!(message["projectId"], "project-alpha");
                assert_eq!(
                    message["agentPubkey"],
                    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                );
                assert_eq!(message["conversationId"], "conversation-alpha");
                assert_eq!(message["ralNumber"], 3);
                assert_eq!(message["gracefulTimeoutMs"], 10_000);
            }
            other => panic!("expected graceful abort signal, got {other:?}"),
        }
    }

    #[test]
    fn missing_process_marks_crashed_for_reconciliation() {
        let plan = plan_worker_abort_decision(
            input(
                WorkerAbortSignal::Shutdown,
                1_000,
                None,
                WorkerAbortProcessStatus::Missing,
            ),
            config(),
        )
        .expect("missing process should plan reconciliation");

        assert_eq!(
            plan.action,
            WorkerAbortAction::MarkCrashedForReconciliation {
                reason: "worker worker-alpha process was missing during abort planning".to_string(),
                last_heartbeat_at: Some(1_000),
            }
        );
    }

    #[test]
    fn validates_heartbeat_worker_and_identity() {
        let mut mismatched_worker = input(
            WorkerAbortSignal::Shutdown,
            1_000,
            None,
            WorkerAbortProcessStatus::Running,
        );
        mismatched_worker.worker_id = "worker-beta".to_string();

        assert_eq!(
            plan_worker_abort_decision(mismatched_worker, config()),
            Err(WorkerAbortError::WorkerMismatch {
                expected: "worker-beta".to_string(),
                actual: "worker-alpha".to_string(),
            })
        );

        let mut mismatched_identity = input(
            WorkerAbortSignal::Shutdown,
            1_000,
            None,
            WorkerAbortProcessStatus::Running,
        );
        mismatched_identity.identity.ral_number = 4;

        assert!(matches!(
            plan_worker_abort_decision(mismatched_identity, config()),
            Err(WorkerAbortError::IdentityMismatch { .. })
        ));
    }

    fn config() -> WorkerAbortConfig {
        WorkerAbortConfig {
            heartbeat: WorkerHeartbeatFreshnessConfig {
                interval_ms: 5_000,
                missed_threshold: 3,
            },
            graceful_timeout_ms: 10_000,
            force_kill_timeout_ms: 5_000,
        }
    }

    fn input(
        signal: WorkerAbortSignal,
        now: u64,
        graceful_signal_sent_at: Option<u64>,
        process_status: WorkerAbortProcessStatus,
    ) -> WorkerAbortDecisionInput<'static> {
        WorkerAbortDecisionInput {
            worker_id: "worker-alpha".to_string(),
            identity: identity(),
            heartbeat: Box::leak(Box::new(heartbeat())),
            process_status,
            signal,
            graceful_signal_sent_at,
            reason: "missed_heartbeat".to_string(),
            now,
            sequence: 41,
            timestamp: 1_710_000_401_041,
            correlation_id: "correlation-abort".to_string(),
        }
    }

    fn heartbeat() -> WorkerHeartbeatSnapshot {
        WorkerHeartbeatSnapshot {
            worker_id: "worker-alpha".to_string(),
            correlation_id: "heartbeat-correlation".to_string(),
            sequence: 40,
            worker_timestamp: 990,
            observed_at: 1_000,
            identity: identity(),
            state: WorkerHeartbeatState::Streaming,
            active_tool_count: 0,
            accumulated_runtime_ms: 700,
        }
    }

    fn identity() -> RalJournalIdentity {
        RalJournalIdentity {
            project_id: "project-alpha".to_string(),
            agent_pubkey: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                .to_string(),
            conversation_id: "conversation-alpha".to_string(),
            ral_number: 3,
        }
    }
}
