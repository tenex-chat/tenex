//! kind:24011 `TenexInstalledAgentList` — backend inventory of installed
//! agents.
//!
//! Mirrors `InstalledAgentListService.publishImmediately` +
//! `createInventoryEvent` (`src/services/status/InstalledAgentListService.ts:32-65`).
//!
//! Event shape (TS verbatim):
//!
//! ```text
//! kind     = 24011
//! content  = ""
//! tags     = ["p", <whitelisted_pubkey>] for each whitelisted_pubkey
//!          + ["agent", <pubkey>, <slug>] for each stored agent,
//!            sorted first by slug, then by pubkey
//! ```
//!
//! Signed with the backend signer
//! (`config.tenexPrivateKey` → see [`crate::nostr_pub::backend_signer`]).

use anyhow::{anyhow, Context, Result};
use nostr_sdk::{Client, Event, EventBuilder, Keys, Kind, Tag, TagKind};

use crate::store::tenex_config::TenexConfigDoc;
use tenex_agent_storage::{derive_agent_pubkey_from_nsec, AgentStorage};

const KIND_INSTALLED_AGENT_LIST: u16 = 24011;

/// One entry in the inventory: `(pubkey-hex, slug)`. Equivalent to the TS
/// `{ pubkey, slug }` shape produced inside `createInventoryEvent`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentEntry {
    pub pubkey: String,
    pub slug: String,
}

/// Collect every stored agent (active + inactive + duplicates) into the
/// canonical inventory ordering (slug ASC, then pubkey ASC). Mirrors the
/// TS `agentStorage.getAllStoredAgents()` + `.map().sort()` pipeline at
/// `InstalledAgentListService.ts:50-59`.
pub fn collect_inventory_entries(base_dir: &std::path::Path) -> Result<Vec<AgentEntry>> {
    let storage = AgentStorage::open(base_dir)?;
    let stored = storage.get_all_stored_agents()?;
    let mut entries: Vec<AgentEntry> = stored
        .into_iter()
        .map(|(_filename_pubkey, agent)| -> Result<AgentEntry> {
            let nsec = agent
                .nsec()
                .ok_or_else(|| anyhow!("stored agent missing nsec"))?;
            let pubkey = derive_agent_pubkey_from_nsec(nsec)?;
            let slug = agent
                .slug()
                .ok_or_else(|| anyhow!("stored agent missing slug"))?
                .to_owned();
            Ok(AgentEntry { pubkey, slug })
        })
        .collect::<Result<_>>()?;
    sort_entries(&mut entries);
    Ok(entries)
}

/// Sort by slug, then pubkey — `localeCompare` against ASCII (the ports'
/// expected universe) collapses to byte ordering, which is what
/// `String::cmp` does.
fn sort_entries(entries: &mut [AgentEntry]) {
    entries.sort_by(|a, b| match a.slug.cmp(&b.slug) {
        std::cmp::Ordering::Equal => a.pubkey.cmp(&b.pubkey),
        other => other,
    });
}

/// Build (and sign) a kind:24011 inventory event. Pure function — does no
/// I/O of its own. Callers usually drive this via
/// [`publish_installed_agents_inventory`].
pub fn build_inventory_event(
    keys: &Keys,
    whitelisted_pubkeys: &[String],
    agents: &[AgentEntry],
) -> Result<Event> {
    let mut tags: Vec<Tag> = Vec::with_capacity(whitelisted_pubkeys.len() + agents.len());

    // ["p", <whitelistedPubkey>] — TS uses .tag() in `getWhitelistedPubkeys`
    // iteration order, so we mirror that.
    for pk in whitelisted_pubkeys {
        tags.push(
            Tag::parse(["p", pk.as_str()]).map_err(|e| anyhow!("build p tag for {pk}: {e}"))?,
        );
    }

    // ["agent", <pubkey>, <slug>] — pre-sorted by caller / `collect_inventory_entries`.
    for agent in agents {
        tags.push(Tag::custom(
            TagKind::Custom("agent".into()),
            [agent.pubkey.clone(), agent.slug.clone()],
        ));
    }

    let event = EventBuilder::new(Kind::Custom(KIND_INSTALLED_AGENT_LIST), "")
        .tags(tags)
        .sign_with_keys(keys)
        .map_err(|e| anyhow!("sign inventory event: {e}"))?;
    Ok(event)
}

/// Resolve relays to publish to. Mirrors the daemon's resolution: prefer
/// configured `relays` from `config.json`; fall back to the bundled
/// default.
fn resolve_relays(doc: &TenexConfigDoc) -> Vec<String> {
    let configured = doc.relays();
    if configured.is_empty() {
        vec!["wss://relay.tenex.chat".to_string()]
    } else {
        configured
    }
}

