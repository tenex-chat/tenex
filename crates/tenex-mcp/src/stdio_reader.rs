use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};

use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::ChildStdout;
use tokio::sync::{broadcast, oneshot};
use tokio::task::JoinHandle;
use tracing::warn;

pub(crate) type PendingResponses = Arc<StdMutex<HashMap<u64, oneshot::Sender<ResponseResult>>>>;
pub(crate) type ResponseResult = std::result::Result<Value, String>;

#[derive(Debug, Deserialize)]
struct JsonRpcIncoming {
    id: Option<Value>,
    method: Option<String>,
    params: Option<Value>,
    result: Option<Value>,
    error: Option<JsonRpcError>,
}

#[derive(Debug, Deserialize)]
struct JsonRpcError {
    code: i64,
    message: String,
}

pub(crate) fn spawn_reader(
    server_name: String,
    stdout: ChildStdout,
    pending: PendingResponses,
    resource_updates: broadcast::Sender<String>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) if line.trim().is_empty() => {}
                Ok(Some(line)) => {
                    if let Err(error) =
                        handle_incoming_line(&server_name, &pending, &resource_updates, &line)
                    {
                        warn!(server = %server_name, error = %error, "MCP stdout line ignored");
                    }
                }
                Ok(None) => {
                    fail_pending(
                        &pending,
                        format!("MCP server '{server_name}' closed stdout"),
                    );
                    break;
                }
                Err(error) => {
                    fail_pending(
                        &pending,
                        format!("reading MCP stdout from '{server_name}': {error}"),
                    );
                    break;
                }
            }
        }
    })
}

fn handle_incoming_line(
    server_name: &str,
    pending: &PendingResponses,
    resource_updates: &broadcast::Sender<String>,
    line: &str,
) -> Result<()> {
    let incoming: JsonRpcIncoming = serde_json::from_str(line)
        .with_context(|| format!("parsing JSON-RPC from '{server_name}'"))?;
    if let Some(id) = incoming.id.as_ref().and_then(Value::as_u64) {
        let result = if let Some(error) = incoming.error {
            Err(format!(
                "MCP server '{server_name}' returned error {}: {}",
                error.code, error.message
            ))
        } else {
            incoming
                .result
                .ok_or_else(|| format!("MCP server '{server_name}' response had no result"))
        };
        if let Some(tx) = pending.lock().unwrap().remove(&id) {
            let _ = tx.send(result);
        }
        return Ok(());
    }

    if incoming.method.as_deref() == Some("notifications/resources/updated") {
        if let Some(uri) = incoming
            .params
            .as_ref()
            .and_then(|params| params.get("uri"))
            .and_then(Value::as_str)
        {
            let _ = resource_updates.send(uri.to_string());
        }
    }
    Ok(())
}

fn fail_pending(pending: &PendingResponses, message: String) {
    for (_, tx) in pending.lock().unwrap().drain() {
        let _ = tx.send(Err(message.clone()));
    }
}
