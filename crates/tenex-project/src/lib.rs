//! `tenex-project` — file-backed view of per-project TENEX state.
//!
//! Reads from `<base_dir>/projects/<dTag>/event.json` and
//! `<base_dir>/agents/<pubkey>.json`. No database, no write API.
//!
//! Project IDs are accepted as either a NIP-33 coordinate (`31933:<pubkey>:<dTag>`)
//! or a bare dTag; normalization happens at the API boundary in [`id`].

pub mod error;
pub mod id;
mod identity;
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
