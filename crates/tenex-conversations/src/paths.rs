//! Filesystem paths for the per-project conversation database.

use std::path::{Path, PathBuf};

pub const CONVERSATION_DB_FILENAME: &str = "conversation.db";
pub const LEGACY_CATALOG_DB_FILENAME: &str = "conversation-catalog.db";
pub const LEGACY_CONVERSATIONS_DIRNAME: &str = "conversations";
pub const LEGACY_BAK_SUFFIX: &str = ".legacy.bak";

/// Default base directory: `$TENEX_BASE_DIR` or `$HOME/.tenex`.
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

pub fn project_dir(base_dir: &Path, d_tag: &str) -> PathBuf {
    projects_dir(base_dir).join(d_tag)
}

pub fn conversation_db_path(base_dir: &Path, d_tag: &str) -> PathBuf {
    project_dir(base_dir, d_tag).join(CONVERSATION_DB_FILENAME)
}

pub fn legacy_catalog_db_path(base_dir: &Path, d_tag: &str) -> PathBuf {
    project_dir(base_dir, d_tag).join(LEGACY_CATALOG_DB_FILENAME)
}

pub fn legacy_conversations_dir(base_dir: &Path, d_tag: &str) -> PathBuf {
    project_dir(base_dir, d_tag).join(LEGACY_CONVERSATIONS_DIRNAME)
}

/// Tool-message storage today is global, not per-project:
/// `<base_dir>/tool-messages/`.
pub fn legacy_tool_messages_dir(base_dir: &Path) -> PathBuf {
    base_dir.join("tool-messages")
}
