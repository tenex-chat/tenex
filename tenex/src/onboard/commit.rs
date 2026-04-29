//! Commit phase that runs after Screen 2: applies daemon-key + projects-dir
//! defaults, persists `~/.tenex/config.json`, and ensures the projects
//! directory exists.
//!
//! Source: `src/commands/onboard.ts:1318-1421` (Screens 1.E, 1.F, and the
//! save block at `:1411-1421`).
//!
//! This module is pure persistence — no I/O prompts, no NDK setup. The
//! optional NDK-side work (background agent discovery, kind:0 profile
//! publish) is scoped to a separate iteration so this commit step can land
//! independently and is testable in isolation.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use nostr_sdk::Keys;

use crate::store::tenex_config::TenexConfigDoc;

/// Inputs needed to commit the initial config. Shape follows what
/// `runOnboarding` has assembled by line `:1411` of the TS source.
#[derive(Debug, Clone)]
pub struct InitialConfig {
    /// One-element list of the user's hex pubkey (per Screen 1).
    pub whitelisted_pubkeys: Vec<String>,
    /// Single chosen relay URL (per Screen 2).
    pub relay: String,
}

/// Result of [`commit`]: the resolved values that future steps may need.
#[derive(Debug, Clone)]
pub struct Committed {
    /// Hex form of the daemon's private key — carried over from
    /// `existingConfig.tenexPrivateKey` if present, otherwise generated.
    pub tenex_private_key: String,
    /// Resolved (absolute, `~`-expanded) projects base dir.
    pub projects_base: PathBuf,
}

/// Apply Screens 1.E and 1.F defaults and persist `config.json`.
///
/// Behaviours:
/// - **Daemon key** (`:1319-1331`): preserved if `existingConfig.tenexPrivateKey`
///   is present; otherwise generated via `Keys::generate()`. Errors out if
///   generation somehow fails (matches the TS `process.exit(1)` path).
/// - **Projects base** (`:1334`): preserved from existing config; otherwise
///   defaults to `$HOME/tenex`. Resolved to an absolute path before
///   persisting (TS uses `path.resolve` at `:1416, :1421`).
/// - **Persist** (`:1412-1421`): writes the merged config to disk via
///   [`TenexConfigDoc::save`] and ensures the projects directory exists.
pub fn commit(base_dir: &Path, input: InitialConfig) -> Result<Committed> {
    let mut doc = TenexConfigDoc::load(base_dir)
        .with_context(|| format!("loading config from {}", base_dir.display()))?;

    // Daemon key: carry over or generate.
    let tenex_private_key = match doc.tenex_private_key() {
        Some(k) if !k.trim().is_empty() => k,
        _ => {
            let keys = Keys::generate();
            keys.secret_key().to_secret_hex()
        }
    };
    if tenex_private_key.is_empty() {
        return Err(anyhow!("Failed to generate daemon key"));
    }

    // Projects base: carry over or default to $HOME/tenex.
    let projects_base_raw = match doc.projects_base() {
        Some(p) if !p.trim().is_empty() => p,
        _ => default_projects_base(),
    };
    let projects_base = resolve_path(&projects_base_raw);

    // Apply the merged settings, preserving every other key in `doc`.
    doc.set_whitelisted_pubkeys(input.whitelisted_pubkeys);
    doc.set_tenex_private_key(tenex_private_key.clone());
    doc.set_projects_base(projects_base.to_string_lossy().into_owned());
    doc.set_relays(vec![input.relay]);

    doc.save(base_dir)
        .with_context(|| format!("saving config to {}", base_dir.display()))?;

    fs::create_dir_all(&projects_base)
        .with_context(|| format!("creating projects directory {}", projects_base.display()))?;

    Ok(Committed {
        tenex_private_key,
        projects_base,
    })
}

/// `~/tenex` (no leading dot — matches the TS path at `:1334`, where the
/// projects dir lives alongside `~/.tenex`, not inside it). Reads `$HOME`
/// from the environment.
pub fn default_projects_base() -> String {
    default_projects_base_with_home(std::env::var("HOME").ok().as_deref())
}

/// Pure variant of [`default_projects_base`] for testability — takes the
/// `$HOME` value as an argument so tests don't have to mutate process
/// environment (which races across parallel test threads).
pub fn default_projects_base_with_home(home: Option<&str>) -> String {
    match home {
        Some(h) if !h.is_empty() => PathBuf::from(h)
            .join("tenex")
            .to_string_lossy()
            .into_owned(),
        _ => "tenex".to_owned(),
    }
}

