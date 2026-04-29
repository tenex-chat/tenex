//! Streaming client for the per-project runtime control socket.
//!
//! tenex-telegram is the only caller today: it synthesizes a Nostr event for
//! the inbound Telegram message (without publishing) and sends it via this
//! client. The runtime feeds the event into its dispatch path; agent-emitted
//! events are streamed back as `DispatchTransportFrame::Event` lines, ending
//! with `Done`, `Superseded`, or `Error`.
//!
//! When the per-project runtime is not running, [`dispatch_via_runtime`]
//! requests a boot from the daemon control socket and waits up to a few
//! seconds for the runtime socket to appear before retrying.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use nostr_sdk::{Event, JsonUtil};
use tenex_protocol::{
    DispatchTransportFrame, DispatchTransportRequest, RuntimeControlRequest,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tracing::{debug, info, warn};

use crate::daemon_client;

const DAEMON_BOOT_TIMEOUT: Duration = Duration::from_secs(10);
const RUNTIME_CONNECT_RETRY_INTERVAL: Duration = Duration::from_millis(250);

pub fn runtime_socket_path(base_dir: &Path, project_id: &str) -> PathBuf {
    base_dir
        .join("projects")
        .join(project_id)
        .join("runtime-control.sock")
}

/// Open the per-project runtime control socket, sending a `BOOT` to the
/// daemon and waiting for the socket to appear if the runtime isn't up yet.
pub async fn connect_runtime(base_dir: &Path, project_id: &str) -> Result<UnixStream> {
    let socket = runtime_socket_path(base_dir, project_id);
    match UnixStream::connect(&socket).await {
        Ok(stream) => return Ok(stream),
        Err(e)
            if matches!(
                e.kind(),
                ErrorKind::NotFound | ErrorKind::ConnectionRefused
            ) =>
        {
            info!(
                project = project_id,
                socket = %socket.display(),
                "runtime socket missing; requesting boot from daemon"
            );
        }
        Err(e) => return Err(e).with_context(|| format!("connect {}", socket.display())),
    }

    daemon_client::request_boot(base_dir, project_id)
        .await
        .with_context(|| format!("daemon BOOT request for project '{project_id}'"))?;

    let deadline = Instant::now() + DAEMON_BOOT_TIMEOUT;
    loop {
        match UnixStream::connect(&socket).await {
            Ok(stream) => return Ok(stream),
            Err(e)
                if matches!(
                    e.kind(),
                    ErrorKind::NotFound | ErrorKind::ConnectionRefused
                ) =>
            {
                if Instant::now() >= deadline {
                    anyhow::bail!(
                        "runtime control socket {} did not appear within {:?} after BOOT",
                        socket.display(),
                        DAEMON_BOOT_TIMEOUT
                    );
                }
                tokio::time::sleep(RUNTIME_CONNECT_RETRY_INTERVAL).await;
            }
            Err(e) => return Err(e).with_context(|| format!("connect {}", socket.display())),
        }
    }
}

/// Outcome of the streaming dispatch.
#[derive(Debug)]
pub enum DispatchOutcome {
    /// Agent run completed successfully and `Done` was received.
    Completed,
    /// The runtime queued the dispatch and then dropped it before running
    /// (a newer dispatch for the same conversation/agent superseded it).
    Superseded,
    /// Runtime returned an `Error` frame (or transport error).
    Failed(String),
}

/// Dispatch `event` via the per-project runtime and invoke `on_event` for each
/// agent-emitted event streamed back.
pub async fn dispatch_via_runtime<F>(
    base_dir: &Path,
    project_id: &str,
    event: &Event,
    mut on_event: F,
) -> Result<DispatchOutcome>
where
    F: FnMut(&Event),
{
    let mut stream = connect_runtime(base_dir, project_id).await?;
    let request = RuntimeControlRequest::DispatchTransport(DispatchTransportRequest {
        event_json: event.as_json(),
    });
    let request_line = serde_json::to_string(&request)?;
    stream.write_all(request_line.as_bytes()).await?;
    stream.write_all(b"\n").await?;
    stream.flush().await?;

    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    loop {
        line.clear();
        let n = reader.read_line(&mut line).await?;
        if n == 0 {
            return Ok(DispatchOutcome::Failed(
                "runtime closed control connection without terminal frame".to_string(),
            ));
        }
        let frame: DispatchTransportFrame = match serde_json::from_str(line.trim()) {
            Ok(f) => f,
            Err(e) => {
                warn!(error = %e, raw = %line.trim(), "ignoring unparseable transport frame");
                continue;
            }
        };
        match frame {
            DispatchTransportFrame::Accepted(accepted) => {
                debug!(
                    conversation_id = %accepted.conversation_id,
                    agent = %accepted.agent_pubkey,
                    "transport dispatch accepted"
                );
            }
            DispatchTransportFrame::Event(ev) => match Event::from_json(&ev.event_json) {
                Ok(parsed) => on_event(&parsed),
                Err(e) => warn!(error = %e, "ignoring unparseable streamed event"),
            },
            DispatchTransportFrame::Done => return Ok(DispatchOutcome::Completed),
            DispatchTransportFrame::Superseded => return Ok(DispatchOutcome::Superseded),
            DispatchTransportFrame::Error(err) => {
                return Ok(DispatchOutcome::Failed(err.message))
            }
        }
    }
}
