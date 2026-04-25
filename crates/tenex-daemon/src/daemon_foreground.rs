use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use thiserror::Error;

use crate::backend_heartbeat_latch::BackendHeartbeatLatchPlanner;
use crate::daemon_loop::{
    DaemonMaintenanceLoopClock, DaemonMaintenanceLoopError, DaemonMaintenanceLoopOutcome,
    DaemonMaintenanceLoopSleeper, DaemonMaintenanceLoopStopSignal, DaemonTickError,
    DaemonTickOutcome, run_daemon_maintenance_loop, run_daemon_maintenance_loop_until_stopped,
    run_daemon_tick_once_from_filesystem,
};
use crate::daemon_shell::{DaemonShell, DaemonShellError, DaemonShellStopMode};
use crate::process_liveness::ProcessLivenessProbe;
use crate::project_boot_state::ProjectBootState;
use crate::project_event_index::ProjectEventIndex;
use crate::publish_outbox::PublishOutboxRelayPublisher;
use crate::publish_outbox::PublishOutboxRetryPolicy;

#[derive(Debug, Clone)]
pub struct DaemonForegroundInput<'a> {
    pub tenex_base_dir: &'a Path,
    pub max_iterations: u64,
    pub sleep_ms: u64,
    pub retry_policy: PublishOutboxRetryPolicy,
    pub project_boot_state: Arc<Mutex<ProjectBootState>>,
    pub project_event_index: Arc<Mutex<ProjectEventIndex>>,
    /// Optional latch shared with the whitelist ingress; when present, the
    /// inner maintenance loop gates the kind 24012 heartbeat on it.
    pub heartbeat_latch: Option<Arc<Mutex<BackendHeartbeatLatchPlanner>>>,
}

#[derive(Debug, Clone)]
pub struct DaemonForegroundStoppableInput<'a> {
    pub tenex_base_dir: &'a Path,
    pub max_iterations: Option<u64>,
    pub sleep_ms: u64,
    pub retry_policy: PublishOutboxRetryPolicy,
    pub project_boot_state: Arc<Mutex<ProjectBootState>>,
    pub project_event_index: Arc<Mutex<ProjectEventIndex>>,
    /// See [`DaemonForegroundInput::heartbeat_latch`].
    pub heartbeat_latch: Option<Arc<Mutex<BackendHeartbeatLatchPlanner>>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DaemonForegroundReport {
    pub tenex_base_dir: PathBuf,
    pub daemon_dir: PathBuf,
    pub started_at_ms: u64,
    pub tick_loop: DaemonMaintenanceLoopOutcome<DaemonTickOutcome>,
}

#[derive(Debug, Error)]
pub enum DaemonForegroundError {
    #[error("daemon foreground start failed: {source}")]
    Start {
        #[source]
        source: DaemonShellError,
    },
    #[error("daemon foreground tick loop failed: {source}")]
    Tick {
        #[source]
        source: Box<DaemonMaintenanceLoopError<DaemonTickError>>,
    },
    #[error("daemon foreground tick loop failed: {source}; shutdown also failed: {stop_error}")]
    TickAndStop {
        #[source]
        source: Box<DaemonMaintenanceLoopError<DaemonTickError>>,
        stop_error: DaemonShellError,
    },
    #[error("daemon foreground shutdown failed after successful tick loop: {source}")]
    Shutdown {
        report: Box<DaemonForegroundReport>,
        #[source]
        source: DaemonShellError,
    },
}

pub fn run_daemon_foreground_from_filesystem<C, S, P, Probe>(
    shell: &DaemonShell<Probe>,
    input: DaemonForegroundInput<'_>,
    clock: &mut C,
    sleeper: &mut S,
    publisher: &Arc<Mutex<P>>,
) -> Result<DaemonForegroundReport, DaemonForegroundError>
where
    Probe: ProcessLivenessProbe + Clone,
    C: DaemonMaintenanceLoopClock,
    S: DaemonMaintenanceLoopSleeper,
    P: PublishOutboxRelayPublisher,
{
    let started_at_ms = clock.now_ms();
    let session = shell
        .start_foreground(started_at_ms)
        .map_err(|source| DaemonForegroundError::Start { source })?;

    let daemon_dir = shell.daemon_dir().to_path_buf();
    let tick_result = run_daemon_maintenance_loop(
        clock,
        sleeper,
        input.max_iterations,
        input.sleep_ms,
        |now_ms| {
            run_daemon_tick_once_from_filesystem(
                crate::daemon_maintenance::DaemonMaintenanceInput {
                    tenex_base_dir: input.tenex_base_dir,
                    daemon_dir: &daemon_dir,
                    now_ms,
                    project_boot_state: input
                        .project_boot_state
                        .lock()
                        .expect("project boot state mutex poisoned")
                        .snapshot(),
                    project_event_index: Arc::clone(&input.project_event_index),
                    heartbeat_latch: input.heartbeat_latch.clone(),
                    dispatch_enqueued_tx: None,
                },
                publisher,
                input.retry_policy,
            )
        },
    );

    match tick_result {
        Ok(tick_loop) => {
            let report = DaemonForegroundReport {
                tenex_base_dir: input.tenex_base_dir.to_path_buf(),
                daemon_dir: daemon_dir.clone(),
                started_at_ms,
                tick_loop,
            };
            match session.stop(DaemonShellStopMode::Shutdown) {
                Ok(()) => Ok(report),
                Err(source) => Err(DaemonForegroundError::Shutdown {
                    report: Box::new(report),
                    source,
                }),
            }
        }
        Err(source) => match session.stop(DaemonShellStopMode::Shutdown) {
            Ok(()) => Err(DaemonForegroundError::Tick {
                source: Box::new(source),
            }),
            Err(stop_error) => Err(DaemonForegroundError::TickAndStop {
                source: Box::new(source),
                stop_error,
            }),
        },
    }
}

