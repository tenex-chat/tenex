use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;
use thiserror::Error;

use crate::backend_events::project_status::ProjectStatusScheduledTaskKind;
use crate::periodic_tick::PeriodicSchedulerSnapshot;
use crate::periodic_tick_state::{
    PeriodicTickStateError, periodic_scheduler_state_path, read_periodic_scheduler_state,
    write_periodic_scheduler_state,
};
use crate::project_status_descriptors::{
    ProjectStatusDescriptor, ProjectStatusDescriptorError, ProjectStatusDescriptorReport,
    read_project_status_descriptors,
};
use crate::scheduled_task_due_planner::{
    SCHEDULED_TASK_DUE_PLANNER_DEFAULT_GRACE_SECONDS, ScheduledTaskDuePlannerError,
    ScheduledTaskDuePlannerProject, ScheduledTaskDuePlannerTickInput, ScheduledTaskTriggerPlan,
    ensure_scheduled_task_due_planner_task, finalize_scheduled_task_trigger_plan,
    tick_scheduled_task_due_planner,
};
use crate::scheduled_task_enqueue::{
    ScheduledTaskEnqueueError, ScheduledTaskEnqueueInput, ScheduledTaskEnqueueOutcome,
    enqueue_scheduled_task_dispatch,
};

pub const SCHEDULED_TASK_MAINTENANCE_DEFAULT_MAX_PLANS: usize = 100;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduledTaskMaintenanceInput<'a> {
    pub tenex_base_dir: &'a Path,
    pub daemon_dir: &'a Path,
    pub now: u64,
    pub first_due_at: u64,
    pub accepted_at: u64,
    pub request_timestamp: u64,
    pub writer_version: &'a str,
    pub grace_seconds: u64,
    pub max_plans: usize,
}

