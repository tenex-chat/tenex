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
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(true)
            .open(path)
            .with_context(|| format!("open lockfile {}", path.display()))?;

        let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if rc != 0 {
            return Err(anyhow::anyhow!(
                "another tenex-embedder is already running (lockfile: {})",
                path.display()
            ));
        }

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
