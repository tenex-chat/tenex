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

pub mod cache;
mod client;
mod daemonize;
pub mod error;
pub mod fetch;
pub mod model;
pub mod paths;
pub mod protocol;
pub mod resolve;
pub mod schema;
pub mod server;

pub use cache::IdentityCache;
pub use error::{IdentityError, Result};
pub use fetch::fetch_identity;
pub use model::IdentityView;
pub use resolve::resolve;
pub use resolve::batch_resolve;

use std::fs;
use std::os::unix::io::AsRawFd;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result as AnyResult};
use serde::Deserialize;

const DEFAULT_RELAYS: &[&str] = &["wss://relay.damus.io", "wss://relay.nostr.band"];

/// Ensure an identity daemon is bound to the runtime socket. If one is already
/// running, this is a quick connect-and-close. Otherwise, double-fork a fresh
/// daemon and wait for it to bind, then close the probe connection.
pub fn ensure_running() -> AnyResult<()> {
    let _probe = ensure_daemon_then_connect()?;
    Ok(())
}

fn ensure_daemon_then_connect() -> AnyResult<std::os::unix::net::UnixStream> {
    let socket = paths::socket_path();

    if let Ok(stream) = std::os::unix::net::UnixStream::connect(&socket) {
        return Ok(stream);
    }

    fs::create_dir_all(paths::default_base_dir())
        .context("create identity base dir")?;

    match daemonize::spawn_daemon()? {
        daemonize::Role::Daemon => run_daemon_role(),
        daemonize::Role::Caller => {
            client::connect_with_retry(&socket, 60, Duration::from_millis(50))
                .context("connect to freshly-spawned identity daemon")
        }
    }
}

fn run_daemon_role() -> ! {
    if let Err(e) = daemonize::detach_stdio(&paths::log_path()) {
        eprintln!("identity daemon: detach_stdio failed: {e:#}");
        std::process::exit(1);
    }
    match run_daemon_sync() {
        Ok(()) => std::process::exit(0),
        Err(e) => {
            eprintln!("identity daemon: {e:#}");
            std::process::exit(1);
        }
    }
}

/// Synchronous entry point that builds a tokio runtime and runs the async daemon.
pub fn run_daemon_sync() -> AnyResult<()> {
    let rt = tokio::runtime::Runtime::new().context("build tokio runtime")?;
    rt.block_on(run_daemon_async())
}

async fn run_daemon_async() -> AnyResult<()> {
    use std::os::unix::fs::PermissionsExt;
    use tokio::net::UnixListener;

    let base_dir = paths::default_base_dir();
    fs::create_dir_all(&base_dir)
        .with_context(|| format!("create {}", base_dir.display()))?;

    let pid_path = paths::pid_path();
    let pid_file = fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(&pid_path)
        .with_context(|| format!("open pid file {}", pid_path.display()))?;

    if !try_lock(pid_file.as_raw_fd())? {
        return Ok(());
    }
    std::mem::forget(pid_file);

    if let Ok(mut f) = fs::OpenOptions::new().write(true).truncate(true).open(&pid_path) {
        use std::io::Write;
        let _ = writeln!(f, "{}", std::process::id());
    }

    let db_path = paths::default_db_path();
    let cache = Arc::new(
        IdentityCache::open(&db_path)
            .with_context(|| format!("open identity cache at {}", db_path.display()))?,
    );

    let relays: Arc<[String]> = load_relays().into();

    let socket_path = paths::socket_path();
    if socket_path.exists() {
        let _ = fs::remove_file(&socket_path);
    }

    let listener = UnixListener::bind(&socket_path)
        .with_context(|| format!("bind {}", socket_path.display()))?;

    fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o600))
        .with_context(|| format!("chmod 600 {}", socket_path.display()))?;

    eprintln!("[identity] listening on {}", socket_path.display());
    server::serve(listener, cache, relays).await;
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
}

fn load_relays() -> Vec<String> {
    let config_path = paths::default_base_dir().join("config.json");
    let bytes = match fs::read(&config_path) {
        Ok(b) => b,
        Err(_) => return DEFAULT_RELAYS.iter().map(|s| s.to_string()).collect(),
    };
    let cfg: TenexConfig = serde_json::from_slice(&bytes).unwrap_or_default();
    if cfg.relays.is_empty() {
        DEFAULT_RELAYS.iter().map(|s| s.to_string()).collect()
    } else {
        cfg.relays
    }
}
