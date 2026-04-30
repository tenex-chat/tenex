use std::path::{Path, PathBuf};

/// Default base directory: `$TENEX_BASE_DIR` or `$HOME/.tenex`.
pub fn base_dir() -> PathBuf {
    if let Ok(custom) = std::env::var("TENEX_BASE_DIR") {
        return PathBuf::from(custom);
    }
    dirs_next::home_dir()
        .map(|h| h.join(".tenex"))
        .expect("HOME directory not resolvable")
}

pub fn embedder_dir(base: &Path) -> PathBuf {
    base.join("embedder")
}

pub fn state_db(base: &Path) -> PathBuf {
    embedder_dir(base).join("state.db")
}

pub fn cursor_db(base: &Path) -> PathBuf {
    embedder_dir(base).join("cursor.db")
}

pub fn pid_file(base: &Path) -> PathBuf {
    base.join("embedder.pid")
}

/// Single global embeddings.db. Replaces the per-project layout.
pub fn embeddings_db(base: &Path) -> PathBuf {
    base.join("embeddings.db")
}
