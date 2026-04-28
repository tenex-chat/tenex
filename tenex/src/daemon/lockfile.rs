//! Singleton lockfile for the supervisor.
//!
//! Format matches `src/utils/lockfile.ts` so a stale lock written by either
//! side is interpretable by the other:
//!     { "pid": 1234, "hostname": "host", "startedAt": 1700000000000 }
//!
//! Detection of a live owner uses `kill(pid, 0)` — same as the TS
//! implementation. Stale locks (owner gone) are removed and reacquired.

use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use tracing::warn;

const LOCKFILE_NAME: &str = "tenex.lock";

#[derive(Debug, Serialize, Deserialize)]
struct LockInfo {
    pid: i32,
    hostname: String,
    #[serde(rename = "startedAt")]
    started_at: u64,
}

pub struct Lockfile {
    path: PathBuf,
}

impl Lockfile {
    pub fn acquire(base_dir: &std::path::Path) -> Result<Self> {
        let dir = base_dir.join("daemon");
        fs::create_dir_all(&dir)
            .with_context(|| format!("creating {}", dir.display()))?;
        let path = dir.join(LOCKFILE_NAME);

        if path.exists() {
            let bytes = fs::read(&path)
                .with_context(|| format!("reading {}", path.display()))?;
            match serde_json::from_slice::<LockInfo>(&bytes) {
                Ok(info) if process_alive(info.pid) => {
                    return Err(anyhow!(
                        "tenex supervisor already running (pid {}, started {}ms epoch)",
                        info.pid,
                        info.started_at
                    ));
                }
                Ok(info) => {
                    warn!(
                        stale_pid = info.pid,
                        "removing stale lockfile",
                    );
                }
                Err(_) => {
                    warn!(path = %path.display(), "removing unparseable lockfile");
                }
            }
            fs::remove_file(&path).ok();
        }

        let info = LockInfo {
            pid: std::process::id() as i32,
            hostname: hostname(),
            started_at: now_millis(),
        };
        let body = serde_json::to_vec_pretty(&info)?;
        fs::write(&path, body)
            .with_context(|| format!("writing {}", path.display()))?;

        Ok(Self { path })
    }
}

impl Drop for Lockfile {
    fn drop(&mut self) {
        if let Err(e) = fs::remove_file(&self.path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                warn!(error = %e, path = %self.path.display(), "failed to remove lockfile");
            }
        }
    }
}

fn process_alive(pid: i32) -> bool {
    // SAFETY: kill with signal 0 is a probe; no signal is delivered.
    let rc = unsafe { libc::kill(pid, 0) };
    if rc == 0 {
        return true;
    }
    // EPERM means the process exists but we lack permission to signal it.
    let errno = unsafe { *libc::__errno_location() };
    errno == libc::EPERM
}

fn hostname() -> String {
    let mut buf = [0u8; 256];
    // SAFETY: gethostname writes at most buf.len() bytes; we null-terminate.
    let rc = unsafe { libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len()) };
    if rc != 0 {
        return "unknown".to_string();
    }
    let nul = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    String::from_utf8_lossy(&buf[..nul]).into_owned()
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
