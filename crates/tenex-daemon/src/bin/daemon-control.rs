use std::env;
use std::fmt;
use std::path::{Path, PathBuf};
use std::process;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tenex_daemon::agent_inventory::read_installed_agent_inventory;
use tenex_daemon::backend_config::read_backend_config;
use tenex_daemon::backend_events_maintenance::{
    BackendEventsMaintenanceInput, BackendEventsMaintenanceOutcome,
    maintain_backend_events_from_filesystem,
};
use tenex_daemon::backend_events_tick::BackendEventsTickProject;
use tenex_daemon::backend_status_runtime::{
    BackendStatusRuntimeInput, agents_dir, publish_backend_status_from_filesystem,
};
use tenex_daemon::caches::prefix_lookup::{PrefixLookupDiagnostics, inspect_prefix_lookup};
use tenex_daemon::caches::profile_names::{ProfileNamesDiagnostics, inspect_profile_names};
use tenex_daemon::caches::trust_pubkeys::{TrustPubkeysDiagnostics, inspect_trust_pubkeys};
use tenex_daemon::daemon_control::{
    inspect_daemon_control, plan_daemon_start, plan_daemon_stop,
    read_daemon_restart_state_compatibility,
};
use tenex_daemon::daemon_diagnostics::{DaemonDiagnosticsInput, inspect_daemon_diagnostics};
use tenex_daemon::daemon_foreground::{
    DaemonForegroundInput, run_daemon_foreground_from_filesystem,
};
use tenex_daemon::daemon_loop::{
    SystemDaemonMaintenanceLoopClock, ThreadDaemonMaintenanceLoopSleeper,
};
use tenex_daemon::daemon_maintenance::{
    DaemonMaintenanceInput, DaemonMaintenanceOutcome, run_daemon_maintenance_once_from_filesystem,
};
use tenex_daemon::daemon_readiness::inspect_daemon_readiness;
use tenex_daemon::daemon_shell::DaemonShell;
use tenex_daemon::project_event_index::ProjectEventIndex;
use tenex_daemon::project_status_descriptors::ProjectStatusDescriptorReport;
use tenex_daemon::project_status_runtime::{
    ProjectStatusRuntimeInput, publish_project_status_from_filesystem,
};
use tenex_daemon::publish_outbox::{
    PublishOutboxDiagnostics, PublishOutboxMaintenanceReport, PublishOutboxRetryPolicy,
    inspect_publish_outbox,
};
use tenex_daemon::relay_publisher::{NostrRelayPublisher, RelayPublisherConfig};
use tenex_daemon::scheduler_wakeups::{inspect_scheduler_wakeups, run_scheduler_maintenance};
use tenex_daemon::subscription_runtime::{
    NostrSubscriptionPlan, NostrSubscriptionPlanInput, build_nostr_subscription_plan,
};

