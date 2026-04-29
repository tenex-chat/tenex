//! On-disk configuration store.
//!
//! Mirrors the TS `ConfigService` (`src/services/ConfigService.ts`) and reads
//! from the same files under `~/.tenex/` (or `$TENEX_BASE_DIR`):
//!
//! | File             | Module                  | TS schema                                       |
//! |------------------|-------------------------|-------------------------------------------------|
//! | `config.json`    | [`tenex_config`]        | `TenexConfigSchema` (`src/services/config/types.ts:133`) |
//! | `llms.json`      | (next iteration)        | `TenexLLMsSchema` (`:396`)                      |
//! | `providers.json` | (next iteration)        | `TenexProvidersSchema` (`:435`)                 |
//! | `mcp.json`       | (next iteration)        | `TenexMCPSchema` (`:466`)                       |
//!
//! All read/write paths preserve insertion order (via `IndexMap`) so files
//! round-trip byte-identically when only typed fields change. Writes use
//! 2-space indent with no trailing newline (matching TS
//! `JSON.stringify(data, null, 2)` at `src/lib/fs/filesystem.ts:115`).

use std::path::PathBuf;

pub mod api_keys;
pub mod atomic;
pub mod conversation_disk_reader;
pub mod embed;
pub mod llms;
pub mod models_dev;
pub mod path_safety;
pub mod project_members;
pub mod project_mutation;
pub mod provider_ids;
pub mod providers;
pub mod tenex_config;

#[cfg(test)]
mod agent_home_env;
#[cfg(test)]
mod agent_home_files;
#[cfg(test)]
mod embed_models;
#[cfg(test)]
mod event_ids;
#[cfg(test)]
mod llm_config_options;
#[cfg(test)]
mod mcp;
#[cfg(test)]
mod project_ids;

/// Resolve the TENEX base directory. Precedence:
///
/// 1. Explicit override (CLI flag).
/// 2. `$TENEX_BASE_DIR` environment variable (non-empty).
/// 3. `$HOME/.tenex` (matches TS `getTenexBasePath()` at `src/constants.ts:22-23`).
pub fn resolve_base_dir(override_path: Option<PathBuf>) -> PathBuf {
    if let Some(p) = override_path {
        return p;
    }
    if let Ok(p) = std::env::var("TENEX_BASE_DIR") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join(".tenex")
}
