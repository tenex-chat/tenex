use std::collections::{BTreeSet, HashMap};
use std::sync::RwLock;

use crate::nostr_event::{NormalizedNostrEvent, SignedNostrEvent};

pub const PROJECT_AGENT_SNAPSHOT_KIND: u64 = 14199;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachedSnapshot {
    pub created_at: u64,
    pub p_tags: BTreeSet<String>,
}

/// Per-owner cache of the latest kind 14199 whitelist snapshot.
///
/// Events with a `created_at` strictly greater than the cached value replace
/// the entry. Events with the same `created_at` are treated as duplicates —
/// the cache keeps the first observation and reports no change even if the
/// p-tag set differs, because NIP-01 leaves ordering undefined within a
/// single timestamp and we want deterministic, monotonic behaviour.
#[derive(Default)]
pub struct SnapshotState {
    inner: RwLock<HashMap<String, CachedSnapshot>>,
}

impl SnapshotState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn observe(&self, event: &SignedNostrEvent) -> bool {
        if event.kind != PROJECT_AGENT_SNAPSHOT_KIND {
            return false;
        }
        self.apply(&event.pubkey, event.created_at, extract_p_tags(&event.tags))
    }

    pub fn observe_normalized(&self, event: &NormalizedNostrEvent) -> bool {
        if event.kind != PROJECT_AGENT_SNAPSHOT_KIND {
            return false;
        }
        let Some(pubkey) = event.pubkey.as_deref() else {
            return false;
        };
        let Some(created_at) = event.created_at else {
            return false;
        };
        self.apply(pubkey, created_at, extract_p_tags(&event.tags))
    }

    pub fn p_tags_for(&self, owner_pubkey: &str) -> Option<BTreeSet<String>> {
        let guard = self.inner.read().expect("snapshot state lock poisoned");
        guard.get(owner_pubkey).map(|entry| entry.p_tags.clone())
    }

    pub fn created_at_for(&self, owner_pubkey: &str) -> Option<u64> {
        let guard = self.inner.read().expect("snapshot state lock poisoned");
        guard.get(owner_pubkey).map(|entry| entry.created_at)
    }

    fn apply(&self, owner_pubkey: &str, created_at: u64, p_tags: BTreeSet<String>) -> bool {
        let mut guard = self.inner.write().expect("snapshot state lock poisoned");
        if let Some(existing) = guard.get(owner_pubkey)
            && existing.created_at >= created_at
        {
            return false;
        }
        guard.insert(
            owner_pubkey.to_string(),
            CachedSnapshot { created_at, p_tags },
        );
        true
    }
}

