//! `tenex-llm-config` — filesystem-backed LLM configuration resolver.
//!
//! ## What this crate does
//!
//! 1. **Loads** `~/.tenex/llms.json` and `~/.tenex/providers.json`.
//! 2. **Resolves** a config name (e.g. `"opus"`, `"auto"`) to a fully
//!    hydrated response that includes the matching API keys from the
//!    provider's credential store.
//! 3. **Tracks key health**: callers can share a [`key_health::KeyHealthTracker`]
//!    and exclude failed keys for the cooldown window.

mod configs;
mod files;
pub mod key_health;
pub mod resolver;
pub mod types;

pub use types::{AcpConfig, ApiKey, MetaConfig, ResolvedConfig, ResolvedVariant, StandardConfig};
