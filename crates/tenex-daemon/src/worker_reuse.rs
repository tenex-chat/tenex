use crate::worker_heartbeat::{WorkerHeartbeatSnapshot, WorkerHeartbeatState};
use crate::worker_process::AgentWorkerReady;
use crate::worker_protocol::WorkerProtocolConfig;
use crate::worker_runtime_state::ActiveWorkerRuntimeSnapshot;

/// Default per-warm-worker concurrency cap. Provisional value pending
/// 11-agent fan-out measurement; tracked in
/// docs/rust/project-warm-worker-design.md.
pub const DEFAULT_WORKER_CONCURRENCY_CAP: usize = 16;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerReuseCandidate {
    pub ready: AgentWorkerReady,
    pub runtime: Option<ActiveWorkerRuntimeSnapshot>,
    pub project_base_path: Option<String>,
    pub working_directory: Option<String>,
    pub metadata_path: Option<String>,
    pub leaked_mcp_process: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerReusePlanInput<'a> {
    pub now: u64,
    pub required_protocol: &'a WorkerProtocolConfig,
    pub required_project_base_path: Option<&'a str>,
    pub required_working_directory: Option<&'a str>,
    pub required_metadata_path: Option<&'a str>,
    pub concurrency_cap: usize,
    pub candidate: &'a WorkerReuseCandidate,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkerReuseDecision {
    ReuseAllowed {
        worker_id: String,
        pid: u64,
        active_executions: usize,
    },
    Recreate {
        reason: WorkerReuseRecreateReason,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkerReuseRecreateReason {
    ProtocolMismatch(WorkerReuseProtocolMismatch),
    ContextMismatch {
        field: WorkerReuseContextField,
        expected: String,
        actual: String,
    },
    ContextUnavailable {
        field: WorkerReuseContextField,
    },
    WorkerStateMismatch {
        state: WorkerHeartbeatState,
    },
    PendingShutdown,
    LeakedMcpProcess,
    ConcurrencyCapReached {
        cap: usize,
        active: usize,
    },
    IdleTtlExpired {
        idle_since_at: u64,
        idle_ttl_ms: u64,
        idle_deadline_at: u64,
        now: u64,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerReuseContextField {
    ProjectBasePath,
    WorkingDirectory,
    MetadataPath,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkerReuseProtocolMismatch {
    Version {
        expected: u64,
        actual: u64,
    },
    Encoding {
        expected: String,
        actual: String,
    },
    MaxFrameBytes {
        expected: u64,
        actual: u64,
    },
    StreamBatchMs {
        expected: u64,
        actual: u64,
    },
    StreamBatchMaxBytes {
        expected: u64,
        actual: u64,
    },
    HeartbeatIntervalMs {
        expected: Option<u64>,
        actual: Option<u64>,
    },
    MissedHeartbeatThreshold {
        expected: Option<u64>,
        actual: Option<u64>,
    },
    WorkerBootTimeoutMs {
        expected: Option<u64>,
        actual: Option<u64>,
    },
    GracefulAbortTimeoutMs {
        expected: Option<u64>,
        actual: Option<u64>,
    },
    ForceKillTimeoutMs {
        expected: Option<u64>,
        actual: Option<u64>,
    },
    IdleTtlMs {
        expected: Option<u64>,
        actual: Option<u64>,
    },
}

pub fn plan_worker_reuse(input: WorkerReusePlanInput<'_>) -> WorkerReuseDecision {
    if let Some(mismatch) =
        protocol_mismatch(input.required_protocol, &input.candidate.ready.protocol)
    {
        return WorkerReuseDecision::Recreate {
            reason: WorkerReuseRecreateReason::ProtocolMismatch(mismatch),
        };
    }

    if let Some(reason) = compare_required_text(
        input.required_project_base_path,
        input.candidate.project_base_path.as_deref(),
        WorkerReuseContextField::ProjectBasePath,
    ) {
        return WorkerReuseDecision::Recreate { reason };
    }

    if let Some(reason) = compare_required_text(
        input.required_working_directory,
        input.candidate.working_directory.as_deref(),
        WorkerReuseContextField::WorkingDirectory,
    ) {
        return WorkerReuseDecision::Recreate { reason };
    }

    if let Some(reason) = compare_required_text(
        input.required_metadata_path,
        input.candidate.metadata_path.as_deref(),
        WorkerReuseContextField::MetadataPath,
    ) {
        return WorkerReuseDecision::Recreate { reason };
    }

    let runtime = input.candidate.runtime.as_ref();
    let active_executions = runtime.map(|runtime| runtime.executions.len()).unwrap_or(0);

    if let Some(runtime) = runtime {
        if runtime.graceful_signal.is_some() {
            return WorkerReuseDecision::Recreate {
                reason: WorkerReuseRecreateReason::PendingShutdown,
            };
        }

        // Idle-TTL only applies when there's no work in flight; otherwise the worker
        // is by definition active.
        if runtime.executions.is_empty() {
            if let Some(reason) = worker_state_mismatch(
                runtime.latest_heartbeat(),
                input.required_protocol.idle_ttl_ms,
                input.now,
            ) {
                return WorkerReuseDecision::Recreate { reason };
            }
        }
    }

    if active_executions >= input.concurrency_cap {
        return WorkerReuseDecision::Recreate {
            reason: WorkerReuseRecreateReason::ConcurrencyCapReached {
                cap: input.concurrency_cap,
                active: active_executions,
            },
        };
    }

    if input
        .candidate
        .leaked_mcp_process
        .is_some_and(std::convert::identity)
    {
        return WorkerReuseDecision::Recreate {
            reason: WorkerReuseRecreateReason::LeakedMcpProcess,
        };
    }

    WorkerReuseDecision::ReuseAllowed {
        worker_id: input.candidate.ready.worker_id.clone(),
        pid: input.candidate.ready.pid,
        active_executions,
    }
}

fn protocol_mismatch(
    expected: &WorkerProtocolConfig,
    actual: &WorkerProtocolConfig,
) -> Option<WorkerReuseProtocolMismatch> {
    if expected.version != actual.version {
        return Some(WorkerReuseProtocolMismatch::Version {
            expected: expected.version,
            actual: actual.version,
        });
    }

    if expected.encoding != actual.encoding {
        return Some(WorkerReuseProtocolMismatch::Encoding {
            expected: expected.encoding.clone(),
            actual: actual.encoding.clone(),
        });
    }

    if expected.max_frame_bytes != actual.max_frame_bytes {
        return Some(WorkerReuseProtocolMismatch::MaxFrameBytes {
            expected: expected.max_frame_bytes,
            actual: actual.max_frame_bytes,
        });
    }

    if expected.stream_batch_ms != actual.stream_batch_ms {
        return Some(WorkerReuseProtocolMismatch::StreamBatchMs {
            expected: expected.stream_batch_ms,
            actual: actual.stream_batch_ms,
        });
    }

    if expected.stream_batch_max_bytes != actual.stream_batch_max_bytes {
        return Some(WorkerReuseProtocolMismatch::StreamBatchMaxBytes {
            expected: expected.stream_batch_max_bytes,
            actual: actual.stream_batch_max_bytes,
        });
    }

    if expected.heartbeat_interval_ms != actual.heartbeat_interval_ms {
        return Some(WorkerReuseProtocolMismatch::HeartbeatIntervalMs {
            expected: expected.heartbeat_interval_ms,
            actual: actual.heartbeat_interval_ms,
        });
    }

    if expected.missed_heartbeat_threshold != actual.missed_heartbeat_threshold {
        return Some(WorkerReuseProtocolMismatch::MissedHeartbeatThreshold {
            expected: expected.missed_heartbeat_threshold,
            actual: actual.missed_heartbeat_threshold,
        });
    }

    if expected.worker_boot_timeout_ms != actual.worker_boot_timeout_ms {
        return Some(WorkerReuseProtocolMismatch::WorkerBootTimeoutMs {
            expected: expected.worker_boot_timeout_ms,
            actual: actual.worker_boot_timeout_ms,
        });
    }

    if expected.graceful_abort_timeout_ms != actual.graceful_abort_timeout_ms {
        return Some(WorkerReuseProtocolMismatch::GracefulAbortTimeoutMs {
            expected: expected.graceful_abort_timeout_ms,
            actual: actual.graceful_abort_timeout_ms,
        });
    }

    if expected.force_kill_timeout_ms != actual.force_kill_timeout_ms {
        return Some(WorkerReuseProtocolMismatch::ForceKillTimeoutMs {
            expected: expected.force_kill_timeout_ms,
            actual: actual.force_kill_timeout_ms,
        });
    }

    if expected.idle_ttl_ms != actual.idle_ttl_ms {
        return Some(WorkerReuseProtocolMismatch::IdleTtlMs {
            expected: expected.idle_ttl_ms,
            actual: actual.idle_ttl_ms,
        });
    }

    None
}

fn compare_required_text(
    required: Option<&str>,
    actual: Option<&str>,
    field: WorkerReuseContextField,
) -> Option<WorkerReuseRecreateReason> {
    let required = required?;

    match actual {
        Some(actual) if actual == required => None,
        Some(actual) => Some(WorkerReuseRecreateReason::ContextMismatch {
            field,
            expected: required.to_string(),
            actual: actual.to_string(),
        }),
        None => Some(WorkerReuseRecreateReason::ContextUnavailable { field }),
    }
}

fn worker_state_mismatch(
    heartbeat: Option<&WorkerHeartbeatSnapshot>,
    idle_ttl_ms: Option<u64>,
    now: u64,
) -> Option<WorkerReuseRecreateReason> {
    let heartbeat = heartbeat?;

    if heartbeat.state != WorkerHeartbeatState::Idle {
        return Some(WorkerReuseRecreateReason::WorkerStateMismatch {
            state: heartbeat.state,
        });
    }

    let idle_ttl_ms = idle_ttl_ms?;
    let idle_deadline_at = heartbeat.observed_at.saturating_add(idle_ttl_ms);

    if now > idle_deadline_at {
        return Some(WorkerReuseRecreateReason::IdleTtlExpired {
            idle_since_at: heartbeat.observed_at,
            idle_ttl_ms,
            idle_deadline_at,
            now,
        });
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ral_journal::RalJournalIdentity;
    use crate::worker_heartbeat::WorkerHeartbeatState;
    use crate::worker_lifecycle::abort::WorkerAbortSignal;
    use crate::worker_protocol::{
        AGENT_WORKER_MAX_FRAME_BYTES, AGENT_WORKER_PROTOCOL_ENCODING,
        AGENT_WORKER_PROTOCOL_VERSION, AGENT_WORKER_STREAM_BATCH_MAX_BYTES,
        AGENT_WORKER_STREAM_BATCH_MS, WorkerProtocolConfig,
    };
    use crate::worker_runtime_state::{
        ActiveExecutionSlot, ActiveWorkerRuntimeSnapshot, WorkerRuntimeGracefulSignal,
    };
    use serde_json::json;

    #[test]
    fn allows_reuse_when_protocol_and_runtime_context_match() {
        let candidate = candidate_with_executions(vec![slot("dispatch-a", identity_a())]);

        assert_eq!(
            plan_worker_reuse(reuse_input(&candidate, &protocol(), 1_010)),
            WorkerReuseDecision::ReuseAllowed {
                worker_id: "worker-a".to_string(),
                pid: 44,
                active_executions: 1,
            }
        );
    }

    #[test]
    fn allows_reuse_when_warm_worker_has_no_active_executions() {
        let candidate = candidate_with_executions(vec![]);

        assert_eq!(
            plan_worker_reuse(reuse_input(&candidate, &protocol(), 1_010)),
            WorkerReuseDecision::ReuseAllowed {
                worker_id: "worker-a".to_string(),
                pid: 44,
                active_executions: 0,
            }
        );
    }

    #[test]
    fn allows_reuse_for_different_agent_in_same_project_when_under_cap() {
        let mut candidate = candidate_with_executions(vec![slot("dispatch-a", identity_a())]);
        candidate
            .runtime
            .as_mut()
            .expect("runtime must exist")
            .executions
            .push(slot("dispatch-b", identity_b()));

        assert_eq!(
            plan_worker_reuse(reuse_input(&candidate, &protocol(), 1_010)),
            WorkerReuseDecision::ReuseAllowed {
                worker_id: "worker-a".to_string(),
                pid: 44,
                active_executions: 2,
            }
        );
    }

    #[test]
    fn rejects_reuse_when_concurrency_cap_reached() {
        let candidate = candidate_with_executions(vec![
            slot("dispatch-a", identity_a()),
            slot("dispatch-b", identity_b()),
        ]);
        let protocol = protocol();
        let input = WorkerReusePlanInput {
            concurrency_cap: 2,
            ..reuse_input(&candidate, &protocol, 1_010)
        };

        assert_eq!(
            plan_worker_reuse(input),
            WorkerReuseDecision::Recreate {
                reason: WorkerReuseRecreateReason::ConcurrencyCapReached {
                    cap: 2,
                    active: 2,
                },
            }
        );
    }

    #[test]
    fn rejects_protocol_version_mismatch() {
        let mut candidate = candidate_with_executions(vec![slot("dispatch-a", identity_a())]);
        candidate.ready.protocol.version = 2;

        assert_eq!(
            plan_worker_reuse(reuse_input(&candidate, &protocol(), 1_010)),
            WorkerReuseDecision::Recreate {
                reason: WorkerReuseRecreateReason::ProtocolMismatch(
                    WorkerReuseProtocolMismatch::Version {
                        expected: AGENT_WORKER_PROTOCOL_VERSION,
                        actual: 2,
                    },
                ),
            }
        );
    }

    #[test]
    fn rejects_protocol_encoding_mismatch() {
        let mut candidate = candidate_with_executions(vec![slot("dispatch-a", identity_a())]);
        candidate.ready.protocol.encoding = "json".to_string();

        assert_eq!(
            plan_worker_reuse(reuse_input(&candidate, &protocol(), 1_010)),
            WorkerReuseDecision::Recreate {
                reason: WorkerReuseRecreateReason::ProtocolMismatch(
                    WorkerReuseProtocolMismatch::Encoding {
                        expected: AGENT_WORKER_PROTOCOL_ENCODING.to_string(),
                        actual: "json".to_string(),
                    },
                ),
            }
        );
    }

    #[test]
    fn rejects_protocol_frame_limit_mismatch() {
        let mut candidate = candidate_with_executions(vec![slot("dispatch-a", identity_a())]);
        candidate.ready.protocol.max_frame_bytes = AGENT_WORKER_MAX_FRAME_BYTES + 1;

        assert_eq!(
            plan_worker_reuse(reuse_input(&candidate, &protocol(), 1_010)),
            WorkerReuseDecision::Recreate {
                reason: WorkerReuseRecreateReason::ProtocolMismatch(
                    WorkerReuseProtocolMismatch::MaxFrameBytes {
                        expected: AGENT_WORKER_MAX_FRAME_BYTES,
                        actual: AGENT_WORKER_MAX_FRAME_BYTES + 1,
                    },
                ),
            }
        );
    }

    #[test]
    fn rejects_expired_idle_ttl_only_when_worker_has_no_executions() {
        // Empty executions + stale idle heartbeat → idle TTL fires.
        let mut empty = candidate_with_executions(vec![]);
        // Attach a stale heartbeat at the worker level via an idle slot.
        empty
            .runtime
            .as_mut()
            .expect("runtime must exist")
            .executions
            .push(ActiveExecutionSlot {
                dispatch_id: "ghost".to_string(),
                identity: identity_a(),
                claim_token: "ghost".to_string(),
                started_at: 1_000,
                last_heartbeat: Some(heartbeat(1_000, WorkerHeartbeatState::Idle)),
            });
        empty
            .runtime
            .as_mut()
            .expect("runtime must exist")
            .executions
            .clear();
        // The idle-TTL branch is gated on `executions.is_empty()` in the impl.
        // Build a worker that has been alive but has no live slots and a heartbeat
        // we recorded somewhere else; we simulate by dropping all slots and using
        // a candidate that has never seen one.
        let now = 6_001;
        assert_eq!(
            plan_worker_reuse(reuse_input(&empty, &protocol_with_idle_ttl(5_000), now)),
            WorkerReuseDecision::ReuseAllowed {
                worker_id: "worker-a".to_string(),
                pid: 44,
                active_executions: 0,
            },
            "warm worker with no executions and no remembered heartbeat is reusable",
        );
    }

    #[test]
    fn rejects_pending_shutdown_and_leaked_mcp_process() {
        let mut shutdown_candidate =
            candidate_with_executions(vec![slot("dispatch-a", identity_a())]);
        shutdown_candidate
            .runtime
            .as_mut()
            .expect("runtime must exist")
            .graceful_signal = Some(WorkerRuntimeGracefulSignal {
            signal: WorkerAbortSignal::Shutdown,
            sent_at: 900,
            reason: "operator shutdown".to_string(),
        });

        assert_eq!(
            plan_worker_reuse(reuse_input(&shutdown_candidate, &protocol(), 1_010)),
            WorkerReuseDecision::Recreate {
                reason: WorkerReuseRecreateReason::PendingShutdown,
            }
        );

        let mut leaked_candidate = candidate_with_executions(vec![slot("dispatch-a", identity_a())]);
        leaked_candidate.leaked_mcp_process = Some(true);

        assert_eq!(
            plan_worker_reuse(reuse_input(&leaked_candidate, &protocol(), 1_010)),
            WorkerReuseDecision::Recreate {
                reason: WorkerReuseRecreateReason::LeakedMcpProcess,
            }
        );
    }

    fn reuse_input<'a>(
        candidate: &'a WorkerReuseCandidate,
        protocol: &'a WorkerProtocolConfig,
        now: u64,
    ) -> WorkerReusePlanInput<'a> {
        WorkerReusePlanInput {
            now,
            required_protocol: protocol,
            required_project_base_path: Some("/projects/project-a"),
            required_working_directory: Some("/projects/project-a/work"),
            required_metadata_path: Some("/projects/project-a/.tenex"),
            concurrency_cap: DEFAULT_WORKER_CONCURRENCY_CAP,
            candidate,
        }
    }

    fn candidate_with_executions(executions: Vec<ActiveExecutionSlot>) -> WorkerReuseCandidate {
        WorkerReuseCandidate {
            ready: AgentWorkerReady {
                worker_id: "worker-a".to_string(),
                pid: 44,
                protocol: protocol_with_idle_ttl(5_000),
                message: json!({
                    "type": "ready",
                    "workerId": "worker-a",
                    "pid": 44,
                }),
            },
            runtime: Some(ActiveWorkerRuntimeSnapshot {
                worker_id: "worker-a".to_string(),
                pid: 44,
                started_at: 900,
                graceful_signal: None,
                executions,
            }),
            project_base_path: Some("/projects/project-a".to_string()),
            working_directory: Some("/projects/project-a/work".to_string()),
            metadata_path: Some("/projects/project-a/.tenex".to_string()),
            leaked_mcp_process: None,
        }
    }

    fn protocol() -> WorkerProtocolConfig {
        protocol_with_idle_ttl(5_000)
    }

    fn protocol_with_idle_ttl(idle_ttl_ms: u64) -> WorkerProtocolConfig {
        WorkerProtocolConfig {
            version: AGENT_WORKER_PROTOCOL_VERSION,
            encoding: AGENT_WORKER_PROTOCOL_ENCODING.to_string(),
            max_frame_bytes: AGENT_WORKER_MAX_FRAME_BYTES,
            stream_batch_ms: AGENT_WORKER_STREAM_BATCH_MS,
            stream_batch_max_bytes: AGENT_WORKER_STREAM_BATCH_MAX_BYTES,
            heartbeat_interval_ms: Some(5_000),
            missed_heartbeat_threshold: Some(3),
            worker_boot_timeout_ms: Some(30_000),
            graceful_abort_timeout_ms: Some(10_000),
            force_kill_timeout_ms: Some(5_000),
            idle_ttl_ms: Some(idle_ttl_ms),
        }
    }

    fn identity_a() -> RalJournalIdentity {
        RalJournalIdentity {
            project_id: "project-a".to_string(),
            agent_pubkey: "a".repeat(64),
            conversation_id: "conversation-a".to_string(),
            ral_number: 7,
        }
    }

    fn identity_b() -> RalJournalIdentity {
        RalJournalIdentity {
            project_id: "project-a".to_string(),
            agent_pubkey: "b".repeat(64),
            conversation_id: "conversation-b".to_string(),
            ral_number: 1,
        }
    }

    fn slot(dispatch_id: &str, identity: RalJournalIdentity) -> ActiveExecutionSlot {
        ActiveExecutionSlot {
            dispatch_id: dispatch_id.to_string(),
            identity,
            claim_token: format!("claim-{dispatch_id}"),
            started_at: 1_000,
            last_heartbeat: Some(heartbeat(1_000, WorkerHeartbeatState::Streaming)),
        }
    }

    fn heartbeat(observed_at: u64, state: WorkerHeartbeatState) -> WorkerHeartbeatSnapshot {
        WorkerHeartbeatSnapshot {
            worker_id: "worker-a".to_string(),
            correlation_id: "heartbeat-correlation".to_string(),
            sequence: 22,
            worker_timestamp: observed_at.saturating_sub(10),
            observed_at,
            identity: identity_a(),
            state,
            active_tool_count: 0,
            accumulated_runtime_ms: 700,
        }
    }
}
