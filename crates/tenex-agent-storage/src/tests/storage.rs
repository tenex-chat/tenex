use indexmap::IndexMap;
use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::*;

fn unique_temp() -> std::path::PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let p = std::env::temp_dir().join(format!(
        "tenex-agent-storage-{}-{}-{n}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&p).unwrap();
    p
}

use nostr_sdk::nips::nip19::FromBech32;
use nostr_sdk::SecretKey;

/// Build a minimal in-memory `AgentDoc` for tests. Returns
/// `(doc, expected_pubkey)`.
fn fixture_agent(slug: &str) -> (AgentDoc, String) {
    let nsec = generate_nsec_bech32().unwrap();
    let pubkey = derive_agent_pubkey_from_nsec(&nsec).unwrap();
    let mut raw = IndexMap::<String, Value>::new();
    raw.insert("nsec".into(), Value::String(nsec));
    raw.insert("slug".into(), Value::String(slug.into()));
    raw.insert("name".into(), Value::String(format!("{slug}-name")));
    raw.insert("role".into(), Value::String("thinker".into()));
    raw.insert("status".into(), Value::String("active".into()));
    (AgentDoc::from_raw(raw), pubkey)
}

#[test]
fn derive_pubkey_from_bech32_nsec_round_trips() {
    let nsec = generate_nsec_bech32().unwrap();
    assert!(nsec.starts_with("nsec1"));
    let pubkey = derive_agent_pubkey_from_nsec(&nsec).unwrap();
    assert_eq!(pubkey.len(), 64, "pubkey must be 64-char hex: {pubkey}");
    assert!(pubkey.chars().all(|c| c.is_ascii_hexdigit()));
}

#[test]
fn derive_pubkey_accepts_hex_nsec() {
    // TS NDKPrivateKeySigner accepts both bech32 and hex.
    let bech = generate_nsec_bech32().unwrap();
    let from_bech = derive_agent_pubkey_from_nsec(&bech).unwrap();
    // Convert bech32 → hex via SecretKey, and feed back as hex.
    let sk = SecretKey::from_bech32(&bech).unwrap();
    let hex_nsec: String = sk
        .as_secret_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let from_hex = derive_agent_pubkey_from_nsec(&hex_nsec).unwrap();
    assert_eq!(from_bech, from_hex);
}

#[test]
fn save_agent_writes_file_and_updates_index() {
    let base = unique_temp();
    let mut storage = AgentStorage::open(&base).unwrap();
    let (doc, expected_pubkey) = fixture_agent("alpha");
    let pubkey = storage.save_agent(&doc).unwrap();
    assert_eq!(pubkey, expected_pubkey);
    assert!(agent_file_path(&base, &pubkey).exists());
    // Index updated.
    assert_eq!(
        storage.index().lookup_pubkey_by_slug("alpha"),
        Some(pubkey.as_str())
    );
    // Re-loadable.
    let loaded = AgentDoc::load(&base, &pubkey).unwrap().unwrap();
    assert_eq!(loaded.slug(), Some("alpha"));
    std::fs::remove_dir_all(&base).ok();
}

#[test]
fn save_agent_persists_event_id_index() {
    let base = unique_temp();
    let mut storage = AgentStorage::open(&base).unwrap();
    let (mut doc, _) = fixture_agent("alpha");
    doc.raw_mut()
        .insert("eventId".into(), Value::String("evt-1".into()));
    let pubkey = storage.save_agent(&doc).unwrap();
    assert_eq!(
        storage.index().lookup_pubkey_by_event_id("evt-1"),
        Some(pubkey.as_str())
    );
    std::fs::remove_dir_all(&base).ok();
}

#[test]
fn save_agent_renames_slug_drops_old_index_entry() {
    let base = unique_temp();
    let mut storage = AgentStorage::open(&base).unwrap();
    let (mut doc, _) = fixture_agent("alpha");
    let pubkey = storage.save_agent(&doc).unwrap();
    // Rename the slug — old entry must vanish.
    doc.raw_mut()
        .insert("slug".into(), Value::String("beta".into()));
    storage.save_agent(&doc).unwrap();
    assert!(storage.index().lookup_pubkey_by_slug("alpha").is_none());
    assert_eq!(
        storage.index().lookup_pubkey_by_slug("beta"),
        Some(pubkey.as_str())
    );
    std::fs::remove_dir_all(&base).ok();
}

#[test]
fn delete_agent_removes_file_and_index_entries() {
    let base = unique_temp();
    let mut storage = AgentStorage::open(&base).unwrap();
    let (mut doc, _) = fixture_agent("alpha");
    doc.raw_mut()
        .insert("eventId".into(), Value::String("evt-1".into()));
    let pubkey = storage.save_agent(&doc).unwrap();

    let deleted = storage.delete_agent(&pubkey).unwrap();
    assert!(deleted);
    assert!(!agent_file_path(&base, &pubkey).exists());
    assert!(storage.index().lookup_pubkey_by_slug("alpha").is_none());
    assert!(storage.index().lookup_pubkey_by_event_id("evt-1").is_none());
    std::fs::remove_dir_all(&base).ok();
}

#[test]
fn delete_agent_returns_false_for_missing() {
    let base = unique_temp();
    let mut storage = AgentStorage::open(&base).unwrap();
    let result = storage.delete_agent("not-real").unwrap();
    assert!(!result);
    std::fs::remove_dir_all(&base).ok();
}

#[test]
fn add_agent_to_project_appends_project_id() {
    let base = unique_temp();
    let mut storage = AgentStorage::open(&base).unwrap();
    let (doc, _) = fixture_agent("alpha");
    let pubkey = storage.save_agent(&doc).unwrap();
    storage.add_agent_to_project(&pubkey, "P1").unwrap();
    let entry = storage.index().by_slug.get("alpha").unwrap();
    assert_eq!(entry.project_ids, vec!["P1".to_string()]);
    // Idempotent — a second add does not duplicate.
    storage.add_agent_to_project(&pubkey, "P1").unwrap();
    let entry = storage.index().by_slug.get("alpha").unwrap();
    assert_eq!(entry.project_ids, vec!["P1".to_string()]);
    std::fs::remove_dir_all(&base).ok();
}

#[test]
fn add_agent_reactivates_inactive_agent() {
    let base = unique_temp();
    let mut storage = AgentStorage::open(&base).unwrap();
    let (mut doc, _) = fixture_agent("alpha");
    doc.raw_mut()
        .insert("status".into(), Value::String("inactive".into()));
    let pubkey = storage.save_agent(&doc).unwrap();
    storage.add_agent_to_project(&pubkey, "P1").unwrap();
    let reloaded = AgentDoc::load(&base, &pubkey).unwrap().unwrap();
    assert!(reloaded.is_active(), "agent should reactivate on add");
    std::fs::remove_dir_all(&base).ok();
}

#[test]
fn remove_agent_from_last_project_marks_inactive() {
    let base = unique_temp();
    let mut storage = AgentStorage::open(&base).unwrap();
    let (doc, _) = fixture_agent("alpha");
    let pubkey = storage.save_agent(&doc).unwrap();
    storage.add_agent_to_project(&pubkey, "P1").unwrap();
    storage.add_agent_to_project(&pubkey, "P2").unwrap();
    storage.remove_agent_from_project(&pubkey, "P1").unwrap();
    let agent = AgentDoc::load(&base, &pubkey).unwrap().unwrap();
    assert!(agent.is_active(), "still in P2");
    storage.remove_agent_from_project(&pubkey, "P2").unwrap();
    let agent = AgentDoc::load(&base, &pubkey).unwrap().unwrap();
    assert!(!agent.is_active(), "no projects → inactive");
    std::fs::remove_dir_all(&base).ok();
}

#[test]
fn cleanup_duplicate_slugs_evicts_old_owner_from_overlap() {
    let base = unique_temp();
    let mut storage = AgentStorage::open(&base).unwrap();
    let (doc1, _) = fixture_agent("shared");
    let pk1 = storage.save_agent(&doc1).unwrap();
    storage.add_agent_to_project(&pk1, "P1").unwrap();

    // A second agent with same slug enters P1.
    let (doc2, _) = fixture_agent("shared");
    let pk2 = storage.save_agent(&doc2).unwrap();
    storage.add_agent_to_project(&pk2, "P1").unwrap();

    // pk2 should now own the slug; pk1 must be inactive after eviction.
    let entry = storage.index().by_slug.get("shared").unwrap();
    assert_eq!(entry.pubkey, pk2);
    let pk1_agent = AgentDoc::load(&base, &pk1).unwrap().unwrap();
    assert!(
        !pk1_agent.is_active(),
        "pk1 evicted from P1, no other projects"
    );
    std::fs::remove_dir_all(&base).ok();
}

#[test]
fn slug_exists_returns_true_for_any_recorded_slug() {
    let base = unique_temp();
    let mut storage = AgentStorage::open(&base).unwrap();
    let (doc, _) = fixture_agent("alpha");
    storage.save_agent(&doc).unwrap();
    assert!(storage.slug_exists("alpha"));
    assert!(!storage.slug_exists("beta"));
    std::fs::remove_dir_all(&base).ok();
}

#[test]
fn get_agent_by_slug_returns_loaded_doc() {
    let base = unique_temp();
    let mut storage = AgentStorage::open(&base).unwrap();
    let (doc, _) = fixture_agent("alpha");
    storage.save_agent(&doc).unwrap();
    let got = storage.get_agent_by_slug("alpha").unwrap().unwrap();
    assert_eq!(got.slug(), Some("alpha"));
    assert!(storage.get_agent_by_slug("missing").unwrap().is_none());
    std::fs::remove_dir_all(&base).ok();
}

#[test]
fn get_agent_by_slug_for_project_filters_correctly() {
    let base = unique_temp();
    let mut storage = AgentStorage::open(&base).unwrap();
    let (doc, _) = fixture_agent("alpha");
    let pk = storage.save_agent(&doc).unwrap();
    storage.add_agent_to_project(&pk, "P1").unwrap();
    assert!(storage
        .get_agent_by_slug_for_project("alpha", "P1")
        .unwrap()
        .is_some());
    assert!(storage
        .get_agent_by_slug_for_project("alpha", "P2")
        .unwrap()
        .is_none());
    std::fs::remove_dir_all(&base).ok();
}

#[test]
fn get_agent_by_event_id_returns_loaded_doc() {
    let base = unique_temp();
    let mut storage = AgentStorage::open(&base).unwrap();
    let (mut doc, _) = fixture_agent("alpha");
    doc.raw_mut()
        .insert("eventId".into(), Value::String("evt-7".into()));
    storage.save_agent(&doc).unwrap();
    let got = storage.get_agent_by_event_id("evt-7").unwrap().unwrap();
    assert_eq!(got.event_id(), Some("evt-7"));
    std::fs::remove_dir_all(&base).ok();
}

#[test]
fn get_canonical_active_agents_skips_inactive() {
    let base = unique_temp();
    let mut storage = AgentStorage::open(&base).unwrap();
    let (a1, _) = fixture_agent("a1");
    let (mut a2, _) = fixture_agent("a2");
    a2.raw_mut()
        .insert("status".into(), Value::String("inactive".into()));
    storage.save_agent(&a1).unwrap();
    storage.save_agent(&a2).unwrap();
    let canonical = storage.get_canonical_active_agents().unwrap();
    let slugs: Vec<_> = canonical
        .iter()
        .map(|d| d.slug().unwrap().to_owned())
        .collect();
    assert_eq!(slugs, vec!["a1".to_string()]);
    std::fs::remove_dir_all(&base).ok();
}

#[test]
fn get_all_stored_agents_includes_inactive() {
    let base = unique_temp();
    let mut storage = AgentStorage::open(&base).unwrap();
    let (a1, _) = fixture_agent("a1");
    let (mut a2, _) = fixture_agent("a2");
    a2.raw_mut()
        .insert("status".into(), Value::String("inactive".into()));
    storage.save_agent(&a1).unwrap();
    storage.save_agent(&a2).unwrap();
    let all = storage.get_all_stored_agents().unwrap();
    assert_eq!(all.len(), 2);
    std::fs::remove_dir_all(&base).ok();
}

#[test]
fn rebuild_index_recovers_from_missing_index_file() {
    let base = unique_temp();
    // Bootstrap: write two agents through storage.
    let pk_a;
    let pk_b;
    {
        let mut storage = AgentStorage::open(&base).unwrap();
        let (a1, _) = fixture_agent("a1");
        let (mut a2, _) = fixture_agent("a2");
        a2.raw_mut()
            .insert("eventId".into(), Value::String("E2".into()));
        pk_a = storage.save_agent(&a1).unwrap();
        pk_b = storage.save_agent(&a2).unwrap();
    }
    // Nuke the index.
    std::fs::remove_file(index_file_path(&base)).unwrap();
    // Re-open and rebuild.
    let mut storage = AgentStorage::open(&base).unwrap();
    assert!(
        storage.index().by_slug.is_empty(),
        "fresh open w/o index = empty"
    );
    storage.rebuild_index().unwrap();
    let pks: std::collections::HashSet<_> = storage
        .index()
        .by_slug
        .values()
        .map(|e| e.pubkey.clone())
        .collect();
    assert!(pks.contains(&pk_a));
    assert!(pks.contains(&pk_b));
    assert_eq!(
        storage.index().lookup_pubkey_by_event_id("E2"),
        Some(pk_b.as_str())
    );
    std::fs::remove_dir_all(&base).ok();
}

#[test]
fn save_inactive_agent_reassigns_slug_to_active_alternative() {
    // Source: `findAlternativeSlugOwner` (`AgentStorage.ts:432-454`)
    // + the inactive branch of saveAgent (`:605-628`).
    let base = unique_temp();
    let mut storage = AgentStorage::open(&base).unwrap();

    // Active agent A owns slug "shared" with no projects.
    let (doc_a, _) = fixture_agent("shared");
    let pk_a = storage.save_agent(&doc_a).unwrap();

    // Active agent B also has slug "shared" but isn't in the index yet —
    // since A was saved first, it owns. To get B into the index without
    // evicting A, we simulate the scenario: write B's file directly.
    let (doc_b, pk_b_expected) = fixture_agent("shared");
    doc_b.save(&base, &pk_b_expected).unwrap();
    let pk_b = pk_b_expected;

    // Now mark A inactive — the alternative owner should be discovered.
    let mut a_inactive = AgentDoc::load(&base, &pk_a).unwrap().unwrap();
    a_inactive
        .raw_mut()
        .insert("status".into(), Value::String("inactive".into()));
    storage.save_agent(&a_inactive).unwrap();

    let entry = storage.index().by_slug.get("shared").unwrap();
    assert_eq!(entry.pubkey, pk_b, "slug ownership should pass to active B");
    std::fs::remove_dir_all(&base).ok();
}
