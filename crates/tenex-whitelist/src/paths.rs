use std::path::{Path, PathBuf};

pub fn config_path(base_dir: &Path) -> PathBuf {
    base_dir.join("config.json")
}

pub fn projects_dir(base_dir: &Path) -> PathBuf {
    base_dir.join("projects")
}
