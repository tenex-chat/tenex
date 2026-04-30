use indexmap::IndexMap;
use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::*;

fn unique_temp() -> std::path::PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let p = std::env::temp_dir().join(format!(
        "tenex-agent-registry-{}-{}-{n}",
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

use crate::sanitize::{migrate_agent_data, normalize_loaded_agent, sanitize_for_persistence};
use crate::serde_util::serialize;

#[test]
fn agent_load_missing_returns_none() {
    let base = unique_temp();
    let doc = AgentDoc::load(&base, "deadbeef").unwrap();
    assert!(doc.is_none());
    std::fs::remove_dir_all(&base).ok();
}

#[test]
fn agent_round_trip_canonical_is_byte_identical() {
    let base = unique_temp();
    let pubkey = "abc123";
    let canonical = br#"{
  "nsec": "nsec1example",
  "slug": "tester",
  "name": "Tester",
  "role": "thinker",
  "instructions": "be careful",
  "useCriteria": "always",
  "status": "active",
  "default": {
    "skills": [
      "write-access"
    ]
  }
}"#;
    write_file(&agent_file_path(&base, pubkey), canonical);
    let doc = AgentDoc::load(&base, pubkey).unwrap().unwrap();
    // Re-save and compare bytes.
    doc.save(&base, pubkey).unwrap();
    let on_disk = std::fs::read(agent_file_path(&base, pubkey)).unwrap();
    assert_eq!(on_disk.as_slice(), canonical.as_slice());
    std::fs::remove_dir_all(&base).ok();
}

#[test]
fn agent_load_drops_project_overrides_and_writes_back() {
    // Source: `migrateAgentData` (`AgentStorage.ts:253-264`).
    let base = unique_temp();
    let pubkey = "deadbeef";
    let legacy = br#"{
  "nsec": "x",
  "slug": "s",
  "name": "n",
  "role": "r",
  "projectOverrides": {
    "P1": {}
  }
}"#;
    write_file(&agent_file_path(&base, pubkey), legacy);
    let doc = AgentDoc::load(&base, pubkey).unwrap().unwrap();
    assert!(!doc.raw().contains_key("projectOverrides"));
    // Should have been written back.
    let on_disk =
        String::from_utf8(std::fs::read(agent_file_path(&base, pubkey)).unwrap()).unwrap();
    assert!(!on_disk.contains("projectOverrides"));
    std::fs::remove_dir_all(&base).ok();
}

#[test]
fn agent_load_drops_pm_overrides() {
    let base = unique_temp();
    let pubkey = "feed";
    let legacy = br#"{
  "nsec": "x",
  "slug": "s",
  "name": "n",
  "role": "r",
  "pmOverrides": {
    "x": 1
  }
}"#;
    write_file(&agent_file_path(&base, pubkey), legacy);
    let doc = AgentDoc::load(&base, pubkey).unwrap().unwrap();
    assert!(!doc.raw().contains_key("pmOverrides"));
    std::fs::remove_dir_all(&base).ok();
}

#[test]
fn agent_save_drops_chat_bindings_from_telegram() {
    // Source: `sanitizeTelegramConfig` (`AgentStorage.ts:22-34`).
    let base = unique_temp();
    let pubkey = "cafe";
    let mut raw = IndexMap::<String, Value>::new();
    raw.insert("nsec".into(), "x".into());
    raw.insert("slug".into(), "s".into());
    raw.insert("name".into(), "n".into());
    raw.insert("role".into(), "r".into());
    let mut tg = serde_json::Map::new();
    tg.insert("botToken".into(), "tok".into());
    tg.insert("chatBindings".into(), serde_json::json!({"x": 1}));
    raw.insert("telegram".into(), Value::Object(tg));

    let doc = AgentDoc::from_raw(raw);
    doc.save(&base, pubkey).unwrap();

    let on_disk =
        String::from_utf8(std::fs::read(agent_file_path(&base, pubkey)).unwrap()).unwrap();
    assert!(
        !on_disk.contains("chatBindings"),
        "chatBindings must be stripped: {on_disk}"
    );
    assert!(on_disk.contains("botToken"));
    std::fs::remove_dir_all(&base).ok();
}

