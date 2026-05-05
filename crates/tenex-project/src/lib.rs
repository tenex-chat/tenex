//! `tenex-project` — file-backed view of per-project TENEX state.
//!
//! Reads from `<base_dir>/projects/<dTag>/event.json` and
//! `<base_dir>/agents/<pubkey>.json`. No database, no write API.
//!
//! Project IDs are accepted as either a NIP-33 coordinate (`31933:<pubkey>:<dTag>`)
//! or a bare dTag; normalization happens at the API boundary in [`id`].

pub mod error;
pub mod git;
pub mod id;
mod identity;
pub mod models;
pub mod paths;
pub mod project;
pub mod signer;
pub mod teams;

pub use error::{Error, Result};
pub use git::{
    branch_head_commit, create_worktree, current_branch, is_worktree_clean, list_worktrees,
    parse_worktree_list, push_branch_to_origin, resolve_working_dir, GitError, WorktreeInfo,
    WorktreeMetadata, WorktreeMetadataStore,
};
pub use id::{normalize_project_id, ProjectDTag};
pub use models::{Agent, ProjectAgent, ProjectMetadata};
pub use project::Project;
#[cfg(feature = "nip46")]
pub use signer::BunkerSigner;
pub use signer::{NsecSigner, Signer, SignerError, SignerScheme};
pub use teams::{load_teams, Team};