fn extract_p_tags(tags: &[Vec<String>]) -> BTreeSet<String> {
    tags.iter()
        .filter_map(|tag| match tag.as_slice() {
            [name, value, ..] if name == "p" => Some(value.clone()),
            _ => None,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use secp256k1::{Keypair, Secp256k1, SecretKey};

    fn pubkey_hex(fill_byte: u8) -> String {
        let secret_bytes = [fill_byte; 32];
        let secret = SecretKey::from_byte_array(secret_bytes).expect("valid secret");
        let secp = Secp256k1::new();
        let keypair = Keypair::from_secret_key(&secp, &secret);
        let (xonly, _) = keypair.x_only_public_key();
        hex::encode(xonly.serialize())
    }

    fn signed_event(kind: u64, pubkey: &str, created_at: u64, p_tags: &[&str]) -> SignedNostrEvent {
        let mut tags: Vec<Vec<String>> = p_tags
            .iter()
            .map(|value| vec!["p".to_string(), (*value).to_string()])
            .collect();
        tags.push(vec!["d".to_string(), "ignored".to_string()]);
        SignedNostrEvent {
            id: "0".repeat(64),
            pubkey: pubkey.to_string(),
            created_at,
            kind,
            tags,
            content: String::new(),
            sig: "0".repeat(128),
        }
    }

    #[test]
    fn observe_returns_false_on_non_14199_event() {
        let state = SnapshotState::new();
        let owner = pubkey_hex(0x01);
        let agent = pubkey_hex(0x02);
        let event = signed_event(14198, &owner, 100, &[&agent]);

        assert!(!state.observe(&event));
        assert!(state.p_tags_for(&owner).is_none());
    }

    #[test]
    fn observe_stores_new_owner_snapshot_and_returns_true() {
        let state = SnapshotState::new();
        let owner = pubkey_hex(0x01);
        let agent_a = pubkey_hex(0x02);
        let agent_b = pubkey_hex(0x03);
        let event = signed_event(14199, &owner, 100, &[&agent_a, &agent_b]);

        assert!(state.observe(&event));

        let expected: BTreeSet<String> = [agent_a, agent_b].into_iter().collect();
        assert_eq!(state.p_tags_for(&owner), Some(expected));
        assert_eq!(state.created_at_for(&owner), Some(100));
    }

    #[test]
    fn observe_ignores_older_created_at() {
        let state = SnapshotState::new();
        let owner = pubkey_hex(0x01);
        let agent_a = pubkey_hex(0x02);
        let agent_b = pubkey_hex(0x03);

        let newer = signed_event(14199, &owner, 200, &[&agent_a]);
        assert!(state.observe(&newer));

        let older = signed_event(14199, &owner, 199, &[&agent_b]);
        assert!(!state.observe(&older));

        let expected: BTreeSet<String> = [agent_a].into_iter().collect();
        assert_eq!(state.p_tags_for(&owner), Some(expected));
        assert_eq!(state.created_at_for(&owner), Some(200));
    }

    #[test]
    fn observe_accepts_newer_created_at_and_overwrites_p_tag_set() {
        let state = SnapshotState::new();
        let owner = pubkey_hex(0x01);
        let agent_a = pubkey_hex(0x02);
        let agent_b = pubkey_hex(0x03);

        let first = signed_event(14199, &owner, 100, &[&agent_a]);
        assert!(state.observe(&first));

        let second = signed_event(14199, &owner, 150, &[&agent_b]);
        assert!(state.observe(&second));

        let expected: BTreeSet<String> = [agent_b].into_iter().collect();
        assert_eq!(state.p_tags_for(&owner), Some(expected));
        assert_eq!(state.created_at_for(&owner), Some(150));
    }

    #[test]
    fn observe_with_same_created_at_and_same_p_tags_returns_false() {
        let state = SnapshotState::new();
        let owner = pubkey_hex(0x01);
        let agent = pubkey_hex(0x02);

        let first = signed_event(14199, &owner, 100, &[&agent]);
        assert!(state.observe(&first));

        let duplicate = signed_event(14199, &owner, 100, &[&agent]);
        assert!(!state.observe(&duplicate));

        let different = signed_event(14199, &owner, 100, &[&pubkey_hex(0x03)]);
        assert!(!state.observe(&different));

        let expected: BTreeSet<String> = [agent].into_iter().collect();
        assert_eq!(state.p_tags_for(&owner), Some(expected));
    }

    #[test]
    fn observe_normalized_matches_observe() {
        let signed_state = SnapshotState::new();
        let normalized_state = SnapshotState::new();

        let owner = pubkey_hex(0x01);
        let agent_a = pubkey_hex(0x02);
        let agent_b = pubkey_hex(0x03);

        let signed = signed_event(14199, &owner, 100, &[&agent_a, &agent_b]);
        assert!(signed_state.observe(&signed));
        assert!(normalized_state.observe_normalized(&signed.normalized()));

        assert_eq!(
            signed_state.p_tags_for(&owner),
            normalized_state.p_tags_for(&owner)
        );
        assert_eq!(
            signed_state.created_at_for(&owner),
            normalized_state.created_at_for(&owner)
        );

        let missing_pubkey = NormalizedNostrEvent {
            kind: PROJECT_AGENT_SNAPSHOT_KIND,
            content: String::new(),
            tags: vec![vec!["p".to_string(), agent_a.clone()]],
            pubkey: None,
            created_at: Some(500),
        };
        assert!(!normalized_state.observe_normalized(&missing_pubkey));

        let missing_created_at = NormalizedNostrEvent {
            kind: PROJECT_AGENT_SNAPSHOT_KIND,
            content: String::new(),
            tags: vec![vec!["p".to_string(), agent_a]],
            pubkey: Some(owner.clone()),
            created_at: None,
        };
        assert!(!normalized_state.observe_normalized(&missing_created_at));
    }

    #[test]
    fn p_tags_for_unknown_owner_returns_none() {
        let state = SnapshotState::new();
        assert!(state.p_tags_for(&pubkey_hex(0xAA)).is_none());
    }

    #[test]
    fn created_at_for_unknown_owner_returns_none() {
        let state = SnapshotState::new();
        assert!(state.created_at_for(&pubkey_hex(0xAB)).is_none());
    }

    #[test]
    fn map_key_is_author_pubkey_not_content() {
        let state = SnapshotState::new();
        let owner_a = pubkey_hex(0x01);
        let owner_b = pubkey_hex(0x02);
        let agent = pubkey_hex(0x03);

        let mut event = signed_event(14199, &owner_a, 100, &[&agent]);
        event.content = owner_b.clone();
        assert!(state.observe(&event));

        assert!(state.p_tags_for(&owner_a).is_some());
        assert!(state.p_tags_for(&owner_b).is_none());
    }
}
