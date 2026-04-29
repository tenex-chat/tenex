//! Integration tests for IdentityCache: open, upsert, get_cached, stale check.

use std::time::{SystemTime, UNIX_EPOCH};

use tempfile::TempDir;
use tenex_identity::{IdentityCache, IdentityView};

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn make_view(pubkey: &str, fetched_at: i64) -> IdentityView {
    IdentityView {
        pubkey: pubkey.to_string(),
        display_name: Some("Alice".to_string()),
        name: Some("alice".to_string()),
        nip05: Some("alice@example.com".to_string()),
        picture: None,
        banner: None,
        about: Some("Nostr user".to_string()),
        lud16: None,
        event_id: Some("abc123".to_string()),
        created_at: Some(1_700_000_000),
        fetched_at,
    }
}

#[test]
fn open_creates_db_and_runs_migrations() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("identity-cache.db");
    let cache = IdentityCache::open(&path).unwrap();
    drop(cache);
    assert!(path.is_file());
    // Re-open should succeed (migrations are idempotent).
    let _ = IdentityCache::open(&path).unwrap();
}

#[test]
fn upsert_and_get_cached_fresh_row() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("identity-cache.db");
    let cache = IdentityCache::open(&path).unwrap();

    let pk = "0000000000000000000000000000000000000000000000000000000000000001";
    let view = make_view(pk, now_secs());

    // Before upsert, get_cached returns None.
    assert!(cache.get_cached(pk).unwrap().is_none());

    cache.upsert(&view).unwrap();

    let fetched = cache.get_cached(pk).unwrap().expect("should be present");
    assert_eq!(fetched.pubkey, pk);
    assert_eq!(fetched.display_name.as_deref(), Some("Alice"));
    assert_eq!(fetched.name.as_deref(), Some("alice"));
    assert!(!cache.is_stale(&fetched));
}

#[test]
fn stale_row_returns_none_from_get_cached() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("identity-cache.db");
    let cache = IdentityCache::open(&path).unwrap();

    let pk = "0000000000000000000000000000000000000000000000000000000000000002";
    // fetched_at is 25 hours ago.
    let stale_fetched_at = now_secs() - (25 * 60 * 60);
    let view = make_view(pk, stale_fetched_at);

    cache.upsert(&view).unwrap();

    // get_cached must return None for a stale row.
    assert!(cache.get_cached(pk).unwrap().is_none());
    // is_stale should agree.
    assert!(cache.is_stale(&view));
}

#[test]
fn upsert_overwrites_existing_row() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("identity-cache.db");
    let cache = IdentityCache::open(&path).unwrap();

    let pk = "0000000000000000000000000000000000000000000000000000000000000003";

    let mut v1 = make_view(pk, now_secs());
    v1.display_name = Some("Old Name".to_string());
    cache.upsert(&v1).unwrap();

    let mut v2 = make_view(pk, now_secs());
    v2.display_name = Some("New Name".to_string());
    cache.upsert(&v2).unwrap();

    let fetched = cache.get_cached(pk).unwrap().expect("should be present");
    assert_eq!(fetched.display_name.as_deref(), Some("New Name"));
}

#[test]
fn best_name_priority() {
    let base = IdentityView {
        pubkey: "abcdef1234567890".to_string(),
        display_name: None,
        name: None,
        nip05: None,
        picture: None,
        banner: None,
        about: None,
        lud16: None,
        event_id: None,
        created_at: None,
        fetched_at: now_secs(),
    };

    // Only pubkey — returns first 8 chars.
    assert_eq!(base.best_name(), "abcdef12");

    // name only.
    let with_name = IdentityView {
        name: Some("bob".to_string()),
        ..base.clone()
    };
    assert_eq!(with_name.best_name(), "bob");

    // display_name wins over name.
    let with_both = IdentityView {
        display_name: Some("Bob Display".to_string()),
        name: Some("bob".to_string()),
        ..base.clone()
    };
    assert_eq!(with_both.best_name(), "Bob Display");

    // Whitespace-only display_name falls through to name.
    let whitespace_dn = IdentityView {
        display_name: Some("   ".to_string()),
        name: Some("bob".to_string()),
        ..base.clone()
    };
    assert_eq!(whitespace_dn.best_name(), "bob");
}
