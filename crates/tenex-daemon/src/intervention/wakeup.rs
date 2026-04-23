use std::path::Path;

use thiserror::Error;

use crate::scheduler_wakeups::{
    SchedulerWakeupError, WakeupEnqueueRequest, WakeupRecord, WakeupStatus, WakeupTarget,
    cancel_wakeup, enqueue_wakeup, list_pending_scheduler_wakeup_paths, read_pending_wakeup_record,
};

pub const INTERVENTION_WAKEUP_REQUESTER_CONTEXT: &str = "intervention-review/v1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InterventionArmInputs<'a> {
    pub project_d_tag: &'a str,
    pub conversation_id: &'a str,
    pub completing_agent_pubkey: &'a str,
    pub user_pubkey: &'a str,
    pub intervention_agent_slug: &'a str,
    pub scheduled_for_ms: u64,
    pub writer_version: &'a str,
}

#[derive(Debug, Error)]
pub enum InterventionWakeupError {
    #[error("scheduler wakeup error: {0}")]
    Scheduler(#[from] SchedulerWakeupError),
}

pub type InterventionWakeupResult<T> = Result<T, InterventionWakeupError>;

pub fn build_arm_request(inputs: InterventionArmInputs<'_>) -> WakeupEnqueueRequest {
    WakeupEnqueueRequest {
        scheduled_for: inputs.scheduled_for_ms,
        target: WakeupTarget::InterventionReview {
            project_d_tag: inputs.project_d_tag.to_string(),
            conversation_id: inputs.conversation_id.to_string(),
            completing_agent_pubkey: inputs.completing_agent_pubkey.to_string(),
            user_pubkey: inputs.user_pubkey.to_string(),
            intervention_agent_slug: inputs.intervention_agent_slug.to_string(),
        },
        requester_context: INTERVENTION_WAKEUP_REQUESTER_CONTEXT.to_string(),
        writer_version: inputs.writer_version.to_string(),
        allow_backdated: false,
    }
}

/// Scan all pending wakeups and return any `InterventionReview` records
/// matching the given project + conversation. Re-arm and cancel both use this.
pub fn list_pending_for_conversation(
    daemon_dir: impl AsRef<Path>,
    project_d_tag: &str,
    conversation_id: &str,
) -> InterventionWakeupResult<Vec<WakeupRecord>> {
    let daemon_dir = daemon_dir.as_ref();
    let paths = list_pending_scheduler_wakeup_paths(daemon_dir)?;
    let mut matches = Vec::new();
    for path in paths {
        let wakeup_id = match path.file_stem().and_then(|stem| stem.to_str()) {
            Some(stem) => stem.to_string(),
            None => continue,
        };
        let record = match read_pending_wakeup_record(daemon_dir, &wakeup_id)? {
            Some(record) => record,
            None => continue,
        };
        if record.status != WakeupStatus::Pending {
            continue;
        }
        if let WakeupTarget::InterventionReview {
            project_d_tag: project,
            conversation_id: conversation,
            ..
        } = &record.target
            && project == project_d_tag
            && conversation == conversation_id
        {
            matches.push(record);
        }
    }
    Ok(matches)
}

pub fn cancel_pending_for_conversation(
    daemon_dir: impl AsRef<Path>,
    project_d_tag: &str,
    conversation_id: &str,
) -> InterventionWakeupResult<usize> {
    let daemon_dir = daemon_dir.as_ref();
    let pending = list_pending_for_conversation(daemon_dir, project_d_tag, conversation_id)?;
    let mut cancelled = 0;
    for record in pending {
        if cancel_wakeup(daemon_dir, &record.wakeup_id)?.is_some() {
            cancelled += 1;
        }
    }
    Ok(cancelled)
}

pub fn arm_review(
    daemon_dir: impl AsRef<Path>,
    inputs: InterventionArmInputs<'_>,
    now_ms: u64,
) -> InterventionWakeupResult<WakeupRecord> {
    let daemon_dir = daemon_dir.as_ref();
    cancel_pending_for_conversation(daemon_dir, inputs.project_d_tag, inputs.conversation_id)?;
    let request = build_arm_request(inputs);
    Ok(enqueue_wakeup(daemon_dir, request, now_ms)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn unique_temp_daemon_dir() -> PathBuf {
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock after epoch")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("tenex-intervention-wakeup-{nanos}-{counter}"));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn sample_inputs<'a>() -> InterventionArmInputs<'a> {
        InterventionArmInputs {
            project_d_tag: "proj-alpha",
            conversation_id: "conv-alpha",
            completing_agent_pubkey: "a".repeat(64).leak(),
            user_pubkey: "b".repeat(64).leak(),
            intervention_agent_slug: "reviewer",
            scheduled_for_ms: 10_000,
            writer_version: "test-version",
        }
    }

    #[test]
    fn arm_persists_pending_wakeup_with_intervention_review_target() {
        let dir = unique_temp_daemon_dir();
        let inputs = sample_inputs();
        let record = arm_review(&dir, inputs.clone(), 1_000).expect("arm");
        assert_eq!(record.status, WakeupStatus::Pending);
        match &record.target {
            WakeupTarget::InterventionReview {
                project_d_tag,
                conversation_id,
                ..
            } => {
                assert_eq!(project_d_tag, "proj-alpha");
                assert_eq!(conversation_id, "conv-alpha");
            }
            other => panic!("expected InterventionReview target, got {other:?}"),
        }
        let pending =
            list_pending_for_conversation(&dir, "proj-alpha", "conv-alpha").expect("list pending");
        assert_eq!(pending.len(), 1);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn re_arming_same_conversation_replaces_previous_pending_wakeup() {
        let dir = unique_temp_daemon_dir();
        let mut inputs = sample_inputs();
        arm_review(&dir, inputs.clone(), 1_000).expect("first arm");

        inputs.scheduled_for_ms = 15_000;
        arm_review(&dir, inputs.clone(), 2_000).expect("second arm");

        let pending =
            list_pending_for_conversation(&dir, "proj-alpha", "conv-alpha").expect("list pending");
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].scheduled_for, 15_000);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn cancel_pending_for_conversation_removes_record() {
        let dir = unique_temp_daemon_dir();
        let inputs = sample_inputs();
        arm_review(&dir, inputs, 1_000).expect("arm");
        let cancelled =
            cancel_pending_for_conversation(&dir, "proj-alpha", "conv-alpha").expect("cancel");
        assert_eq!(cancelled, 1);
        let pending =
            list_pending_for_conversation(&dir, "proj-alpha", "conv-alpha").expect("list pending");
        assert!(pending.is_empty());
        fs::remove_dir_all(&dir).ok();
    }
}
