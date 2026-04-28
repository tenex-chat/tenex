//! Filesystem paths for the host-wide identity daemon.

use std::path::PathBuf;

pub const IDENTITY_CACHE_DB_FILENAME: &str = "identity-cache.db";
pub const IDENTITY_SOCKET_FILENAME: &str = "identity.sock";

/// Default base directory: `$TENEX_BASE_DIR` or `$HOME/.tenex`.
pub fn default_base_dir() -> PathBuf {
    if let Ok(custom) = std::env::var("TENEX_BASE_DIR") {
        return PathBuf::from(custom);
    }
    dirs_next::home_dir()
        .map(|h| h.join(".tenex"))
        .expect("HOME directory not resolvable")
}

/// Default path for the host-wide identity cache: `<base_dir>/identity-cache.db`.
pub fn default_db_path() -> PathBuf {
    default_base_dir().join(IDENTITY_CACHE_DB_FILENAME)
}

/// Unix socket path: `<base_dir>/identity.sock`.
pub fn socket_path() -> PathBuf {
    default_base_dir().join(IDENTITY_SOCKET_FILENAME)
}

/// PID / lock file: `<base_dir>/identity.pid`.
pub fn pid_path() -> PathBuf {
    default_base_dir().join("identity.pid")
}

/// Log file for the daemonized process: `<base_dir>/identity.log`.
pub fn log_path() -> PathBuf {
    default_base_dir().join("identity.log")
}
