//! Process supervision for project runtimes and host-level companion daemons.
//!
//! `boot(d_tag)` / `boot_binary(key, path)` are idempotent: if a supervised
//! task for that key already exists the call is a no-op.  The d_tag is
//! appended as a positional argument to the boot argv.  Children run in their
//! own process group (setsid via `process_group(0)`), so a SIGTERM to the
//! group reaches every descendant on shutdown.

use std::collections::HashMap;
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::process::Command;
use tokio::sync::{watch, Mutex};
use tokio::task::JoinHandle;
use tracing::{debug, error, info, warn, Instrument};

use super::display;

/// Outcome of a single supervised child invocation, used to drive the surrounding
/// restart loop after the instrumented spawn-and-watch future completes.
enum ChildOutcome {
    /// Child exited cleanly (status 0); supervisor should stop restarting.
    CleanExit,
    /// Child crashed or `wait()` failed; supervisor should back off and restart.
    Crashed,
    /// `cmd.spawn()` itself failed; supervisor should back off and retry.
    SpawnFailed,
    /// Shutdown signalled and the child was terminated; supervisor should stop.
    ShutdownTerminated,
    /// `shutdown` channel changed but did not transition to `true` (reset path);
    /// supervisor should reset its backoff and re-enter the spawn loop.
    ShutdownReset,
}

const RESTART_BACKOFF_INITIAL_MS: u64 = 1_000;
const RESTART_BACKOFF_MAX_MS: u64 = 30_000;
const SIGTERM_GRACE_MS: u64 = 5_000;

/// Minimum spacing between project-runtime process spawns. Each runtime
/// opens its own ws connection and fires several REQ subscriptions on
/// startup; without spacing, daemon-startup with N projects causes N
/// connections + ~6N subscriptions to hit the relay in the same tick and
/// trip its REQ rate limit (HTTP 429). Companion daemons are not paced
/// — they boot once and don't subscribe in bursts.
const RUNTIME_BOOT_INTERVAL: Duration = Duration::from_millis(500);

#[derive(Clone)]
pub struct Supervisor {
    boot_argv: Arc<Vec<String>>,
    base_dir: Arc<PathBuf>,
    children: Arc<Mutex<HashMap<String, JoinHandle<()>>>>,
    shutdown_tx: watch::Sender<bool>,
    shutdown_rx: watch::Receiver<bool>,
    /// Earliest `Instant` at which the next project-runtime spawn is
    /// allowed. Each successful `boot()` reserves the next slot under
    /// this lock and the spawned task sleeps until it arrives.
    runtime_boot_pacer: Arc<Mutex<Instant>>,
}

impl Supervisor {
    pub fn new(boot_argv: Vec<String>, base_dir: PathBuf) -> Self {
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        Self {
            boot_argv: Arc::new(boot_argv),
            base_dir: Arc::new(base_dir),
            children: Arc::new(Mutex::new(HashMap::new())),
            shutdown_tx,
            shutdown_rx,
            runtime_boot_pacer: Arc::new(Mutex::new(Instant::now())),
        }
    }

    /// Reserve the next runtime-boot time slot. Returns how long the caller
    /// must wait before its spawn is permitted to run.
    async fn reserve_runtime_boot_slot(&self) -> Duration {
        let mut pacer = self.runtime_boot_pacer.lock().await;
        let now = Instant::now();
        let scheduled = (*pacer).max(now);
        *pacer = scheduled + RUNTIME_BOOT_INTERVAL;
        scheduled.saturating_duration_since(now)
    }

    pub async fn boot(&self, d_tag: String) {
        if *self.shutdown_rx.borrow() {
            return;
        }

        let mut children = self.children.lock().await;
        if children.contains_key(&d_tag) {
            debug!(d_tag, "already supervised");
            return;
        }

        let mut argv: Vec<String> = (*self.boot_argv).to_vec();
        argv.push(d_tag.clone());

        let base_dir = self.base_dir.clone();
        let mut shutdown = self.shutdown_rx.clone();
        let key = d_tag.clone();
        let boot_delay = self.reserve_runtime_boot_slot().await;
        if !boot_delay.is_zero() {
            debug!(
                d_tag = %d_tag,
                delay_ms = boot_delay.as_millis() as u64,
                "staggering runtime boot to spread relay load"
            );
        }

        let handle = tokio::spawn(async move {
            if !boot_delay.is_zero() {
                tokio::time::sleep(boot_delay).await;
            }
            supervise(&key, &argv, &base_dir, &mut shutdown).await;
        });

        children.insert(d_tag, handle);
    }

    /// Spawn and supervise a host-level companion daemon binary.
    ///
    /// `key` is an opaque identifier used for logging and idempotency.
    /// `path` is the absolute path to the binary (no extra args are passed).
    pub async fn boot_binary(&self, key: String, path: PathBuf) {
        self.boot_command(key, vec![path.to_string_lossy().into_owned()])
            .await;
    }

