//! API entry point. `Project::open_conversations` is the canonical way for
//! every consumer (agent runner, intervention watcher, search tools, future
//! Rust orchestrator) to acquire a [`ConversationStore`] for a given project.
//!
//! Accepts either a NIP-33 coordinate (`31933:<pubkey>:<dTag>`) or a bare
//! dTag at every entry point; normalization happens once here.

use std::path::{Path, PathBuf};

use crate::error::Result;
use crate::ids::normalize_project_id;
use crate::migration::MigrationReport;
use crate::paths::{conversation_db_path, default_base_dir};
use crate::store::ConversationStore;

pub struct Project {
    d_tag: String,
    base_dir: PathBuf,
}

impl Project {
    /// Create a `Project` handle. `project_id` may be either form.
    pub fn new(project_id: &str, base_dir: &Path) -> Result<Self> {
        let d_tag = normalize_project_id(project_id)?;
        Ok(Self {
            d_tag,
            base_dir: base_dir.to_path_buf(),
        })
    }

    /// Same as [`Self::new`] but uses the default base directory
    /// (`$TENEX_BASE_DIR` or `~/.tenex`).
    pub fn new_with_default_base(project_id: &str) -> Result<Self> {
        Self::new(project_id, &default_base_dir())
    }

    pub fn d_tag(&self) -> &str {
        &self.d_tag
    }

    pub fn base_dir(&self) -> &Path {
        &self.base_dir
    }

    pub fn conversation_db_path(&self) -> PathBuf {
        conversation_db_path(&self.base_dir, &self.d_tag)
    }

    /// Open the project's `conversation.db`, applying pending migrations.
    pub fn open_conversations(project_id: &str, base_dir: &Path) -> Result<ConversationStore> {
        let project = Self::new(project_id, base_dir)?;
        ConversationStore::open(&project.conversation_db_path())
    }

    /// Run the one-time migration from the legacy four-store layout.
    /// Idempotent. See [`crate::migration`].
    pub fn migrate_from_legacy(project_id: &str, base_dir: &Path) -> Result<MigrationReport> {
        crate::migration::migrate_from_legacy(project_id, base_dir)
    }
}
