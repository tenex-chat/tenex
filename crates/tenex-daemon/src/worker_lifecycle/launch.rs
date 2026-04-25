use serde_json::Value;
use thiserror::Error;

use crate::dispatch_queue::DispatchQueueRecord;
use crate::ral_journal::RalJournalIdentity;
use crate::worker_protocol::{
    AgentWorkerExecuteMessageInput, AgentWorkerExecutionFlags, WorkerProtocolError,
    build_agent_worker_execute_message,
};

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct RalAllocationLockScope {
    pub project_id: String,
    pub agent_pubkey: String,
    pub conversation_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct RalStateLockScope {
    pub project_id: String,
    pub agent_pubkey: String,
    pub conversation_id: String,
    pub ral_number: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerLaunchPlanInput<'a> {
    pub dispatch: &'a DispatchQueueRecord,
    pub identity: &'a RalJournalIdentity,
    pub sequence: u64,
    pub timestamp: u64,
    pub project_base_path: String,
    pub metadata_path: String,
    pub triggering_envelope: Value,
    pub execution_flags: AgentWorkerExecutionFlags,
    pub delegation_snapshot: crate::ral_journal::RalDelegationSnapshot,
    /// Inline executing-agent block (signing key + slug + system prompt + skills + ...).
    /// When `Some`, the worker materializes the agent from this payload and
    /// does not read agent storage from disk.
    pub agent: Option<Value>,
    /// Daemon's authoritative project agent inventory at dispatch time.
    pub project_agent_inventory: Option<Vec<Value>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerLaunchPlan {
    pub allocation_lock_scope: RalAllocationLockScope,
    pub state_lock_scope: RalStateLockScope,
    pub execute_message: Value,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum WorkerLaunchError {
    #[error("worker protocol error: {0}")]
    Protocol(#[from] WorkerProtocolError),
    #[error("dispatch {dispatch_id} RAL identity does not match expected launch identity")]
    DispatchIdentityMismatch {
        dispatch_id: String,
        expected: Box<RalJournalIdentity>,
        actual: Box<RalJournalIdentity>,
    },
}

pub type WorkerLaunchResult<T> = Result<T, WorkerLaunchError>;

pub fn plan_ral_allocation_lock_scope(identity: &RalJournalIdentity) -> RalAllocationLockScope {
    RalAllocationLockScope {
        project_id: identity.project_id.clone(),
        agent_pubkey: identity.agent_pubkey.clone(),
        conversation_id: identity.conversation_id.clone(),
    }
}

pub fn plan_ral_state_lock_scope(identity: &RalJournalIdentity) -> RalStateLockScope {
    RalStateLockScope {
        project_id: identity.project_id.clone(),
        agent_pubkey: identity.agent_pubkey.clone(),
        conversation_id: identity.conversation_id.clone(),
        ral_number: identity.ral_number,
    }
}

pub fn plan_worker_launch(
    input: WorkerLaunchPlanInput<'_>,
) -> WorkerLaunchResult<WorkerLaunchPlan> {
    let actual_identity = dispatch_ral_identity(input.dispatch);
    if &actual_identity != input.identity {
        return Err(WorkerLaunchError::DispatchIdentityMismatch {
            dispatch_id: input.dispatch.dispatch_id.clone(),
            expected: Box::new(input.identity.clone()),
            actual: Box::new(actual_identity),
        });
    }

    let execute_message = build_agent_worker_execute_message(AgentWorkerExecuteMessageInput {
        dispatch: input.dispatch,
        sequence: input.sequence,
        timestamp: input.timestamp,
        project_base_path: input.project_base_path,
        metadata_path: input.metadata_path,
        triggering_envelope: input.triggering_envelope,
        execution_flags: input.execution_flags,
        delegation_snapshot: input.delegation_snapshot,
        agent: input.agent,
        project_agent_inventory: input.project_agent_inventory,
    })?;

    Ok(WorkerLaunchPlan {
        allocation_lock_scope: plan_ral_allocation_lock_scope(input.identity),
        state_lock_scope: plan_ral_state_lock_scope(input.identity),
        execute_message,
    })
}

fn dispatch_ral_identity(dispatch: &DispatchQueueRecord) -> RalJournalIdentity {
    RalJournalIdentity {
        project_id: dispatch.ral.project_id.clone(),
        agent_pubkey: dispatch.ral.agent_pubkey.clone(),
        conversation_id: dispatch.ral.conversation_id.clone(),
        ral_number: dispatch.ral.ral_number,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch_queue::{
        DispatchQueueRecordParams, DispatchQueueStatus, DispatchRalIdentity,
        build_dispatch_queue_record,
    };
    use crate::worker_protocol::{
        AgentWorkerExecutionFlags, WorkerProtocolError, WorkerProtocolFixture,
    };
    use serde_json::Value;

    const WORKER_PROTOCOL_FIXTURE: &str = include_str!(
        "../../../../src/test-utils/fixtures/worker-protocol/agent-execution.compat.json"
    );

    #[test]
    fn worker_launch_plan_derives_lock_scopes_and_execute_message() {
        let execute = fixture_valid_message("execute");
        let identity = identity_from_execute(&execute);
        let dispatch = dispatch_from_execute(&execute, DispatchQueueStatus::Leased);

        let plan =
            plan_worker_launch(launch_input(&dispatch, &identity, &execute)).expect("must plan");

        assert_eq!(
            plan.allocation_lock_scope,
            RalAllocationLockScope {
                project_id: identity.project_id.clone(),
                agent_pubkey: identity.agent_pubkey.clone(),
                conversation_id: identity.conversation_id.clone(),
            }
        );
        assert_eq!(
            plan.state_lock_scope,
            RalStateLockScope {
                project_id: identity.project_id.clone(),
                agent_pubkey: identity.agent_pubkey.clone(),
                conversation_id: identity.conversation_id.clone(),
                ral_number: identity.ral_number,
            }
        );
        assert_eq!(plan.execute_message, execute);
    }

    #[test]
    fn worker_launch_plan_rejects_dispatch_identity_mismatch() {
        let execute = fixture_valid_message("execute");
        let mut expected_identity = identity_from_execute(&execute);
        let dispatch = dispatch_from_execute(&execute, DispatchQueueStatus::Leased);
        expected_identity.ral_number += 1;

        let error = plan_worker_launch(launch_input(&dispatch, &expected_identity, &execute))
            .expect_err("mismatched launch identity must fail");

        assert_eq!(
            error,
            WorkerLaunchError::DispatchIdentityMismatch {
                dispatch_id: "dispatch-fixture".to_string(),
                expected: Box::new(expected_identity),
                actual: Box::new(identity_from_execute(&execute)),
            }
        );
    }

    #[test]
    fn worker_launch_plan_reuses_execute_message_validation() {
        let execute = fixture_valid_message("execute");
        let identity = identity_from_execute(&execute);
        let dispatch = dispatch_from_execute(&execute, DispatchQueueStatus::Queued);

        let error = plan_worker_launch(launch_input(&dispatch, &identity, &execute))
            .expect_err("queued dispatch must not launch");

        assert_eq!(
            error,
            WorkerLaunchError::Protocol(WorkerProtocolError::DispatchNotLeasedForExecute {
                dispatch_id: "dispatch-fixture".to_string(),
                status: DispatchQueueStatus::Queued,
            })
        );
    }

    #[test]
    fn ral_lock_scope_planners_are_derived_from_identity() {
        let identity = RalJournalIdentity {
            project_id: "project-a".to_string(),
            agent_pubkey: "a".repeat(64),
            conversation_id: "conversation-a".to_string(),
            ral_number: 7,
        };

        assert_eq!(
            plan_ral_allocation_lock_scope(&identity),
            RalAllocationLockScope {
                project_id: "project-a".to_string(),
                agent_pubkey: "a".repeat(64),
                conversation_id: "conversation-a".to_string(),
            }
        );
        assert_eq!(
            plan_ral_state_lock_scope(&identity),
            RalStateLockScope {
                project_id: "project-a".to_string(),
                agent_pubkey: "a".repeat(64),
                conversation_id: "conversation-a".to_string(),
                ral_number: 7,
            }
        );
    }

    fn fixture_valid_message(name: &'static str) -> Value {
        let fixture: WorkerProtocolFixture =
            serde_json::from_str(WORKER_PROTOCOL_FIXTURE).expect("fixture must parse");
        fixture
            .valid_messages
            .into_iter()
            .find(|message| message.name == name)
            .unwrap_or_else(|| panic!("fixture must include {name} message"))
            .message
    }

    fn launch_input<'a>(
        dispatch: &'a DispatchQueueRecord,
        identity: &'a RalJournalIdentity,
        execute: &Value,
    ) -> WorkerLaunchPlanInput<'a> {
        let flags = &execute["executionFlags"];
        WorkerLaunchPlanInput {
            dispatch,
            identity,
            sequence: value_u64(execute, "sequence"),
            timestamp: value_u64(execute, "timestamp"),
            project_base_path: value_string(execute, "projectBasePath"),
            metadata_path: value_string(execute, "metadataPath"),
            triggering_envelope: execute["triggeringEnvelope"].clone(),
            execution_flags: AgentWorkerExecutionFlags {
                is_delegation_completion: flags["isDelegationCompletion"]
                    .as_bool()
                    .expect("delegation flag must be bool"),
                has_pending_delegations: flags["hasPendingDelegations"]
                    .as_bool()
                    .expect("pending flag must be bool"),
                pending_delegation_ids: flags["pendingDelegationIds"]
                    .as_array()
                    .map(|ids| {
                        ids.iter()
                            .filter_map(|id| id.as_str().map(str::to_string))
                            .collect()
                    })
                    .unwrap_or_default(),
                debug: flags["debug"].as_bool().expect("debug flag must be bool"),
            },
            delegation_snapshot: crate::ral_journal::RalDelegationSnapshot::default(),
            agent: None,
            project_agent_inventory: None,
        }
    }

    fn dispatch_from_execute(execute: &Value, status: DispatchQueueStatus) -> DispatchQueueRecord {
        let identity = identity_from_execute(execute);
        build_dispatch_queue_record(DispatchQueueRecordParams {
            sequence: 42,
            timestamp: 1710000400999,
            correlation_id: value_string(execute, "correlationId"),
            dispatch_id: "dispatch-fixture".to_string(),
            ral: DispatchRalIdentity {
                project_id: identity.project_id,
                agent_pubkey: identity.agent_pubkey,
                conversation_id: identity.conversation_id,
                ral_number: identity.ral_number,
            },
            triggering_event_id: execute["triggeringEnvelope"]["message"]["nativeId"]
                .as_str()
                .expect("trigger native id must be string")
                .to_string(),
            claim_token: value_string(execute, "ralClaimToken"),
            status,
        })
    }

    fn identity_from_execute(execute: &Value) -> RalJournalIdentity {
        RalJournalIdentity {
            project_id: value_string(execute, "projectId"),
            agent_pubkey: value_string(execute, "agentPubkey"),
            conversation_id: value_string(execute, "conversationId"),
            ral_number: value_u64(execute, "ralNumber"),
        }
    }

    fn value_string(value: &Value, key: &'static str) -> String {
        value[key]
            .as_str()
            .unwrap_or_else(|| panic!("fixture field {key} must be string"))
            .to_string()
    }

    fn value_u64(value: &Value, key: &'static str) -> u64 {
        value[key]
            .as_u64()
            .unwrap_or_else(|| panic!("fixture field {key} must be u64"))
    }
}