    /// Spawn and supervise an arbitrary command.
    ///
    /// `argv[0]` is the program and the remaining entries are arguments.
    pub async fn boot_command(&self, key: String, argv: Vec<String>) {
        if *self.shutdown_rx.borrow() {
            return;
        }

        let mut children = self.children.lock().await;
        if children.contains_key(&key) {
            debug!(key, "already supervised");
            return;
        }

        if argv.is_empty() {
            error!(key, "cannot supervise empty argv");
            return;
        }

        let base_dir = self.base_dir.clone();
        let mut shutdown = self.shutdown_rx.clone();
        let key_owned = key.clone();

        let handle = tokio::spawn(async move {
            supervise(&key_owned, &argv, &base_dir, &mut shutdown).await;
        });

        children.insert(key, handle);
    }

    pub async fn shutdown(&self) {
        let _ = self.shutdown_tx.send(true);
        let mut children = self.children.lock().await;
        let handles: Vec<_> = children.drain().collect();
        drop(children);
        for (key, handle) in handles {
            match handle.await {
                Ok(()) => info!(key, "child supervisor exited"),
                Err(e) if e.is_cancelled() => {}
                Err(e) => warn!(key, error = %e, "child supervisor join error"),
            }
        }
    }
}

async fn supervise(
    key: &str,
    argv: &[String],
    base_dir: &Path,
    shutdown: &mut watch::Receiver<bool>,
) {
    let mut backoff_ms = RESTART_BACKOFF_INITIAL_MS;

    loop {
        if *shutdown.borrow() {
            return;
        }

        let Some((program, args)) = argv.split_first() else {
            error!(key, "argv is empty");
            return;
        };

        let mut cmd = Command::new(program);
        cmd.args(args);
        cmd.env("TENEX_BASE_DIR", base_dir);
        cmd.stdin(Stdio::null());
        // Process group so SIGTERM here reaches grandchildren on shutdown.
        cmd.process_group(0);
        cmd.kill_on_drop(false);

        debug!(key, program = %program, "spawning service");

        let span = tracing::info_span!(
            "tenex.daemon.child_spawn",
            "supervised.key" = %key,
            "supervised.program" = %program,
            "exit.code" = tracing::field::Empty,
            "exit.signal" = tracing::field::Empty,
        );

        let outcome = async {
            let mut child = match cmd.spawn() {
                Ok(c) => c,
                Err(e) => {
                    error!(key, error = %e, "spawn failed");
                    tenex_telemetry::record_current_error(&e);
                    display::service_crashed(key, None);
                    return ChildOutcome::SpawnFailed;
                }
            };

            debug!(key, pid = ?child.id(), "service started");
            display::service_started(key);

            tokio::select! {
                res = child.wait() => match res {
                    Ok(status) if status.success() => {
                        tracing::Span::current().record("exit.code", 0_i64);
                        display::service_exited_cleanly(key);
                        ChildOutcome::CleanExit
                    }
                    Ok(status) => {
                        let code = status.code();
                        let signal = status.signal();
                        if let Some(c) = code {
                            tracing::Span::current().record("exit.code", c as i64);
                        }
                        if let Some(s) = signal {
                            tracing::Span::current().record("exit.signal", s as i64);
                        }
                        let crash = format!(
                            "child {key} exited with code={code:?} signal={signal:?}",
                        );
                        tenex_telemetry::record_current_error(&crash);
                        display::service_crashed(key, code);
                        ChildOutcome::Crashed
                    }
                    Err(e) => {
                        error!(key, error = %e, "wait failed");
                        tenex_telemetry::record_current_error(&e);
                        display::service_crashed(key, None);
                        ChildOutcome::Crashed
                    }
                },
                _ = shutdown.changed() => {
                    if *shutdown.borrow() {
                        terminate(key, &mut child).await;
                        ChildOutcome::ShutdownTerminated
                    } else {
                        ChildOutcome::ShutdownReset
                    }
                }
            }
        }
        .instrument(span)
        .await;

        match outcome {
            ChildOutcome::CleanExit | ChildOutcome::ShutdownTerminated => return,
            ChildOutcome::ShutdownReset => {
                backoff_ms = RESTART_BACKOFF_INITIAL_MS;
                continue;
            }
            ChildOutcome::Crashed | ChildOutcome::SpawnFailed => {
                if !sleep_or_shutdown(backoff_ms, shutdown).await {
                    return;
                }
                backoff_ms = (backoff_ms.saturating_mul(2)).min(RESTART_BACKOFF_MAX_MS);
            }
        }
    }
}

async fn sleep_or_shutdown(ms: u64, shutdown: &mut watch::Receiver<bool>) -> bool {
    tokio::select! {
        _ = tokio::time::sleep(Duration::from_millis(ms)) => true,
        _ = shutdown.changed() => !*shutdown.borrow(),
    }
}

async fn terminate(key: &str, child: &mut tokio::process::Child) {
    let Some(pid) = child.id() else {
        return;
    };
    info!(key, pid, "sending SIGTERM to process group");
    // Negative pid = process group. SAFETY: pid was provided by tokio, valid for kill().
    unsafe {
        libc::kill(-(pid as i32), libc::SIGTERM);
    }

    let grace = tokio::time::sleep(Duration::from_millis(SIGTERM_GRACE_MS));
    tokio::select! {
        _ = child.wait() => {}
        _ = grace => {
            warn!(key, pid, "child did not exit within grace period; sending SIGKILL");
            unsafe { libc::kill(-(pid as i32), libc::SIGKILL); }
            let _ = child.wait().await;
        }
    }
}
