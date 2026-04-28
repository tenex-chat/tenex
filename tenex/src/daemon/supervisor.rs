//! Per-project process supervision.
//!
//! `boot(d_tag)` is idempotent: if a child for that d-tag is already running
//! or pending restart, the call is a no-op. Children run in their own process
//! group (setsid via `process_group(0)`), so a SIGTERM to the group reaches
//! every descendant on shutdown.

use std::collections::HashMap;
use std::path::PathBuf;
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

        let boot_argv = self.boot_argv.clone();
        let base_dir = self.base_dir.clone();
        let mut shutdown = self.shutdown_rx.clone();
        let d_tag_owned = d_tag.clone();

        let handle = tokio::spawn(async move {
            supervise(&d_tag_owned, &boot_argv, &base_dir, &mut shutdown).await;
        });

        children.insert(d_tag, handle);
    }

    pub async fn shutdown(&self) {
        let _ = self.shutdown_tx.send(true);
        let mut children = self.children.lock().await;
        let handles: Vec<_> = children.drain().collect();
        drop(children);
        for (d_tag, handle) in handles {
            match handle.await {
                Ok(()) => info!(d_tag, "child supervisor exited"),
                Err(e) if e.is_cancelled() => {}
                Err(e) => warn!(d_tag, error = %e, "child supervisor join error"),
            }
        }
    }
}

async fn supervise(
    d_tag: &str,
    boot_argv: &[String],
    base_dir: &std::path::Path,
    shutdown: &mut watch::Receiver<bool>,
) {
    let mut backoff_ms = RESTART_BACKOFF_INITIAL_MS;

    loop {
        if *shutdown.borrow() {
            return;
        }

        let Some((program, args)) = boot_argv.split_first() else {
            error!(d_tag, "boot command is empty");
            return;
        };

        let mut cmd = Command::new(program);
        cmd.args(args);
        cmd.arg("--boot").arg(d_tag);
        cmd.env("TENEX_BASE_DIR", base_dir);
        cmd.stdin(Stdio::null());
        // Process group so SIGTERM here reaches grandchildren on shutdown.
        cmd.process_group(0);
        cmd.kill_on_drop(false);

        info!(d_tag, program = %program, "spawning project runtime");
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                error!(d_tag, error = %e, "spawn failed");
                if !sleep_or_shutdown(backoff_ms, shutdown).await {
                    return;
                }
                backoff_ms = (backoff_ms.saturating_mul(2)).min(RESTART_BACKOFF_MAX_MS);
                continue;
            }
        };

        let pid = child.id();
        info!(d_tag, ?pid, "project runtime started");

        let exited_cleanly = tokio::select! {
            res = child.wait() => {
                match res {
                    Ok(status) => {
                        warn!(d_tag, code = ?status.code(), "project exited");
                        false
                    }
                    Err(e) => {
                        error!(d_tag, error = %e, "wait failed");
                        false
                    }
                }
            }
            _ = shutdown.changed() => {
                if *shutdown.borrow() {
                    terminate(d_tag, &mut child).await;
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

async fn terminate(d_tag: &str, child: &mut tokio::process::Child) {
    let Some(pid) = child.id() else {
        return;
    };
    info!(d_tag, pid, "sending SIGTERM to process group");
    // Negative pid = process group. SAFETY: pid was provided by tokio, valid for kill().
    unsafe {
        libc::kill(-(pid as i32), libc::SIGTERM);
    }

    let grace = tokio::time::sleep(Duration::from_millis(SIGTERM_GRACE_MS));
    tokio::select! {
        _ = child.wait() => {}
        _ = grace => {
            warn!(d_tag, pid, "child did not exit within grace period; sending SIGKILL");
            unsafe { libc::kill(-(pid as i32), libc::SIGKILL); }
            let _ = child.wait().await;
        }
    }
}
