//! Daemon-side view of `~/.tenex/config.json`.
//!
//! Thin wrapper over [`crate::store::tenex_config::TenexConfigDoc`] that
//! enforces the daemon's startup invariants (non-empty whitelist, default
//! relay) and exposes a flat `Config` struct for the supervisor + nostr
//! subscription code.

use std::path::Path;

use anyhow::{anyhow, Result};

use crate::store::tenex_config::TenexConfigDoc;

const DEFAULT_RELAYS: &[&str] = &["wss://relay.tenex.chat"];

/// Daemon's resolved view of the config — defaults applied, invariants
/// validated. The full document is in `crate::store::tenex_config`.
#[derive(Debug, Clone)]
pub struct Config {
    pub whitelisted_pubkeys: Vec<String>,
    pub relays: Vec<String>,
    /// See `TenexConfigDoc::route_unauthorized_authors` — defaults to
    /// false. Controls whether external-author kind:1 events that match
    /// a project's `#a` tag are eligible for firewall + dispatch.
    pub route_unauthorized_authors: bool,
    /// Human-readable name for this backend instance (`backendName` in
    /// config.json). Emitted as `["backend", "<name>"]` on kind:0 agent
    /// profiles so clients can distinguish multi-backend setups.
    pub backend_name: Option<String>,
}

/// Load `<base_dir>/config.json` and apply daemon-startup invariants.
/// Errors when `whitelistedPubkeys` is missing or empty.
pub fn load(base_dir: &Path) -> Result<Config> {
    let doc = TenexConfigDoc::load(base_dir)?;

    let whitelisted_pubkeys = doc.whitelisted_pubkeys();
    if whitelisted_pubkeys.is_empty() {
        return Err(anyhow!(
            "no whitelistedPubkeys in {}/config.json — run `tenex onboard` first",
            base_dir.display()
        ));
    }

    let relays = if doc.relays().is_empty() {
        DEFAULT_RELAYS.iter().map(|s| (*s).to_string()).collect()
    } else {
        doc.relays()
    };

    Ok(Config {
        whitelisted_pubkeys,
        relays,
        route_unauthorized_authors: doc.route_unauthorized_authors(),
        backend_name: doc.backend_name(),
    })
}
