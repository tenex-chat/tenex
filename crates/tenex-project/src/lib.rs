//! `tenex-project` — typed SQLite-backed read/write view of per-project TENEX state.
//!
//! One SQLite file per project at `<base_dir>/projects/<dTag>/project.db`.
//! Library only: every Rust binary that needs project context links this crate
//! and opens the file directly. No daemon, no socket.
//!
//! Project IDs are accepted as either a NIP-33 coordinate (`31933:<pubkey>:<dTag>`)
//! or a bare dTag; normalization happens at the API boundary in [`id`].

pub mod error;
pub mod id;
pub mod legacy;
pub mod migrations;
pub mod models;
pub mod paths;
pub mod project;
pub mod signer;
pub mod teams;

pub use error::{Error, Result};
pub use id::{normalize_project_id, ProjectDTag};
pub use models::{Agent, ProjectAgent, ProjectMetadata};
pub use project::Project;
pub use signer::{NsecSigner, Signer, SignerError, SignerScheme};
pub use teams::{load_teams, render_teams_context, teams_for_agent, Team};
