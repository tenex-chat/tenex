use std::path::PathBuf;

pub fn base_dir() -> PathBuf {
    if let Ok(custom) = std::env::var("TENEX_BASE_DIR") {
        return PathBuf::from(custom);
    }
    dirs_next::home_dir()
        .map(|h| h.join(".tenex"))
        .expect("HOME directory not resolvable")
}

pub fn config_file() -> PathBuf {
    base_dir().join("config.json")
}

pub fn pid_file() -> PathBuf {
    base_dir().join("scheduler.pid")
}

pub fn projects_dir() -> PathBuf {
    base_dir().join("projects")
}

pub fn project_schedules_file(d_tag: &str) -> PathBuf {
    projects_dir().join(d_tag).join("schedules.json")
}

pub fn agents_index_file() -> PathBuf {
    base_dir().join("agents").join("index.json")
}
