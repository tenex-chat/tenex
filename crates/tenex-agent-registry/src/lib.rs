//! Global installed-agent JSON registry.
//!
//! Owns `<base_dir>/agents/index.json` and `<base_dir>/agents/<pubkey>.json`.

mod atomic;
pub mod category;
mod doc;
pub mod index;
mod keys;
pub mod paths;
pub mod projection;
mod sanitize;
mod serde_util;
pub mod storage;

pub use category::{is_valid_category, resolve_category, AgentCategory, VALID_CATEGORIES};
pub use doc::{AgentDoc, TelegramAgentConfig};
pub use index::{AgentIndexDoc, SlugEntry};
pub use keys::{derive_agent_pubkey_from_nsec, generate_nsec_bech32};
pub use paths::{agent_file_path, agents_dir, index_file_path};
pub use projection::{read_agent_projection_file, AgentProjection};
pub use storage::AgentStorage;

#[cfg(test)]
mod tests;