const CACHES_DIAGNOSTICS_SCHEMA_VERSION: u32 = 1;
const DAEMON_FOREGROUND_DIAGNOSTICS_SCHEMA_VERSION: u32 = 1;
const DEFAULT_FOREGROUND_RELAY_TIMEOUT_MS: u64 = 10_000;
const USAGE_EXIT_CODE: i32 = 2;
const RUNTIME_EXIT_CODE: i32 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
enum DaemonControlCommand {
    Caches,
    Diagnostics,
    BackendEventsPlan,
    BackendEventsEnqueueStatus,
    BackendEventsEnqueueProjectStatus,
    BackendEventsPeriodicTick,
    DaemonMaintenance,
    DaemonForeground,
    NostrSubscriptionPlan,
    Readiness,
    SchedulerWakeups,
    SchedulerWakeupsMaintain,
    Status,
    StartPlan,
    StopPlan,
    RestartState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DaemonControlCliOptions {
    command: DaemonControlCommand,
    daemon_dir: PathBuf,
    tenex_base_dir: PathBuf,
    inspected_at: u64,
    created_at: Option<u64>,
    accepted_at: Option<u64>,
    request_timestamp: Option<u64>,
    first_due_at: Option<u64>,
    iterations: Option<u64>,
    sleep_ms: u64,
    project_owner_pubkey: Option<String>,
    project_d_tag: Option<String>,
    project_manager_pubkey: Option<String>,
    worktrees: Vec<String>,
    discover_projects: bool,
    since: Option<u64>,
    lesson_definition_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct CachesDiagnostics {
    schema_version: u32,
    inspected_at: u64,
    trust_pubkeys: TrustPubkeysDiagnostics,
    prefix_lookup: PrefixLookupDiagnostics,
    profile_names: ProfileNamesDiagnostics,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendEventsPlanDiagnostics {
    schema_version: u32,
    inspected_at: u64,
    publish_outbox: PublishOutboxDiagnostics,
    status_publisher_readiness: BackendEventsStatusPublisherReadiness,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendEventsStatusPublisherReadiness {
    kind: &'static str,
    ready: bool,
    reason: String,
    tenex_base_dir: PathBuf,
    backend_pubkey: Option<String>,
    owner_pubkey_count: usize,
    relay_url_count: usize,
    active_agent_count: Option<usize>,
    skipped_agent_file_count: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendEventsEnqueueStatusDiagnostics {
    schema_version: u32,
    tenex_base_dir: PathBuf,
    daemon_dir: PathBuf,
    created_at: u64,
    accepted_at: u64,
    request_timestamp: u64,
    backend_pubkey: String,
    owner_pubkey_count: usize,
    relay_url_count: usize,
    active_agent_count: usize,
    skipped_agent_file_count: usize,
    heartbeat_event_id: String,
    agent_config_event_ids: Vec<String>,
    publish_outbox_after: PublishOutboxDiagnostics,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendEventsEnqueueProjectStatusDiagnostics {
    schema_version: u32,
    tenex_base_dir: PathBuf,
    daemon_dir: PathBuf,
    created_at: u64,
    accepted_at: u64,
    request_timestamp: u64,
    project_owner_pubkey: String,
    project_d_tag: String,
    backend_pubkey: String,
    owner_pubkey_count: usize,
    active_agent_count: usize,
    scheduled_task_count: usize,
    worktree_count: usize,
    project_status_event_id: String,
    publish_outbox_after: PublishOutboxDiagnostics,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendEventsPeriodicTickDiagnostics {
    schema_version: u32,
    #[serde(flatten)]
    maintenance: BackendEventsMaintenanceOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_descriptor_report: Option<ProjectStatusDescriptorReport>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct DaemonMaintenanceDiagnostics {
    schema_version: u32,
    #[serde(flatten)]
    maintenance: DaemonMaintenanceOutcome,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct DaemonForegroundDiagnostics {
    schema_version: u32,
    tenex_base_dir: PathBuf,
    daemon_dir: PathBuf,
    started_at: u64,
    stopped_at: u64,
    iterations: u64,
    sleep_ms: u64,
    steps: Vec<DaemonForegroundStepDiagnostics>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct DaemonForegroundStepDiagnostics {
    iteration_index: u64,
    now_ms: u64,
    tick: DaemonForegroundTickDiagnostics,
    sleep_after_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct DaemonForegroundTickDiagnostics {
    maintenance: DaemonMaintenanceOutcome,
    publish_outbox: PublishOutboxMaintenanceReport,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct NostrSubscriptionPlanDiagnostics {
    schema_version: u32,
    inspected_at: u64,
    tenex_base_dir: PathBuf,
    plan: NostrSubscriptionPlan,
}

#[derive(Debug)]
struct CliError {
    message: String,
    exit_code: i32,
}

impl fmt::Display for CliError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for CliError {}

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    let args = env::args().skip(1).collect::<Vec<_>>();
    let runtime_handle = tokio::runtime::Handle::current();
    let result =
        match tokio::task::spawn_blocking(move || run_cli_with_runtime(args, runtime_handle)).await
        {
            Ok(result) => result,
            Err(error) => Err(runtime_error(format!(
                "failed to join daemon-control CLI task: {error}"
            ))),
        };

    match result {
        Ok(output) => println!("{output}"),
        Err(error) => {
            eprintln!("{error}");
            process::exit(error.exit_code);
        }
    }
}

fn run_cli<I, S>(args: I) -> Result<String, CliError>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let args = args.into_iter().map(Into::into).collect::<Vec<_>>();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| runtime_error(error.to_string()))?;
    run_cli_with_runtime(args, runtime.handle().clone())
}

fn run_cli_with_runtime(
    args: Vec<String>,
    runtime_handle: tokio::runtime::Handle,
) -> Result<String, CliError> {
    let options = parse_daemon_control_args(&args)?;

    match options.command {
        DaemonControlCommand::Caches => {
            let diagnostics = inspect_caches(&options)?;
            serde_json::to_string_pretty(&diagnostics)
                .map_err(|error| runtime_error(error.to_string()))
        }
        DaemonControlCommand::Diagnostics => {
            let diagnostics = inspect_daemon_diagnostics(DaemonDiagnosticsInput {
                daemon_dir: &options.daemon_dir,
                inspected_at: options.inspected_at,
                worker_runtime_state: None,
            })
            .map_err(|error| runtime_error(error.to_string()))?;
            serde_json::to_string_pretty(&diagnostics)
                .map_err(|error| runtime_error(error.to_string()))
        }
        DaemonControlCommand::BackendEventsPlan => {
            let diagnostics = inspect_backend_events_plan(&options)?;
            serde_json::to_string_pretty(&diagnostics)
                .map_err(|error| runtime_error(error.to_string()))
        }
        DaemonControlCommand::BackendEventsEnqueueStatus => {
            let diagnostics = enqueue_backend_events_status(&options)?;
            serde_json::to_string_pretty(&diagnostics)
                .map_err(|error| runtime_error(error.to_string()))
        }
        DaemonControlCommand::BackendEventsEnqueueProjectStatus => {
            let diagnostics = enqueue_backend_events_project_status(&options)?;
            serde_json::to_string_pretty(&diagnostics)
                .map_err(|error| runtime_error(error.to_string()))
        }
        DaemonControlCommand::BackendEventsPeriodicTick => {
            let diagnostics = run_backend_events_periodic_tick(&options)?;
            serde_json::to_string_pretty(&diagnostics)
                .map_err(|error| runtime_error(error.to_string()))
        }
        DaemonControlCommand::DaemonMaintenance => {
            let diagnostics = run_daemon_maintenance(&options)?;
            serde_json::to_string_pretty(&diagnostics)
                .map_err(|error| runtime_error(error.to_string()))
        }
        DaemonControlCommand::DaemonForeground => {
            let diagnostics = run_daemon_foreground(&options, &runtime_handle)?;
            serde_json::to_string_pretty(&diagnostics)
                .map_err(|error| runtime_error(error.to_string()))
        }
        DaemonControlCommand::NostrSubscriptionPlan => {
            let diagnostics = inspect_nostr_subscription_plan(&options)?;
            serde_json::to_string_pretty(&diagnostics)
                .map_err(|error| runtime_error(error.to_string()))
        }
        DaemonControlCommand::Readiness => serde_json::to_string_pretty(
            &inspect_daemon_readiness(&options.tenex_base_dir)
                .map_err(|error| runtime_error(error.to_string()))?,
        )
        .map_err(|error| runtime_error(error.to_string())),
        DaemonControlCommand::SchedulerWakeups => serde_json::to_string_pretty(
            &inspect_scheduler_wakeups(&options.daemon_dir, options.inspected_at)
                .map_err(|error| runtime_error(error.to_string()))?,
        )
        .map_err(|error| runtime_error(error.to_string())),
        DaemonControlCommand::SchedulerWakeupsMaintain => serde_json::to_string_pretty(
            &run_scheduler_maintenance(&options.daemon_dir, options.inspected_at)
                .map_err(|error| runtime_error(error.to_string()))?,
        )
        .map_err(|error| runtime_error(error.to_string())),
        DaemonControlCommand::Status => serde_json::to_string_pretty(
            &inspect_daemon_control(&DaemonShell::new(&options.daemon_dir))
                .map_err(|error| runtime_error(error.to_string()))?,
        )
        .map_err(|error| runtime_error(error.to_string())),
        DaemonControlCommand::StartPlan => {
            let lock_state = DaemonShell::new(&options.daemon_dir)
                .inspect_lock()
                .map_err(|error| runtime_error(error.to_string()))?;
            serde_json::to_string_pretty(&plan_daemon_start(&lock_state))
                .map_err(|error| runtime_error(error.to_string()))
        }
        DaemonControlCommand::StopPlan => {
            let shell = DaemonShell::new(&options.daemon_dir);
            let lock_state = shell
                .inspect_lock()
                .map_err(|error| runtime_error(error.to_string()))?;
            let status_snapshot = shell.status_snapshot();
            serde_json::to_string_pretty(&plan_daemon_stop(&lock_state, &status_snapshot))
                .map_err(|error| runtime_error(error.to_string()))
        }
        DaemonControlCommand::RestartState => serde_json::to_string_pretty(
            &read_daemon_restart_state_compatibility(&DaemonShell::new(&options.daemon_dir))
                .map_err(|error| runtime_error(error.to_string()))?,
        )
        .map_err(|error| runtime_error(error.to_string())),
    }
}

fn inspect_caches(options: &DaemonControlCliOptions) -> Result<CachesDiagnostics, CliError> {
    Ok(CachesDiagnostics {
        schema_version: CACHES_DIAGNOSTICS_SCHEMA_VERSION,
        inspected_at: options.inspected_at,
        trust_pubkeys: inspect_trust_pubkeys(&options.daemon_dir, options.inspected_at)
            .map_err(|error| runtime_error(error.to_string()))?,
        prefix_lookup: inspect_prefix_lookup(&options.daemon_dir, options.inspected_at)
            .map_err(|error| runtime_error(error.to_string()))?,
        profile_names: inspect_profile_names(&options.daemon_dir, options.inspected_at)
            .map_err(|error| runtime_error(error.to_string()))?,
    })
}

fn inspect_nostr_subscription_plan(
    options: &DaemonControlCliOptions,
) -> Result<NostrSubscriptionPlanDiagnostics, CliError> {
    let project_event_index = std::sync::Arc::new(std::sync::Mutex::new(ProjectEventIndex::new()));
    let plan = build_nostr_subscription_plan(NostrSubscriptionPlanInput {
        tenex_base_dir: &options.tenex_base_dir,
        since: options.since,
        lesson_definition_ids: &options.lesson_definition_ids,
        project_event_index: &project_event_index,
        persisted_whitelist: &[],
    })
    .map_err(|error| runtime_error(error.to_string()))?;

    Ok(NostrSubscriptionPlanDiagnostics {
        schema_version: 1,
        inspected_at: options.inspected_at,
        tenex_base_dir: options.tenex_base_dir.clone(),
        plan,
    })
}

fn run_backend_events_periodic_tick(
    options: &DaemonControlCliOptions,
) -> Result<BackendEventsPeriodicTickDiagnostics, CliError> {
    let accepted_at = options.accepted_at.unwrap_or(options.inspected_at);
    let request_timestamp = options.request_timestamp.unwrap_or(accepted_at);
    let now = options.created_at.unwrap_or(accepted_at / 1_000);
    let first_due_at = options.first_due_at.unwrap_or(now);

    if options.discover_projects
        && (options.project_owner_pubkey.is_some()
            || options.project_d_tag.is_some()
            || options.project_manager_pubkey.is_some()
            || !options.worktrees.is_empty())
    {
        return Err(usage_error(
            "--discover-projects cannot be combined with explicit project options",
        ));
    }

    let project_descriptor_report: Option<ProjectStatusDescriptorReport> =
        if options.discover_projects {
            let config = read_backend_config(&options.tenex_base_dir)
                .map_err(|error| runtime_error(error.to_string()))?;
            let projects_base = config
                .projects_base
                .as_deref()
                .unwrap_or("/tmp/tenex-projects");
            Some(ProjectEventIndex::new().descriptors_report(projects_base))
        } else {
            None
        };
    let discovered_projects = project_descriptor_report
        .as_ref()
        .map(|report| {
            report
                .descriptors
                .iter()
                .map(|descriptor| BackendEventsTickProject {
                    project_owner_pubkey: &descriptor.project_owner_pubkey,
                    project_d_tag: &descriptor.project_d_tag,
                    project_manager_pubkey: descriptor.project_manager_pubkey.as_deref(),
                    project_base_path: descriptor.project_base_path.as_deref().map(Path::new),
                    worktrees: None,
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let explicit_project = if options.discover_projects {
        None
    } else {
        match (
            options.project_owner_pubkey.as_deref(),
            options.project_d_tag.as_deref(),
        ) {
            (Some(project_owner_pubkey), Some(project_d_tag)) => Some(BackendEventsTickProject {
                project_owner_pubkey,
                project_d_tag,
                project_manager_pubkey: options.project_manager_pubkey.as_deref(),
                project_base_path: None,
                worktrees: Some(&options.worktrees),
            }),
            (None, None)
                if options.project_manager_pubkey.is_some() || !options.worktrees.is_empty() =>
            {
                return Err(usage_error(
                    "--project-owner-pubkey and --project-d-tag are required when project-specific options are set",
                ));
            }
            (None, None) => None,
            _ => {
                return Err(usage_error(
                    "--project-owner-pubkey and --project-d-tag must be provided together",
                ));
            }
        }
    };
    let projects = if options.discover_projects {
        discovered_projects.as_slice()
    } else {
        explicit_project.as_slice()
    };
    let maintenance = maintain_backend_events_from_filesystem(BackendEventsMaintenanceInput {
        tenex_base_dir: &options.tenex_base_dir,
        daemon_dir: &options.daemon_dir,
        now,
        first_due_at,
        accepted_at,
        request_timestamp,
        projects,
    })
    .map_err(|error| runtime_error(error.to_string()))?;

    Ok(BackendEventsPeriodicTickDiagnostics {
        schema_version: 1,
        maintenance,
        project_descriptor_report,
    })
}

fn run_daemon_maintenance(
    options: &DaemonControlCliOptions,
) -> Result<DaemonMaintenanceDiagnostics, CliError> {
    let project_event_index = std::sync::Arc::new(std::sync::Mutex::new(ProjectEventIndex::new()));
    let diagnostics = run_daemon_maintenance_once_from_filesystem(DaemonMaintenanceInput {
        tenex_base_dir: &options.tenex_base_dir,
        daemon_dir: &options.daemon_dir,
        now_ms: options.inspected_at,
        project_boot_state: tenex_daemon::project_boot_state::empty_booted_projects_state(),
        project_event_index,
        heartbeat_latch: None,
    })
    .map_err(|error| runtime_error(error.to_string()))?;

    Ok(DaemonMaintenanceDiagnostics {
        schema_version: 1,
        maintenance: diagnostics,
    })
}

fn run_daemon_foreground(
    options: &DaemonControlCliOptions,
    runtime_handle: &tokio::runtime::Handle,
) -> Result<DaemonForegroundDiagnostics, CliError> {
    let iterations = options
        .iterations
        .ok_or_else(|| usage_error("--iterations is required"))?;
    if iterations == 0 {
        return Err(usage_error("--iterations must be greater than 0"));
    }

    let config = read_backend_config(&options.tenex_base_dir)
        .map_err(|error| runtime_error(error.to_string()))?;
    let relay_config = RelayPublisherConfig::new(
        config.effective_relay_urls(),
        Duration::from_millis(DEFAULT_FOREGROUND_RELAY_TIMEOUT_MS),
    )
    .map_err(|error| runtime_error(error.to_string()))?;
    let publisher = std::sync::Arc::new(std::sync::Mutex::new(
        NostrRelayPublisher::spawn_on_runtime(relay_config, runtime_handle.clone())
            .map_err(|error| runtime_error(error.to_string()))?,
    ));
    let shell = DaemonShell::new(&options.daemon_dir);
    let mut clock = SystemDaemonMaintenanceLoopClock;
    let mut sleeper = ThreadDaemonMaintenanceLoopSleeper;
    let project_event_index = std::sync::Arc::new(std::sync::Mutex::new(ProjectEventIndex::new()));
    let report = run_daemon_foreground_from_filesystem(
        &shell,
        DaemonForegroundInput {
            tenex_base_dir: &options.tenex_base_dir,
            max_iterations: iterations,
            sleep_ms: options.sleep_ms,
            retry_policy: PublishOutboxRetryPolicy::default(),
            project_boot_state: std::sync::Arc::new(std::sync::Mutex::new(
                tenex_daemon::project_boot_state::ProjectBootState::new(),
            )),
            project_event_index,
            heartbeat_latch: None,
        },
        &mut clock,
        &mut sleeper,
        &publisher,
    )
    .map_err(|error| runtime_error(error.to_string()))?;
    let stopped_at = current_unix_time_ms();
    let steps = report
        .tick_loop
        .steps
        .into_iter()
        .map(|step| DaemonForegroundStepDiagnostics {
            iteration_index: step.iteration_index,
            now_ms: step.now_ms,
            tick: DaemonForegroundTickDiagnostics {
                maintenance: step.maintenance_outcome.maintenance,
                publish_outbox: step.maintenance_outcome.publish_outbox,
            },
            sleep_after_ms: step.sleep_after_ms,
        })
        .collect();

    Ok(DaemonForegroundDiagnostics {
        schema_version: DAEMON_FOREGROUND_DIAGNOSTICS_SCHEMA_VERSION,
        tenex_base_dir: report.tenex_base_dir,
        daemon_dir: report.daemon_dir,
        started_at: report.started_at_ms,
        stopped_at,
        iterations,
        sleep_ms: options.sleep_ms,
        steps,
    })
}

fn enqueue_backend_events_project_status(
    options: &DaemonControlCliOptions,
) -> Result<BackendEventsEnqueueProjectStatusDiagnostics, CliError> {
    let accepted_at = options.accepted_at.unwrap_or(options.inspected_at);
    let request_timestamp = options.request_timestamp.unwrap_or(accepted_at);
    let created_at = options.created_at.unwrap_or(accepted_at / 1_000);
    let project_owner_pubkey = options
        .project_owner_pubkey
        .as_deref()
        .ok_or_else(|| usage_error("--project-owner-pubkey is required"))?;
    let project_d_tag = options
        .project_d_tag
        .as_deref()
        .ok_or_else(|| usage_error("--project-d-tag is required"))?;

    let outcome = publish_project_status_from_filesystem(ProjectStatusRuntimeInput {
        tenex_base_dir: &options.tenex_base_dir,
        daemon_dir: &options.daemon_dir,
        created_at,
        accepted_at,
        request_timestamp,
        project_owner_pubkey,
        project_d_tag,
        project_manager_pubkey: options.project_manager_pubkey.as_deref(),
        project_base_path: None,
        agents: None,
        worktrees: Some(&options.worktrees),
    })
    .map_err(|error| runtime_error(error.to_string()))?;
    let publish_outbox_after = inspect_publish_outbox(&options.daemon_dir, accepted_at)
        .map_err(|error| runtime_error(error.to_string()))?;

    Ok(BackendEventsEnqueueProjectStatusDiagnostics {
        schema_version: 1,
        tenex_base_dir: options.tenex_base_dir.clone(),
        daemon_dir: options.daemon_dir.clone(),
        created_at,
        accepted_at,
        request_timestamp,
        project_owner_pubkey: project_owner_pubkey.to_string(),
        project_d_tag: project_d_tag.to_string(),
        backend_pubkey: outcome.project_status.record.event.pubkey.clone(),
        owner_pubkey_count: outcome.config.whitelisted_pubkeys.len(),
        active_agent_count: outcome.agent_inventory.active_agents.len(),
        scheduled_task_count: outcome.scheduled_tasks.len(),
        worktree_count: outcome.snapshot.worktrees.len(),
        project_status_event_id: outcome.project_status.record.event.id,
        publish_outbox_after,
    })
}

fn enqueue_backend_events_status(
    options: &DaemonControlCliOptions,
) -> Result<BackendEventsEnqueueStatusDiagnostics, CliError> {
    let accepted_at = options.accepted_at.unwrap_or(options.inspected_at);
    let request_timestamp = options.request_timestamp.unwrap_or(accepted_at);
    let created_at = options.created_at.unwrap_or(accepted_at / 1_000);
    let input = BackendStatusRuntimeInput::new(
        &options.tenex_base_dir,
        &options.daemon_dir,
        created_at,
        accepted_at,
        request_timestamp,
    );
    let outcome = publish_backend_status_from_filesystem(input)
        .map_err(|error| runtime_error(error.to_string()))?;
    let publish_outbox_after = inspect_publish_outbox(&options.daemon_dir, accepted_at)
        .map_err(|error| runtime_error(error.to_string()))?;

    let heartbeat = outcome
        .heartbeat
        .expect("daemon-control always publishes heartbeat (no latch configured)");
    Ok(BackendEventsEnqueueStatusDiagnostics {
        schema_version: 1,
        tenex_base_dir: options.tenex_base_dir.clone(),
        daemon_dir: options.daemon_dir.clone(),
        created_at,
        accepted_at,
        request_timestamp,
        backend_pubkey: heartbeat.record.event.pubkey.clone(),
        owner_pubkey_count: outcome.config.whitelisted_pubkeys.len(),
        relay_url_count: outcome.config.effective_relay_urls().len(),
        active_agent_count: outcome.agent_inventory.active_agents.len(),
        skipped_agent_file_count: outcome.agent_inventory.skipped_files.len(),
        heartbeat_event_id: heartbeat.record.event.id,
        agent_config_event_ids: outcome
            .agent_configs
            .into_iter()
            .map(|p| p.record.event.id)
            .collect(),
        publish_outbox_after,
    })
}

fn inspect_backend_events_plan(
    options: &DaemonControlCliOptions,
) -> Result<BackendEventsPlanDiagnostics, CliError> {
    let publish_outbox = inspect_publish_outbox(&options.daemon_dir, options.inspected_at)
        .map_err(|error| runtime_error(error.to_string()))?;

    Ok(BackendEventsPlanDiagnostics {
        schema_version: 1,
        inspected_at: options.inspected_at,
        publish_outbox,
        status_publisher_readiness: inspect_backend_status_publisher_readiness(
            &options.tenex_base_dir,
        ),
    })
}

fn inspect_backend_status_publisher_readiness(
    tenex_base_dir: &Path,
) -> BackendEventsStatusPublisherReadiness {
    let config = match read_backend_config(tenex_base_dir) {
        Ok(config) => config,
        Err(error) => {
            return backend_status_unready(
                tenex_base_dir,
                format!("backend config unavailable: {error}"),
                None,
                0,
                0,
                None,
                None,
            );
        }
    };

    let owner_pubkey_count = config.whitelisted_pubkeys.len();
    let relay_url_count = config.effective_relay_urls().len();
    let signer = match config.backend_signer() {
        Ok(signer) => signer,
        Err(error) => {
            return backend_status_unready(
                tenex_base_dir,
                format!("backend signer unavailable: {error}"),
                None,
                owner_pubkey_count,
                relay_url_count,
                None,
                None,
            );
        }
    };

    if config.whitelisted_pubkeys.is_empty() {
        return backend_status_unready(
            tenex_base_dir,
            "no whitelistedPubkeys configured".to_string(),
            Some(signer.pubkey_hex().to_string()),
            owner_pubkey_count,
            relay_url_count,
            None,
            None,
        );
    }

    match read_installed_agent_inventory(agents_dir(tenex_base_dir)) {
        Ok(report) => BackendEventsStatusPublisherReadiness {
            kind: "backend-status",
            ready: true,
            reason: "ready".to_string(),
            tenex_base_dir: tenex_base_dir.to_path_buf(),
            backend_pubkey: Some(signer.pubkey_hex().to_string()),
            owner_pubkey_count,
            relay_url_count,
            active_agent_count: Some(report.active_agents.len()),
            skipped_agent_file_count: Some(report.skipped_files.len()),
        },
        Err(error) => backend_status_unready(
            tenex_base_dir,
            format!("agent inventory unavailable: {error}"),
            Some(signer.pubkey_hex().to_string()),
            owner_pubkey_count,
            relay_url_count,
            None,
            None,
        ),
    }
}

fn backend_status_unready(
    tenex_base_dir: &Path,
    reason: String,
    backend_pubkey: Option<String>,
    owner_pubkey_count: usize,
    relay_url_count: usize,
    active_agent_count: Option<usize>,
    skipped_agent_file_count: Option<usize>,
) -> BackendEventsStatusPublisherReadiness {
    BackendEventsStatusPublisherReadiness {
        kind: "backend-status",
        ready: false,
        reason,
        tenex_base_dir: tenex_base_dir.to_path_buf(),
        backend_pubkey,
        owner_pubkey_count,
        relay_url_count,
        active_agent_count,
        skipped_agent_file_count,
    }
}

fn parse_daemon_control_args(args: &[String]) -> Result<DaemonControlCliOptions, CliError> {
    let command = match args.first().map(String::as_str) {
        Some("caches") => DaemonControlCommand::Caches,
        Some("diagnostics") => DaemonControlCommand::Diagnostics,
        Some("backend-events-plan") => DaemonControlCommand::BackendEventsPlan,
        Some("backend-events-enqueue-status") => DaemonControlCommand::BackendEventsEnqueueStatus,
        Some("backend-events-enqueue-project-status") => {
            DaemonControlCommand::BackendEventsEnqueueProjectStatus
        }
        Some("backend-events-periodic-tick") => DaemonControlCommand::BackendEventsPeriodicTick,
        Some("daemon-maintenance") => DaemonControlCommand::DaemonMaintenance,
        Some("daemon-foreground") => DaemonControlCommand::DaemonForeground,
        Some("nostr-subscription-plan") => DaemonControlCommand::NostrSubscriptionPlan,
        Some("readiness") => DaemonControlCommand::Readiness,
        Some("scheduler-wakeups") => DaemonControlCommand::SchedulerWakeups,
        Some("scheduler-wakeups-maintain") => DaemonControlCommand::SchedulerWakeupsMaintain,
        Some("status") => DaemonControlCommand::Status,
        Some("start-plan") => DaemonControlCommand::StartPlan,
        Some("stop-plan") => DaemonControlCommand::StopPlan,
        Some("restart-state") => DaemonControlCommand::RestartState,
        Some("help" | "--help" | "-h") | None => return Err(usage_error(usage())),
        Some(command) => {
            return Err(usage_error(format!(
                "unknown daemon-control command: {command}\n\n{}",
                usage()
            )));
        }
    };

    let mut daemon_dir = None;
    let mut tenex_base_dir = None;
    let mut inspected_at = None;
    let mut created_at = None;
    let mut accepted_at = None;
    let mut request_timestamp = None;
    let mut first_due_at = None;
    let mut iterations = None;
    let mut sleep_ms = 0;
    let mut project_owner_pubkey = None;
    let mut project_d_tag = None;
    let mut project_manager_pubkey = None;
    let mut worktrees = Vec::new();
    let mut discover_projects = false;
    let mut since = None;
    let mut lesson_definition_ids = Vec::new();
    let mut index = 1;

    while index < args.len() {
        match args[index].as_str() {
            "--daemon-dir" => {
                index += 1;
                let value = args
                    .get(index)
                    .ok_or_else(|| usage_error("--daemon-dir requires a value"))?;
                daemon_dir = Some(PathBuf::from(value));
            }
            "--tenex-base-dir" => {
                index += 1;
                let value = args
                    .get(index)
                    .ok_or_else(|| usage_error("--tenex-base-dir requires a value"))?;
                tenex_base_dir = Some(PathBuf::from(value));
            }
            "--inspected-at" => {
                index += 1;
                let value = args
                    .get(index)
                    .ok_or_else(|| usage_error("--inspected-at requires a value"))?;
                inspected_at = Some(parse_u64_arg("--inspected-at", value)?);
            }
            "--created-at" => {
                index += 1;
                let value = args
                    .get(index)
                    .ok_or_else(|| usage_error("--created-at requires a value"))?;
                created_at = Some(parse_u64_arg("--created-at", value)?);
            }
            "--accepted-at" => {
                index += 1;
                let value = args
                    .get(index)
                    .ok_or_else(|| usage_error("--accepted-at requires a value"))?;
                accepted_at = Some(parse_u64_arg("--accepted-at", value)?);
            }
            "--request-timestamp" => {
                index += 1;
                let value = args
                    .get(index)
                    .ok_or_else(|| usage_error("--request-timestamp requires a value"))?;
                request_timestamp = Some(parse_u64_arg("--request-timestamp", value)?);
            }
            "--first-due-at" => {
                index += 1;
                let value = args
                    .get(index)
                    .ok_or_else(|| usage_error("--first-due-at requires a value"))?;
                first_due_at = Some(parse_u64_arg("--first-due-at", value)?);
            }
            "--iterations" => {
                index += 1;
                let value = args
                    .get(index)
                    .ok_or_else(|| usage_error("--iterations requires a value"))?;
                iterations = Some(parse_u64_arg("--iterations", value)?);
            }
            "--sleep-ms" => {
                index += 1;
                let value = args
                    .get(index)
                    .ok_or_else(|| usage_error("--sleep-ms requires a value"))?;
                sleep_ms = parse_u64_arg("--sleep-ms", value)?;
            }
            "--project-owner-pubkey" => {
                index += 1;
                let value = args
                    .get(index)
                    .ok_or_else(|| usage_error("--project-owner-pubkey requires a value"))?;
                project_owner_pubkey = Some(value.clone());
            }
            "--project-d-tag" => {
                index += 1;
                let value = args
                    .get(index)
                    .ok_or_else(|| usage_error("--project-d-tag requires a value"))?;
                project_d_tag = Some(value.clone());
            }
            "--project-manager-pubkey" => {
                index += 1;
                let value = args
                    .get(index)
                    .ok_or_else(|| usage_error("--project-manager-pubkey requires a value"))?;
                project_manager_pubkey = Some(value.clone());
            }
            "--worktree" => {
                index += 1;
                let value = args
                    .get(index)
                    .ok_or_else(|| usage_error("--worktree requires a value"))?;
                worktrees.push(value.clone());
            }
            "--discover-projects" => {
                discover_projects = true;
            }
            "--since" => {
                index += 1;
                let value = args
                    .get(index)
                    .ok_or_else(|| usage_error("--since requires a value"))?;
                since = Some(parse_u64_arg("--since", value)?);
            }
            "--lesson-definition-id" => {
                index += 1;
                let value = args
                    .get(index)
                    .ok_or_else(|| usage_error("--lesson-definition-id requires a value"))?;
                lesson_definition_ids.push(value.clone());
            }
            "--help" | "-h" => return Err(usage_error(usage())),
            argument => {
                return Err(usage_error(format!(
                    "unknown argument: {argument}\n\n{}",
                    usage()
                )));
            }
        }
        index += 1;
    }

    let daemon_dir = match daemon_dir {
        Some(daemon_dir) => daemon_dir,
        None if command == DaemonControlCommand::Readiness
            || command == DaemonControlCommand::DaemonMaintenance
            || command == DaemonControlCommand::DaemonForeground
            || command == DaemonControlCommand::NostrSubscriptionPlan =>
        {
            tenex_base_dir
                .as_ref()
                .map(|base_dir| base_dir.join("daemon"))
                .ok_or_else(|| usage_error("--daemon-dir or --tenex-base-dir is required"))?
        }
        None => return Err(usage_error("--daemon-dir is required")),
    };
    let tenex_base_dir = tenex_base_dir.unwrap_or_else(|| infer_tenex_base_dir(&daemon_dir));

    Ok(DaemonControlCliOptions {
        command,
        daemon_dir,
        tenex_base_dir,
        inspected_at: inspected_at.unwrap_or_else(current_unix_time_ms),
        created_at,
        accepted_at,
        request_timestamp,
        first_due_at,
        iterations,
        sleep_ms,
        project_owner_pubkey,
        project_d_tag,
        project_manager_pubkey,
        worktrees,
        discover_projects,
        since,
        lesson_definition_ids,
    })
}

fn infer_tenex_base_dir(daemon_dir: &Path) -> PathBuf {
    if daemon_dir.file_name().and_then(|name| name.to_str()) == Some("daemon") {
        return daemon_dir
            .parent()
            .map(PathBuf::from)
            .unwrap_or_else(|| daemon_dir.to_path_buf());
    }

    daemon_dir.to_path_buf()
}

fn parse_u64_arg(name: &str, value: &str) -> Result<u64, CliError> {
    value
        .parse::<u64>()
        .map_err(|_| usage_error(format!("{name} must be an unsigned integer")))
}

fn current_unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time must be after UNIX_EPOCH")
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

fn usage() -> String {
    [
        "usage:",
        "  daemon-control caches --daemon-dir <path> [--inspected-at <ms>]",
        "  daemon-control diagnostics --daemon-dir <path> [--inspected-at <ms>]",
        "  daemon-control backend-events-plan --daemon-dir <path> [--tenex-base-dir <path>] [--inspected-at <ms>]",
        "  daemon-control backend-events-enqueue-status --daemon-dir <path> [--tenex-base-dir <path>] [--created-at <s>] [--accepted-at <ms>] [--request-timestamp <ms>]",
        "  daemon-control backend-events-enqueue-project-status --daemon-dir <path> [--tenex-base-dir <path>] --project-owner-pubkey <hex> --project-d-tag <d> [--project-manager-pubkey <hex>] [--worktree <branch>] [--created-at <s>] [--accepted-at <ms>] [--request-timestamp <ms>]",
        "  daemon-control backend-events-periodic-tick --daemon-dir <path> [--tenex-base-dir <path>] [--discover-projects | --project-owner-pubkey <hex> --project-d-tag <d>] [--project-manager-pubkey <hex>] [--worktree <branch>] [--first-due-at <s>] [--created-at <s>] [--accepted-at <ms>] [--request-timestamp <ms>]",
        "  daemon-control daemon-maintenance [--daemon-dir <path> | --tenex-base-dir <path>] [--inspected-at <ms>]",
        "  daemon-control daemon-foreground [--daemon-dir <path> | --tenex-base-dir <path>] --iterations <count> [--sleep-ms <ms>]",
        "  daemon-control nostr-subscription-plan [--daemon-dir <path> | --tenex-base-dir <path>] [--since <s>] [--lesson-definition-id <event-id>]...",
        "  daemon-control readiness [--daemon-dir <path> | --tenex-base-dir <path>]",
        "  daemon-control scheduler-wakeups --daemon-dir <path> [--inspected-at <ms>]",
        "  daemon-control scheduler-wakeups-maintain --daemon-dir <path> [--inspected-at <ms>]",
        "  daemon-control status --daemon-dir <path>",
        "  daemon-control start-plan --daemon-dir <path>",
        "  daemon-control stop-plan --daemon-dir <path>",
        "  daemon-control restart-state --daemon-dir <path>",
    ]
    .join("\n")
}

fn usage_error(message: impl Into<String>) -> CliError {
    CliError {
        message: message.into(),
        exit_code: USAGE_EXIT_CODE,
    }
}

fn runtime_error(message: impl Into<String>) -> CliError {
    CliError {
        message: message.into(),
        exit_code: RUNTIME_EXIT_CODE,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use secp256k1::{Keypair, Secp256k1, SecretKey};
    use serde_json::{Value, json};
    use std::collections::BTreeMap;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    use tenex_daemon::caches::CACHES_WRITER;
    use tenex_daemon::caches::prefix_lookup::{PrefixLookupSnapshot, write_prefix_lookup};
    use tenex_daemon::caches::profile_names::{
        ProfileNameEntry, ProfileNamesSnapshot, write_profile_names,
    };
    use tenex_daemon::caches::trust_pubkeys::{TrustPubkeysSnapshot, write_trust_pubkeys};
    use tenex_daemon::filesystem_state::{
        build_lock_info, build_restart_state, save_restart_state_file, write_lock_info_file,
    };
    use tenex_daemon::scheduler_wakeups::{
        WakeupEnqueueRequest, WakeupFailureClassification, WakeupRetryPolicy, WakeupTarget,
        enqueue_wakeup, mark_wakeup_failed,
    };

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);
    const TEST_SECRET_KEY_HEX: &str =
        "0101010101010101010101010101010101010101010101010101010101010101";
    const TEST_BACKEND_PUBKEY_HEX: &str =
        "1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f";

    #[test]
    fn parses_caches_args() {
        let options = parse_daemon_control_args(&[
            "caches".to_string(),
            "--daemon-dir".to_string(),
            "/tmp/tenex-daemon".to_string(),
            "--inspected-at".to_string(),
            "1710001000000".to_string(),
        ])
        .expect("caches args must parse");

        assert_eq!(options.command, DaemonControlCommand::Caches);
        assert_eq!(options.daemon_dir, PathBuf::from("/tmp/tenex-daemon"));
        assert_eq!(options.inspected_at, 1710001000000);
    }

    #[test]
    fn parses_diagnostics_args() {
        let options = parse_daemon_control_args(&[
            "diagnostics".to_string(),
            "--daemon-dir".to_string(),
            "/tmp/tenex-daemon".to_string(),
            "--inspected-at".to_string(),
            "1710001000000".to_string(),
        ])
        .expect("diagnostics args must parse");

        assert_eq!(options.command, DaemonControlCommand::Diagnostics);
        assert_eq!(options.daemon_dir, PathBuf::from("/tmp/tenex-daemon"));
        assert_eq!(options.inspected_at, 1710001000000);
    }

    #[test]
    fn parses_backend_events_plan_args() {
        let options = parse_daemon_control_args(&[
            "backend-events-plan".to_string(),
            "--daemon-dir".to_string(),
            "/tmp/tenex-daemon".to_string(),
            "--inspected-at".to_string(),
            "1710001000000".to_string(),
        ])
        .expect("backend-events-plan args must parse");

        assert_eq!(options.command, DaemonControlCommand::BackendEventsPlan);
        assert_eq!(options.daemon_dir, PathBuf::from("/tmp/tenex-daemon"));
        assert_eq!(options.inspected_at, 1710001000000);
    }

    #[test]
    fn parses_backend_events_enqueue_status_args() {
        let options = parse_daemon_control_args(&[
            "backend-events-enqueue-status".to_string(),
            "--daemon-dir".to_string(),
            "/tmp/tenex-daemon".to_string(),
            "--tenex-base-dir".to_string(),
            "/tmp/tenex".to_string(),
            "--created-at".to_string(),
            "1710001000".to_string(),
            "--accepted-at".to_string(),
            "1710001000100".to_string(),
            "--request-timestamp".to_string(),
            "1710001000050".to_string(),
        ])
        .expect("backend-events-enqueue-status args must parse");

        assert_eq!(
            options.command,
            DaemonControlCommand::BackendEventsEnqueueStatus
        );
        assert_eq!(options.daemon_dir, PathBuf::from("/tmp/tenex-daemon"));
        assert_eq!(options.tenex_base_dir, PathBuf::from("/tmp/tenex"));
        assert_eq!(options.created_at, Some(1_710_001_000));
        assert_eq!(options.accepted_at, Some(1_710_001_000_100));
        assert_eq!(options.request_timestamp, Some(1_710_001_000_050));
    }

    #[test]
    fn parses_backend_events_enqueue_project_status_args() {
        let options = parse_daemon_control_args(&[
            "backend-events-enqueue-project-status".to_string(),
            "--daemon-dir".to_string(),
            "/tmp/tenex-daemon".to_string(),
            "--tenex-base-dir".to_string(),
            "/tmp/tenex".to_string(),
            "--project-owner-pubkey".to_string(),
            xonly_pubkey_hex(0x02),
            "--project-d-tag".to_string(),
            "demo-project".to_string(),
            "--project-manager-pubkey".to_string(),
            xonly_pubkey_hex(0x03),
            "--worktree".to_string(),
            "main".to_string(),
            "--worktree".to_string(),
            "feature/rust".to_string(),
            "--created-at".to_string(),
            "1710001000".to_string(),
            "--accepted-at".to_string(),
            "1710001000100".to_string(),
            "--request-timestamp".to_string(),
            "1710001000050".to_string(),
        ])
        .expect("backend-events-enqueue-project-status args must parse");

        assert_eq!(
            options.command,
            DaemonControlCommand::BackendEventsEnqueueProjectStatus
        );
        assert_eq!(options.daemon_dir, PathBuf::from("/tmp/tenex-daemon"));
        assert_eq!(options.tenex_base_dir, PathBuf::from("/tmp/tenex"));
        assert_eq!(options.project_d_tag.as_deref(), Some("demo-project"));
        assert_eq!(
            options.worktrees,
            vec!["main".to_string(), "feature/rust".to_string()]
        );
        assert_eq!(options.created_at, Some(1_710_001_000));
        assert_eq!(options.accepted_at, Some(1_710_001_000_100));
        assert_eq!(options.request_timestamp, Some(1_710_001_000_050));
    }

    #[test]
    fn parses_backend_events_periodic_tick_args() {
        let options = parse_daemon_control_args(&[
            "backend-events-periodic-tick".to_string(),
            "--daemon-dir".to_string(),
            "/tmp/tenex-daemon".to_string(),
            "--tenex-base-dir".to_string(),
            "/tmp/tenex".to_string(),
            "--project-owner-pubkey".to_string(),
            xonly_pubkey_hex(0x0a),
            "--project-d-tag".to_string(),
            "demo-project".to_string(),
            "--first-due-at".to_string(),
            "1710000990".to_string(),
            "--created-at".to_string(),
            "1710001000".to_string(),
            "--accepted-at".to_string(),
            "1710001000100".to_string(),
            "--request-timestamp".to_string(),
            "1710001000050".to_string(),
        ])
        .expect("backend-events-periodic-tick args must parse");

        assert_eq!(
            options.command,
            DaemonControlCommand::BackendEventsPeriodicTick
        );
        assert_eq!(options.daemon_dir, PathBuf::from("/tmp/tenex-daemon"));
        assert_eq!(options.tenex_base_dir, PathBuf::from("/tmp/tenex"));
        assert_eq!(options.project_d_tag.as_deref(), Some("demo-project"));
        assert_eq!(options.first_due_at, Some(1_710_000_990));
        assert_eq!(options.created_at, Some(1_710_001_000));
        assert_eq!(options.accepted_at, Some(1_710_001_000_100));
        assert_eq!(options.request_timestamp, Some(1_710_001_000_050));
    }

    #[test]
    fn parses_backend_events_periodic_tick_discovery_args() {
        let options = parse_daemon_control_args(&[
            "backend-events-periodic-tick".to_string(),
            "--daemon-dir".to_string(),
            "/tmp/tenex-daemon".to_string(),
            "--tenex-base-dir".to_string(),
            "/tmp/tenex".to_string(),
            "--discover-projects".to_string(),
            "--first-due-at".to_string(),
            "1710000990".to_string(),
        ])
        .expect("backend-events-periodic-tick discovery args must parse");

        assert_eq!(
            options.command,
            DaemonControlCommand::BackendEventsPeriodicTick
        );
        assert_eq!(options.daemon_dir, PathBuf::from("/tmp/tenex-daemon"));
        assert_eq!(options.tenex_base_dir, PathBuf::from("/tmp/tenex"));
        assert!(options.discover_projects);
        assert_eq!(options.first_due_at, Some(1_710_000_990));
    }

    #[test]
    fn parses_daemon_maintenance_args_with_tenex_base_dir_only() {
        let options = parse_daemon_control_args(&[
            "daemon-maintenance".to_string(),
            "--tenex-base-dir".to_string(),
            "/tmp/tenex".to_string(),
            "--inspected-at".to_string(),
            "1710001000000".to_string(),
        ])
        .expect("daemon-maintenance args must parse");

        assert_eq!(options.command, DaemonControlCommand::DaemonMaintenance);
        assert_eq!(options.tenex_base_dir, PathBuf::from("/tmp/tenex"));
        assert_eq!(options.daemon_dir, PathBuf::from("/tmp/tenex/daemon"));
        assert_eq!(options.inspected_at, 1710001000000);
    }

    #[test]
    fn parses_daemon_foreground_args_with_tenex_base_dir_only() {
        let options = parse_daemon_control_args(&[
            "daemon-foreground".to_string(),
            "--tenex-base-dir".to_string(),
            "/tmp/tenex".to_string(),
            "--iterations".to_string(),
            "2".to_string(),
            "--sleep-ms".to_string(),
            "50".to_string(),
        ])
        .expect("daemon-foreground args must parse");

        assert_eq!(options.command, DaemonControlCommand::DaemonForeground);
        assert_eq!(options.tenex_base_dir, PathBuf::from("/tmp/tenex"));
        assert_eq!(options.daemon_dir, PathBuf::from("/tmp/tenex/daemon"));
        assert_eq!(options.iterations, Some(2));
        assert_eq!(options.sleep_ms, 50);
    }

    #[test]
    fn parses_nostr_subscription_plan_args_with_tenex_base_dir_only() {
        let options = parse_daemon_control_args(&[
            "nostr-subscription-plan".to_string(),
            "--tenex-base-dir".to_string(),
            "/tmp/tenex".to_string(),
            "--since".to_string(),
            "1710001000".to_string(),
            "--lesson-definition-id".to_string(),
            "lesson-alpha".to_string(),
            "--lesson-definition-id".to_string(),
            "lesson-beta".to_string(),
        ])
        .expect("nostr-subscription-plan args must parse");

        assert_eq!(options.command, DaemonControlCommand::NostrSubscriptionPlan);
        assert_eq!(options.tenex_base_dir, PathBuf::from("/tmp/tenex"));
        assert_eq!(options.daemon_dir, PathBuf::from("/tmp/tenex/daemon"));
        assert_eq!(options.since, Some(1_710_001_000));
        assert_eq!(
            options.lesson_definition_ids,
            vec!["lesson-alpha".to_string(), "lesson-beta".to_string()]
        );
    }

    #[test]
    fn parses_readiness_args_with_tenex_base_dir_only() {
        let options = parse_daemon_control_args(&[
            "readiness".to_string(),
            "--tenex-base-dir".to_string(),
            "/tmp/tenex".to_string(),
        ])
        .expect("readiness args must parse");

        assert_eq!(options.command, DaemonControlCommand::Readiness);
        assert_eq!(options.tenex_base_dir, PathBuf::from("/tmp/tenex"));
        assert_eq!(options.daemon_dir, PathBuf::from("/tmp/tenex/daemon"));
    }

    #[test]
    fn parses_scheduler_wakeups_args() {
        let options = parse_daemon_control_args(&[
            "scheduler-wakeups".to_string(),
            "--daemon-dir".to_string(),
            "/tmp/tenex-daemon".to_string(),
            "--inspected-at".to_string(),
            "1710001000000".to_string(),
        ])
        .expect("scheduler wakeups args must parse");

        assert_eq!(options.command, DaemonControlCommand::SchedulerWakeups);
        assert_eq!(options.daemon_dir, PathBuf::from("/tmp/tenex-daemon"));
        assert_eq!(options.inspected_at, 1710001000000);
    }

    #[test]
    fn parses_scheduler_wakeups_maintenance_args() {
        let options = parse_daemon_control_args(&[
            "scheduler-wakeups-maintain".to_string(),
            "--daemon-dir".to_string(),
            "/tmp/tenex-daemon".to_string(),
            "--inspected-at".to_string(),
            "1710001000000".to_string(),
        ])
        .expect("scheduler wakeups maintenance args must parse");

        assert_eq!(
            options.command,
            DaemonControlCommand::SchedulerWakeupsMaintain
        );
        assert_eq!(options.daemon_dir, PathBuf::from("/tmp/tenex-daemon"));
        assert_eq!(options.inspected_at, 1710001000000);
    }

    #[test]
    fn parses_status_args() {
        let options = parse_daemon_control_args(&[
            "status".to_string(),
            "--daemon-dir".to_string(),
            "/tmp/tenex-daemon".to_string(),
        ])
        .expect("status args must parse");

        assert_eq!(options.command, DaemonControlCommand::Status);
        assert_eq!(options.daemon_dir, PathBuf::from("/tmp/tenex-daemon"));
    }

    #[test]
    fn parses_start_plan_args() {
        let options = parse_daemon_control_args(&[
            "start-plan".to_string(),
            "--daemon-dir".to_string(),
            "/tmp/tenex-daemon".to_string(),
        ])
        .expect("start-plan args must parse");

        assert_eq!(options.command, DaemonControlCommand::StartPlan);
    }

    #[test]
    fn parses_stop_plan_args() {
        let options = parse_daemon_control_args(&[
            "stop-plan".to_string(),
            "--daemon-dir".to_string(),
            "/tmp/tenex-daemon".to_string(),
        ])
        .expect("stop-plan args must parse");

        assert_eq!(options.command, DaemonControlCommand::StopPlan);
    }

    #[test]
    fn parses_restart_state_args() {
        let options = parse_daemon_control_args(&[
            "restart-state".to_string(),
            "--daemon-dir".to_string(),
            "/tmp/tenex-daemon".to_string(),
        ])
        .expect("restart-state args must parse");

        assert_eq!(options.command, DaemonControlCommand::RestartState);
    }

    #[test]
    fn foreground_command_rejects_missing_iterations() {
        let error = run_cli(["daemon-foreground", "--daemon-dir", "/tmp/tenex-daemon"])
            .expect_err("daemon-foreground without iterations must fail");

        assert_eq!(error.to_string(), "--iterations is required");
        assert_eq!(error.exit_code, USAGE_EXIT_CODE);
    }

    #[test]
    fn help_usage_includes_daemon_foreground_command() {
        let error = run_cli(["help"]).expect_err("help must return usage");

        assert!(
            error
                .to_string()
                .contains("daemon-control daemon-foreground")
        );
        assert!(
            error
                .to_string()
                .contains("daemon-control nostr-subscription-plan")
        );
        assert_eq!(error.exit_code, USAGE_EXIT_CODE);
    }

    #[test]
    fn caches_empty_daemon_outputs_cache_diagnostics_json() {
        let daemon_dir = unique_temp_daemon_dir();
        let output = run_cli([
            "caches",
            "--daemon-dir",
            daemon_dir.to_str().expect("temp path must be utf-8"),
            "--inspected-at",
            "1710001000000",
        ])
        .expect("caches command must succeed");

        let value: Value = serde_json::from_str(&output).expect("output must be json");
        assert_eq!(value["schemaVersion"], json!(1));
        assert_eq!(value["inspectedAt"], json!(1_710_001_000_000u64));
        assert_eq!(
            value["trustPubkeys"]["inspectedAt"],
            json!(1_710_001_000_000u64)
        );
        assert_eq!(value["trustPubkeys"]["present"], json!(false));
        assert_eq!(value["trustPubkeys"]["pubkeyCount"], json!(0));
        assert_eq!(value["prefixLookup"]["present"], json!(false));
        assert_eq!(value["prefixLookup"]["prefixCount"], json!(0));
        assert_eq!(value["profileNames"]["present"], json!(false));
        assert_eq!(value["profileNames"]["entryCount"], json!(0));
        assert_eq!(value["profileNames"]["displayNameCount"], json!(0));
        assert_eq!(value["profileNames"]["nip05Count"], json!(0));

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn caches_populated_daemon_outputs_cache_diagnostics_json() {
        let daemon_dir = unique_temp_daemon_dir();
        let pubkey_one =
            "1111111111111111111111111111111111111111111111111111111111111111".to_string();
        let pubkey_two =
            "2222222222222222222222222222222222222222222222222222222222222222".to_string();
        let pubkey_three =
            "3333333333333333333333333333333333333333333333333333333333333333".to_string();

        write_trust_pubkeys(
            &daemon_dir,
            &TrustPubkeysSnapshot {
                schema_version: 0,
                writer: CACHES_WRITER.to_string(),
                writer_version: "test-version".to_string(),
                updated_at: 1_710_001_000_100,
                pubkeys: vec![pubkey_two.clone(), pubkey_one.clone(), pubkey_three.clone()],
            },
        )
        .expect("trust pubkeys write must succeed");

        let mut prefixes = BTreeMap::new();
        prefixes.insert("111111".to_string(), pubkey_one.clone());
        prefixes.insert("222222".to_string(), pubkey_two.clone());
        write_prefix_lookup(
            &daemon_dir,
            &PrefixLookupSnapshot {
                schema_version: 0,
                writer: CACHES_WRITER.to_string(),
                writer_version: "test-version".to_string(),
                updated_at: 1_710_001_000_200,
                prefixes,
            },
        )
        .expect("prefix lookup write must succeed");

        let mut entries = BTreeMap::new();
        entries.insert(
            pubkey_one,
            ProfileNameEntry {
                display_name: Some("Alice".to_string()),
                nip05: Some("alice@example.test".to_string()),
                observed_at: 1_710_001_000_150,
            },
        );
        entries.insert(
            pubkey_two,
            ProfileNameEntry {
                display_name: Some("Bob".to_string()),
                nip05: None,
                observed_at: 1_710_001_000_180,
            },
        );
        entries.insert(
            pubkey_three,
            ProfileNameEntry {
                display_name: None,
                nip05: Some("carol@example.test".to_string()),
                observed_at: 1_710_001_000_200,
            },
        );
        write_profile_names(
            &daemon_dir,
            &ProfileNamesSnapshot {
                schema_version: 0,
                writer: CACHES_WRITER.to_string(),
                writer_version: "test-version".to_string(),
                updated_at: 1_710_001_000_300,
                entries,
            },
        )
        .expect("profile names write must succeed");

        let output = run_cli([
            "caches",
            "--daemon-dir",
            daemon_dir.to_str().expect("temp path must be utf-8"),
            "--inspected-at",
            "1710001000500",
        ])
        .expect("caches command must succeed");

        let value: Value = serde_json::from_str(&output).expect("output must be json");
        assert_eq!(value["schemaVersion"], json!(1));
        assert_eq!(value["inspectedAt"], json!(1_710_001_000_500u64));
        assert_eq!(value["trustPubkeys"]["present"], json!(true));
        assert_eq!(value["trustPubkeys"]["pubkeyCount"], json!(3));
        assert_eq!(value["trustPubkeys"]["writer"], json!(CACHES_WRITER));
        assert_eq!(
            value["trustPubkeys"]["writerVersion"],
            json!("test-version")
        );
        assert_eq!(
            value["trustPubkeys"]["updatedAt"],
            json!(1_710_001_000_100u64)
        );
        assert_eq!(value["prefixLookup"]["present"], json!(true));
        assert_eq!(value["prefixLookup"]["prefixCount"], json!(2));
        assert_eq!(
            value["prefixLookup"]["updatedAt"],
            json!(1_710_001_000_200u64)
        );
        assert_eq!(value["profileNames"]["present"], json!(true));
        assert_eq!(value["profileNames"]["entryCount"], json!(3));
        assert_eq!(value["profileNames"]["displayNameCount"], json!(2));
        assert_eq!(value["profileNames"]["nip05Count"], json!(2));
        assert_eq!(
            value["profileNames"]["updatedAt"],
            json!(1_710_001_000_300u64)
        );

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn scheduler_wakeups_empty_daemon_outputs_diagnostics_json() {
        let daemon_dir = unique_temp_daemon_dir();
        let output = run_cli([
            "scheduler-wakeups",
            "--daemon-dir",
            daemon_dir.to_str().expect("temp path must be utf-8"),
            "--inspected-at",
            "1710001000000",
        ])
        .expect("scheduler wakeups command must succeed");

        let value: Value = serde_json::from_str(&output).expect("output must be json");
        assert_eq!(value["schemaVersion"], json!(1));
        assert_eq!(value["inspectedAt"], json!(1_710_001_000_000u64));
        assert_eq!(value["pendingCount"], json!(0));
        assert_eq!(value["firedCount"], json!(0));
        assert_eq!(value["failedCount"], json!(0));
        assert_eq!(value["duePendingCount"], json!(0));
        assert_eq!(value["dueRetryCount"], json!(0));
        assert!(value["oldestPending"].is_null());
        assert!(value["nextRetryAt"].is_null());
        assert!(value["latestFailure"].is_null());

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn scheduler_wakeups_maintenance_requeues_due_retry_json() {
        let daemon_dir = unique_temp_daemon_dir();
        let record = enqueue_wakeup(
            &daemon_dir,
            WakeupEnqueueRequest {
                scheduled_for: 1_710_001_000_100,
                target: WakeupTarget::ProjectWakeup {
                    project_d_tag: "project-alpha".to_string(),
                },
                requester_context: "daemon-control-test".to_string(),
                writer_version: "test-version".to_string(),
                allow_backdated: false,
            },
            1_710_001_000_000,
        )
        .expect("wakeup enqueue must succeed");
        mark_wakeup_failed(
            &daemon_dir,
            &record.wakeup_id,
            1_710_001_000_150,
            WakeupFailureClassification::Retryable,
            Some("worker unavailable".to_string()),
            Some(50),
            WakeupRetryPolicy::default(),
        )
        .expect("wakeup failure must persist");

        let output = run_cli([
            "scheduler-wakeups-maintain",
            "--daemon-dir",
            daemon_dir.to_str().expect("temp path must be utf-8"),
            "--inspected-at",
            "1710001000200",
        ])
        .expect("scheduler wakeups maintenance command must succeed");

        let value: Value = serde_json::from_str(&output).expect("output must be json");
        assert_eq!(value["diagnosticsBefore"]["failedCount"], json!(1));
        assert_eq!(value["diagnosticsBefore"]["dueRetryCount"], json!(1));
        assert_eq!(value["requeued"][0]["wakeupId"], json!(record.wakeup_id));
        assert_eq!(value["diagnosticsAfter"]["pendingCount"], json!(1));
        assert_eq!(value["diagnosticsAfter"]["failedCount"], json!(0));
        assert_eq!(value["diagnosticsAfter"]["duePendingCount"], json!(1));

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn daemon_maintenance_outputs_maintenance_json() {
        let tenex_base_dir = unique_temp_base_dir();
        let daemon_dir = tenex_base_dir.join("daemon");
        let agents_dir = tenex_base_dir.join("agents");
        let project_dir = tenex_base_dir.join("projects").join("demo-project");
        fs::create_dir_all(&daemon_dir).expect("daemon dir must create");
        fs::create_dir_all(&agents_dir).expect("agents dir must create");
        fs::create_dir_all(&project_dir).expect("project dir must create");

        let owner = xonly_pubkey_hex(0x02);
        fs::write(
            tenex_base_dir.join("config.json"),
            format!(
                r#"{{
                    "whitelistedPubkeys": ["{owner}"],
                    "tenexPrivateKey": "{TEST_SECRET_KEY_HEX}",
                    "relays": ["wss://relay.one"]
                }}"#
            ),
        )
        .expect("config must write");
        fs::write(
            project_dir.join("project.json"),
            format!(
                r#"{{
                    "schemaVersion": 1,
                    "status": "running",
                    "projectOwnerPubkey": "{owner}",
                    "projectDTag": "demo-project",
                    "worktrees": ["main"]
                }}"#
            ),
        )
        .expect("project descriptor must write");
        let output = run_cli([
            "daemon-maintenance",
            "--daemon-dir",
            daemon_dir.to_str().expect("temp path must be utf-8"),
            "--inspected-at",
            "1710001000000",
        ])
        .expect("daemon maintenance command must succeed");

        let value: Value = serde_json::from_str(&output).expect("output must be json");
        assert_eq!(value["schemaVersion"], json!(1));
        assert_eq!(value["tenexBaseDir"], json!(tenex_base_dir));
        assert_eq!(value["daemonDir"], json!(daemon_dir));
        assert_eq!(value["nowMs"], json!(1_710_001_000_000u64));
        assert_eq!(value["nowSeconds"], json!(1_710_001_000u64));
        // daemon-control starts with an empty ProjectEventIndex; project descriptors are only
        // populated from live kind:31933 events fed by the running daemon.
        assert_eq!(
            value["projectDescriptorReport"]["descriptors"],
            json!([])
        );
        assert_eq!(
            value["bootedProjectDescriptorReport"]["descriptors"],
            json!([])
        );
        // backend_events was removed from DaemonMaintenanceOutcome; backend-status
        // and project-status publishing now run as dedicated async driver tasks.
        assert!(value["backendEvents"].is_null());
        assert_eq!(
            value["schedulerWakeups"]["diagnosticsAfter"]["pendingCount"],
            json!(0)
        );

        fs::remove_dir_all(tenex_base_dir).expect("temp tenex base dir cleanup must succeed");
    }

    #[test]
    fn diagnostics_empty_daemon_outputs_inspection_json() {
        let daemon_dir = unique_temp_daemon_dir();
        let output = run_cli([
            "diagnostics",
            "--daemon-dir",
            daemon_dir.to_str().expect("temp path must be utf-8"),
            "--inspected-at",
            "1710001000000",
        ])
        .expect("diagnostics command must succeed");

        let value: Value = serde_json::from_str(&output).expect("output must be json");
        assert_eq!(value["schemaVersion"], json!(1));
        assert_eq!(value["inspectedAt"], json!(1_710_001_000_000u64));
        assert_eq!(value["daemon"]["lockfile"], Value::Null);
        assert_eq!(value["dispatchQueue"]["lastSequence"], json!(0));
        assert_eq!(
            value["publishOutbox"]["inspectedAt"],
            json!(1_710_001_000_000u64)
        );
        assert_eq!(
            value["telegramOutbox"]["inspectedAt"],
            json!(1_710_001_000_000u64)
        );
        assert!(value["workerRuntime"].is_null());

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn backend_events_plan_empty_daemon_outputs_inspection_json() {
        let daemon_dir = unique_temp_daemon_dir();
        let output = run_cli([
            "backend-events-plan",
            "--daemon-dir",
            daemon_dir.to_str().expect("temp path must be utf-8"),
            "--inspected-at",
            "1710001000000",
        ])
        .expect("backend-events-plan command must succeed");

        let value: Value = serde_json::from_str(&output).expect("output must be json");
        assert_eq!(value["schemaVersion"], json!(1));
        assert_eq!(value["inspectedAt"], json!(1_710_001_000_000u64));
        assert_eq!(value["publishOutbox"]["schemaVersion"], json!(1));
        assert_eq!(
            value["publishOutbox"]["inspectedAt"],
            json!(1_710_001_000_000u64)
        );
        assert_eq!(value["publishOutbox"]["pendingCount"], json!(0));
        assert_eq!(value["publishOutbox"]["publishedCount"], json!(0));
        assert_eq!(value["publishOutbox"]["failedCount"], json!(0));
        assert_eq!(
            value["statusPublisherReadiness"]["kind"],
            json!("backend-status")
        );
        assert_eq!(value["statusPublisherReadiness"]["ready"], json!(false));
        assert!(
            value["statusPublisherReadiness"]["reason"]
                .as_str()
                .expect("readiness reason must be a string")
                .contains("backend config unavailable")
        );
        assert_eq!(
            value["statusPublisherReadiness"]["ownerPubkeyCount"],
            json!(0)
        );
        assert_eq!(value["statusPublisherReadiness"]["relayUrlCount"], json!(0));
        assert!(value["statusPublisherReadiness"]["backendPubkey"].is_null());
        assert!(value["statusPublisherReadiness"]["activeAgentCount"].is_null());

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn backend_events_plan_reports_ready_filesystem_inputs() {
        let tenex_base_dir = unique_temp_base_dir();
        let daemon_dir = tenex_base_dir.join("daemon");
        let agents_dir = tenex_base_dir.join("agents");
        fs::create_dir_all(&daemon_dir).expect("daemon dir must create");
        fs::create_dir_all(&agents_dir).expect("agents dir must create");

        let owner = xonly_pubkey_hex(0x02);
        let agent = xonly_pubkey_hex(0x03);
        fs::write(
            tenex_base_dir.join("config.json"),
            format!(
                r#"{{
                    "whitelistedPubkeys": ["{owner}"],
                    "tenexPrivateKey": "{TEST_SECRET_KEY_HEX}",
                    "relays": ["wss://relay.one"]
                }}"#
            ),
        )
        .expect("config must write");
        fs::write(
            agents_dir.join(format!("{agent}.json")),
            r#"{"slug":"worker","status":"active"}"#,
        )
        .expect("agent file must write");

        let output = run_cli([
            "backend-events-plan",
            "--daemon-dir",
            daemon_dir.to_str().expect("daemon path must be utf-8"),
            "--tenex-base-dir",
            tenex_base_dir.to_str().expect("base path must be utf-8"),
            "--inspected-at",
            "1710001000000",
        ])
        .expect("backend-events-plan command must succeed");

        let value: Value = serde_json::from_str(&output).expect("output must be json");
        let readiness = &value["statusPublisherReadiness"];
        assert_eq!(readiness["kind"], json!("backend-status"));
        assert_eq!(readiness["ready"], json!(true));
        assert_eq!(readiness["reason"], json!("ready"));
        assert_eq!(readiness["backendPubkey"], json!(TEST_BACKEND_PUBKEY_HEX));
        assert_eq!(readiness["ownerPubkeyCount"], json!(1));
        assert_eq!(readiness["relayUrlCount"], json!(1));
        assert_eq!(readiness["activeAgentCount"], json!(1));
        assert_eq!(readiness["skippedAgentFileCount"], json!(0));

        fs::remove_dir_all(tenex_base_dir).expect("temp base dir cleanup must succeed");
    }

    #[test]
    fn nostr_subscription_plan_outputs_filesystem_derived_filters_json() {
        let tenex_base_dir = unique_temp_base_dir();
        let daemon_dir = tenex_base_dir.join("daemon");
        let agents_dir = tenex_base_dir.join("agents");
        let project_dir = tenex_base_dir.join("projects").join("demo-project");
        fs::create_dir_all(&daemon_dir).expect("daemon dir must create");
        fs::create_dir_all(&agents_dir).expect("agents dir must create");
        fs::create_dir_all(&project_dir).expect("project dir must create");

        let owner = xonly_pubkey_hex(0x20);
        let agent = xonly_pubkey_hex(0x21);
        let lesson = "e".repeat(64);
        fs::write(
            tenex_base_dir.join("config.json"),
            format!(
                r#"{{
                    "whitelistedPubkeys": ["{owner}"],
                    "relays": ["wss://relay.one", "https://not-a-relay"],
                    "tenexPrivateKey": "{TEST_SECRET_KEY_HEX}"
                }}"#
            ),
        )
        .expect("config must write");
        fs::write(
            project_dir.join("project.json"),
            format!(
                r#"{{
                    "status": "running",
                    "projectOwnerPubkey": "{owner}",
                    "projectDTag": "demo-project",
                    "projectBasePath": "/repo/demo"
                }}"#
            ),
        )
        .expect("project descriptor must write");
        fs::write(
            agents_dir.join("index.json"),
            serde_json::to_string_pretty(&json!({
                "byProject": {
                    "demo-project": [agent]
                }
            }))
            .expect("agent index must serialize"),
        )
        .expect("agent index must write");
        fs::write(
            agents_dir.join(format!("{agent}.json")),
            r#"{"slug":"worker","status":"active","default":{}}"#,
        )
        .expect("agent file must write");

        let output = run_cli([
            "nostr-subscription-plan",
            "--tenex-base-dir",
            tenex_base_dir.to_str().expect("base path must be utf-8"),
            "--inspected-at",
            "1710001000000",
            "--since",
            "1710001000",
            "--lesson-definition-id",
            &lesson,
        ])
        .expect("nostr-subscription-plan command must succeed");

        let value: Value = serde_json::from_str(&output).expect("output must be json");
        assert_eq!(value["schemaVersion"], json!(1));
        assert_eq!(value["inspectedAt"], json!(1_710_001_000_000u64));
        assert_eq!(value["plan"]["relayUrls"], json!(["wss://relay.one"]));
        assert_eq!(value["plan"]["whitelistedPubkeys"], json!([owner]));
        // The daemon-control CLI starts with an empty ProjectEventIndex, so no project
        // addresses or agent pubkeys are discovered without a live daemon seeding the index.
        assert_eq!(value["plan"]["projectAddresses"], json!([]));
        assert_eq!(value["plan"]["agentPubkeys"], json!([]));
        assert_eq!(value["plan"]["staticFilters"].as_array().unwrap().len(), 3);
        // project_tagged_filter and agent_mentions_filter are both absent (no projects/agents).
        assert!(value["plan"]["projectTaggedFilter"].is_null());
        assert!(value["plan"]["agentMentionsFilter"].is_null());
        assert_eq!(
            value["plan"]["projectAgentSnapshotFilter"]["kinds"],
            json!([14199])
        );
        assert_eq!(
            value["plan"]["projectAgentSnapshotFilter"]["authors"],
            json!([owner])
        );
        assert_eq!(value["plan"]["nip46ReplyFilter"]["kinds"], json!([24133]));
        assert_eq!(value["plan"]["nip46ReplyFilter"]["authors"], json!([owner]));
        assert_eq!(
            value["plan"]["nip46ReplyFilter"]["#p"],
            json!([TEST_BACKEND_PUBKEY_HEX])
        );
        assert_eq!(value["plan"]["nip46ReplyFilter"]["limit"], json!(0));
        assert_eq!(value["plan"]["lessonFilters"][0]["#e"], json!([lesson]));
        // 3 static + 0 project_tagged + 0 agent_mentions + 1 snapshot + 1 nip46 + 1 lesson = 6
        assert_eq!(value["plan"]["filters"].as_array().unwrap().len(), 6);

        fs::remove_dir_all(tenex_base_dir).expect("temp base dir cleanup must succeed");
    }

    #[test]
    fn backend_events_enqueue_status_writes_pending_outbox_records_json() {
        let tenex_base_dir = unique_temp_base_dir();
        let daemon_dir = tenex_base_dir.join("daemon");
        let agents_dir = tenex_base_dir.join("agents");
        fs::create_dir_all(&daemon_dir).expect("daemon dir must create");
        fs::create_dir_all(&agents_dir).expect("agents dir must create");

        let owner = xonly_pubkey_hex(0x04);
        let agent = xonly_pubkey_hex(0x05);
        fs::write(
            tenex_base_dir.join("config.json"),
            format!(
                r#"{{
                    "whitelistedPubkeys": ["{owner}"],
                    "tenexPrivateKey": "{TEST_SECRET_KEY_HEX}",
                    "relays": ["wss://relay.one"]
                }}"#
            ),
        )
        .expect("config must write");
        fs::write(
            agents_dir.join(format!("{agent}.json")),
            r#"{"slug":"worker","status":"active"}"#,
        )
        .expect("agent file must write");

        let output = run_cli([
            "backend-events-enqueue-status",
            "--daemon-dir",
            daemon_dir.to_str().expect("daemon path must be utf-8"),
            "--tenex-base-dir",
            tenex_base_dir.to_str().expect("base path must be utf-8"),
            "--created-at",
            "1710001000",
            "--accepted-at",
            "1710001000100",
            "--request-timestamp",
            "1710001000050",
        ])
        .expect("backend-events-enqueue-status command must succeed");

        let value: Value = serde_json::from_str(&output).expect("output must be json");
        assert_eq!(value["schemaVersion"], json!(1));
        assert_eq!(value["createdAt"], json!(1_710_001_000u64));
        assert_eq!(value["acceptedAt"], json!(1_710_001_000_100u64));
        assert_eq!(value["requestTimestamp"], json!(1_710_001_000_050u64));
        assert_eq!(value["backendPubkey"], json!(TEST_BACKEND_PUBKEY_HEX));
        assert_eq!(value["ownerPubkeyCount"], json!(1));
        assert_eq!(value["relayUrlCount"], json!(1));
        assert_eq!(value["activeAgentCount"], json!(1));
        assert_eq!(value["skippedAgentFileCount"], json!(0));
        assert_ne!(
            value["heartbeatEventId"],
            value["installedAgentListEventId"]
        );
        assert_eq!(value["publishOutboxAfter"]["pendingCount"], json!(2));
        assert_eq!(value["publishOutboxAfter"]["publishedCount"], json!(0));
        assert_eq!(value["publishOutboxAfter"]["failedCount"], json!(0));
        assert_eq!(
            value["publishOutboxAfter"]["oldestPending"]["agentPubkey"],
            json!(TEST_BACKEND_PUBKEY_HEX)
        );

        fs::remove_dir_all(tenex_base_dir).expect("temp base dir cleanup must succeed");
    }

    #[test]
    fn backend_events_enqueue_project_status_writes_pending_outbox_record_json() {
        let tenex_base_dir = unique_temp_base_dir();
        let daemon_dir = tenex_base_dir.join("daemon");
        let agents_dir = tenex_base_dir.join("agents");
        let project_dir = tenex_base_dir.join("projects").join("demo-project");
        fs::create_dir_all(&daemon_dir).expect("daemon dir must create");
        fs::create_dir_all(&agents_dir).expect("agents dir must create");
        fs::create_dir_all(&project_dir).expect("project dir must create");

        let owner = xonly_pubkey_hex(0x06);
        let extra_owner = xonly_pubkey_hex(0x07);
        let agent = xonly_pubkey_hex(0x08);
        fs::write(
            tenex_base_dir.join("config.json"),
            format!(
                r#"{{
                    "whitelistedPubkeys": ["{owner}", "{extra_owner}"],
                    "tenexPrivateKey": "{TEST_SECRET_KEY_HEX}",
                    "relays": ["wss://relay.one"]
                }}"#
            ),
        )
        .expect("config must write");
        fs::write(
            agents_dir.join(format!("{agent}.json")),
            r#"{"slug":"worker","status":"active"}"#,
        )
        .expect("agent file must write");
        fs::write(
            tenex_base_dir.join("llms.json"),
            r#"{"configurations":{"alpha":{"provider":"openai","model":"gpt-4o"}}}"#,
        )
        .expect("llms file must write");
        fs::write(
            project_dir.join("schedules.json"),
            r#"[{
                "id": "task-1",
                "title": "Nightly report",
                "schedule": "0 1 * * *",
                "prompt": "Run nightly report",
                "targetAgentSlug": "worker"
            }]"#,
        )
        .expect("schedules file must write");

        let output = run_cli([
            "backend-events-enqueue-project-status",
            "--daemon-dir",
            daemon_dir.to_str().expect("daemon path must be utf-8"),
            "--tenex-base-dir",
            tenex_base_dir.to_str().expect("base path must be utf-8"),
            "--project-owner-pubkey",
            &owner,
            "--project-d-tag",
            "demo-project",
            "--project-manager-pubkey",
            &agent,
            "--worktree",
            "main",
            "--created-at",
            "1710001200",
            "--accepted-at",
            "1710001200100",
            "--request-timestamp",
            "1710001200050",
        ])
        .expect("backend-events-enqueue-project-status command must succeed");

        let value: Value = serde_json::from_str(&output).expect("output must be json");
        assert_eq!(value["schemaVersion"], json!(1));
        assert_eq!(value["createdAt"], json!(1_710_001_200u64));
        assert_eq!(value["acceptedAt"], json!(1_710_001_200_100u64));
        assert_eq!(value["requestTimestamp"], json!(1_710_001_200_050u64));
        assert_eq!(value["projectOwnerPubkey"], json!(owner));
        assert_eq!(value["projectDTag"], json!("demo-project"));
        assert_eq!(value["backendPubkey"], json!(TEST_BACKEND_PUBKEY_HEX));
        assert_eq!(value["ownerPubkeyCount"], json!(2));
        assert_eq!(value["activeAgentCount"], json!(1));
        assert_eq!(value["scheduledTaskCount"], json!(1));
        assert_eq!(value["worktreeCount"], json!(1));
        assert_eq!(value["publishOutboxAfter"]["pendingCount"], json!(1));
        assert_eq!(value["publishOutboxAfter"]["publishedCount"], json!(0));
        assert_eq!(value["publishOutboxAfter"]["failedCount"], json!(0));

        fs::remove_dir_all(tenex_base_dir).expect("temp base dir cleanup must succeed");
    }

    #[test]
    fn backend_events_periodic_tick_writes_backend_and_project_outbox_records_json() {
        let tenex_base_dir = unique_temp_base_dir();
        let daemon_dir = tenex_base_dir.join("daemon");
        let agents_dir = tenex_base_dir.join("agents");
        let project_dir = tenex_base_dir.join("projects").join("demo-project");
        fs::create_dir_all(&daemon_dir).expect("daemon dir must create");
        fs::create_dir_all(&agents_dir).expect("agents dir must create");
        fs::create_dir_all(&project_dir).expect("project dir must create");

        let owner = xonly_pubkey_hex(0x0b);
        let agent = xonly_pubkey_hex(0x0c);
        fs::write(
            tenex_base_dir.join("config.json"),
            format!(
                r#"{{
                    "whitelistedPubkeys": ["{owner}"],
                    "tenexPrivateKey": "{TEST_SECRET_KEY_HEX}",
                    "relays": ["wss://relay.one"]
                }}"#
            ),
        )
        .expect("config must write");
        fs::write(
            agents_dir.join(format!("{agent}.json")),
            r#"{"slug":"worker","status":"active"}"#,
        )
        .expect("agent file must write");
        fs::write(
            tenex_base_dir.join("llms.json"),
            r#"{"configurations":{"alpha":{"provider":"openai","model":"gpt-4o"}}}"#,
        )
        .expect("llms file must write");
        fs::write(
            project_dir.join("schedules.json"),
            r#"[{
                "id": "task-1",
                "title": "Nightly report",
                "schedule": "0 1 * * *",
                "prompt": "Run nightly report",
                "targetAgentSlug": "worker"
            }]"#,
        )
        .expect("schedules file must write");

