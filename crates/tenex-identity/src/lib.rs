//! `tenex-identity` — host-wide Nostr kind:0 identity resolution daemon.
//!
//! Resolves `pubkey → IdentityView` from Nostr kind:0 metadata events,
//! backed by a host-wide SQLite cache at `~/.tenex/identity-cache.db`.
//!
//! The binary listens on `~/.tenex/identity.sock` (a Unix domain socket).
//! Clients send `RESOLVE <hex_pubkey>\n` and receive a JSON line back.
//!
//! TTL-based freshness: rows older than 24 h are considered stale.
//! On a stale hit the cached row is returned immediately and a background
//! task silently refetches. On a miss the fetch is synchronous.
//!
//! The daemon is started as a supervised subprocess by `tenex daemon` via
//! the hidden `tenex identity-run` subcommand; the fork-based approach was
//! removed because forking inside a multi-threaded tokio runtime deadlocks
//! on the libc environment mutex.

pub mod cache;
mod client;
pub mod error;
pub mod fetch;
pub mod model;
pub mod paths;
pub mod protocol;
pub mod resolve;
pub mod schema;
pub mod server;
pub(crate) mod tags;

pub use cache::IdentityCache;
pub use client::wait_until_ready;
pub use error::{IdentityError, Result};
pub use fetch::fetch_identity;
pub use model::IdentityView;
pub use resolve::batch_resolve;
pub use resolve::resolve;

use std::fs;
use std::os::unix::io::AsRawFd;
use std::sync::Arc;

use anyhow::{anyhow, Context, Result as AnyResult};
use nostr_sdk::{Client, Keys};
use serde::Deserialize;

const DEFAULT_RELAYS: &[&str] = &["wss://relay.tenex.chat"];

/// Always-on relay for kind:0 identity resolution. Appended to every relay
/// list — purplepag.es specializes in kind:0 metadata distribution, so we
/// connect there regardless of user configuration.
const IDENTITY_PINNED_RELAY: &str = "wss://purplepag.es";

/// Synchronous entry point that builds a tokio runtime and runs the async daemon.
/// Called from the `tenex identity-run` subcommand binary.
pub fn run_daemon_sync() -> AnyResult<()> {
    if tokio::runtime::Handle::try_current().is_ok() {
        return std::thread::spawn(run_daemon_on_new_runtime)
            .join()
            .map_err(|_| anyhow!("identity daemon runtime thread panicked"))?;
    }

    run_daemon_on_new_runtime()
}

fn run_daemon_on_new_runtime() -> AnyResult<()> {
    let rt = tokio::runtime::Runtime::new().context("build tokio runtime")?;
    rt.block_on(run_daemon_async())
}

async fn run_daemon_async() -> AnyResult<()> {
    use std::os::unix::fs::PermissionsExt;
    use tokio::net::UnixListener;

    let base_dir = paths::default_base_dir();
    fs::create_dir_all(&base_dir).with_context(|| format!("create {}", base_dir.display()))?;

    let pid_path = paths::pid_path();
    let pid_file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&pid_path)
        .with_context(|| format!("open pid file {}", pid_path.display()))?;

    if !try_lock(pid_file.as_raw_fd())? {
        return Ok(());
    }
    std::mem::forget(pid_file);

    if let Ok(mut f) = fs::OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(&pid_path)
    {
        use std::io::Write;
        let _ = writeln!(f, "{}", std::process::id());
    }

    let db_path = paths::default_db_path();
    let cache = Arc::new(
        IdentityCache::open(&db_path)
            .with_context(|| format!("open identity cache at {}", db_path.display()))?,
    );

    let config = load_config();
    let client = match config.tenex_private_key.as_deref() {
        Some(secret) => Client::new(Keys::parse(secret).context("parse tenexPrivateKey")?),
        None => Client::default(),
    };
    for relay in &resolve_relays(&config) {
        client
            .add_relay(relay.as_str())
            .await
            .with_context(|| format!("add relay {relay}"))?;
    }

    // Bind the socket before connecting to relays so the parent process can
    // confirm the daemon is up without racing against slow/unreachable relays.
    // Relay connections complete asynchronously after serve() starts.
    let socket_path = paths::socket_path();
    if socket_path.exists() {
        let _ = fs::remove_file(&socket_path);
    }

    let listener = UnixListener::bind(&socket_path)
        .with_context(|| format!("bind {}", socket_path.display()))?;

    fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o600))
        .with_context(|| format!("chmod 600 {}", socket_path.display()))?;

    client.connect().await;
    server::serve(listener, cache, client).await;
    Ok(())
}

fn try_lock(fd: i32) -> AnyResult<bool> {
    let rc = unsafe { libc::flock(fd, libc::LOCK_EX | libc::LOCK_NB) };
    if rc == 0 {
        Ok(true)
    } else {
        let err = std::io::Error::last_os_error();
        match err.raw_os_error() {
            Some(libc::EWOULDBLOCK) => Ok(false),
            _ => Err(err).context("flock pid file"),
        }
    }
}

#[derive(Deserialize, Default)]
struct TenexConfig {
    #[serde(default)]
    relays: Vec<String>,
    #[serde(default, rename = "tenexPrivateKey")]
    tenex_private_key: Option<String>,
}

fn load_config() -> TenexConfig {
    let config_path = paths::default_base_dir().join("config.json");
    fs::read(&config_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn resolve_relays(config: &TenexConfig) -> Vec<String> {
    let configured: Vec<String> = if config.relays.is_empty() {
        DEFAULT_RELAYS.iter().map(|s| s.to_string()).collect()
    } else {
        config.relays.clone()
    };

    let mut out = configured;
    if !out.iter().any(|r| r == IDENTITY_PINNED_RELAY) {
        out.push(IDENTITY_PINNED_RELAY.to_owned());
    }
    out
}