#[test]
fn agent_load_promotes_legacy_default_telegram_to_top_level() {
    // Source: `normalizeLoadedAgent` (`AgentStorage.ts:50-61`).
    let base = unique_temp();
    let pubkey = "promote";
    let legacy = br#"{
  "nsec": "x",
  "slug": "s",
  "name": "n",
  "role": "r",
  "default": {
    "skills": ["write-access"],
    "telegram": {
      "botToken": "tok"
    }
  }
}"#;
    write_file(&agent_file_path(&base, pubkey), legacy);
    let doc = AgentDoc::load(&base, pubkey).unwrap().unwrap();
    assert!(doc.raw().contains_key("telegram"));
    assert!(
        !doc.raw()
            .get("default")
            .and_then(Value::as_object)
            .map(|m| m.contains_key("telegram"))
            .unwrap_or(false),
        "default.telegram must be dropped after promotion"
    );
    // botToken must be preserved.
    let tg = doc.raw().get("telegram").unwrap().as_object().unwrap();
    assert_eq!(tg.get("botToken").and_then(Value::as_str), Some("tok"));
    std::fs::remove_dir_all(&base).ok();
}

#[test]
fn agent_load_strips_empty_default_block() {
    let base = unique_temp();
    let pubkey = "empty";
    let legacy = br#"{
  "nsec": "x",
  "slug": "s",
  "name": "n",
  "role": "r",
  "default": {}
}"#;
    write_file(&agent_file_path(&base, pubkey), legacy);
    let doc = AgentDoc::load(&base, pubkey).unwrap().unwrap();
    assert!(!doc.raw().contains_key("default"));
    std::fs::remove_dir_all(&base).ok();
}

#[test]
fn agent_load_strips_empty_telegram_block() {
    let base = unique_temp();
    let pubkey = "emptytel";
    let legacy = br#"{
  "nsec": "x",
  "slug": "s",
  "name": "n",
  "role": "r",
  "telegram": {}
}"#;
    write_file(&agent_file_path(&base, pubkey), legacy);
    let doc = AgentDoc::load(&base, pubkey).unwrap().unwrap();
    assert!(!doc.raw().contains_key("telegram"));
    std::fs::remove_dir_all(&base).ok();
}

#[test]
fn agent_top_level_telegram_wins_over_legacy_default_telegram() {
    // If both top-level telegram and default.telegram exist, the
    // top-level wins (`normalizeLoadedAgent` `:56-58`: `topLevelTelegram
    // ?? legacyDefaultTelegram`).
    let base = unique_temp();
    let pubkey = "doubletel";
    let legacy = br#"{
  "nsec": "x",
  "slug": "s",
  "name": "n",
  "role": "r",
  "telegram": {
    "botToken": "TOP"
  },
  "default": {
    "telegram": {
      "botToken": "LEGACY"
    }
  }
}"#;
    write_file(&agent_file_path(&base, pubkey), legacy);
    let doc = AgentDoc::load(&base, pubkey).unwrap().unwrap();
    let tg = doc.raw().get("telegram").unwrap().as_object().unwrap();
    assert_eq!(tg.get("botToken").and_then(Value::as_str), Some("TOP"));
    // default block should be gone (only had legacy telegram).
    assert!(!doc.raw().contains_key("default"));
    std::fs::remove_dir_all(&base).ok();
}

#[test]
fn agent_is_active_treats_missing_status_as_active() {
    // Source: `isAgentActive` (`AgentStorage.ts:169-174`).
    let mut raw = IndexMap::<String, Value>::new();
    raw.insert("nsec".into(), "x".into());
    raw.insert("slug".into(), "s".into());
    raw.insert("name".into(), "n".into());
    raw.insert("role".into(), "r".into());
    let doc = AgentDoc::from_raw(raw);
    assert!(doc.is_active());
}

