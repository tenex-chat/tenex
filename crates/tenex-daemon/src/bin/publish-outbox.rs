use std::env;
use std::fmt;
use std::path::{Path, PathBuf};
use std::process;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tenex_daemon::backend_config::read_backend_config;
use tenex_daemon::publish_outbox::{inspect_publish_outbox, run_publish_outbox_maintenance};
use tenex_daemon::relay_publisher::{NostrRelayPublisher, RelayPublisherConfig};

const DEFAULT_RELAY_TIMEOUT_MS: u64 = 10_000;
const USAGE_EXIT_CODE: i32 = 2;
const RUNTIME_EXIT_CODE: i32 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
enum PublishOutboxCommand {
    Inspect,
    Maintain,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PublishOutboxCliOptions {
    command: PublishOutboxCommand,
    daemon_dir: PathBuf,
    tenex_base_dir: Option<PathBuf>,
    now_ms: u64,
    relay_timeout_ms: u64,
    relay_urls: Vec<String>,
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
    let options = parse_publish_outbox_args(&args)?;

    match options.command {
        PublishOutboxCommand::Inspect => {
            let diagnostics = inspect_publish_outbox(&options.daemon_dir, options.now_ms)
                .map_err(|error| runtime_error(error.to_string()))?;
            serde_json::to_string_pretty(&diagnostics)
                .map_err(|error| runtime_error(error.to_string()))
        }
        PublishOutboxCommand::Maintain => {
            let relay_config = build_relay_config(&options)?;
            let mut publisher = build_relay_publisher(&options, relay_config);
            let report =
                run_publish_outbox_maintenance(&options.daemon_dir, &mut publisher, options.now_ms)
                    .map_err(|error| runtime_error(error.to_string()))?;
            serde_json::to_string_pretty(&report).map_err(|error| runtime_error(error.to_string()))
        }
    }
}

fn parse_publish_outbox_args(args: &[String]) -> Result<PublishOutboxCliOptions, CliError> {
    let command = match args.first().map(String::as_str) {
        Some("inspect") => PublishOutboxCommand::Inspect,
        Some("maintain") => PublishOutboxCommand::Maintain,
        Some("help" | "--help" | "-h") | None => return Err(usage_error(usage())),
        Some(command) => {
            return Err(usage_error(format!(
                "unknown publish-outbox command: {command}\n\n{}",
                usage()
            )));
        }
    };

    let mut daemon_dir = None;
    let mut tenex_base_dir = None;
    let mut now_ms = None;
    let mut relay_timeout_ms = DEFAULT_RELAY_TIMEOUT_MS;
    let mut relay_urls = Vec::new();
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
            "--now-ms" => {
                index += 1;
                let value = args
                    .get(index)
                    .ok_or_else(|| usage_error("--now-ms requires a value"))?;
                now_ms = Some(parse_u64_arg("--now-ms", value)?);
            }
            "--relay-timeout-ms" => {
                index += 1;
                let value = args
                    .get(index)
                    .ok_or_else(|| usage_error("--relay-timeout-ms requires a value"))?;
                relay_timeout_ms = parse_u64_arg("--relay-timeout-ms", value)?;
            }
            "--relay-url" => {
                index += 1;
                let value = args
                    .get(index)
                    .ok_or_else(|| usage_error("--relay-url requires a value"))?;
                relay_urls.push(value.clone());
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
    let now_ms = now_ms.unwrap_or_else(current_unix_time_ms);

    Ok(PublishOutboxCliOptions {
        command,
        daemon_dir,
        tenex_base_dir,
        now_ms,
        relay_timeout_ms,
        relay_urls,
    })
}

fn build_relay_publisher(
    options: &PublishOutboxCliOptions,
    relay_config: RelayPublisherConfig,
) -> NostrRelayPublisher {
    let tenex_base_dir = options
        .tenex_base_dir
        .clone()
        .unwrap_or_else(|| infer_tenex_base_dir(&options.daemon_dir));
    match read_backend_config(&tenex_base_dir).and_then(|config| config.backend_signer()) {
        Ok(signer) => NostrRelayPublisher::with_auth_signer(relay_config, signer),
        Err(_) => NostrRelayPublisher::new(relay_config),
    }
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

fn build_relay_config(options: &PublishOutboxCliOptions) -> Result<RelayPublisherConfig, CliError> {
    let timeout = Duration::from_millis(options.relay_timeout_ms);
    if options.relay_urls.is_empty() {
        RelayPublisherConfig::from_env_or_default(env::var("RELAYS").ok().as_deref(), timeout)
            .map_err(|error| runtime_error(error.to_string()))
    } else {
        RelayPublisherConfig::new(options.relay_urls.clone(), timeout)
            .map_err(|error| runtime_error(error.to_string()))
    }
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
        "  publish-outbox inspect --daemon-dir <path> [--now-ms <ms>]",
        "  publish-outbox maintain --daemon-dir <path> [--tenex-base-dir <path>] [--now-ms <ms>] [--relay-timeout-ms <ms>] [--relay-url <url>]...",
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

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn parses_inspect_args() {
        let options = parse_publish_outbox_args(&[
            "inspect".to_string(),
            "--daemon-dir".to_string(),
            "/tmp/tenex-daemon".to_string(),
            "--now-ms".to_string(),
            "1710001000000".to_string(),
        ])
        .expect("inspect args must parse");

        assert_eq!(options.command, PublishOutboxCommand::Inspect);
        assert_eq!(options.daemon_dir, PathBuf::from("/tmp/tenex-daemon"));
        assert_eq!(options.now_ms, 1710001000000);
        assert_eq!(options.relay_timeout_ms, DEFAULT_RELAY_TIMEOUT_MS);
        assert!(options.relay_urls.is_empty());
    }

    #[test]
    fn parses_maintain_args_with_relay_urls() {
        let options = parse_publish_outbox_args(&[
            "maintain".to_string(),
            "--daemon-dir".to_string(),
            "/tmp/tenex-daemon".to_string(),
            "--relay-timeout-ms".to_string(),
            "5000".to_string(),
            "--relay-url".to_string(),
            "wss://relay-one.test".to_string(),
            "--relay-url".to_string(),
            "wss://relay-two.test".to_string(),
        ])
        .expect("maintain args must parse");

        assert_eq!(options.command, PublishOutboxCommand::Maintain);
        assert_eq!(options.relay_timeout_ms, 5000);
        assert_eq!(
            options.relay_urls,
            vec![
                "wss://relay-one.test".to_string(),
                "wss://relay-two.test".to_string()
            ]
        );
    }

    #[test]
    fn inspect_empty_publish_outbox_outputs_diagnostics_json() {
        let daemon_dir = unique_temp_daemon_dir();
        let output = run_cli([
            "inspect",
            "--daemon-dir",
            daemon_dir.to_str().expect("temp path must be utf-8"),
            "--now-ms",
            "1710001000000",
        ])
        .expect("inspect command must succeed");

        let value: Value = serde_json::from_str(&output).expect("output must be json");
        assert_eq!(value["schemaVersion"], 1);
        assert_eq!(value["inspectedAt"], json!(1710001000000_u64));
        assert_eq!(value["pendingCount"], 0);
        assert_eq!(value["publishedCount"], 0);
        assert_eq!(value["failedCount"], 0);

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn maintain_empty_publish_outbox_outputs_report_json_without_publishing() {
        let daemon_dir = unique_temp_daemon_dir();
        let output = run_cli([
            "maintain",
            "--daemon-dir",
            daemon_dir.to_str().expect("temp path must be utf-8"),
            "--now-ms",
            "1710001000000",
        ])
        .expect("maintain command must succeed");

        let value: Value = serde_json::from_str(&output).expect("output must be json");
        assert_eq!(value["diagnosticsBefore"]["pendingCount"], 0);
        assert_eq!(value["diagnosticsBefore"]["failedCount"], 0);
        assert_eq!(value["requeued"], Value::Array(Vec::new()));
        assert_eq!(value["drained"], Value::Array(Vec::new()));
        assert_eq!(value["diagnosticsAfter"]["publishedCount"], 0);

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn rejects_missing_daemon_dir_with_usage_exit_code() {
        let error = run_cli(["inspect"]).expect_err("command must fail");

        assert_eq!(error.to_string(), "--daemon-dir is required");
        assert_eq!(error.exit_code, USAGE_EXIT_CODE);
    }

    #[test]
    fn rejects_invalid_relay_url_with_runtime_exit_code() {
        let daemon_dir = unique_temp_daemon_dir();
        let error = run_cli([
            "maintain",
            "--daemon-dir",
            daemon_dir.to_str().expect("temp path must be utf-8"),
            "--relay-url",
            "https://relay.example.test",
        ])
        .expect_err("command must fail");

        assert_eq!(error.exit_code, RUNTIME_EXIT_CODE);
        assert!(
            error
                .to_string()
                .contains("relay url must use ws:// or wss://")
        );

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    fn unique_temp_daemon_dir() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be after UNIX_EPOCH")
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let daemon_dir = env::temp_dir().join(format!(
            "tenex-publish-outbox-cli-{}-{counter}-{unique}",
            process::id()
        ));
        fs::create_dir_all(&daemon_dir).expect("temp daemon dir must be created");
        daemon_dir
    }
}
