use std::env;
use std::fmt;
use std::path::{Path, PathBuf};
use std::process;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tenex_daemon::backend_config::read_backend_config;
use tenex_daemon::daemon_foreground::{
    DaemonForegroundStoppableInput, DaemonForegroundWorkerInput,
    run_daemon_foreground_until_stopped_from_filesystem_with_worker,
};
use tenex_daemon::daemon_loop::{
    DaemonMaintenanceLoopClock, DaemonMaintenanceLoopSleeper, DaemonMaintenanceLoopStopSignal,
    SystemDaemonMaintenanceLoopClock, ThreadDaemonMaintenanceLoopSleeper,
};
use tenex_daemon::daemon_maintenance::DaemonMaintenanceOutcome;
use tenex_daemon::daemon_shell::DaemonShell;
use tenex_daemon::publish_outbox::PublishOutboxMaintenanceReport;
use tenex_daemon::publish_outbox::{PublishOutboxRelayPublisher, PublishOutboxRetryPolicy};
use tenex_daemon::relay_publisher::{NostrRelayPublisher, RelayPublisherConfig};
use tenex_daemon::worker_concurrency::WorkerConcurrencyLimits;
use tenex_daemon::worker_dispatch_execution::AgentWorkerProcessDispatchSpawner;
use tenex_daemon::worker_process::{
    AgentWorkerCommand, AgentWorkerProcessConfig, bun_agent_worker_command,
};
use tenex_daemon::worker_runtime_state::WorkerRuntimeState;

const DEFAULT_RELAY_TIMEOUT_MS: u64 = 10_000;
const DEFAULT_SLEEP_MS: u64 = 1_000;
const DEFAULT_WORKER_MAX_FRAMES: u64 = 4_096;
const DAEMON_FOREGROUND_DIAGNOSTICS_SCHEMA_VERSION: u32 = 1;
const USAGE_EXIT_CODE: i32 = 2;
const RUNTIME_EXIT_CODE: i32 = 1;
const WORKER_ENGINE_ENV: &str = "TENEX_AGENT_WORKER_ENGINE";
const AGENT_WORKER_ENGINE: &str = "agent";
static DAEMON_STOP_REQUESTED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, PartialEq, Eq)]
struct DaemonCliOptions {
    daemon_dir: Option<PathBuf>,
    tenex_base_dir: Option<PathBuf>,
    iterations: Option<u64>,
    sleep_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct DaemonForegroundDiagnostics {
    schema_version: u32,
    tenex_base_dir: PathBuf,
    daemon_dir: PathBuf,
    started_at: u64,
    stopped_at: u64,
    completed_iterations: u64,
    max_iterations: Option<u64>,
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
    let options = parse_daemon_args(&args)?;
    validate_iterations(&options)?;
    install_signal_handlers()?;
    let mut clock = SystemDaemonMaintenanceLoopClock;
    let mut sleeper = ThreadDaemonMaintenanceLoopSleeper;
    let mut stop_signal = ProcessSignalStopSignal;
    let mut publisher = actual_relay_publisher(&options)?;
    let diagnostics = run_daemon_foreground(
        &options,
        &mut clock,
        &mut sleeper,
        &mut stop_signal,
        &mut publisher,
    )?;
    serde_json::to_string_pretty(&diagnostics).map_err(|error| runtime_error(error.to_string()))
}

fn run_daemon_foreground<C, S, Stop, P>(
    options: &DaemonCliOptions,
    clock: &mut C,
    sleeper: &mut S,
    stop_signal: &mut Stop,
    publisher: &mut P,
) -> Result<DaemonForegroundDiagnostics, CliError>
where
    C: DaemonMaintenanceLoopClock,
    S: DaemonMaintenanceLoopSleeper,
    Stop: DaemonMaintenanceLoopStopSignal,
    P: PublishOutboxRelayPublisher,
{
    validate_iterations(options)?;

    let (tenex_base_dir, daemon_dir) = resolve_daemon_paths(options)?;
    let shell = DaemonShell::new(&daemon_dir);
    let worker_command = build_agent_worker_command()?;
    let worker_config = AgentWorkerProcessConfig::default();
    let mut worker_runtime_state = WorkerRuntimeState::default();
    let mut worker_spawner = AgentWorkerProcessDispatchSpawner;
    let report = run_daemon_foreground_until_stopped_from_filesystem_with_worker(
        &shell,
        DaemonForegroundStoppableInput {
            tenex_base_dir: &tenex_base_dir,
            max_iterations: options.iterations,
            sleep_ms: options.sleep_ms,
            retry_policy: PublishOutboxRetryPolicy::default(),
        },
        DaemonForegroundWorkerInput {
            runtime_state: &mut worker_runtime_state,
            limits: WorkerConcurrencyLimits::default(),
            correlation_id_prefix: "daemon-foreground-worker".to_string(),
            command: worker_command,
            worker_config: &worker_config,
            writer_version: daemon_writer_version(),
            resolved_pending_delegations: Vec::new(),
            first_publish_result_sequence: Some(1),
            max_frames: DEFAULT_WORKER_MAX_FRAMES,
        },
        clock,
        sleeper,
        stop_signal,
        &mut worker_spawner,
        publisher,
    )
    .map_err(|error| runtime_error(error.to_string()))?;

    let stopped_at = current_unix_time_ms();
    let steps: Vec<DaemonForegroundStepDiagnostics> = report
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
        completed_iterations: steps.len() as u64,
        max_iterations: options.iterations,
        sleep_ms: options.sleep_ms,
        steps,
    })
}