#[test]
fn agent_is_active_only_inactive_string_means_inactive() {
    let mut raw = IndexMap::<String, Value>::new();
    raw.insert("status".into(), Value::String("inactive".into()));
    let doc = AgentDoc::from_raw(raw);
    assert!(!doc.is_active());

    let mut raw2 = IndexMap::<String, Value>::new();
    raw2.insert("status".into(), Value::String("active".into()));
    let doc2 = AgentDoc::from_raw(raw2);
    assert!(doc2.is_active());

    // Garbage status is treated as active (TS code's `=== "inactive"`).
    let mut raw3 = IndexMap::<String, Value>::new();
    raw3.insert("status".into(), Value::String("paused".into()));
    let doc3 = AgentDoc::from_raw(raw3);
    assert!(doc3.is_active());
}

#[test]
fn agent_typed_accessors_match_raw() {
    let base = unique_temp();
    let pubkey = "typed";
    let canonical = br#"{
  "nsec": "nsec1foo",
  "slug": "alpha",
  "name": "Alpha",
  "role": "thinker",
  "eventId": "evt1",
  "status": "active"
}"#;
    write_file(&agent_file_path(&base, pubkey), canonical);
    let doc = AgentDoc::load(&base, pubkey).unwrap().unwrap();
    assert_eq!(doc.nsec(), Some("nsec1foo"));
    assert_eq!(doc.slug(), Some("alpha"));
    assert_eq!(doc.name(), Some("Alpha"));
    assert_eq!(doc.role(), Some("thinker"));
    assert_eq!(doc.event_id(), Some("evt1"));
    assert_eq!(doc.status(), Some("active"));
    assert!(doc.is_active());
    std::fs::remove_dir_all(&base).ok();
}

#[test]
fn agent_category_accessor_resolves_through_role_categories() {
    use crate::AgentCategory;
    let base = unique_temp();
    let pubkey = "categorised";
    let canonical = br#"{
  "nsec": "nsec1foo",
  "slug": "alpha",
  "name": "Alpha",
  "role": "thinker",
  "category": "domain-expert",
  "description": "small philosopher",
  "instructions": "be careful",
  "useCriteria": "always"
}"#;
    write_file(&agent_file_path(&base, pubkey), canonical);
    let doc = AgentDoc::load(&base, pubkey).unwrap().unwrap();
    assert_eq!(doc.category(), Some(AgentCategory::DomainExpert));
    assert_eq!(doc.description(), Some("small philosopher"));
    assert_eq!(doc.instructions(), Some("be careful"));
    assert_eq!(doc.use_criteria(), Some("always"));
    std::fs::remove_dir_all(&base).ok();
}

#[test]
fn agent_load_promotes_legacy_inferred_category_to_category() {
    use crate::AgentCategory;
    let base = unique_temp();
    let pubkey = "legacy-inferred";
    let legacy = br#"{
  "nsec": "nsec1foo",
  "slug": "alpha",
  "name": "Alpha",
  "inferredCategory": "worker"
}"#;
    write_file(&agent_file_path(&base, pubkey), legacy);
    let doc = AgentDoc::load(&base, pubkey).unwrap().unwrap();
    assert_eq!(doc.category(), Some(AgentCategory::Worker));
    assert!(doc.raw().get("inferredCategory").is_none());
    assert_eq!(
        doc.raw().get("category").and_then(Value::as_str),
        Some("worker")
    );
    std::fs::remove_dir_all(&base).ok();
}

