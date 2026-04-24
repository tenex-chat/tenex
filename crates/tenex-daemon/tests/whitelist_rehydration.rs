//! Startup whitelist rehydration invariant.
//!
//! Proves that `build_static_filters` returns a non-empty filter set when the
//! daemon rehydrates its owner whitelist from `<daemon_dir>/whitelist.json` at
//! startup — even when `config.json` carries no `whitelistedPubkeys`.

use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};

use secp256k1::{Keypair, Secp256k1, SecretKey};
use tempfile::tempdir;

use tenex_daemon::daemon_whitelist_store::{read_daemon_whitelist, write_daemon_whitelist};
use tenex_daemon::project_event_index::ProjectEventIndex;
use tenex_daemon::subscription_filters::build_static_filters;
use tenex_daemon::subscription_runtime::{
    NostrSubscriptionPlanInput, build_nostr_subscription_plan,
};

const TEST_SECRET_KEY_HEX: &str =
    "0101010101010101010101010101010101010101010101010101010101010101";

fn pubkey_hex(fill_byte: u8) -> String {
    let secret_bytes = [fill_byte; 32];
    let secret = SecretKey::from_byte_array(secret_bytes).expect("valid secret");
    let secp = Secp256k1::new();
    let keypair = Keypair::from_secret_key(&secp, &secret);
    let (xonly, _) = keypair.x_only_public_key();
    hex::encode(xonly.serialize())
}

fn write_empty_config(base_dir: &Path) {
    // config.json with no whitelistedPubkeys but with a valid private key so
    // the backend signer can be derived (required by build_nostr_subscription_plan).
    fs::write(
        base_dir.join("config.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "tenexPrivateKey": TEST_SECRET_KEY_HEX,
        }))
        .expect("config must serialize"),
    )
    .expect("config must write");
}

fn fresh_project_event_index() -> Arc<Mutex<ProjectEventIndex>> {
    Arc::new(Mutex::new(ProjectEventIndex::new()))
}

#[test]
fn build_static_filters_returns_non_empty_for_seeded_pubkeys() {
    let owner = pubkey_hex(0x11);
    let filters = build_static_filters(&[owner.clone()], Some(1_710_001_000));
    assert!(
        !filters.is_empty(),
        "build_static_filters must return non-empty for non-empty authors"
    );
    assert!(
        filters.iter().all(|f| f.authors.contains(&owner)),
        "all static filters must include the seeded owner pubkey"
    );
}

#[test]
fn whitelist_round_trip_survives_simulated_restart() {
    let dir = tempdir().expect("tempdir");
    let daemon_dir = dir.path().join("daemon");
    let owner_a = pubkey_hex(0x22);
    let owner_b = pubkey_hex(0x33);

    // Simulate first-run persistence: daemon starts, has owners, writes them.
    write_daemon_whitelist(&daemon_dir, &[owner_a.clone(), owner_b.clone()]);

    // Simulate restart: read back the persisted whitelist.
    let rehydrated = read_daemon_whitelist(&daemon_dir);
    assert_eq!(rehydrated.len(), 2);
    assert!(rehydrated.contains(&owner_a));
    assert!(rehydrated.contains(&owner_b));

    // Verify that rehydrated pubkeys produce non-empty static filters.
    let filters = build_static_filters(&rehydrated, None);
    assert!(
        !filters.is_empty(),
        "rehydrated whitelist must produce non-empty static filters"
    );
}

#[test]
fn subscription_plan_uses_persisted_whitelist_when_config_is_empty() {
    let dir = tempdir().expect("tempdir");
    let base_dir = dir.path();
    let daemon_dir = base_dir.join("daemon");
    let owner = pubkey_hex(0x44);

    // config.json has no whitelistedPubkeys.
    write_empty_config(base_dir);

    // Seed the daemon whitelist (simulates a previous run that had owners).
    write_daemon_whitelist(&daemon_dir, &[owner.clone()]);
    let persisted = read_daemon_whitelist(&daemon_dir);

    let project_event_index = fresh_project_event_index();
    let plan = build_nostr_subscription_plan(NostrSubscriptionPlanInput {
        tenex_base_dir: base_dir,
        since: Some(1_710_001_000),
        lesson_definition_ids: &[],
        project_event_index: &project_event_index,
        persisted_whitelist: &persisted,
    })
    .expect("subscription plan must build with persisted whitelist");

    assert_eq!(
        plan.whitelisted_pubkeys,
        vec![owner.clone()],
        "plan must use the persisted whitelist as the effective owner set"
    );
    assert!(
        !plan.static_filters.is_empty(),
        "static filters must be non-empty when persisted whitelist provides owners"
    );
    assert!(
        plan.static_filters
            .iter()
            .all(|f| f.authors.contains(&owner)),
        "every static filter must include the rehydrated owner pubkey"
    );
    assert!(
        !plan.filters.is_empty(),
        "plan.filters must be non-empty so the subscription gateway starts"
    );
}

#[test]
fn subscription_plan_prefers_config_whitelist_over_persisted() {
    let dir = tempdir().expect("tempdir");
    let base_dir = dir.path();
    let daemon_dir = base_dir.join("daemon");
    let config_owner = pubkey_hex(0x55);
    let stale_owner = pubkey_hex(0x66);

    // config.json has an owner.
    fs::write(
        base_dir.join("config.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "tenexPrivateKey": TEST_SECRET_KEY_HEX,
            "whitelistedPubkeys": [config_owner],
        }))
        .expect("config must serialize"),
    )
    .expect("config must write");

    // Daemon whitelist has a different (stale) owner.
    write_daemon_whitelist(&daemon_dir, &[stale_owner.clone()]);
    let persisted = read_daemon_whitelist(&daemon_dir);

    let project_event_index = fresh_project_event_index();
    let plan = build_nostr_subscription_plan(NostrSubscriptionPlanInput {
        tenex_base_dir: base_dir,
        since: None,
        lesson_definition_ids: &[],
        project_event_index: &project_event_index,
        persisted_whitelist: &persisted,
    })
    .expect("subscription plan must build");

    // config.json is authoritative — stale persisted entry is ignored.
    assert_eq!(
        plan.whitelisted_pubkeys,
        vec![config_owner],
        "config.json whitelist must win over persisted fallback"
    );
    assert!(
        !plan.whitelisted_pubkeys.contains(&stale_owner),
        "stale persisted owner must not appear in plan when config has owners"
    );
}
