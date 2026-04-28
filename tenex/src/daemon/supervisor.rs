//! Process supervision for project runtimes and host-level companion daemons.
//!
//! `boot(d_tag)` / `boot_binary(key, path)` are idempotent: if a supervised
//! task for that key already exists the call is a no-op. Children run in their
//! own process group (setsid via `process_group(0)`), so a SIGTERM to the
//! group reaches every descendant on shutdown.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use tokio::process::Command;
use tokio::sync::{watch, Mutex};
use tokio::task::JoinHandle;
use tracing::{debug, error, info, warn};

const RESTART_BACKOFF_INITIAL_MS: u64 = 1_000;
const RESTART_BACKOFF_MAX_MS: u64 = 30_000;
const SIGTERM_GRACE_MS: u64 = 5_000;

#[derive(Clone)]
pub struct Supervisor {
    boot_argv: Arc<Vec<String>>,
    base_dir: Arc<PathBuf>,
    children: Arc<Mutex<HashMap<String, JoinHandle<()>>>>,
    shutdown_tx: watch::Sender<bool>,
    shutdown_rx: watch::Receiver<bool>,
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
        }
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
        argv.push("--boot".into());
        argv.push(d_tag.clone());

        let base_dir = self.base_dir.clone();
        let mut shutdown = self.shutdown_rx.clone();
        let key = d_tag.clone();

        let handle = tokio::spawn(async move {
            supervise(&key, &argv, &base_dir, &mut shutdown).await;
        });

        children.insert(d_tag, handle);
    }

    /// Spawn and supervise a host-level companion daemon binary.
    ///
    /// `key` is an opaque identifier used for logging and idempotency.
    /// `path` is the absolute path to the binary (no extra args are passed).
    pub async fn boot_binary(&self, key: String, path: PathBuf) {
        if *self.shutdown_rx.borrow() {
            return;
        }

        let mut children = self.children.lock().await;
        if children.contains_key(&key) {
            debug!(key, "already supervised");
            return;
        }

        let argv = vec![path.to_string_lossy().into_owned()];
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

        info!(key, program = %program, "spawning service");
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                error!(key, error = %e, "spawn failed");
                if !sleep_or_shutdown(backoff_ms, shutdown).await {
                    return;
                }
                backoff_ms = (backoff_ms.saturating_mul(2)).min(RESTART_BACKOFF_MAX_MS);
                continue;
            }
        };

        let pid = child.id();
        info!(key, ?pid, "service started");

        let exited_cleanly = tokio::select! {
            res = child.wait() => {
                match res {
                    Ok(status) => {
                        warn!(key, code = ?status.code(), "service exited");
                        false
                    }
                    Err(e) => {
                        error!(key, error = %e, "wait failed");
                        false
                    }
                }
            }
            _ = shutdown.changed() => {
                if *shutdown.borrow() {
                    terminate(key, &mut child).await;
                    return;
                }
                true
            }
        };

        if exited_cleanly {
            // Reset backoff after a healthy run that we ended ourselves.
            backoff_ms = RESTART_BACKOFF_INITIAL_MS;
        }

        if !sleep_or_shutdown(backoff_ms, shutdown).await {
            return;
        }
        backoff_ms = (backoff_ms.saturating_mul(2)).min(RESTART_BACKOFF_MAX_MS);
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