#[test]
fn agent_persistence_drops_legacy_inferred_category() {
    let base = unique_temp();
    let pubkey = "legacy-persist";
    let mut raw = IndexMap::<String, Value>::new();
    raw.insert("nsec".into(), Value::String("nsec1foo".into()));
    raw.insert("slug".into(), Value::String("alpha".into()));
    raw.insert("name".into(), Value::String("Alpha".into()));
    raw.insert("category".into(), Value::String("reviewer".into()));
    raw.insert("inferredCategory".into(), Value::String("worker".into()));
    let doc = AgentDoc::from_raw(raw);
    doc.save(&base, pubkey).unwrap();
    let loaded = AgentDoc::load(&base, pubkey).unwrap().unwrap();
    assert_eq!(
        loaded.raw().get("category").and_then(Value::as_str),
        Some("reviewer")
    );
    assert!(loaded.raw().get("inferredCategory").is_none());
    std::fs::remove_dir_all(&base).ok();
}

#[test]
fn agent_persistence_promotes_legacy_inferred_category_when_category_missing() {
    let base = unique_temp();
    let pubkey = "legacy-persist-promote";
    let mut raw = IndexMap::<String, Value>::new();
    raw.insert("nsec".into(), Value::String("nsec1foo".into()));
    raw.insert("slug".into(), Value::String("alpha".into()));
    raw.insert("name".into(), Value::String("Alpha".into()));
    raw.insert("inferredCategory".into(), Value::String("worker".into()));
    let doc = AgentDoc::from_raw(raw);
    doc.save(&base, pubkey).unwrap();
    let loaded = AgentDoc::load(&base, pubkey).unwrap().unwrap();
    assert_eq!(
        loaded.raw().get("category").and_then(Value::as_str),
        Some("worker")
    );
    assert!(loaded.raw().get("inferredCategory").is_none());
    std::fs::remove_dir_all(&base).ok();
}

#[test]
fn agent_telegram_config_accessor_extracts_typed_block() {
    let base = unique_temp();
    let pubkey = "tgagent";
    let canonical = br#"{
  "nsec": "nsec1foo",
  "slug": "alpha",
  "name": "Alpha",
  "role": "thinker",
  "telegram": {
    "botToken": "1234:abcd",
    "allowDMs": true,
    "apiBaseUrl": "https://api.test"
  }
}"#;
    write_file(&agent_file_path(&base, pubkey), canonical);
    let doc = AgentDoc::load(&base, pubkey).unwrap().unwrap();
    let tg = doc.telegram_config().unwrap();
    assert_eq!(tg.bot_token, "1234:abcd");
    assert_eq!(tg.allow_dms, Some(true));
    assert_eq!(tg.api_base_url.as_deref(), Some("https://api.test"));
    assert!(tg.publish_reasoning_to_telegram.is_none());
    std::fs::remove_dir_all(&base).ok();
}

#[test]
fn agent_telegram_config_returns_none_when_block_absent() {
    let base = unique_temp();
    let pubkey = "no-tg";
    let canonical = br#"{
  "nsec": "nsec1foo",
  "slug": "alpha",
  "name": "Alpha",
  "role": "thinker"
}"#;
    write_file(&agent_file_path(&base, pubkey), canonical);
    let doc = AgentDoc::load(&base, pubkey).unwrap().unwrap();
    assert!(doc.telegram_config().is_none());
    std::fs::remove_dir_all(&base).ok();
}

