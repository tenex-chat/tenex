use std::path::{Path, PathBuf};

use crate::id::ProjectDTag;

/// Default base directory: `$TENEX_BASE_DIR` if set, else `~/.tenex`.
///
/// This mirrors `crates/tenex-summarizer/src/paths.rs` so that every Rust
/// binary in the fleet resolves the same root.
pub fn default_base_dir() -> PathBuf {
    if let Ok(custom) = std::env::var("TENEX_BASE_DIR") {
        return PathBuf::from(custom);
    }
    dirs_next::home_dir()
        .map(|h| h.join(".tenex"))
        .expect("HOME directory not resolvable")
}

pub fn projects_dir(base_dir: &Path) -> PathBuf {
    base_dir.join("projects")
}

pub fn project_dir(base_dir: &Path, d_tag: &ProjectDTag) -> PathBuf {
    projects_dir(base_dir).join(d_tag.as_str())
}

pub fn project_db(base_dir: &Path, d_tag: &ProjectDTag) -> PathBuf {
    project_dir(base_dir, d_tag).join("project.db")
}

pub fn agents_dir(base_dir: &Path) -> PathBuf {
    base_dir.join("agents")
}

pub fn agent_file(base_dir: &Path, pubkey: &str) -> PathBuf {
    agents_dir(base_dir).join(format!("{pubkey}.json"))
}

pub fn project_event_file(base_dir: &Path, d_tag: &ProjectDTag) -> PathBuf {
    project_dir(base_dir, d_tag).join("event.json")
}
