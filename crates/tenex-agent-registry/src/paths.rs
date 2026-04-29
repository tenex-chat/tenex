use std::path::{Path, PathBuf};

const AGENTS_DIRNAME: &str = "agents";
pub(crate) const INDEX_FILENAME: &str = "index.json";

pub fn agents_dir(base_dir: &Path) -> PathBuf {
    base_dir.join(AGENTS_DIRNAME)
}

pub fn index_file_path(base_dir: &Path) -> PathBuf {
    agents_dir(base_dir).join(INDEX_FILENAME)
}

pub fn agent_file_path(base_dir: &Path, pubkey: &str) -> PathBuf {
    agents_dir(base_dir).join(format!("{pubkey}.json"))
}
