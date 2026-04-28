mod cache;
mod client;
mod daemonize;
mod paths;
mod protocol;
mod server;
mod watch;

use anyhow::{anyhow, Context, Result};
use std::env;
use std::fs;
use std::os::unix::io::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use cache::TrustCache;

fn main() -> ExitCode {
    let args: Vec<String> = env::args().collect();
    let result = match args.get(1).map(String::as_str) {
        Some("check") => cmd_check(&args[2..]),
        Some("status") => cmd_status(),
        Some("help") | Some("-h") | Some("--help") => {
            print_help();
            return ExitCode::from(0);
        }
        None => {
            print_help();
            return ExitCode::from(2);
        }
        Some(other) => {
            eprintln!("whitelist: unknown command '{other}'");
            print_help();
            return ExitCode::from(2);
        }
    };
    match result {
        Ok(code) => code,
        Err(e) => {
            eprintln!("whitelist: {e:#}");
            ExitCode::from(2)
        }
    }
}

fn print_help() {
    eprintln!("Usage:");
    eprintln!("  whitelist check <hex_pubkey> <project_dtag>");
    eprintln!("       exit 0 if allowed, 1 if denied, 2 on error");
    eprintln!("  whitelist status");
    eprintln!("       print cache stats from the running daemon");
}

fn cmd_check(args: &[String]) -> Result<ExitCode> {
    if args.len() != 2 {
        return Err(anyhow!(
            "check requires <hex_pubkey> <project_dtag>; got {} args",
            args.len()
        ));
    }
    let pubkey = args[0].trim().to_ascii_lowercase();
    let dtag = args[1].trim();
    if dtag.is_empty() {
        return Err(anyhow!("project_dtag must not be empty"));
    }
    let stream = ensure_daemon_then_connect()?;
    let allowed = client::check(stream, &pubkey, dtag)?;
    Ok(if allowed {
        ExitCode::from(0)
    } else {
        ExitCode::from(1)
    })
}

fn cmd_status() -> Result<ExitCode> {
    let stream = ensure_daemon_then_connect()?;
    let response = client::status(stream)?;
    print!("{response}");
    Ok(ExitCode::from(0))
}

/// Connect to the running daemon. If absent, double-fork one and wait for it
/// to bind. Always returns a connected stream — or an error if startup fails.
fn ensure_daemon_then_connect() -> Result<UnixStream> {
    let socket = paths::socket_path();

    if let Ok(stream) = UnixStream::connect(&socket) {
        return Ok(stream);
    }

    fs::create_dir_all(paths::whitelist_dir()).context("create whitelist runtime dir")?;

    match daemonize::spawn_daemon()? {
        daemonize::Role::Daemon => run_daemon_role(),
        daemonize::Role::Caller => {
            client::connect_with_retry(&socket, 60, Duration::from_millis(50))
                .context("connect to freshly-spawned daemon")
        }
    }
}

/// Daemon process entry point. Returns `!`: never falls back to the CLI flow.
fn run_daemon_role() -> ! {
    if let Err(e) = daemonize::detach_stdio(&paths::log_path()) {
        eprintln!("whitelist daemon: detach_stdio failed: {e:#}");
        std::process::exit(1);
    }
    match run_daemon() {
        Ok(()) => std::process::exit(0),
        Err(e) => {
            eprintln!("whitelist daemon: {e:#}");
            std::process::exit(1);
        }
    }
}

fn run_daemon() -> Result<()> {
    let pid_path = paths::pid_path();
    let socket_path = paths::socket_path();

    // Single-instance lock: hold an exclusive flock on the pid file for the
    // whole process lifetime. A racing daemon fails the lock and exits; the
    // CLI that spawned it will still find this daemon's socket and connect.
    let pid_file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&pid_path)
        .with_context(|| format!("open pid file {}", pid_path.display()))?;
    if !try_lock(pid_file.as_raw_fd())? {
        // Another daemon is starting/running. The other will publish the
        // socket; nothing for us to do.
        return Ok(());
    }
    // Keep the lock for the lifetime of the process.
    std::mem::forget(pid_file);

    // Reopen pid file for writing the pid line (separate handle, lock unaffected).
    if let Ok(mut f) = fs::OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(&pid_path)
    {
        use std::io::Write;
        let _ = writeln!(f, "{}", std::process::id());
    }

    // Stale socket from a crashed prior daemon (we hold the lock, so nobody is
    // actually listening): unlink before bind.
    if socket_path.exists() {
        let _ = fs::remove_file(&socket_path);
    }
    let listener = UnixListener::bind(&socket_path)
        .with_context(|| format!("bind {}", socket_path.display()))?;
    set_socket_perms(&socket_path)?;

    let cache = Arc::new(TrustCache::new());
    cache.reload_all()?;
    watch::spawn(cache.clone())?;

    eprintln!("[whitelist] listening on {}", socket_path.display());
    server::serve(listener, cache)
}

fn try_lock(fd: i32) -> Result<bool> {
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

fn set_socket_perms(socket: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let perms = fs::Permissions::from_mode(0o600);
    fs::set_permissions(socket, perms)
        .with_context(|| format!("chmod 600 {}", socket.display()))?;
    Ok(())
}
