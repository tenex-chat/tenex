//! Reap orphaned companion daemons left behind by a previous supervisor.
//!
//! Companions are spawned in their own process group so SIGTERM to the
//! supervisor reaches them on graceful shutdown. If the supervisor is
//! killed ungracefully (SIGKILL, terminal force-close, panic before
//! shutdown completes) the children survive, keep their flock-held pid
//! files, and block the next supervisor from booting fresh copies.
//!
//! Once we hold our own daemon lockfile we are by definition the sole
//! authority for this base_dir, so any process still flock-holding a
//! companion pid file is an orphan from a previous run. Reap it.
//!
//! Reaping uses flock as the source of truth: flock is kernel-released
//! on process death, so a held lock means the holder is alive. The pid
//! recorded in the file is reliable while that holder is alive.
//!
//! SIGTERM is given a 5s grace; SIGKILL gets another 2s. Failure to
//! release the lock after both is a fatal startup error — the user
//! gets the pid and lockfile path so they can intervene manually.
//!
//! Identity is reaped here too even though it boots through a
//! different path: it follows the same flock pattern and its orphan
//! would otherwise keep serving the unix socket from a previous run.

use std::fs::OpenOptions;
use std::io::ErrorKind;
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use tracing::warn;

use super::display;

const SIGTERM_GRACE: Duration = Duration::from_millis(5_000);
const SIGKILL_GRACE: Duration = Duration::from_millis(2_000);
const POLL_INTERVAL: Duration = Duration::from_millis(100);

/// (label, pid filename within base_dir) for every companion that uses a
/// flock-held pid file. Telegram has no lockfile; embedder is not
/// supervised by this daemon and may run independently.
pub fn reap_targets() -> &'static [(&'static str, &'static str)] {
    &[
        ("identity", "identity.pid"),
        ("summarizer", "summarizer.pid"),
        ("scheduler", "scheduler.pid"),
        ("intervention", "intervention.pid"),
    ]
}

pub fn reap_orphans(base_dir: &Path) -> Result<()> {
    for (label, filename) in reap_targets() {
        reap_one(label, base_dir.join(filename))?;
    }
    Ok(())
}

fn reap_one(label: &str, path: PathBuf) -> Result<()> {
    let Some(pid) = locked_pid(&path)? else {
        return Ok(());
    };

    warn!(label, pid, path = %path.display(), "reaping orphan companion daemon");
    display::orphan_reaped(label, pid);

    unsafe { libc::kill(pid, libc::SIGTERM) };
    if wait_until_released(&path, SIGTERM_GRACE)? {
        return Ok(());
    }

    warn!(label, pid, "orphan did not exit on SIGTERM; sending SIGKILL");
    unsafe { libc::kill(pid, libc::SIGKILL) };
    if wait_until_released(&path, SIGKILL_GRACE)? {
        return Ok(());
    }

    Err(anyhow!(
        "failed to reap orphan {label} (pid {pid}); lockfile {} still held — kill the process manually",
        path.display()
    ))
}

/// Returns Some(pid) if a process is currently flock-holding `path`,
/// None if the file is absent or the lock is free.
fn locked_pid(path: &Path) -> Result<Option<i32>> {
    let probe = match OpenOptions::new().read(true).write(true).open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(e).with_context(|| format!("open {}", path.display()));
        }
    };
    if try_flock_nb(probe.as_raw_fd())? {
        // Released our test lock by dropping the FD; no orphan.
        return Ok(None);
    }
    drop(probe);

    let contents = std::fs::read_to_string(path)
        .with_context(|| format!("read pid from {}", path.display()))?;
    let pid: i32 = contents.trim().parse().map_err(|_| {
        anyhow!(
            "{} is flock-held but contains no parseable pid; remove it or kill the holder manually",
            path.display()
        )
    })?;
    Ok(Some(pid))
}

fn wait_until_released(path: &Path, grace: Duration) -> Result<bool> {
    let deadline = Instant::now() + grace;
    loop {
        match OpenOptions::new().read(true).write(true).open(path) {
            Ok(probe) => {
                if try_flock_nb(probe.as_raw_fd())? {
                    return Ok(true);
                }
            }
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(true),
            Err(e) => {
                return Err(e).with_context(|| format!("reopen {}", path.display()));
            }
        }
        if Instant::now() >= deadline {
            return Ok(false);
        }
        thread::sleep(POLL_INTERVAL);
    }
}

fn try_flock_nb(fd: i32) -> Result<bool> {
    let rc = unsafe { libc::flock(fd, libc::LOCK_EX | libc::LOCK_NB) };
    if rc == 0 {
        return Ok(true);
    }
    let err = std::io::Error::last_os_error();
    match err.raw_os_error() {
        Some(libc::EWOULDBLOCK) => Ok(false),
        _ => Err(err).context("flock"),
    }
}
