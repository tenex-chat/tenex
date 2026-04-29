//! Client for the daemon control socket (`<base_dir>/daemon/control.sock`).
//!
//! Speaks the line-oriented protocol implemented by
//! `tenex/src/daemon/control_socket.rs` to ask the daemon to boot a
//! per-project runtime on demand:
//!
//! ```text
//! BOOT <d_tag>\n   →   OK\n  |  ERR <message>\n
//! ```

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

pub fn socket_path(base_dir: &Path) -> PathBuf {
    base_dir.join("daemon").join("control.sock")
}

pub async fn request_boot(base_dir: &Path, d_tag: &str) -> Result<()> {
    let path = socket_path(base_dir);
    let connect = UnixStream::connect(&path);
    let mut stream = tokio::time::timeout(REQUEST_TIMEOUT, connect)
        .await
        .map_err(|_| anyhow!("daemon control socket connect timed out"))?
        .with_context(|| format!("connect {}", path.display()))?;

    let line = format!("BOOT {d_tag}\n");
    stream.write_all(line.as_bytes()).await?;
    stream.flush().await?;

    let mut reader = BufReader::new(stream);
    let mut response = String::new();
    let read = tokio::time::timeout(REQUEST_TIMEOUT, reader.read_line(&mut response))
        .await
        .map_err(|_| anyhow!("daemon BOOT response timed out"))??;
    if read == 0 {
        anyhow::bail!("daemon closed connection without responding");
    }
    let trimmed = response.trim();
    if trimmed == "OK" {
        Ok(())
    } else if let Some(rest) = trimmed.strip_prefix("ERR ") {
        anyhow::bail!("daemon rejected BOOT: {rest}")
    } else {
        anyhow::bail!("unexpected daemon response: {trimmed:?}")
    }
}
