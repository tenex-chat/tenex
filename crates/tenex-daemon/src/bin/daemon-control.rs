use std::env;
use std::fmt;
use std::path::{Path, PathBuf};
use std::process;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tenex_daemon::agent_inventory::read_installed_agent_inventory;
use tenex_daemon::backend_config::read_backend_config;
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
use tenex_daemon::daemon_shell::DaemonShell;
use tenex_daemon::publish_outbox::{PublishOutboxDiagnostics, inspect_publish_outbox};
use tenex_daemon::scheduler_wakeups::{inspect_scheduler_wakeups, run_scheduler_maintenance};

const CACHES_DIAGNOSTICS_SCHEMA_VERSION: u32 = 1;
const USAGE_EXIT_CODE: i32 = 2;
const RUNTIME_EXIT_CODE: i32 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
enum DaemonControlCommand {
    Caches,
    Diagnostics,
    BackendEventsPlan,
    BackendEventsEnqueueStatus,
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
    installed_agent_list_event_id: String,
    publish_outbox_after: PublishOutboxDiagnostics,
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

fn main() {
    match run_cli(env::args().skip(1)) {
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

    Ok(BackendEventsEnqueueStatusDiagnostics {
        schema_version: 1,
        tenex_base_dir: options.tenex_base_dir.clone(),
        daemon_dir: options.daemon_dir.clone(),
        created_at,
        accepted_at,
        request_timestamp,
        backend_pubkey: outcome.heartbeat.record.event.pubkey.clone(),
        owner_pubkey_count: outcome.config.whitelisted_pubkeys.len(),
        relay_url_count: outcome.config.effective_relay_urls().len(),
        active_agent_count: outcome.agent_inventory.active_agents.len(),
        skipped_agent_file_count: outcome.agent_inventory.skipped_files.len(),
        heartbeat_event_id: outcome.heartbeat.record.event.id,
        installed_agent_list_event_id: outcome.installed_agent_list.record.event.id,
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

    let daemon_dir = daemon_dir.ok_or_else(|| usage_error("--daemon-dir is required"))?;
    let tenex_base_dir = tenex_base_dir.unwrap_or_else(|| infer_tenex_base_dir(&daemon_dir));

    Ok(DaemonControlCliOptions {
        command,
        daemon_dir,
        tenex_base_dir,
        inspected_at: inspected_at.unwrap_or_else(current_unix_time_ms),
        created_at,
        accepted_at,
        request_timestamp,
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
            &build_restart_state(
                1_710_000_000_000,
                vec!["project-alpha".to_string()],
                std::process::id(),
                "tenex-host",
            ),
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
