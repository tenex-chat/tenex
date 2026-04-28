//! `tenex-llm-config` — LLM configuration resolver + IPC server.
//!
//! ## What this crate does
//!
//! 1. **Loads** `~/.tenex/llms.json` and `~/.tenex/providers.json`.
//! 2. **Resolves** a config name (e.g. `"opus"`, `"auto"`) to a fully
//!    hydrated response that includes the matching API keys from the
//!    provider's credential store.
//! 3. **Tracks key health**: callers report failures by provider+index;
//!    failed keys are excluded for 5 minutes before automatically recovering.
//! 4. **Serves** an NDJSON Unix-socket IPC so TypeScript (or any other
//!    process) can resolve configs without reading the raw files themselves.
//!
//! ## Starting the server
//!
//! ```no_run
//! # use std::path::PathBuf;
//! # async fn run() -> anyhow::Result<()> {
//! tenex_llm_config::Server::start(PathBuf::from("/home/user/.tenex")).await?;
//! # Ok(()) }
//! ```

pub mod key_health;
pub mod protocol;
pub mod resolver;
pub mod server;

pub use server::Server;
