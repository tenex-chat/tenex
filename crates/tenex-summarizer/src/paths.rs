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

pub fn llms_file() -> PathBuf {
    base_dir().join("llms.json")
}

pub fn providers_file() -> PathBuf {
    base_dir().join("providers.json")
}

pub fn projects_dir() -> PathBuf {
    base_dir().join("projects")
}

pub fn pid_file() -> PathBuf {
    base_dir().join("summarizer.pid")
}

pub fn summarizer_dir() -> PathBuf {
    base_dir().join("summarizer")
}

pub fn state_db() -> PathBuf {
    summarizer_dir().join("state.db")
}

pub fn categories_file() -> PathBuf {
    base_dir().join("data").join("conversation-categories.json")
}
