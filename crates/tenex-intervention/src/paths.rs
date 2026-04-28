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
    base_dir().join("intervention.pid")
}

pub fn intervention_state_file(d_tag: &str) -> PathBuf {
    base_dir().join(format!("intervention_state_{d_tag}.json"))
}

/// Legacy path used before dTag-scoped filenames (project coordinate as filename).
pub fn intervention_state_file_legacy(project_id: &str) -> PathBuf {
    base_dir().join(format!("intervention_state_{project_id}.json"))
}

pub fn agents_index_file() -> PathBuf {
    base_dir().join("agents").join("index.json")
}

pub fn projects_dir() -> PathBuf {
    base_dir().join("projects")
}
