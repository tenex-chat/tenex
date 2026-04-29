//! Reusable agent provisioning operations.
//!
//! Mirrors `src/services/agents/AgentProvisioningService.ts`. Each function
//! composes the local AgentStorage mutation with the Nostr inventory
//! publish (`kind:24011`) the way the TS service does. Suitable for
//! consumption by the CLI delete path, the interactive agent manager's
//! bulk operations, and any future automated cleanup flows.
//!
//! All functions are best-effort about the inventory publish — a publish
//! failure is logged but does not fail the operation, matching the TS
//! `try { … } catch { logger.warn(...) }` shape at
//! `AgentProvisioningService.ts:28-32`.

use anyhow::Result;

use crate::nostr_pub::installed_agents::publish_installed_agents_inventory;
use tenex_agent_registry::AgentStorage;

/// Options for [`delete_stored_agent`]. Mirrors the TS option bag
/// (`AgentProvisioningService.ts:69-75`).
///
/// **Do not derive `Default`.** TS's `publishInventory` defaults to
/// `true` (line :87 — `if (options?.publishInventory !== false)`).
/// Rust's `bool::default()` is `false`, so a derived `Default::default()`
/// would silently invert the semantics — callers expecting TS-equivalent
/// behaviour would skip the inventory publish without any warning.
/// Construct via [`DeleteOptions::new()`] to get the TS-faithful
/// starting point.
#[derive(Debug, Clone, Copy)]
pub struct DeleteOptions {
    /// When `false`, skip the kind:24011 inventory publish entirely.
    /// Defaults to `true` via `DeleteOptions::new()`. The bulk-merge
    /// orchestrator passes `false` for all but the last delete to avoid
    /// spamming the relay.
    pub publish_inventory: bool,
}

impl DeleteOptions {
    pub fn new() -> Self {
        Self {
            publish_inventory: true,
        }
    }

    pub fn with_publish_inventory(mut self, publish: bool) -> Self {
        self.publish_inventory = publish;
        self
    }
}

/// Delete a stored agent and (optionally) republish the kind:24011
/// inventory. Mirrors `deleteStoredAgent` (`AgentProvisioningService.ts:69-92`).
///
/// Returns `Ok(false)` when no agent file existed for `pubkey` (matching
/// TS `if (!existingAgent) return false;` at `:79-80`). Returns `Ok(true)`
/// when the agent was found and deleted; the inventory publish either
/// succeeded or surfaced a warning to stderr — failures here are not
/// fatal.
pub async fn delete_stored_agent(
    base_dir: &std::path::Path,
    pubkey: &str,
    options: DeleteOptions,
) -> Result<bool> {
    let mut storage = AgentStorage::open(base_dir)?;
    let deleted = storage.delete_agent(pubkey)?;
    if !deleted {
        return Ok(false);
    }

    if options.publish_inventory {
        if let Err(e) = publish_installed_agents_inventory(base_dir).await {
            // TS path: `logger.warn(...)`. Surface to stderr so CLI users see
            // the failure; tests / library callers can capture if needed.
            eprintln!(
                "{}",
                crate::tui::theme::chalk_yellow(&format!(
                    "Warning: failed to publish installed-agent inventory: {e}"
                )),
            );
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use indexmap::IndexMap;
    use serde_json::Value;
    use std::sync::atomic::{AtomicU64, Ordering};
    use tenex_agent_registry::{generate_nsec_bech32, AgentDoc};

    fn unique_temp() -> std::path::PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!(
            "tenex-provisioning-{}-{}-{n}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn save_agent(base: &std::path::Path, slug: &str) -> String {
        let mut storage = AgentStorage::open(base).unwrap();
        let nsec = generate_nsec_bech32().unwrap();
        let mut raw = IndexMap::<String, Value>::new();
        raw.insert("nsec".into(), Value::String(nsec));
        raw.insert("slug".into(), Value::String(slug.into()));
        raw.insert("name".into(), Value::String(slug.into()));
        raw.insert("role".into(), Value::String("thinker".into()));
        raw.insert("status".into(), Value::String("active".into()));
        let doc = AgentDoc::from_raw(raw);
        storage.save_agent(&doc).unwrap()
    }

    /// `publish_inventory: false` skips the network call entirely, so
    /// this test runs offline and verifies the local state change.
    #[tokio::test]
    async fn delete_stored_agent_skips_publish_when_disabled() {
        let base = unique_temp();
        let pk = save_agent(&base, "alpha");
        let result = delete_stored_agent(
            &base,
            &pk,
            DeleteOptions::new().with_publish_inventory(false),
        )
        .await
        .unwrap();
        assert!(result);
        // File gone.
        let storage = AgentStorage::open(&base).unwrap();
        assert!(storage.load_agent(&pk).unwrap().is_none());
        std::fs::remove_dir_all(&base).ok();
    }

    #[tokio::test]
    async fn delete_stored_agent_returns_false_for_missing() {
        let base = unique_temp();
        let result = delete_stored_agent(
            &base,
            "deadbeef",
            DeleteOptions::new().with_publish_inventory(false),
        )
        .await
        .unwrap();
        assert!(!result);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn delete_options_new_publishes_by_default() {
        // `DeleteOptions::new()` matches the TS default
        // (`publishInventory: true` unless caller passes `false`, per
        // `AgentProvisioningService.ts:87`). `Default` is *not* derived
        // on this type — `bool::default()` is `false`, which would
        // silently invert TS's semantics for any caller writing
        // `DeleteOptions::default()`.
        assert!(DeleteOptions::new().publish_inventory);
    }

    #[test]
    fn with_publish_inventory_round_trips() {
        let opts = DeleteOptions::new().with_publish_inventory(false);
        assert!(!opts.publish_inventory);
        let opts = opts.with_publish_inventory(true);
        assert!(opts.publish_inventory);
    }
}
