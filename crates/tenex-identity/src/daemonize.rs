use anyhow::{Context, Result};
use nix::sys::wait::waitpid;
use nix::unistd::{chdir, dup2, fork, setsid, ForkResult};
use std::fs::OpenOptions;
use std::os::unix::io::AsRawFd;
use std::path::Path;
use std::process::exit;

pub enum Role {
    Caller,
    Daemon,
}

/// Classic double-fork: caller's process tree gets a session-leaderless,
/// reparented-to-init grandchild. The intermediate child's exit is reaped
/// here so the caller doesn't leave a zombie.
pub fn spawn_daemon() -> Result<Role> {
    match unsafe { fork() }.context("first fork")? {
        ForkResult::Parent { child } => {
            waitpid(child, None).context("waitpid intermediate child")?;
            Ok(Role::Caller)
        }
        ForkResult::Child => {
            setsid().context("setsid")?;
            match unsafe { fork() }.context("second fork")? {
                ForkResult::Parent { .. } => exit(0),
                ForkResult::Child => Ok(Role::Daemon),
            }
        }
    }
}

/// Redirect stdin from /dev/null and stdout+stderr to the log file.
pub fn detach_stdio(log_path: &Path) -> Result<()> {
    chdir("/").context("chdir /")?;

    let dev_null = OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/null")
        .context("open /dev/null")?;
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .with_context(|| format!("open log {}", log_path.display()))?;

    dup2(dev_null.as_raw_fd(), 0).context("dup2 stdin")?;
    dup2(log.as_raw_fd(), 1).context("dup2 stdout")?;
    dup2(log.as_raw_fd(), 2).context("dup2 stderr")?;

    Ok(())
}