fn build_agent_worker_command() -> Result<AgentWorkerCommand, CliError> {
    Ok(bun_agent_worker_command(&repository_root()?, bun_program())
        .env(WORKER_ENGINE_ENV, AGENT_WORKER_ENGINE))
}

fn repository_root() -> Result<PathBuf, CliError> {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .ok_or_else(|| runtime_error("failed to resolve repository root"))
}

fn bun_program() -> PathBuf {
    env::var_os("BUN_BIN")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("bun"))
}

fn daemon_writer_version() -> String {
    format!("tenex-daemon@{}", env!("CARGO_PKG_VERSION"))
}

fn actual_relay_publisher(options: &DaemonCliOptions) -> Result<NostrRelayPublisher, CliError> {
    let (tenex_base_dir, _) = resolve_daemon_paths(options)?;
    let backend_config =
        read_backend_config(&tenex_base_dir).map_err(|error| runtime_error(error.to_string()))?;
    let relay_config = RelayPublisherConfig::new(
        backend_config.effective_relay_urls(),
        Duration::from_millis(DEFAULT_RELAY_TIMEOUT_MS),
    )
    .map_err(|error| runtime_error(error.to_string()))?;
    let auth_signer = backend_config
        .backend_signer()
        .map_err(|error| runtime_error(error.to_string()))?;
    Ok(NostrRelayPublisher::with_auth_signer(
        relay_config,
        auth_signer,
    ))
}

fn validate_iterations(options: &DaemonCliOptions) -> Result<(), CliError> {
    if options.iterations == Some(0) {
        return Err(usage_error("--iterations must be greater than 0"));
    }

    Ok(())
}

fn parse_daemon_args(args: &[String]) -> Result<DaemonCliOptions, CliError> {
    if matches!(
        args.first().map(String::as_str),
        Some("help" | "--help" | "-h") | None
    ) {
        return Err(usage_error(usage()));
    }

    let mut daemon_dir = None;
    let mut tenex_base_dir = None;
    let mut iterations = None;
    let mut sleep_ms = DEFAULT_SLEEP_MS;
    let mut index = 0;

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

    if daemon_dir.is_none() && tenex_base_dir.is_none() {
        return Err(usage_error("--daemon-dir or --tenex-base-dir is required"));
    }

    Ok(DaemonCliOptions {
        daemon_dir,
        tenex_base_dir,
        iterations,
        sleep_ms,
    })
}

fn resolve_daemon_paths(options: &DaemonCliOptions) -> Result<(PathBuf, PathBuf), CliError> {
    let daemon_dir = match &options.daemon_dir {
        Some(daemon_dir) => daemon_dir.clone(),
        None => options
            .tenex_base_dir
            .as_ref()
            .map(|base_dir| base_dir.join("daemon"))
            .ok_or_else(|| usage_error("--daemon-dir or --tenex-base-dir is required"))?,
    };

    let tenex_base_dir = options
        .tenex_base_dir
        .clone()
        .unwrap_or_else(|| infer_tenex_base_dir(&daemon_dir));

    Ok((tenex_base_dir, daemon_dir))
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
        "  daemon --daemon-dir <path> [--iterations <count>] [--sleep-ms <ms>]",
        "  daemon --tenex-base-dir <path> [--iterations <count>] [--sleep-ms <ms>]",
    ]
    .join("\n")
}

#[derive(Debug, Clone, Copy, Default)]
struct ProcessSignalStopSignal;

impl DaemonMaintenanceLoopStopSignal for ProcessSignalStopSignal {
    fn should_stop(&mut self) -> bool {
        DAEMON_STOP_REQUESTED.load(Ordering::Relaxed)
    }
}