/// Sign and publish the inventory event. End-to-end orchestration:
/// load config + storage, build event, connect, send, drop client.
///
/// Best-effort by design — TS catches the publish error and logs a warning
/// (`AgentProvisioningService.ts:28-32`), continuing on. We mirror that:
/// errors during publish surface but are not fatal in callers that catch.
pub async fn publish_installed_agents_inventory(base_dir: &std::path::Path) -> Result<()> {
    let doc = TenexConfigDoc::load(base_dir)?;
    let whitelisted = doc.whitelisted_pubkeys();
    let relays = resolve_relays(&doc);

    let keys = crate::nostr_pub::backend_signer::ensure_backend_keys(base_dir)?;
    let agents = collect_inventory_entries(base_dir)?;
    let event = build_inventory_event(&keys, &whitelisted, &agents)?;

    let client = Client::new(keys);
    for relay in &relays {
        client
            .add_relay(relay.as_str())
            .await
            .with_context(|| format!("add_relay {relay}"))?;
    }
    client.connect().await;
    client
        .send_event(&event)
        .await
        .map_err(|e| anyhow!("send_event: {e}"))?;
    client.disconnect().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use indexmap::IndexMap;
    use serde_json::Value;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn unique_temp() -> std::path::PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!(
            "tenex-installed-agents-{}-{}-{n}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn make_keys() -> Keys {
        Keys::generate()
    }

    #[test]
    fn sort_entries_orders_by_slug_then_pubkey() {
        let mut entries = vec![
            AgentEntry {
                slug: "beta".into(),
                pubkey: "11".into(),
            },
            AgentEntry {
                slug: "alpha".into(),
                pubkey: "ff".into(),
            },
            AgentEntry {
                slug: "alpha".into(),
                pubkey: "00".into(),
            },
        ];
        sort_entries(&mut entries);
        assert_eq!(
            entries,
            vec![
                AgentEntry {
                    slug: "alpha".into(),
                    pubkey: "00".into()
                },
                AgentEntry {
                    slug: "alpha".into(),
                    pubkey: "ff".into()
                },
                AgentEntry {
                    slug: "beta".into(),
                    pubkey: "11".into()
                },
            ]
        );
    }

    #[test]
    fn build_event_has_correct_kind_and_empty_content() {
        let keys = make_keys();
        let event = build_inventory_event(&keys, &[], &[]).unwrap();
        assert_eq!(u16::from(event.kind), KIND_INSTALLED_AGENT_LIST);
        assert_eq!(event.content, "");
    }

    #[test]
    fn build_event_emits_one_p_tag_per_whitelisted_pubkey() {
        let keys = make_keys();
        let whitelisted: Vec<String> = vec!["a".repeat(64), "b".repeat(64), "c".repeat(64)];
        let event = build_inventory_event(&keys, &whitelisted, &[]).unwrap();
        let p_tags: Vec<Vec<&str>> = event
            .tags
            .iter()
            .filter_map(|t| {
                let s = t.as_slice();
                if s.first().map(String::as_str) == Some("p") {
                    Some(s.iter().map(String::as_str).collect())
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(p_tags.len(), 3);
        for (i, pk) in whitelisted.iter().enumerate() {
            assert_eq!(p_tags[i], vec!["p", pk.as_str()]);
        }
    }

    #[test]
    fn build_event_emits_agent_tag_with_pubkey_and_slug() {
        let keys = make_keys();
        let agents = vec![
            AgentEntry {
                slug: "alpha".into(),
                pubkey: "p1".into(),
            },
            AgentEntry {
                slug: "beta".into(),
                pubkey: "p2".into(),
            },
        ];
        let event = build_inventory_event(&keys, &[], &agents).unwrap();
        let agent_tags: Vec<Vec<&str>> = event
            .tags
            .iter()
            .filter_map(|t| {
                let s = t.as_slice();
                if s.first().map(String::as_str) == Some("agent") {
                    Some(s.iter().map(String::as_str).collect())
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(
            agent_tags,
            vec![vec!["agent", "p1", "alpha"], vec!["agent", "p2", "beta"],]
        );
    }

    #[test]
    fn build_event_signature_verifies() {
        let keys = make_keys();
        let event = build_inventory_event(&keys, &[], &[]).unwrap();
        // nostr's verify() returns Result<()>; success means signature good.
        event
            .verify()
            .expect("backend-signed inventory event must verify");
    }

    #[test]
    fn collect_inventory_returns_sorted_entries_from_storage() {
        let base = unique_temp();
        let mut storage = AgentStorage::open(&base).unwrap();
        // Build three agents with slugs in non-canonical order.
        for slug in ["zebra", "alpha", "mango"] {
            let nsec = tenex_agent_storage::generate_nsec_bech32().unwrap();
            let mut raw = IndexMap::<String, Value>::new();
            raw.insert("nsec".into(), Value::String(nsec));
            raw.insert("slug".into(), Value::String(slug.to_owned()));
            raw.insert("name".into(), Value::String(slug.to_owned()));
            raw.insert("role".into(), Value::String("thinker".to_owned()));
            raw.insert("status".into(), Value::String("active".to_owned()));
            let doc = tenex_agent_storage::AgentDoc::from_raw(raw);
            storage.save_agent(&doc).unwrap();
        }
        let entries = collect_inventory_entries(&base).unwrap();
        let slugs: Vec<&str> = entries.iter().map(|e| e.slug.as_str()).collect();
        assert_eq!(slugs, vec!["alpha", "mango", "zebra"]);
        // Pubkeys are 64-char hex.
        for e in &entries {
            assert_eq!(e.pubkey.len(), 64);
        }
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn build_event_p_tags_precede_agent_tags() {
        // TS source iterates p tags first then agents — preserve that order
        // so external consumers parsing the event see them in that order.
        let keys = make_keys();
        let whitelisted = vec!["a".repeat(64)];
        let agents = vec![AgentEntry {
            slug: "x".into(),
            pubkey: "p".into(),
        }];
        let event = build_inventory_event(&keys, &whitelisted, &agents).unwrap();
        let kinds: Vec<&str> = event
            .tags
            .iter()
            .map(|t| t.as_slice().first().map(String::as_str).unwrap_or(""))
            .collect();
        assert_eq!(kinds, vec!["p", "agent"]);
    }

    #[test]
    fn resolve_relays_uses_default_when_empty() {
        let base = unique_temp();
        let doc = TenexConfigDoc::load(&base).unwrap();
        // Fresh config has no relays.
        let relays = resolve_relays(&doc);
        assert_eq!(relays, vec!["wss://relay.tenex.chat".to_string()]);
        std::fs::remove_dir_all(&base).ok();
    }
}