/// Re-export of [`crate::utils::path_expand::resolve_path`].
///
/// This was originally an inline tilde-expanding `path.resolve`
/// analogue; consolidated into `utils::path_expand` (which also covers
/// the `expandHome` case independently) and re-exported here for
/// backwards-compatible callers + tests.
pub use crate::utils::path_expand::resolve_path;

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_temp() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "tenex-commit-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&p).unwrap();
        p
    }

    // The `~`-expansion variants of `resolve_path` are tested in
    // `crate::utils::path_expand::tests` with proper $HOME serialisation
    // via a process-wide mutex (`with_home`). Don't duplicate them here:
    // direct $HOME mutation in this module would race with those tests
    // under cargo's parallel test runner.

    #[test]
    fn resolve_path_passes_absolute_paths_through() {
        let p = resolve_path("/abs/path");
        assert_eq!(p, PathBuf::from("/abs/path"));
    }

    #[test]
    fn resolve_path_joins_relative_against_cwd() {
        let cwd = std::env::current_dir().unwrap();
        let p = resolve_path("rel/path");
        assert_eq!(p, cwd.join("rel/path"));
    }

    #[test]
    fn default_projects_base_is_home_slash_tenex() {
        // Use the pure variant so we don't race with other tests on $HOME.
        assert_eq!(
            default_projects_base_with_home(Some("/tmp/myhome")),
            "/tmp/myhome/tenex"
        );
    }

    #[test]
    fn default_projects_base_falls_back_to_relative_when_home_missing() {
        assert_eq!(default_projects_base_with_home(None), "tenex");
        assert_eq!(default_projects_base_with_home(Some("")), "tenex");
    }

    #[test]
    fn commit_writes_relay_pubkey_and_carries_over_unrelated_fields() {
        let base = fresh_temp();
        // Pre-existing config with an unrelated nested field — must survive.
        std::fs::write(
            base.join("config.json"),
            br#"{
  "version": 7,
  "logging": {
    "level": "info",
    "logFile": "/tmp/x"
  }
}"#,
        )
        .unwrap();
        let projects = base.join("projects-out");
        std::env::set_var("HOME", base.to_string_lossy().into_owned());
        // Force a known projects_base by pre-writing it.
        let mut doc = TenexConfigDoc::load(&base).unwrap();
        doc.set_projects_base(projects.to_string_lossy().into_owned());
        doc.save(&base).unwrap();

        let committed = commit(
            &base,
            InitialConfig {
                whitelisted_pubkeys: vec!["aa".repeat(32)],
                relay: "wss://relay.example.com".to_owned(),
            },
        )
        .unwrap();

        assert!(projects.exists(), "projects dir was not created");
        assert!(!committed.tenex_private_key.is_empty());

        let written = std::fs::read_to_string(base.join("config.json")).unwrap();
        // Carried-over fields preserved.
        assert!(written.contains("\"version\": 7"));
        assert!(written.contains("\"logFile\": \"/tmp/x\""));
        // New fields applied.
        assert!(written.contains("\"whitelistedPubkeys\""));
        assert!(written.contains("\"tenexPrivateKey\""));
        assert!(written.contains("\"relays\""));
        assert!(written.contains("wss://relay.example.com"));

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn commit_carries_over_existing_daemon_key_when_present() {
        let base = fresh_temp();
        let known_key = "aa".repeat(32); // 64 hex chars
        std::fs::write(
            base.join("config.json"),
            format!(
                r#"{{"tenexPrivateKey":"{known_key}","projectsBase":"{}"}}"#,
                base.join("p").to_string_lossy()
            )
            .as_bytes(),
        )
        .unwrap();

        let committed = commit(
            &base,
            InitialConfig {
                whitelisted_pubkeys: vec!["bb".repeat(32)],
                relay: "wss://r.example".to_owned(),
            },
        )
        .unwrap();

        assert_eq!(committed.tenex_private_key, known_key);

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn commit_generates_daemon_key_when_missing() {
        let base = fresh_temp();
        std::fs::write(
            base.join("config.json"),
            format!(
                r#"{{"projectsBase":"{}"}}"#,
                base.join("p").to_string_lossy()
            )
            .as_bytes(),
        )
        .unwrap();

        let committed = commit(
            &base,
            InitialConfig {
                whitelisted_pubkeys: vec!["bb".repeat(32)],
                relay: "wss://r.example".to_owned(),
            },
        )
        .unwrap();

        // Generated key must be 64 hex chars.
        assert_eq!(committed.tenex_private_key.len(), 64);
        assert!(committed
            .tenex_private_key
            .bytes()
            .all(|b| b.is_ascii_hexdigit()));

        std::fs::remove_dir_all(&base).ok();
    }
}