pub fn run_daemon_foreground_until_stopped_from_filesystem<C, S, Stop, P, Probe>(
    shell: &DaemonShell<Probe>,
    input: DaemonForegroundStoppableInput<'_>,
    clock: &mut C,
    sleeper: &mut S,
    stop_signal: &mut Stop,
    publisher: &Arc<Mutex<P>>,
) -> Result<DaemonForegroundReport, DaemonForegroundError>
where
    Probe: ProcessLivenessProbe + Clone,
    C: DaemonMaintenanceLoopClock,
    S: DaemonMaintenanceLoopSleeper,
    Stop: DaemonMaintenanceLoopStopSignal,
    P: PublishOutboxRelayPublisher,
{
    let started_at_ms = clock.now_ms();
    let session = shell
        .start_foreground(started_at_ms)
        .map_err(|source| DaemonForegroundError::Start { source })?;

    let daemon_dir = shell.daemon_dir().to_path_buf();
    let tick_result = run_daemon_maintenance_loop_until_stopped(
        clock,
        sleeper,
        stop_signal,
        input.max_iterations,
        input.sleep_ms,
        |now_ms| {
            run_daemon_tick_once_from_filesystem(
                crate::daemon_maintenance::DaemonMaintenanceInput {
                    tenex_base_dir: input.tenex_base_dir,
                    daemon_dir: &daemon_dir,
                    now_ms,
                    project_boot_state: input
                        .project_boot_state
                        .lock()
                        .expect("project boot state mutex poisoned")
                        .snapshot(),
                    project_event_index: Arc::clone(&input.project_event_index),
                    heartbeat_latch: input.heartbeat_latch.clone(),
                    dispatch_enqueued_tx: None,
                },
                publisher,
                input.retry_policy,
            )
        },
    );

    match tick_result {
        Ok(tick_loop) => {
            let report = DaemonForegroundReport {
                tenex_base_dir: input.tenex_base_dir.to_path_buf(),
                daemon_dir: daemon_dir.clone(),
                started_at_ms,
                tick_loop,
            };
            match session.stop(DaemonShellStopMode::Shutdown) {
                Ok(()) => Ok(report),
                Err(source) => Err(DaemonForegroundError::Shutdown {
                    report: Box::new(report),
                    source,
                }),
            }
        }
        Err(source) => match session.stop(DaemonShellStopMode::Shutdown) {
            Ok(()) => Err(DaemonForegroundError::Tick {
                source: Box::new(source),
            }),
            Err(stop_error) => Err(DaemonForegroundError::TickAndStop {
                source: Box::new(source),
                stop_error,
            }),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend_config::backend_config_path;
    use crate::filesystem_state::{read_lock_info_file, read_status_file};
    use crate::nostr_event::SignedNostrEvent;
    use crate::process_liveness::ProcessLivenessProbe;
    use crate::publish_outbox::{
        PublishRelayError, PublishRelayReport, PublishRelayResult, inspect_publish_outbox,
    };
    use crate::ral_lock::RalLockOwnerProcessStatus;
    use secp256k1::{Keypair, Secp256k1, SecretKey};
    use serde_json::json;
    use std::collections::VecDeque;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{SystemTime, UNIX_EPOCH};

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

    #[derive(Debug)]
    struct StopAfterChecks {
        checks: usize,
        stop_on_or_after: usize,
    }

    impl DaemonMaintenanceLoopStopSignal for StopAfterChecks {
        fn should_stop(&mut self) -> bool {
            self.checks += 1;
            self.checks >= self.stop_on_or_after
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

    #[derive(Debug, Clone)]
    struct FixedProbe {
        status: RalLockOwnerProcessStatus,
    }

    impl ProcessLivenessProbe for FixedProbe {
        fn process_status(&self, _pid: u32) -> RalLockOwnerProcessStatus {
            self.status
        }
    }
    #[test]
    fn foreground_runner_runs_the_tick_loop_and_shuts_down() {
        let fixture = foreground_fixture("foreground_runner_runs_the_tick_loop_and_shuts_down");
        let shell = test_shell(&fixture.daemon_dir);
        let mut clock = RecordingClock {
            now_ms_values: VecDeque::from(vec![
                1_710_001_000_000,
                1_710_001_000_100,
                1_710_001_000_200,
            ]),
            observed_now_ms_values: Vec::new(),
        };
        let mut sleeper = RecordingSleeper::default();
        let publisher = Arc::new(Mutex::new(RecordingPublisher::default()));
        let project_event_index = Arc::new(Mutex::new(ProjectEventIndex::new()));

        let report = run_daemon_foreground_from_filesystem(
            &shell,
            DaemonForegroundInput {
                tenex_base_dir: &fixture.tenex_base_dir,
                max_iterations: 2,
                sleep_ms: 25,
                retry_policy: PublishOutboxRetryPolicy::default(),
                project_boot_state: empty_project_boot_state(),
                project_event_index: Arc::clone(&project_event_index),
                heartbeat_latch: None,
            },
            &mut clock,
            &mut sleeper,
            &publisher,
        )
        .expect("foreground runner must succeed");

        assert_eq!(report.tenex_base_dir, fixture.tenex_base_dir);
        assert_eq!(report.daemon_dir, fixture.daemon_dir);
        assert_eq!(report.started_at_ms, 1_710_001_000_000);
        assert_eq!(
            clock.observed_now_ms_values,
            vec![1_710_001_000_000, 1_710_001_000_100, 1_710_001_000_200]
        );
        assert_eq!(sleeper.sleeps_ms, vec![25]);
        assert_eq!(report.tick_loop.steps.len(), 2);
        assert_eq!(report.tick_loop.steps[0].iteration_index, 0);
        assert_eq!(report.tick_loop.steps[1].iteration_index, 1);
        assert_eq!(report.tick_loop.steps[0].sleep_after_ms, Some(25));
        assert_eq!(report.tick_loop.steps[1].sleep_after_ms, None);
        // Backend-status (kind 24012/24011) now publishes from the dedicated
        // backend_status_driver, not from the central tick. With no booted
        // projects in the fixture, the tick has nothing to publish.
        assert!(publisher.lock().unwrap().published_event_ids.is_empty());
        assert_eq!(
            read_lock_info_file(&fixture.daemon_dir).expect("lock read must succeed"),
            None
        );
        assert_eq!(
            read_status_file(&fixture.daemon_dir).expect("status read must succeed"),
            None
        );
        let publish_outbox = inspect_publish_outbox(&fixture.daemon_dir, 1_710_001_000_200)
            .expect("publish outbox diagnostics must read");
        assert_eq!(publish_outbox.pending_count, 0);
        assert_eq!(publish_outbox.published_count, 0);
    }

    #[test]
    fn foreground_runner_until_stopped_honors_stop_signal_and_shuts_down() {
        let fixture =
            foreground_fixture("foreground_runner_until_stopped_honors_stop_signal_and_shuts_down");
        let shell = test_shell(&fixture.daemon_dir);
        let mut clock = RecordingClock {
            now_ms_values: VecDeque::from(vec![1_710_001_000_000, 1_710_001_000_100]),
            observed_now_ms_values: Vec::new(),
        };
        let mut sleeper = RecordingSleeper::default();
        let mut stop_signal = StopAfterChecks {
            checks: 0,
            stop_on_or_after: 2,
        };
        let publisher = Arc::new(Mutex::new(RecordingPublisher::default()));
        let project_event_index = Arc::new(Mutex::new(ProjectEventIndex::new()));

        let report = run_daemon_foreground_until_stopped_from_filesystem(
            &shell,
            DaemonForegroundStoppableInput {
                tenex_base_dir: &fixture.tenex_base_dir,
                max_iterations: None,
                sleep_ms: 25,
                retry_policy: PublishOutboxRetryPolicy::default(),
                project_boot_state: empty_project_boot_state(),
                project_event_index: Arc::clone(&project_event_index),
                heartbeat_latch: None,
            },
            &mut clock,
            &mut sleeper,
            &mut stop_signal,
            &publisher,
        )
        .expect("foreground runner must stop cleanly");

        assert_eq!(report.tick_loop.steps.len(), 1);
        assert_eq!(
            clock.observed_now_ms_values,
            vec![1_710_001_000_000, 1_710_001_000_100]
        );
        assert!(sleeper.sleeps_ms.is_empty());
        assert_eq!(stop_signal.checks, 2);
        // Backend-status now publishes from the dedicated driver; with no
        // booted projects the central tick has nothing to publish.
        assert!(publisher.lock().unwrap().published_event_ids.is_empty());
        assert_eq!(
            read_lock_info_file(&fixture.daemon_dir).expect("lock read must succeed"),
            None
        );
        assert_eq!(
            read_status_file(&fixture.daemon_dir).expect("status read must succeed"),
            None
        );
    }


    #[test]
    fn foreground_runner_releases_lock_and_status_when_the_tick_loop_fails() {
        let daemon_dir = unique_temp_daemon_dir();
        let shell = test_shell(&daemon_dir);
        let mut clock = RecordingClock {
            now_ms_values: VecDeque::from(vec![1_710_001_100_000, 1_710_001_100_100]),
            observed_now_ms_values: Vec::new(),
        };
        let mut sleeper = RecordingSleeper::default();
        let publisher = Arc::new(Mutex::new(RecordingPublisher::default()));
        let project_event_index = Arc::new(Mutex::new(ProjectEventIndex::new()));

        let error = run_daemon_foreground_from_filesystem(
            &shell,
            DaemonForegroundInput {
                tenex_base_dir: &daemon_dir,
                max_iterations: 1,
                sleep_ms: 25,
                retry_policy: PublishOutboxRetryPolicy::default(),
                project_boot_state: empty_project_boot_state(),
                project_event_index: Arc::clone(&project_event_index),
                heartbeat_latch: None,
            },
            &mut clock,
            &mut sleeper,
            &publisher,
        )
        .expect_err("missing backend config must fail the tick loop");

        match error {
            DaemonForegroundError::Tick { source } => {
                let message = source.to_string();
                assert!(
                    message.contains("config.json"),
                    "unexpected tick failure: {source}"
                );
            }
            other => panic!("unexpected error: {other:?}"),
        }
        assert_eq!(
            read_lock_info_file(&daemon_dir).expect("lock read must succeed"),
            None
        );
        assert_eq!(
            read_status_file(&daemon_dir).expect("status read must succeed"),
            None
        );
        assert!(sleeper.sleeps_ms.is_empty());
        assert!(publisher.lock().unwrap().published_event_ids.is_empty());

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[derive(Debug)]
    struct ForegroundFixture {
        tenex_base_dir: PathBuf,
        daemon_dir: PathBuf,
    }

    impl Drop for ForegroundFixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.tenex_base_dir);
        }
    }

    fn foreground_fixture(prefix: &str) -> ForegroundFixture {
        let tenex_base_dir = unique_temp_dir(prefix);
        let daemon_dir = tenex_base_dir.join("daemon");
        let agents_dir = tenex_base_dir.join("agents");
        let projects_dir = tenex_base_dir.join("projects");
        fs::create_dir_all(&daemon_dir).expect("daemon dir must create");
        fs::create_dir_all(&agents_dir).expect("agents dir must create");
        fs::create_dir_all(&projects_dir).expect("projects dir must create");
        let config = json!({
            "whitelistedPubkeys": [owner_pubkey(0x02)],
            "tenexPrivateKey": TEST_SECRET_KEY_HEX,
            "relays": ["wss://relay.one"],
        });
        fs::write(
            backend_config_path(&tenex_base_dir),
            serde_json::to_string_pretty(&config).expect("config json must serialize"),
        )
        .expect("config must write");

        ForegroundFixture {
            tenex_base_dir,
            daemon_dir,
        }
    }

    fn empty_project_boot_state() -> Arc<Mutex<ProjectBootState>> {
        Arc::new(Mutex::new(ProjectBootState::new()))
    }

    fn test_shell(daemon_dir: &Path) -> DaemonShell<FixedProbe> {
        DaemonShell::with_identity(
            daemon_dir.to_path_buf(),
            FixedProbe {
                status: RalLockOwnerProcessStatus::Running,
            },
            4242,
            "tenex-host",
        )
    }

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be after UNIX_EPOCH")
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("{prefix}-{unique}-{counter}"))
    }

    fn unique_temp_daemon_dir() -> PathBuf {
        unique_temp_dir("daemon-foreground")
    }

    fn owner_pubkey(fill_byte: u8) -> String {
        let secret_bytes = [fill_byte; 32];
        let secret = SecretKey::from_byte_array(secret_bytes).expect("valid secret");
        let secp = Secp256k1::new();
        let keypair = Keypair::from_secret_key(&secp, &secret);
        let (xonly, _) = keypair.x_only_public_key();
        hex::encode(xonly.serialize())
    }
}