extern "C" fn request_daemon_stop(_signal: libc::c_int) {
    DAEMON_STOP_REQUESTED.store(true, Ordering::SeqCst);
}

fn install_signal_handlers() -> Result<(), CliError> {
    DAEMON_STOP_REQUESTED.store(false, Ordering::SeqCst);
    for signal in [libc::SIGINT, libc::SIGTERM] {
        install_signal_handler(signal)?;
    }
    Ok(())
}

fn install_signal_handler(signal: libc::c_int) -> Result<(), CliError> {
    let mut action = unsafe { std::mem::zeroed::<libc::sigaction>() };
    action.sa_sigaction = request_daemon_stop as usize;
    action.sa_flags = 0;
    let install_result = unsafe {
        libc::sigemptyset(&mut action.sa_mask);
        libc::sigaction(signal, &action, std::ptr::null_mut())
    };
    if install_result == -1 {
        return Err(runtime_error(format!(
            "failed to install signal handler for signal {signal}"
        )));
    }
    Ok(())
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
    use serde_json::Value;
    use std::collections::VecDeque;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    use secp256k1::{Keypair, Secp256k1, SecretKey};
    use tenex_daemon::backend_config::backend_config_path;
    use tenex_daemon::daemon_loop::NeverStopDaemonMaintenanceLoop;
    use tenex_daemon::nostr_event::SignedNostrEvent;
    use tenex_daemon::publish_outbox::{PublishRelayError, PublishRelayReport, PublishRelayResult};
    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);
    const TEST_SECRET_KEY_HEX: &str =
        "0101010101010101010101010101010101010101010101010101010101010101";

    #[derive(Debug, Default)]
    struct RecordingClock {
        now_ms_values: VecDeque<u64>,
        observed_now_ms_values: Vec<u64>,
    }

    impl DaemonMaintenanceLoopClock for RecordingClock {
        fn now_ms(&mut self) -> u64 {
            let now_ms = self
                .now_ms_values
                .pop_front()
                .expect("clock must have a value");
            self.observed_now_ms_values.push(now_ms);
            now_ms
        }
    }

    #[derive(Debug, Default)]
    struct RecordingSleeper {
        sleeps_ms: Vec<u64>,
    }

    impl DaemonMaintenanceLoopSleeper for RecordingSleeper {
        fn sleep_ms(&mut self, sleep_ms: u64) {
            self.sleeps_ms.push(sleep_ms);
        }
    }

    #[derive(Debug, Default)]
    struct RecordingPublisher {
        published_event_ids: Vec<String>,
    }

    impl PublishOutboxRelayPublisher for RecordingPublisher {
        fn publish_signed_event(
            &mut self,
            event: &SignedNostrEvent,
        ) -> Result<PublishRelayReport, PublishRelayError> {
            self.published_event_ids.push(event.id.clone());
            Ok(PublishRelayReport {
                relay_results: vec![PublishRelayResult {
                    relay_url: "wss://relay.one".to_string(),
                    accepted: true,
                    message: None,
                }],
            })
        }
    }

    #[test]
    fn parses_daemon_args_with_tenex_base_dir() {
        let options = parse_daemon_args(&[
            "--tenex-base-dir".to_string(),
            "/tmp/tenex".to_string(),
            "--iterations".to_string(),
            "2".to_string(),
            "--sleep-ms".to_string(),
            "25".to_string(),
        ])
        .expect("daemon args must parse");

        assert_eq!(options.tenex_base_dir, Some(PathBuf::from("/tmp/tenex")));
        assert!(options.daemon_dir.is_none());
        assert_eq!(options.iterations, Some(2));
        assert_eq!(options.sleep_ms, 25);
    }

    #[test]
    fn parses_daemon_args_without_iteration_cap() {
        let options =
            parse_daemon_args(&["--tenex-base-dir".to_string(), "/tmp/tenex".to_string()])
                .expect("daemon args must parse");

        assert_eq!(options.tenex_base_dir, Some(PathBuf::from("/tmp/tenex")));
        assert_eq!(options.iterations, None);
        assert_eq!(options.sleep_ms, DEFAULT_SLEEP_MS);
    }

    #[test]
    fn resolves_daemon_dir_from_base_dir() {
        let options = DaemonCliOptions {
            daemon_dir: None,
            tenex_base_dir: Some(PathBuf::from("/tmp/tenex")),
            iterations: Some(1),
            sleep_ms: 0,
        };

        let (tenex_base_dir, daemon_dir) =
            resolve_daemon_paths(&options).expect("paths must resolve");

        assert_eq!(tenex_base_dir, PathBuf::from("/tmp/tenex"));
        assert_eq!(daemon_dir, PathBuf::from("/tmp/tenex/daemon"));
    }

    #[test]
    fn resolves_base_dir_from_daemon_dir() {
        let options = DaemonCliOptions {
            daemon_dir: Some(PathBuf::from("/tmp/tenex/daemon")),
            tenex_base_dir: None,
            iterations: Some(1),
            sleep_ms: 0,
        };

        let (tenex_base_dir, daemon_dir) =
            resolve_daemon_paths(&options).expect("paths must resolve");

        assert_eq!(tenex_base_dir, PathBuf::from("/tmp/tenex"));
        assert_eq!(daemon_dir, PathBuf::from("/tmp/tenex/daemon"));
    }

    #[test]
    fn foreground_runner_serializes_diagnostics() {
        let fixture = foreground_fixture("foreground_runner_serializes_diagnostics");
        let options = DaemonCliOptions {
            daemon_dir: Some(fixture.daemon_dir.clone()),
            tenex_base_dir: Some(fixture.tenex_base_dir.clone()),
            iterations: Some(2),
            sleep_ms: 25,
        };
        let mut clock = RecordingClock {
            now_ms_values: VecDeque::from(vec![
                1_710_001_000_000,
                1_710_001_000_100,
                1_710_001_000_200,
            ]),
            observed_now_ms_values: Vec::new(),
        };
        let mut sleeper = RecordingSleeper::default();
        let mut stop_signal = NeverStopDaemonMaintenanceLoop;
        let mut publisher = RecordingPublisher::default();

        let diagnostics = run_daemon_foreground(
            &options,
            &mut clock,
            &mut sleeper,
            &mut stop_signal,
            &mut publisher,
        )
        .expect("foreground runner must succeed");

        assert_eq!(diagnostics.tenex_base_dir, fixture.tenex_base_dir);
        assert_eq!(diagnostics.daemon_dir, fixture.daemon_dir);
        assert_eq!(diagnostics.started_at, 1_710_001_000_000);
        assert_eq!(diagnostics.completed_iterations, 2);
        assert_eq!(diagnostics.max_iterations, Some(2));
        assert_eq!(diagnostics.sleep_ms, 25);
        assert_eq!(
            clock.observed_now_ms_values,
            vec![1_710_001_000_000, 1_710_001_000_100, 1_710_001_000_200]
        );
        assert_eq!(sleeper.sleeps_ms, vec![25]);
        assert_eq!(diagnostics.steps.len(), 2);
        assert_eq!(diagnostics.steps[0].iteration_index, 0);
        assert_eq!(diagnostics.steps[0].sleep_after_ms, Some(25));
        assert!(!publisher.published_event_ids.is_empty());

        let json = serde_json::to_value(&diagnostics).expect("diagnostics must serialize");
        assert_eq!(json["schemaVersion"], Value::from(1));
        assert_eq!(json["completedIterations"], Value::from(2));
        assert_eq!(json["maxIterations"], Value::from(2));
    }

    fn foreground_fixture(prefix: &str) -> ForegroundFixture {
        let tenex_base_dir = unique_temp_dir(prefix);
        let daemon_dir = tenex_base_dir.join("daemon");
        let agents_dir = tenex_base_dir.join("agents");
        fs::create_dir_all(&daemon_dir).expect("daemon dir must create");
        fs::create_dir_all(&agents_dir).expect("agents dir must create");
        fs::write(
            backend_config_path(&tenex_base_dir),
            format!(
                r#"{{
                    "whitelistedPubkeys": ["{}"],
                    "tenexPrivateKey": "{TEST_SECRET_KEY_HEX}",
                    "relays": ["wss://relay.one"]
                }}"#,
                pubkey_hex(0x02),
            ),
        )
        .expect("config must write");

        ForegroundFixture {
            tenex_base_dir,
            daemon_dir,
        }
    }

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be after UNIX_EPOCH")
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("{prefix}-{unique}-{counter}"))
    }

    struct ForegroundFixture {
        tenex_base_dir: PathBuf,
        daemon_dir: PathBuf,
    }

    fn pubkey_hex(fill_byte: u8) -> String {
        let secret_bytes = [fill_byte; 32];
        let secret = SecretKey::from_byte_array(secret_bytes).expect("valid secret");
        let secp = Secp256k1::new();
        let keypair = Keypair::from_secret_key(&secp, &secret);
        let (xonly, _) = keypair.x_only_public_key();
        hex::encode(xonly.serialize())
    }
}