impl<'a> ScheduledTaskMaintenanceInput<'a> {
    pub fn from_millis(
        tenex_base_dir: &'a Path,
        daemon_dir: &'a Path,
        now_ms: u64,
        writer_version: &'a str,
    ) -> Self {
        let now = now_ms / 1_000;
        Self {
            tenex_base_dir,
            daemon_dir,
            now,
            first_due_at: now,
            accepted_at: now_ms,
            request_timestamp: now_ms,
            writer_version,
            grace_seconds: SCHEDULED_TASK_DUE_PLANNER_DEFAULT_GRACE_SECONDS,
            max_plans: SCHEDULED_TASK_MAINTENANCE_DEFAULT_MAX_PLANS,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTaskMaintenanceOutcome {
    pub tenex_base_dir: PathBuf,
    pub daemon_dir: PathBuf,
    pub now: u64,
    pub first_due_at: u64,
    pub accepted_at: u64,
    pub request_timestamp: u64,
    pub writer_version: String,
    pub grace_seconds: u64,
    pub max_plans: usize,
    pub project_descriptor_report: ProjectStatusDescriptorReport,
    pub scheduler_state_path: PathBuf,
    pub registered_planner_task: bool,
    pub planner: ScheduledTaskMaintenancePlannerReport,
    pub triggers: Vec<ScheduledTaskMaintenanceTriggerOutcome>,
    pub persisted_scheduler_snapshot: PeriodicSchedulerSnapshot,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTaskMaintenancePlannerReport {
    pub tick_due: bool,
    pub due_task_names: Vec<String>,
    pub plans: Vec<ScheduledTaskPlanDiagnostic>,
    pub truncated: bool,
    pub scheduler_snapshot: PeriodicSchedulerSnapshot,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTaskMaintenanceTriggerOutcome {
    pub plan: ScheduledTaskPlanDiagnostic,
    pub enqueue: ScheduledTaskEnqueueOutcome,
    pub finalization: ScheduledTaskFinalizationReport,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTaskPlanDiagnostic {
    pub project_d_tag: String,
    pub project_ref: String,
    pub task_id: String,
    pub title: String,
    pub from_pubkey: String,
    pub target_agent: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_channel: Option<String>,
    pub schedule: String,
    pub kind: String,
    pub due_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_run: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTaskFinalizationReport {
    pub path: PathBuf,
    pub updated: bool,
    pub removed: bool,
}

#[derive(Debug, Error)]
pub enum ScheduledTaskMaintenanceError {
    #[error("project descriptor discovery failed: {source}")]
    ProjectDescriptors {
        #[source]
        source: ProjectStatusDescriptorError,
    },
    #[error("periodic scheduler state failed: {source}")]
    SchedulerState {
        #[source]
        source: PeriodicTickStateError,
    },
    #[error("scheduled task due planner failed: {source}")]
    Planner {
        #[source]
        source: ScheduledTaskDuePlannerError,
    },
    #[error("missing project descriptor for scheduled task project {project_d_tag}")]
    MissingProjectDescriptor { project_d_tag: String },
    #[error("scheduled task enqueue failed for {project_d_tag}/{task_id}: {source}")]
    Enqueue {
        project_d_tag: String,
        task_id: String,
        #[source]
        source: ScheduledTaskEnqueueError,
    },
    #[error("scheduled task finalization failed for {project_d_tag}/{task_id}: {source}")]
    Finalize {
        project_d_tag: String,
        task_id: String,
        #[source]
        source: ScheduledTaskDuePlannerError,
    },
}

pub fn maintain_scheduled_tasks_from_filesystem(
    input: ScheduledTaskMaintenanceInput<'_>,
) -> Result<ScheduledTaskMaintenanceOutcome, ScheduledTaskMaintenanceError> {
    let project_descriptor_report = read_project_status_descriptors(input.tenex_base_dir)
        .map_err(|source| ScheduledTaskMaintenanceError::ProjectDescriptors { source })?;
    let planner_projects = planner_projects_from_descriptors(&project_descriptor_report);
    let descriptor_by_d_tag = descriptors_by_d_tag(&project_descriptor_report);
    let mut scheduler = read_periodic_scheduler_state(input.daemon_dir)
        .map_err(|source| ScheduledTaskMaintenanceError::SchedulerState { source })?;
    let registered_planner_task =
        ensure_scheduled_task_due_planner_task(&mut scheduler, input.first_due_at)
            .map_err(ScheduledTaskDuePlannerError::from)
            .map_err(|source| ScheduledTaskMaintenanceError::Planner { source })?;
    let planner_outcome = tick_scheduled_task_due_planner(ScheduledTaskDuePlannerTickInput {
        scheduler: &mut scheduler,
        tenex_base_dir: input.tenex_base_dir,
        projects: &planner_projects,
        now: input.now,
        grace_seconds: input.grace_seconds,
        max_plans: input.max_plans,
    })
    .map_err(|source| ScheduledTaskMaintenanceError::Planner { source })?;
    let scheduler_snapshot = planner_outcome
        .scheduler_snapshot
        .clone()
        .unwrap_or_else(|| scheduler.inspect());
    let planner = ScheduledTaskMaintenancePlannerReport {
        tick_due: planner_outcome.tick_due,
        due_task_names: planner_outcome.due_task_names.clone(),
        plans: planner_outcome
            .plans
            .iter()
            .map(ScheduledTaskPlanDiagnostic::from)
            .collect(),
        truncated: planner_outcome.truncated,
        scheduler_snapshot,
    };

    let mut triggers = Vec::new();
    for plan in &planner_outcome.plans {
        let project = descriptor_by_d_tag
            .get(plan.project_d_tag.as_str())
            .ok_or_else(|| ScheduledTaskMaintenanceError::MissingProjectDescriptor {
                project_d_tag: plan.project_d_tag.clone(),
            })?;
        let enqueue = enqueue_scheduled_task_dispatch(ScheduledTaskEnqueueInput {
            daemon_dir: input.daemon_dir,
            tenex_base_dir: input.tenex_base_dir,
            project,
            plan,
            timestamp: input.accepted_at,
            writer_version: input.writer_version.to_string(),
        })
        .map_err(|source| ScheduledTaskMaintenanceError::Enqueue {
            project_d_tag: plan.project_d_tag.clone(),
            task_id: plan.task_id.clone(),
            source,
        })?;
        let finalization = finalize_scheduled_task_trigger_plan(input.tenex_base_dir, plan)
            .map_err(|source| ScheduledTaskMaintenanceError::Finalize {
                project_d_tag: plan.project_d_tag.clone(),
                task_id: plan.task_id.clone(),
                source,
            })?;
        triggers.push(ScheduledTaskMaintenanceTriggerOutcome {
            plan: ScheduledTaskPlanDiagnostic::from(plan),
            enqueue,
            finalization: ScheduledTaskFinalizationReport {
                path: finalization.path,
                updated: finalization.updated,
                removed: finalization.removed,
            },
        });
    }

    let persisted_scheduler_snapshot = write_periodic_scheduler_state(input.daemon_dir, &scheduler)
        .map_err(|source| ScheduledTaskMaintenanceError::SchedulerState { source })?;

    Ok(ScheduledTaskMaintenanceOutcome {
        tenex_base_dir: input.tenex_base_dir.to_path_buf(),
        daemon_dir: input.daemon_dir.to_path_buf(),
        now: input.now,
        first_due_at: input.first_due_at,
        accepted_at: input.accepted_at,
        request_timestamp: input.request_timestamp,
        writer_version: input.writer_version.to_string(),
        grace_seconds: input.grace_seconds,
        max_plans: input.max_plans,
        project_descriptor_report,
        scheduler_state_path: periodic_scheduler_state_path(input.daemon_dir),
        registered_planner_task,
        planner,
        triggers,
        persisted_scheduler_snapshot,
    })
}

impl From<&ScheduledTaskTriggerPlan> for ScheduledTaskPlanDiagnostic {
    fn from(plan: &ScheduledTaskTriggerPlan) -> Self {
        Self {
            project_d_tag: plan.project_d_tag.clone(),
            project_ref: plan.project_ref.clone(),
            task_id: plan.task_id.clone(),
            title: plan.title.clone(),
            from_pubkey: plan.from_pubkey.clone(),
            target_agent: plan.target_agent.clone(),
            target_channel: plan.target_channel.clone(),
            schedule: plan.schedule.clone(),
            kind: scheduled_task_kind_label(plan.kind).to_string(),
            due_at: plan.due_at,
            last_run: plan.last_run,
        }
    }
}

fn planner_projects_from_descriptors<'a>(
    report: &'a ProjectStatusDescriptorReport,
) -> Vec<ScheduledTaskDuePlannerProject<'a>> {
    report
        .descriptors
        .iter()
        .map(|descriptor| ScheduledTaskDuePlannerProject {
            project_d_tag: &descriptor.project_d_tag,
        })
        .collect()
}

fn descriptors_by_d_tag(
    report: &ProjectStatusDescriptorReport,
) -> BTreeMap<&str, &ProjectStatusDescriptor> {
    report
        .descriptors
        .iter()
        .map(|descriptor| (descriptor.project_d_tag.as_str(), descriptor))
        .collect()
}

fn scheduled_task_kind_label(kind: ProjectStatusScheduledTaskKind) -> &'static str {
    match kind {
        ProjectStatusScheduledTaskKind::Cron => "cron",
        ProjectStatusScheduledTaskKind::Oneoff => "oneoff",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch_queue::replay_dispatch_queue;
    use crate::periodic_tick_state::periodic_scheduler_state_path;
    use crate::project_status_descriptors::{PROJECT_DESCRIPTOR_FILE_NAME, projects_dir};
    use crate::ral_journal::read_ral_journal_records;
    use crate::scheduled_task_dispatch_input::read_optional;
    use secp256k1::{Keypair, Secp256k1, SecretKey};
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn maintenance_enqueues_due_tasks_finalizes_schedules_and_persists_scheduler() {
        let fixture = Fixture::new("scheduled-task-maintenance-base");
        fixture.write_oneoff_schedule("task-one", "reporter");

        let outcome = maintain_scheduled_tasks_from_filesystem(ScheduledTaskMaintenanceInput {
            tenex_base_dir: &fixture.tenex_base_dir,
            daemon_dir: &fixture.daemon_dir,
            now: 1_710_001_000,
            first_due_at: 1_710_001_000,
            accepted_at: 1_710_001_000_100,
            request_timestamp: 1_710_001_000_050,
            writer_version: "test-writer",
            grace_seconds: 86_400,
            max_plans: 10,
        })
        .expect("scheduled task maintenance must run");

        assert_eq!(outcome.project_descriptor_report.descriptors.len(), 1);
        assert!(outcome.registered_planner_task);
        assert!(outcome.planner.tick_due);
        assert_eq!(
            outcome.planner.due_task_names,
            vec!["scheduled-task-due-planner".to_string()]
        );
        assert_eq!(outcome.triggers.len(), 1);
        assert_eq!(outcome.triggers[0].plan.task_id, "task-one");
        assert_eq!(outcome.triggers[0].plan.kind, "oneoff");
        assert_eq!(outcome.triggers[0].enqueue.project_d_tag, "demo-project");
        assert_eq!(outcome.triggers[0].enqueue.task_id, "task-one");
        assert!(outcome.triggers[0].enqueue.queued);
        assert!(!outcome.triggers[0].enqueue.already_existed);
        assert!(outcome.triggers[0].finalization.removed);
        assert!(!outcome.triggers[0].finalization.updated);
        assert_eq!(outcome.persisted_scheduler_snapshot.tasks.len(), 1);
        assert_eq!(
            outcome.persisted_scheduler_snapshot.tasks[0].next_due_at,
            1_710_001_030
        );
        assert!(periodic_scheduler_state_path(&fixture.daemon_dir).is_file());

        let sidecar = read_optional(
            &fixture.daemon_dir,
            &outcome.triggers[0].enqueue.dispatch_id,
        )
        .expect("sidecar read must succeed")
        .expect("sidecar must exist");
        assert_eq!(sidecar.task_diagnostic_metadata.task_id, "task-one");
        assert_eq!(
            read_ral_journal_records(&fixture.daemon_dir)
                .expect("RAL journal must read")
                .len(),
            2
        );
        assert_eq!(
            replay_dispatch_queue(&fixture.daemon_dir)
                .expect("dispatch queue must replay")
                .queued
                .len(),
            1
        );

        let schedules = fs::read_to_string(fixture.schedules_path()).expect("schedules must read");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&schedules).expect("schedules json"),
            serde_json::json!([])
        );

        fixture.cleanup();
    }

    #[test]
    fn enqueue_failure_leaves_schedule_and_scheduler_state_unmodified() {
        let fixture = Fixture::new("scheduled-task-maintenance-failure-base");
        fixture.write_oneoff_schedule("task-fail", "missing-agent");
        let original_schedules =
            fs::read_to_string(fixture.schedules_path()).expect("schedules must read");

        let error = maintain_scheduled_tasks_from_filesystem(ScheduledTaskMaintenanceInput {
            tenex_base_dir: &fixture.tenex_base_dir,
            daemon_dir: &fixture.daemon_dir,
            now: 1_710_001_000,
            first_due_at: 1_710_001_000,
            accepted_at: 1_710_001_000_100,
            request_timestamp: 1_710_001_000_050,
            writer_version: "test-writer",
            grace_seconds: 86_400,
            max_plans: 10,
        })
        .expect_err("enqueue failure must fail maintenance");

        match error {
            ScheduledTaskMaintenanceError::Enqueue {
                project_d_tag,
                task_id,
                ..
            } => {
                assert_eq!(project_d_tag, "demo-project");
                assert_eq!(task_id, "task-fail");
            }
            other => panic!("unexpected error: {other:?}"),
        }
        assert_eq!(
            fs::read_to_string(fixture.schedules_path()).expect("schedules must read"),
            original_schedules
        );
        assert!(!periodic_scheduler_state_path(&fixture.daemon_dir).exists());
        assert!(
            read_ral_journal_records(&fixture.daemon_dir)
                .expect("RAL journal must read")
                .is_empty()
        );
        assert!(
            replay_dispatch_queue(&fixture.daemon_dir)
                .expect("dispatch queue must replay")
                .queued
                .is_empty()
        );

        fixture.cleanup();
    }

    struct Fixture {
        root: PathBuf,
        daemon_dir: PathBuf,
        tenex_base_dir: PathBuf,
        owner_pubkey: String,
    }

    impl Fixture {
        fn new(name: &str) -> Self {
            let root = unique_temp_dir(name);
            let daemon_dir = root.join("daemon");
            let tenex_base_dir = root.join("tenex");
            let owner_pubkey = pubkey_hex(0x02);
            let agent_pubkey = pubkey_hex(0x03);
            fs::create_dir_all(&daemon_dir).expect("daemon dir must create");
            write_project_descriptor(&tenex_base_dir, "demo-project", &owner_pubkey);
            write_agent_sources(&tenex_base_dir, "demo-project", &agent_pubkey);

            Self {
                root,
                daemon_dir,
                tenex_base_dir,
                owner_pubkey,
            }
        }

        fn schedules_path(&self) -> PathBuf {
            self.tenex_base_dir
                .join("projects")
                .join("demo-project")
                .join("schedules.json")
        }

        fn write_oneoff_schedule(&self, task_id: &str, target_agent_slug: &str) {
            fs::write(
                self.schedules_path(),
                format!(
                    r#"[{{
                        "id": "{task_id}",
                        "title": "One off",
                        "schedule": "2024-03-09T16:00:00.000Z",
                        "executeAt": "2024-03-09T16:00:00.000Z",
                        "prompt": "Run the report",
                        "fromPubkey": "{}",
                        "targetAgentSlug": "{target_agent_slug}",
                        "projectId": "31933:{}:demo-project",
                        "projectRef": "31933:{}:demo-project",
                        "type": "oneoff"
                    }}]"#,
                    self.owner_pubkey, self.owner_pubkey, self.owner_pubkey
                ),
            )
            .expect("schedules must write");
        }

        fn cleanup(self) {
            fs::remove_dir_all(self.root).expect("cleanup must succeed");
        }
    }

