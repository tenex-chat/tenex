//! Async Unix-socket IPC server.
//!
//! **Socket:** `<base_dir>/llm-config.sock`
//!
//! Each connected client gets its own tokio task.  Each request–response pair
//! is a single JSON line (NDJSON).  Connections are persistent: a client may
//! send multiple requests on one connection.
//!
//! Config state is reloaded from disk every 30 seconds in a background task
//! so that edits to `llms.json` / `providers.json` take effect without a
//! daemon restart.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixListener;
use tokio::sync::RwLock;
use tracing::{debug, error, info, warn};

use crate::key_health::KeyHealthTracker;
use crate::protocol::Request;
use crate::resolver::{load_llms, load_providers, resolve_config, LlmDocs, ProviderDocs};

const SOCKET_NAME: &str = "llm-config.sock";
const RELOAD_INTERVAL: Duration = Duration::from_secs(30);

struct State {
    llms: LlmDocs,
    providers: ProviderDocs,
}

pub struct Server {
    base_dir: PathBuf,
    state: Arc<RwLock<State>>,
    key_health: Arc<KeyHealthTracker>,
}

impl Server {
    /// Bind the socket and enter the accept loop.  Never returns under normal
    /// operation; returns an error on fatal bind failures.
    pub async fn start(base_dir: PathBuf) -> Result<()> {
        let llms = load_llms(&base_dir)?;
        let providers = load_providers(&base_dir)?;

        let server = Arc::new(Server {
            base_dir: base_dir.clone(),
            state: Arc::new(RwLock::new(State { llms, providers })),
            key_health: Arc::new(KeyHealthTracker::new()),
        });

        // Periodic reload so config changes take effect without a restart.
        {
            let s = server.clone();
            tokio::spawn(async move {
                let mut ticker = tokio::time::interval(RELOAD_INTERVAL);
                ticker.tick().await; // discard the immediate first tick
                loop {
                    ticker.tick().await;
                    s.reload().await;
                }
            });
        }

        let socket_path = base_dir.join(SOCKET_NAME);
        // Remove stale socket from a previous run.
        if socket_path.exists() {
            std::fs::remove_file(&socket_path)?;
        }

        let listener = UnixListener::bind(&socket_path)?;
        info!(path = %socket_path.display(), "llm-config IPC server listening");

        loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    let s = server.clone();
                    tokio::spawn(async move {
                        if let Err(e) = s.handle_client(stream).await {
                            warn!(error = %e, "llm-config: client error");
                        }
                    });
                }
                Err(e) => error!(error = %e, "llm-config: accept error"),
            }
        }
    }

    async fn reload(&self) {
        let llms = match load_llms(&self.base_dir) {
            Ok(l) => l,
            Err(e) => {
                warn!(error = %e, "llm-config: reload llms.json failed");
                return;
            }
        };
        let providers = match load_providers(&self.base_dir) {
            Ok(p) => p,
            Err(e) => {
                warn!(error = %e, "llm-config: reload providers.json failed");
                return;
            }
        };
        let mut state = self.state.write().await;
        state.llms = llms;
        state.providers = providers;
        debug!("llm-config: reloaded from disk");
    }

    async fn handle_client(&self, stream: tokio::net::UnixStream) -> Result<()> {
        let (reader_half, mut writer) = stream.into_split();
        let mut reader = BufReader::new(reader_half);
        let mut line = String::new();

        loop {
            line.clear();
            let n = reader.read_line(&mut line).await?;
            if n == 0 {
                return Ok(()); // client disconnected
            }

            let response_val = self.dispatch(line.trim()).await;
            let mut bytes = serde_json::to_vec(&response_val)?;
            bytes.push(b'\n');
            writer.write_all(&bytes).await?;
            writer.flush().await?;
        }
    }

    async fn dispatch(&self, line: &str) -> serde_json::Value {
        let request: Request = match serde_json::from_str(line) {
            Ok(r) => r,
            Err(e) => return serde_json::json!({"ok": false, "error": format!("parse error: {e}")}),
        };

        match request {
            Request::Resolve { name } => {
                let state = self.state.read().await;
                resolve_config(&name, &state.llms, &state.providers, &self.key_health)
            }

            Request::ResolveRole { role } => {
                let state = self.state.read().await;
                let config_name = match state.llms.roles.get(&role) {
                    Some(n) => n.clone(),
                    None => {
                        return serde_json::json!({
                            "ok": false,
                            "error": format!("no config assigned to role '{role}'")
                        })
                    }
                };
                resolve_config(
                    &config_name,
                    &state.llms,
                    &state.providers,
                    &self.key_health,
                )
            }

            Request::ReportFailure {
                provider,
                key_index,
            } => {
                self.key_health.mark_failed(&provider, key_index);
                serde_json::json!({ "ok": true })
            }
        }
    }
}
