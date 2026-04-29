use std::env;
use std::path::PathBuf;

pub fn base_dir() -> PathBuf {
    if let Ok(custom) = env::var("TENEX_BASE_DIR") {
        return PathBuf::from(custom);
    }
    let home = env::var("HOME").expect("HOME environment variable not set");
    PathBuf::from(home).join(".tenex")
}

pub fn whitelist_dir() -> PathBuf {
    base_dir().join("whitelist")
}

pub fn socket_path() -> PathBuf {
    whitelist_dir().join("whitelist.sock")
}

pub fn pid_path() -> PathBuf {
    whitelist_dir().join("whitelist.pid")
}

pub fn log_path() -> PathBuf {
    whitelist_dir().join("whitelist.log")
}

pub fn config_path() -> PathBuf {
    base_dir().join("config.json")
}

pub fn backend_pubkeys_path() -> PathBuf {
    whitelist_dir().join("pubkeys.txt")
}

pub fn projects_dir() -> PathBuf {
    base_dir().join("projects")
}
