//! Daemon control socket.
//!
//! A small Unix socket the daemon binds at `<base_dir>/daemon/control.sock`
//! so companion daemons (e.g. `tenex-telegram`) can request that a per-project
//! runtime be booted on demand. The protocol is line-oriented text:
//!
//! ```text
//! BOOT <d_tag>\n   →   OK\n            (d_tag known, boot queued / already running)
//!                       ERR <message>\n (d_tag unknown or other failure)
//! ```
//!
//! Mirrors the line-protocol shape of `whitelist/src/lib.rs` but uses Tokio
//! since the daemon is already async and owns the [`Supervisor`].

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use tokio::fs;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tracing::{info, warn};

use super::supervisor::Supervisor;

pub fn socket_path(base_dir: &Path) -> PathBuf {
    base_dir.join("daemon").join("control.sock")
}

/// Bind the daemon control socket and serve requests forever. Each accepted
/// connection is handled in its own task; the listener loop never returns
/// while the daemon is alive.
pub async fn serve(base_dir: PathBuf, supervisor: Supervisor) -> Result<()> {
    let path = socket_path(&base_dir);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .await
            .with_context(|| format!("create {}", parent.display()))?;
    }
    if path.exists() {
        let _ = fs::remove_file(&path).await;
    }
    let listener = UnixListener::bind(&path)
        .with_context(|| format!("bind daemon control socket {}", path.display()))?;
    info!(path = %path.display(), "daemon control socket listening");

    loop {
        let (stream, _) = listener.accept().await?;
        let supervisor = supervisor.clone();
        let base_dir = base_dir.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_connection(stream, supervisor, base_dir).await {
                warn!(error = %e, "daemon control connection failed");
            }
        });
    }
}

async fn handle_connection(
    stream: UnixStream,
    supervisor: Supervisor,
    base_dir: PathBuf,
) -> Result<()> {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    let n = reader.read_line(&mut line).await?;
    if n == 0 {
        return Ok(());
    }
    let cmd = line.trim();
    let response = match parse_command(cmd) {
        Ok(Command::Boot { d_tag }) => match boot_project(&supervisor, &base_dir, &d_tag).await {
            Ok(()) => "OK\n".to_string(),
            Err(e) => format!("ERR {e}\n"),
        },
        Err(e) => format!("ERR {e}\n"),
    };
    let mut stream = reader.into_inner();
    stream.write_all(response.as_bytes()).await?;
    stream.flush().await?;
    Ok(())
}

enum Command {
    Boot { d_tag: String },
}

fn parse_command(line: &str) -> Result<Command, String> {
    let mut parts = line.split_whitespace();
    let verb = parts.next().ok_or_else(|| "empty command".to_string())?;
    match verb {
        "BOOT" => {
            let d_tag = parts
                .next()
                .ok_or_else(|| "BOOT requires a d_tag".to_string())?
                .to_string();
            if parts.next().is_some() {
                return Err("BOOT takes exactly one argument".to_string());
            }
            Ok(Command::Boot { d_tag })
        }
        other => Err(format!("unknown verb: {other}")),
    }
}

async fn boot_project(supervisor: &Supervisor, base_dir: &Path, d_tag: &str) -> Result<()> {
    // Reject d_tags that don't correspond to a discovered project, otherwise a
    // typo from a transport bridge would spawn a runtime that can't open
    // `event.json` and immediately fails.
    let project_event = base_dir.join("projects").join(d_tag).join("event.json");
    if !project_event.exists() {
        anyhow::bail!("unknown project '{d_tag}'");
    }
    supervisor.boot(d_tag.to_string()).await;
    Ok(())
}