    fn write_project_descriptor(tenex_base_dir: &Path, project_d_tag: &str, owner_pubkey: &str) {
        let project_dir = projects_dir(tenex_base_dir).join(project_d_tag);
        fs::create_dir_all(&project_dir).expect("project dir must create");
        fs::write(
            project_dir.join(PROJECT_DESCRIPTOR_FILE_NAME),
            format!(
                r#"{{
                    "status": "running",
                    "projectOwnerPubkey": "{owner_pubkey}",
                    "projectDTag": "{project_d_tag}",
                    "projectBasePath": "/repo/{project_d_tag}"
                }}"#
            ),
        )
        .expect("project descriptor must write");
    }

    fn write_agent_sources(tenex_base_dir: &Path, project_d_tag: &str, agent_pubkey: &str) {
        let agents_dir = tenex_base_dir.join("agents");
        fs::create_dir_all(&agents_dir).expect("agents dir must create");
        fs::write(
            agents_dir.join("index.json"),
            format!(r#"{{"byProject":{{"{project_d_tag}":["{agent_pubkey}"]}}}}"#),
        )
        .expect("agent index must write");
        fs::write(
            agents_dir.join(format!("{agent_pubkey}.json")),
            r#"{"slug":"reporter","status":"active","default":{"model":"claude"}}"#,
        )
        .expect("agent file must write");
    }

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be after UNIX_EPOCH")
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("{prefix}-{unique}-{counter}"))
    }

    fn pubkey_hex(seed: u8) -> String {
        let secp = Secp256k1::new();
        let secret = SecretKey::from_byte_array([seed; 32]).expect("test secret key must be valid");
        let keypair = Keypair::from_secret_key(&secp, &secret);
        let (x_only, _) = keypair.x_only_public_key();
        x_only.to_string()
    }
}