        let output = run_cli([
            "backend-events-periodic-tick",
            "--daemon-dir",
            daemon_dir.to_str().expect("daemon path must be utf-8"),
            "--tenex-base-dir",
            tenex_base_dir.to_str().expect("base path must be utf-8"),
            "--project-owner-pubkey",
            &owner,
            "--project-d-tag",
            "demo-project",
            "--project-manager-pubkey",
            &agent,
            "--worktree",
            "main",
            "--first-due-at",
            "1710001300",
            "--created-at",
            "1710001300",
            "--accepted-at",
            "1710001300100",
            "--request-timestamp",
            "1710001300050",
        ])
        .expect("backend-events-periodic-tick command must succeed");

        let value: Value = serde_json::from_str(&output).expect("output must be json");
        let project_task_name = format!("project-status:{owner}:demo-project");
        assert_eq!(value["schemaVersion"], json!(1));
        assert_eq!(value["now"], json!(1_710_001_300u64));
        assert_eq!(value["firstDueAt"], json!(1_710_001_300u64));
        // backend-status is no longer in the periodic scheduler; its driver owns its timer.
        assert_eq!(
            value["registered"]["registeredTaskNames"],
            json!([project_task_name.clone()])
        );
        assert_eq!(
            value["tick"]["dueTaskNames"],
            json!([project_task_name])
        );
        assert_eq!(
            value["tick"]["projectStatuses"][0]["enqueuedEventCount"],
            json!(1)
        );
        assert_eq!(
            value["tick"]["schedulerSnapshot"]["tasks"][0]["intervalSeconds"],
            json!(30)
        );
        assert_eq!(
            value["tick"]["schedulerSnapshot"]["tasks"][0]["nextDueAt"],
            json!(1_710_001_330u64)
        );
        // 1 project-status event (backend-status events now come from the driver, not the tick).
        assert_eq!(value["publishOutboxAfter"]["pendingCount"], json!(1));
        assert_eq!(value["publishOutboxAfter"]["publishedCount"], json!(0));
        assert_eq!(value["publishOutboxAfter"]["failedCount"], json!(0));
        assert_eq!(
            value["persistedSchedulerSnapshot"]["tasks"][0]["nextDueAt"],
            json!(1_710_001_330u64)
        );

