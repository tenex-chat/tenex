//! `flock`-based singleton lockfile. Identical pattern to
//! `tenex-summarizer::lockfile`. Held for the lifetime of the daemon.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

pub struct Lockfile {
    path: PathBuf,
    file: Option<File>,
}

impl Lockfile {
    /// Acquire an exclusive non-blocking flock on `path`. Returns an
    /// error if another process already holds the lock.
    pub fn acquire(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create dir {}", parent.display()))?;
        }
        // Open without truncation: a concurrent failing-to-acquire
        // process must NOT clobber the existing holder's pid file.
        // Truncation is deferred until after we own the flock.
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)
            .with_context(|| format!("open lockfile {}", path.display()))?;

        let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if rc != 0 {
            return Err(anyhow::anyhow!(
                "another tenex-embedder is already running (lockfile: {})",
                path.display()
            ));
        }

        // Now that we own the lock, replace any stale contents from a
        // previous holder with our own pid.
        file.set_len(0)
            .with_context(|| format!("truncate lockfile {}", path.display()))?;
        let pid = std::process::id();
        let _ = writeln!(file, "{pid}");

        Ok(Self {
            path: path.to_path_buf(),
            file: Some(file),
        })
    }

    /// Probe `path` for a running process. Returns `Some(pid)` when the
    /// file is currently flock-held by another process, `None`
    /// otherwise.
    pub fn probe(path: &Path) -> Result<Option<u32>> {
        if !path.exists() {
            return Ok(None);
        }
        let file = OpenOptions::new().read(true).write(true).open(path)?;
        let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if rc == 0 {
            // We could acquire — no other holder. Release immediately.
            unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) };
            return Ok(None);
        }
        let contents = std::fs::read_to_string(path).unwrap_or_default();
        let pid = contents.trim().parse::<u32>().ok();
        Ok(pid)
    }
}

impl Drop for Lockfile {
    fn drop(&mut self) {
        // Closing the file descriptor releases the lock.
        if let Some(file) = self.file.take() {
            drop(file);
        }
        let _ = std::fs::remove_file(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn second_acquire_attempt_preserves_pid_file_of_existing_holder() {
        // Regression: `acquire` used to call `OpenOptions::truncate(true)`
        // *before* the flock check. A second concurrent acquire would
        // truncate the pid file, fail the flock, and leave the holder's
        // pid file empty — making `probe()` report no pid even though
        // the original holder still owned the lock.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("lock");
        let original_pid = std::process::id();

        let _lock = Lockfile::acquire(&path).expect("first acquire must succeed");

        // A second acquire from the same process: flock distinguishes
        // open-file-descriptions on Linux, so this must fail with the
        // lock held by `_lock`.
        let second = Lockfile::acquire(&path);
        assert!(
            second.is_err(),
            "second acquire must fail while first lock is held"
        );

        // probe() must still report the original holder's pid — the
        // pid file must not have been blanked by the failing attempt.
        let probed = Lockfile::probe(&path).expect("probe must not error");
        assert_eq!(
            probed,
            Some(original_pid),
            "pid file must survive a failed concurrent acquire attempt"
        );
    }

    #[test]
    fn acquire_writes_pid_and_drop_removes_lockfile() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("lock");
        {
            let _lock = Lockfile::acquire(&path).unwrap();
            assert!(path.exists());
            let contents = std::fs::read_to_string(&path).unwrap();
            assert_eq!(contents.trim().parse::<u32>().ok(), Some(std::process::id()));
        }
        // After drop the lockfile is removed.
        assert!(!path.exists());
    }

    #[test]
    fn probe_returns_none_when_no_lockfile() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("nonexistent");
        assert_eq!(Lockfile::probe(&path).unwrap(), None);
    }
}