#[test]
fn update_agent_telegram_config_writes_and_clears() {
    // Use a real agent so storage's slug ownership invariants hold.
    let base = unique_temp();
    let mut storage = AgentStorage::open(&base).unwrap();
    let nsec = generate_nsec_bech32().unwrap();
    let mut raw = IndexMap::<String, Value>::new();
    raw.insert("nsec".into(), Value::String(nsec));
    raw.insert("slug".into(), Value::String("alpha".into()));
    raw.insert("name".into(), Value::String("Alpha".into()));
    raw.insert("role".into(), Value::String("thinker".into()));
    let pk = storage.save_agent(&AgentDoc::from_raw(raw)).unwrap();

    // Set a config.
    let cfg = TelegramAgentConfig {
        bot_token: "tok".into(),
        allow_dms: Some(true),
        api_base_url: None,
        publish_reasoning_to_telegram: None,
        publish_conversation_to_telegram: None,
    };
    let written = storage
        .update_agent_telegram_config(&pk, Some(&cfg))
        .unwrap();
    assert!(written);
    let agent = AgentDoc::load(&base, &pk).unwrap().unwrap();
    assert_eq!(agent.telegram_config().unwrap().bot_token, "tok");

    // Clear it.
    let cleared = storage.update_agent_telegram_config(&pk, None).unwrap();
    assert!(cleared);
    let agent = AgentDoc::load(&base, &pk).unwrap().unwrap();
    assert!(agent.telegram_config().is_none());

    std::fs::remove_dir_all(&base).ok();
}

#[test]
fn update_agent_telegram_config_returns_false_for_missing_agent() {
    let base = unique_temp();
    let mut storage = AgentStorage::open(&base).unwrap();
    let result = storage
        .update_agent_telegram_config("notfound", None)
        .unwrap();
    assert!(!result);
    std::fs::remove_dir_all(&base).ok();
}

#[test]
fn agent_category_unknown_resolves_to_none() {
    // Legacy values like "executor" / "expert" / "advisor" are
    // mentioned in storage.ts as auto-migrated. The strict resolver
    // returns None for them; the caller decides whether to migrate
    // or leave the on-disk value alone.
    let base = unique_temp();
    let pubkey = "legacy";
    let canonical = br#"{
  "nsec": "nsec1foo",
  "slug": "alpha",
  "name": "Alpha",
  "role": "thinker",
  "category": "executor"
}"#;
    write_file(&agent_file_path(&base, pubkey), canonical);
    let doc = AgentDoc::load(&base, pubkey).unwrap().unwrap();
    assert_eq!(doc.category(), None);
    std::fs::remove_dir_all(&base).ok();
}

#[test]
fn agent_round_trip_real_user_files() {
    // Brutal-verify pin: every real agent file in ~/.tenex/agents/ must
    // round-trip byte-identically through load → save (provided the file
    // has no legacy fields that would trigger a rewrite).
    let real_dir = std::env::var("HOME")
        .ok()
        .map(std::path::PathBuf::from)
        .map(|h| h.join(".tenex/agents"));
    let Some(real_dir) = real_dir else { return };
    if !real_dir.exists() {
        return;
    }

    let mut checked = 0usize;
    let mut skipped_legacy = 0usize;
    for entry in std::fs::read_dir(&real_dir).unwrap() {
        let entry = entry.unwrap();
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !name.ends_with(".json") || name == "index.json" {
            continue;
        }
        // Try to parse and round-trip.
        let original = std::fs::read(&path).unwrap();
        let mut raw: IndexMap<String, Value> = match serde_json::from_slice(&original) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let normalized = normalize_loaded_agent(&mut raw);
        let migrated = migrate_agent_data(&mut raw);
        if normalized || migrated {
            skipped_legacy += 1;
            continue;
        }
        // Now sanitize-on-save (which on a clean file should be no-op).
        sanitize_for_persistence(&mut raw);
        let regen = serialize(&raw).unwrap();
        // Some user files have a trailing `\n` from external editors —
        // TS `JSON.stringify` does not emit one, so neither do we.
        // Strip any single trailing `\n` from the original before the
        // byte-identical pin so we don't false-flag cosmetic editor
        // whitespace.
        let mut original_normalized = original.clone();
        if original_normalized.last() == Some(&b'\n') {
            original_normalized.pop();
        }
        assert_eq!(
            regen.as_slice(),
            original_normalized.as_slice(),
            "round-trip diverged for {}",
            path.display()
        );
        checked += 1;
    }
    eprintln!(
        "agent_round_trip_real_user_files: checked={checked} legacy_skipped={skipped_legacy}"
    );
}
