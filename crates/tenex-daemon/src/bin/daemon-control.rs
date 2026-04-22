use std::env;
use std::fmt;
use std::path::PathBuf;
use std::process;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tenex_daemon::caches::prefix_lookup::{PrefixLookupDiagnostics, inspect_prefix_lookup};
use tenex_daemon::caches::profile_names::{ProfileNamesDiagnostics, inspect_profile_names};
use tenex_daemon::caches::trust_pubkeys::{TrustPubkeysDiagnostics, inspect_trust_pubkeys};
use tenex_daemon::daemon_control::{
    inspect_daemon_control, plan_daemon_start, plan_daemon_stop,
    read_daemon_restart_state_compatibility,
};
use tenex_daemon::daemon_diagnostics::{DaemonDiagnosticsInput, inspect_daemon_diagnostics};
use tenex_daemon::daemon_shell::DaemonShell;

const CACHES_DIAGNOSTICS_SCHEMA_VERSION: u32 = 1;
const USAGE_EXIT_CODE: i32 = 2;
const RUNTIME_EXIT_CODE: i32 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
enum DaemonControlCommand {
    Caches,
    Diagnostics,
    Status,
    StartPlan,
    StopPlan,
    RestartState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DaemonControlCliOptions {
    command: DaemonControlCommand,
    daemon_dir: PathBuf,
    inspected_at: u64,
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

fn parse_daemon_control_args(args: &[String]) -> Result<DaemonControlCliOptions, CliError> {
    let command = match args.first().map(String::as_str) {
        Some("caches") => DaemonControlCommand::Caches,
        Some("diagnostics") => DaemonControlCommand::Diagnostics,
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
    let mut inspected_at = None;
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
            "--inspected-at" => {
                index += 1;
                let value = args
                    .get(index)
                    .ok_or_else(|| usage_error("--inspected-at requires a value"))?;
                inspected_at = Some(parse_u64_arg("--inspected-at", value)?);
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

    Ok(DaemonControlCliOptions {
        command,
        daemon_dir,
        inspected_at: inspected_at.unwrap_or_else(current_unix_time_ms),
    })
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

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

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
}
