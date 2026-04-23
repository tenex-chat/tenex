use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;
use thiserror::Error;

use crate::backend_events::project_status::ProjectStatusScheduledTaskKind;
use crate::periodic_tick::PeriodicSchedulerSnapshot;
use crate::periodic_tick_state::{PeriodicTickStateError, periodic_scheduler_state_path};
use crate::project_status_descriptors::{ProjectStatusDescriptor, ProjectStatusDescriptorReport};
use crate::scheduled_task_due_planner::{
    ScheduledTaskDuePlannerDueInput, ScheduledTaskDuePlannerError, ScheduledTaskDuePlannerProject,
    ScheduledTaskTriggerPlan, finalize_scheduled_task_trigger_plan,
    tick_scheduled_task_due_planner_for_due_tasks,
};
use crate::scheduled_task_enqueue::{
    ScheduledTaskEnqueueError, ScheduledTaskEnqueueInput, ScheduledTaskEnqueueOutcome,
    enqueue_scheduled_task_dispatch,
};

pub const SCHEDULED_TASK_MAINTENANCE_DEFAULT_MAX_PLANS: usize = 100;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduledTaskMaintenanceSharedSchedulerInput<'a> {
    pub tenex_base_dir: &'a Path,
    pub daemon_dir: &'a Path,
    pub now: u64,
    pub first_due_at: u64,
    pub accepted_at: u64,
    pub request_timestamp: u64,
    pub writer_version: &'a str,
    pub grace_seconds: u64,
    pub max_plans: usize,
    pub project_descriptor_report: ProjectStatusDescriptorReport,
    pub registered_planner_task: bool,
    pub due_task_names: Vec<String>,
    pub scheduler_snapshot: PeriodicSchedulerSnapshot,
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

pub fn maintain_scheduled_tasks_from_shared_scheduler(
    input: ScheduledTaskMaintenanceSharedSchedulerInput<'_>,
) -> Result<ScheduledTaskMaintenanceOutcome, ScheduledTaskMaintenanceError> {
    let planner_projects = planner_projects_from_descriptors(&input.project_descriptor_report);
    let descriptor_by_d_tag = descriptors_by_d_tag(&input.project_descriptor_report);
    let planner_outcome =
        tick_scheduled_task_due_planner_for_due_tasks(ScheduledTaskDuePlannerDueInput {
            due_task_names: input.due_task_names,
            scheduler_snapshot: input.scheduler_snapshot.clone(),
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
        .unwrap_or_else(|| input.scheduler_snapshot.clone());
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
        project_descriptor_report: input.project_descriptor_report,
        scheduler_state_path: periodic_scheduler_state_path(input.daemon_dir),
        registered_planner_task: input.registered_planner_task,
        planner,
        triggers,
        persisted_scheduler_snapshot: input.scheduler_snapshot,
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
