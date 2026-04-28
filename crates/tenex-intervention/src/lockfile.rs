//! flock(2)-based singleton lock. Mirrors the pattern used by tenex-summarizer.

use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};

pub struct Lockfile {
    path: PathBuf,
    _file: std::fs::File,
}

impl Lockfile {
    pub fn acquire(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("create {}", parent.display()))?;
        }

        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(path)
            .with_context(|| format!("open {}", path.display()))?;

        if !try_flock(file.as_raw_fd())? {
            return Err(anyhow!(
                "another tenex-intervention holds {}",
                path.display()
            ));
        }

        let mut writer = OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(path)
            .with_context(|| format!("rewrite {}", path.display()))?;
        writeln!(writer, "{}", std::process::id())
            .with_context(|| format!("write pid to {}", path.display()))?;

        Ok(Self {
            path: path.to_path_buf(),
            _file: file,
        })
    }

    pub fn probe(path: &Path) -> Result<Option<u32>> {
        if !path.exists() {
            return Ok(None);
        }
        let probe = OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .with_context(|| format!("open {}", path.display()))?;
        if try_flock(probe.as_raw_fd())? {
            return Ok(None);
        }
        let mut contents = String::new();
        let mut reader = OpenOptions::new()
            .read(true)
            .open(path)
            .with_context(|| format!("read {}", path.display()))?;
        reader.read_to_string(&mut contents).ok();
        let pid = contents.trim().parse::<u32>().ok();
        Ok(pid.or(Some(0)))
    }
}

impl Drop for Lockfile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn try_flock(fd: i32) -> Result<bool> {
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
