use std::env;
use std::fmt;
use std::path::PathBuf;
use std::process;

use tenex_daemon::daemon_control::{
    inspect_daemon_control, plan_daemon_start, plan_daemon_stop,
    read_daemon_restart_state_compatibility,
};
use tenex_daemon::daemon_shell::DaemonShell;

const USAGE_EXIT_CODE: i32 = 2;
const RUNTIME_EXIT_CODE: i32 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
enum DaemonControlCommand {
    Status,
    StartPlan,
    StopPlan,
    RestartState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DaemonControlCliOptions {
    command: DaemonControlCommand,
    daemon_dir: PathBuf,
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
    let shell = DaemonShell::new(&options.daemon_dir);

    match options.command {
        DaemonControlCommand::Status => serde_json::to_string_pretty(
            &inspect_daemon_control(&shell).map_err(|error| runtime_error(error.to_string()))?,
        )
        .map_err(|error| runtime_error(error.to_string())),
        DaemonControlCommand::StartPlan => {
            let lock_state = shell
                .inspect_lock()
                .map_err(|error| runtime_error(error.to_string()))?;
            serde_json::to_string_pretty(&plan_daemon_start(&lock_state))
                .map_err(|error| runtime_error(error.to_string()))
        }
        DaemonControlCommand::StopPlan => {
            let lock_state = shell
                .inspect_lock()
                .map_err(|error| runtime_error(error.to_string()))?;
            let status_snapshot = shell.status_snapshot();
            serde_json::to_string_pretty(&plan_daemon_stop(&lock_state, &status_snapshot))
                .map_err(|error| runtime_error(error.to_string()))
        }
        DaemonControlCommand::RestartState => serde_json::to_string_pretty(
            &read_daemon_restart_state_compatibility(&shell)
                .map_err(|error| runtime_error(error.to_string()))?,
        )
        .map_err(|error| runtime_error(error.to_string())),
    }
}

fn parse_daemon_control_args(args: &[String]) -> Result<DaemonControlCliOptions, CliError> {
    let command = match args.first().map(String::as_str) {
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
    })
}

fn usage() -> String {
    [
        "usage:",
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
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    use tenex_daemon::filesystem_state::{
        build_lock_info, build_restart_state, save_restart_state_file, write_lock_info_file,
    };

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

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