        let second_output = run_cli([
            "backend-events-periodic-tick",
            "--daemon-dir",
            daemon_dir.to_str().expect("daemon path must be utf-8"),
            "--tenex-base-dir",
            tenex_base_dir.to_str().expect("base path must be utf-8"),
            "--project-owner-pubkey",
            &owner,
            "--project-d-tag",
            "demo-project",
            "--project-manager-pubkey",
            &agent,
            "--worktree",
            "main",
            "--first-due-at",
            "1710001300",
            "--created-at",
            "1710001310",
            "--accepted-at",
            "1710001310100",
            "--request-timestamp",
            "1710001310050",
        ])
        .expect("second backend-events-periodic-tick command must succeed");

        let second: Value = serde_json::from_str(&second_output).expect("output must be json");
        assert_eq!(second["registered"]["registeredTaskNames"], json!([]));
        assert_eq!(second["tick"]["dueTaskNames"], json!([]));
        assert_eq!(second["tick"]["projectStatuses"], json!([]));
        assert_eq!(
            second["persistedSchedulerSnapshot"]["tasks"][0]["nextDueAt"],
            json!(1_710_001_330u64)
        );
        // Still 1 pending from the first run (backend-status events no longer accumulate here).
        assert_eq!(second["publishOutboxAfter"]["pendingCount"], json!(1));

