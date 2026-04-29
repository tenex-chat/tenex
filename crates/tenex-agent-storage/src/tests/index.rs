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

fn write_file(path: &std::path::Path, bytes: &[u8]) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(path, bytes).unwrap();
}

use crate::index::parse_index;

#[test]
fn index_load_missing_returns_empty() {
    let base = unique_temp();
    let doc = AgentIndexDoc::load(&base).unwrap();
    assert!(doc.by_slug().is_empty());
    assert!(doc.by_event_id().is_empty());
    std::fs::remove_dir_all(&base).ok();
}

#[test]
fn index_round_trip_canonical_is_byte_identical() {
    let base = unique_temp();
    let canonical = br#"{
  "bySlug": {
    "alpha": {
      "pubkey": "aaaa",
      "projectIds": [
        "P1"
      ]
    },
    "beta": {
      "pubkey": "bbbb",
      "projectIds": []
    }
  },
  "byEventId": {
    "evt1": "aaaa"
  }
}"#;
    write_file(&index_file_path(&base), canonical);
    let doc = AgentIndexDoc::load(&base).unwrap();
    let bytes = doc.serialize_bytes().unwrap();
    assert_eq!(
        bytes.as_slice(),
        canonical.as_slice(),
        "byte-identical roundtrip"
    );
    std::fs::remove_dir_all(&base).ok();
}

#[test]
fn index_legacy_string_format_migrates() {
    // Source: `migrateIndexFormat` at `AgentStorage.ts:341-361`.
    let base = unique_temp();
    let legacy = br#"{
  "bySlug": {
    "alpha": "aaaa",
    "beta": "bbbb"
  },
  "byEventId": {}
}"#;
    write_file(&index_file_path(&base), legacy);
    let doc = AgentIndexDoc::load(&base).unwrap();
    assert_eq!(doc.by_slug().len(), 2);
    assert_eq!(doc.by_slug().get("alpha").unwrap().pubkey, "aaaa");
    assert_eq!(
        doc.by_slug().get("alpha").unwrap().project_ids,
        Vec::<String>::new()
    );
    // Disk should now be canonicalized.
    let on_disk = std::fs::read(index_file_path(&base)).unwrap();
    assert!(std::str::from_utf8(&on_disk)
        .unwrap()
        .contains("\"projectIds\""));
    std::fs::remove_dir_all(&base).ok();
}

#[test]
fn index_legacy_byproject_field_is_dropped() {
    let base = unique_temp();
    let legacy = br#"{
  "bySlug": {
    "alpha": {
      "pubkey": "aaaa",
      "projectIds": []
    }
  },
  "byEventId": {},
  "byProject": {
    "P1": ["aaaa"]
  }
}"#;
    write_file(&index_file_path(&base), legacy);
    let doc = AgentIndexDoc::load(&base).unwrap();
    assert_eq!(doc.by_slug().len(), 1);
    let on_disk = String::from_utf8(std::fs::read(index_file_path(&base)).unwrap()).unwrap();
    assert!(
        !on_disk.contains("byProject"),
        "byProject must be stripped on save: {on_disk}"
    );
    std::fs::remove_dir_all(&base).ok();
}

#[test]
fn index_round_trip_real_user_index() {
    // Brutal-verify against the user's actual ~/.tenex/agents/index.json
    // when present. This pin fires only on machines with real data;
    // CI without that file silently passes.
    let real = std::env::var("HOME")
        .ok()
        .map(std::path::PathBuf::from)
        .map(|h| h.join(".tenex/agents/index.json"));
    let Some(real_path) = real else { return };
    if !real_path.exists() {
        return;
    }
    let original = std::fs::read(&real_path).unwrap();
    // Parse the original (mark as canonical if it has no legacy bits).
    let parsed: Value = serde_json::from_slice(&original).unwrap();
    let (doc, needs_migration) = parse_index(&parsed).unwrap();
    if needs_migration {
        // Real file already canonical — but skip the byte-pin if it
        // somehow had legacy fields. The migration test covers that.
        return;
    }
    let regen = doc.serialize_bytes().unwrap();
    assert_eq!(
        regen.as_slice(),
        original.as_slice(),
        "real index.json round-trip diverged"
    );
}
