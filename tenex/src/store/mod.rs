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
mod llm_config_options;
#[cfg(test)]
mod project_ids;

/// Resolve the TENEX base directory. Precedence:
///
/// 1. Explicit override (CLI flag).
/// 2. `$TENEX_BASE_DIR` environment variable (non-empty).
/// 3. `$HOME/.tenex` (matches TS `getTenexBasePath()` at `src/constants.ts:22-23`).
pub fn resolve_base_dir(override_path: Option<PathBuf>) -> PathBuf {
    let raw = if let Some(p) = override_path {
        p
    } else if let Ok(p) = std::env::var("TENEX_BASE_DIR") {
        if p.is_empty() {
            default_home_base()
        } else {
            PathBuf::from(p)
        }
    } else {
        default_home_base()
    };
    absolutize(raw)
}

fn default_home_base() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join(".tenex")
}

/// Anchor a relative base dir to the current working directory once at
/// resolution time, then keep it stable forever after. The daemon supervisor
/// propagates this to children as `TENEX_BASE_DIR`; if it were left relative,
/// each child would re-resolve it against its own cwd and end up at a
/// different physical directory.
fn absolutize(p: PathBuf) -> PathBuf {
    if p.is_absolute() {
        return p;
    }
    match std::env::current_dir() {
        Ok(cwd) => cwd.join(p),
        Err(_) => p,
    }
}