        fs::remove_dir_all(tenex_base_dir).expect("temp base dir cleanup must succeed");
    }

    #[test]
    fn backend_events_periodic_tick_discovers_project_descriptors_json() {
        let tenex_base_dir = unique_temp_base_dir();
        let daemon_dir = tenex_base_dir.join("daemon");
        let agents_dir = tenex_base_dir.join("agents");
        let project_dir = tenex_base_dir.join("projects").join("demo-project");
        let stopped_project_dir = tenex_base_dir.join("projects").join("stopped-project");
        fs::create_dir_all(&daemon_dir).expect("daemon dir must create");
        fs::create_dir_all(&agents_dir).expect("agents dir must create");
        fs::create_dir_all(&project_dir).expect("project dir must create");
        fs::create_dir_all(&stopped_project_dir).expect("stopped project dir must create");

        let owner = xonly_pubkey_hex(0x0d);
        let stopped_owner = xonly_pubkey_hex(0x0e);
        let agent = xonly_pubkey_hex(0x0f);
        fs::write(
            tenex_base_dir.join("config.json"),
            format!(
                r#"{{
                    "whitelistedPubkeys": ["{owner}"],
                    "tenexPrivateKey": "{TEST_SECRET_KEY_HEX}",
                    "relays": ["wss://relay.one"]
                }}"#
            ),
        )
        .expect("config must write");
        fs::write(
            agents_dir.join(format!("{agent}.json")),
            r#"{"slug":"worker","status":"active"}"#,
        )
        .expect("agent file must write");
        fs::write(
            tenex_base_dir.join("llms.json"),
            r#"{"configurations":{"alpha":{"provider":"openai","model":"gpt-4o"}}}"#,
        )
        .expect("llms file must write");
        fs::write(
            project_dir.join("schedules.json"),
            r#"[{
                "id": "task-1",
                "title": "Nightly report",
                "schedule": "0 1 * * *",
                "prompt": "Run nightly report",
                "targetAgentSlug": "worker"
            }]"#,
        )
        .expect("schedules file must write");
        fs::write(
            project_dir.join("project.json"),
            format!(
                r#"{{
                    "schemaVersion": 1,
                    "status": "running",
                    "projectOwnerPubkey": "{owner}",
                    "projectDTag": "demo-project",
                    "projectManagerPubkey": "{agent}",
                    "worktrees": ["main", "feature/rust"]
                }}"#
            ),
        )
        .expect("project descriptor must write");
        fs::write(
            stopped_project_dir.join("project.json"),
            format!(
                r#"{{
                    "schemaVersion": 1,
                    "status": "stopped",
                    "projectOwnerPubkey": "{stopped_owner}",
                    "projectDTag": "stopped-project"
                }}"#
            ),
        )
        .expect("stopped project descriptor must write");

        let output = run_cli([
            "backend-events-periodic-tick",
            "--daemon-dir",
            daemon_dir.to_str().expect("daemon path must be utf-8"),
            "--tenex-base-dir",
            tenex_base_dir.to_str().expect("base path must be utf-8"),
            "--discover-projects",
            "--first-due-at",
            "1710001400",
            "--created-at",
            "1710001400",
            "--accepted-at",
            "1710001400100",
            "--request-timestamp",
            "1710001400050",
        ])
        .expect("backend-events-periodic-tick discovery command must succeed");

        let value: Value = serde_json::from_str(&output).expect("output must be json");
        // --discover-projects uses an empty ProjectEventIndex (no live daemon), so no projects
        // are found even though project.json files exist on disk. backend-status is also no
        // longer registered in the periodic scheduler (its driver owns its timer).
        assert_eq!(value["registered"]["registeredTaskNames"], json!([]));
        assert_eq!(value["tick"]["dueTaskNames"], json!([]));
        assert_eq!(
            value["tick"]["projectStatuses"].as_array().unwrap().len(),
            0
        );
        assert_eq!(
            value["projectDescriptorReport"]["descriptors"],
            json!([])
        );
        assert_eq!(value["publishOutboxAfter"]["pendingCount"], json!(0));

        fs::remove_dir_all(tenex_base_dir).expect("temp base dir cleanup must succeed");
    }

    #[test]
    fn readiness_outputs_startup_gate_json() {
        let tenex_base_dir = unique_temp_base_dir();
        fs::create_dir_all(&tenex_base_dir).expect("base dir must create");
        fs::write(
            tenex_base_dir.join("config.json"),
            format!(
                r#"{{
                    "whitelistedPubkeys": ["{}"],
                    "tenexPrivateKey": "{TEST_SECRET_KEY_HEX}",
                    "relays": ["wss://relay.one"]
                }}"#,
                xonly_pubkey_hex(0x09)
            ),
        )
        .expect("config must write");

        let output = run_cli([
            "readiness",
            "--tenex-base-dir",
            tenex_base_dir.to_str().expect("base path must be utf-8"),
        ])
        .expect("readiness command must succeed");

        let value: Value = serde_json::from_str(&output).expect("output must be json");
        assert_eq!(value["schemaVersion"], json!(1));
        assert_eq!(value["ready"], json!(true));
        assert_eq!(value["checks"][0]["name"], json!("base-directory"));
        assert_eq!(value["checks"][0]["status"], json!("ok"));
        assert!(
            value["checks"]
                .as_array()
                .expect("checks must be an array")
                .iter()
                .any(|check| check["name"] == json!("lockfile") && check["status"] == json!("ok"))
        );

        fs::remove_dir_all(tenex_base_dir).expect("temp base dir cleanup must succeed");
    }

    #[test]
    fn status_empty_daemon_outputs_inspection_json() {
        let daemon_dir = unique_temp_daemon_dir();
        let output = run_cli([
            "status",
            "--daemon-dir",
            daemon_dir.to_str().expect("temp path must be utf-8"),
        ])
        .expect("status command must succeed");

        let value: Value = serde_json::from_str(&output).expect("output must be json");
        assert_eq!(value["statusSnapshot"]["presence"], json!("missing_lock"));
        assert_eq!(value["lockState"]["kind"], json!("missing"));
        assert_eq!(value["restartStateCompatibility"]["kind"], json!("missing"));

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn start_plan_busy_lock_outputs_refusal_json() {
        let daemon_dir = unique_temp_daemon_dir();
        write_lock_info_file(
            &daemon_dir,
            &build_lock_info(std::process::id(), "tenex-host", 1_710_000_000_000),
        )
        .expect("lock write must succeed");

        let output = run_cli([
            "start-plan",
            "--daemon-dir",
            daemon_dir.to_str().expect("temp path must be utf-8"),
        ])
        .expect("start-plan command must succeed");

        let value: Value = serde_json::from_str(&output).expect("output must be json");
        assert_eq!(value["kind"], json!("refused"));
        assert_eq!(value["lock_state"]["kind"], json!("busy"));
        assert_eq!(value["reason"]["kind"], json!("busy_lock"));
        assert_eq!(value["reason"]["owner"]["pid"], json!(std::process::id()));

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn stop_plan_missing_lock_outputs_refusal_json() {
        let daemon_dir = unique_temp_daemon_dir();
        let output = run_cli([
            "stop-plan",
            "--daemon-dir",
            daemon_dir.to_str().expect("temp path must be utf-8"),
        ])
        .expect("stop-plan command must succeed");

        let value: Value = serde_json::from_str(&output).expect("output must be json");
        assert_eq!(value["kind"], json!("refused"));
        assert_eq!(value["lock_state"]["kind"], json!("missing"));
        assert_eq!(value["reason"], json!("missing_lock"));
        assert_eq!(value["status_snapshot"]["presence"], json!("missing_lock"));

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn restart_state_present_outputs_json() {
        let daemon_dir = unique_temp_daemon_dir();
        save_restart_state_file(
            &daemon_dir,
            &build_restart_state(1_710_000_000_000, std::process::id(), "tenex-host"),
        )
        .expect("restart state write must succeed");

        let output = run_cli([
            "restart-state",
            "--daemon-dir",
            daemon_dir.to_str().expect("temp path must be utf-8"),
        ])
        .expect("restart-state command must succeed");

        let value: Value = serde_json::from_str(&output).expect("output must be json");
        assert_eq!(value["kind"], json!("present"));
        assert_eq!(value["restart_state"]["pid"], json!(std::process::id()));

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn rejects_missing_daemon_dir_with_usage_exit_code() {
        let error = run_cli(["status"]).expect_err("command must fail");

        assert_eq!(error.to_string(), "--daemon-dir is required");
        assert_eq!(error.exit_code, USAGE_EXIT_CODE);
    }

    fn unique_temp_daemon_dir() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be after UNIX_EPOCH")
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let daemon_dir = env::temp_dir().join(format!(
            "tenex-daemon-control-cli-{}-{counter}-{unique}",
            process::id()
        ));
        fs::create_dir_all(&daemon_dir).expect("temp daemon dir must be created");
        daemon_dir
    }

    fn unique_temp_base_dir() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be after UNIX_EPOCH")
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        env::temp_dir().join(format!(
            "tenex-daemon-control-base-{}-{counter}-{unique}",
            process::id()
        ))
    }

    fn xonly_pubkey_hex(fill_byte: u8) -> String {
        let secret_bytes = [fill_byte; 32];
        let secret = SecretKey::from_byte_array(secret_bytes).expect("valid secret");
        let secp = Secp256k1::new();
        let keypair = Keypair::from_secret_key(&secp, &secret);
        let (xonly, _) = keypair.x_only_public_key();
        hex::encode(xonly.serialize())
    }
}
