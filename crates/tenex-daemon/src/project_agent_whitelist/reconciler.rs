use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tracing::warn;

use crate::agent_inventory::read_project_index_agent_pubkeys;
use crate::backend_config::Nip46Config;
use crate::backend_status_runtime::agents_dir;
use crate::nip46::client::{PublishOutboxHandle, SignError};
use crate::nip46::registry::{NIP46Registry, RegistryError};
use crate::nostr_event::NormalizedNostrEvent;
use crate::project_agent_whitelist::snapshot_state::{PROJECT_AGENT_SNAPSHOT_KIND, SnapshotState};

/// Diff the locally installed agent set against the cached 14199 snapshot
/// for a given owner; when they differ, build an unsigned kind 14199 event,
/// ask the owner's NIP-46 client to sign it, and enqueue the signed event to
/// the publish outbox.
#[derive(Debug, thiserror::Error)]
pub enum ReconcilerError {
    #[error("reconciler agent inventory error: {0}")]
    Inventory(String),
    #[error("reconciler registry error: {0}")]
    Registry(#[from] RegistryError),
    #[error("reconciler sign error: {0}")]
    Sign(#[from] SignError),
    #[error("reconciler outbox error: {0}")]
    Outbox(String),
}

#[derive(Debug, PartialEq, Eq)]
pub enum ReconcileOutcome {
    NoChange,
    Published { p_tag_count: usize },
}

pub struct ReconcilerDeps {
    pub tenex_base_dir: PathBuf,
    pub backend_pubkey: String,
    /// Whitelisted owner pubkeys shared with the daemon boot and the SIGHUP
    /// reload path. The reconciler itself does not iterate this set — each
    /// reconcile is driven by a trigger message carrying a specific owner
    /// pubkey — but the shared lock lets the daemon swap the configured set
    /// atomically and gives tests a way to observe the current configuration.
    pub owners: Arc<RwLock<Vec<String>>>,
    pub snapshot_state: Arc<SnapshotState>,
    pub nip46_registry: Arc<NIP46Registry>,
    pub nip46_config: Nip46Config,
    pub default_relay: String,
    pub outbox: Arc<dyn PublishOutboxHandle + Send + Sync>,
    pub debounce: Duration,
    pub idle_retry: Duration,
}

pub fn reconcile_owner(
    deps: &ReconcilerDeps,
    owner: &str,
) -> Result<ReconcileOutcome, ReconcilerError> {
    let local = read_project_index_agent_pubkeys(agents_dir(&deps.tenex_base_dir))
        .map_err(|err| ReconcilerError::Inventory(err.to_string()))?;

    let cached = deps.snapshot_state.p_tags_for(owner);
    if cached.is_none() && !deps.snapshot_state.is_catchup_complete() {
        return Ok(ReconcileOutcome::NoChange);
    }

    let desired = desired_p_tags(cached.as_ref(), &local, &deps.backend_pubkey);
    let current = cached.unwrap_or_default();
    if desired == current {
        return Ok(ReconcileOutcome::NoChange);
    }

    if desired.len() == 1 && desired.contains(&deps.backend_pubkey) {
        warn!(
            owner = %owner,
            backend_pubkey = %deps.backend_pubkey,
            "skipping 14199 reconciliation because no current snapshot or local agent pubkeys are available"
        );
        return Ok(ReconcileOutcome::NoChange);
    }

    let tags: Vec<Vec<String>> = desired
        .iter()
        .map(|pubkey| vec!["p".to_string(), pubkey.clone()])
        .collect();
    let unsigned = NormalizedNostrEvent {
        kind: PROJECT_AGENT_SNAPSHOT_KIND,
        content: String::new(),
        tags,
        pubkey: Some(owner.to_string()),
        created_at: Some(now_unix()),
    };

    let client =
        deps.nip46_registry
            .client_for_owner(owner, &deps.nip46_config, &deps.default_relay)?;
    let signed = client.sign_event(&unsigned)?;

    let p_tag_count = signed
        .tags
        .iter()
        .filter(|tag| tag.first().map(String::as_str) == Some("p"))
        .count();

    deps.outbox
        .enqueue(signed, vec![deps.default_relay.clone()])
        .map_err(ReconcilerError::Outbox)?;

    Ok(ReconcileOutcome::Published { p_tag_count })
}

fn desired_p_tags(
    cached: Option<&BTreeSet<String>>,
    local_agents: &BTreeSet<String>,
    backend_pubkey: &str,
) -> BTreeSet<String> {
    let mut desired = cached.cloned().unwrap_or_default();
    if !backend_pubkey.is_empty() {
        desired.insert(backend_pubkey.to_string());
    }
    desired.extend(local_agents.iter().cloned());
    desired
}

pub fn run_reconciler_loop(deps: ReconcilerDeps, trigger_rx: Receiver<String>) {
    let mut deadlines: BTreeMap<String, Instant> = BTreeMap::new();

    loop {
        let next_deadline = deadlines.values().copied().min();

        let recv_result = match next_deadline {
            None => trigger_rx
                .recv()
                .map_err(|_| RecvTimeoutError::Disconnected),
            Some(deadline) => {
                let wake_in = deadline
                    .saturating_duration_since(Instant::now())
                    .min(deps.idle_retry);
                trigger_rx.recv_timeout(wake_in)
            }
        };

        match recv_result {
            Ok(owner) => {
                deadlines.insert(owner, Instant::now() + deps.debounce);
            }
            Err(RecvTimeoutError::Timeout) => {
                let now = Instant::now();
                let due_owners: Vec<String> = deadlines
                    .iter()
                    .filter(|(_, deadline)| **deadline <= now)
                    .map(|(owner, _)| owner.clone())
                    .collect();

                for owner in due_owners {
                    match reconcile_owner(&deps, &owner) {
                        Ok(ReconcileOutcome::NoChange) | Ok(ReconcileOutcome::Published { .. }) => {
                            deadlines.remove(&owner);
                        }
                        Err(err) => {
                            warn!(
                                owner = %owner,
                                error = %err,
                                "reconcile_owner failed; rescheduling"
                            );
                            deadlines.insert(owner, Instant::now() + deps.idle_retry);
                        }
                    }
                }
            }
            Err(RecvTimeoutError::Disconnected) => {
                return;
            }
        }
    }
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time must be after UNIX_EPOCH")
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend_signer::HexBackendSigner;
    use crate::nip44;
    use crate::nip46::pending::PendingNip46Requests;
    use crate::nip46::protocol::{Nip46Request, Nip46Response};
    use crate::nostr_event::{SignedNostrEvent, canonical_payload, event_hash_hex};
    use secp256k1::{Keypair, PublicKey, Secp256k1, SecretKey};
    use std::collections::BTreeSet;
    use std::fs;
    use std::path::Path;
    use std::str::FromStr;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::mpsc;
    use std::thread::{self, JoinHandle};

    const BACKEND_SECRET_HEX: &str =
        "0101010101010101010101010101010101010101010101010101010101010101";
    const OWNER_SECRET_HEX: &str =
        "0202020202020202020202020202020202020202020202020202020202020202";

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    struct MockOutbox {
        captured: Mutex<Vec<(SignedNostrEvent, Vec<String>)>>,
    }

    impl MockOutbox {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                captured: Mutex::new(Vec::new()),
            })
        }

        fn captured(&self) -> Vec<(SignedNostrEvent, Vec<String>)> {
            self.captured.lock().unwrap().clone()
        }

        fn len(&self) -> usize {
            self.captured.lock().unwrap().len()
        }
    }

    impl PublishOutboxHandle for MockOutbox {
        fn enqueue(&self, event: SignedNostrEvent, relay_urls: Vec<String>) -> Result<(), String> {
            self.captured.lock().unwrap().push((event, relay_urls));
            Ok(())
        }
    }

    struct OwnerKeys {
        secret: SecretKey,
        keypair: Keypair,
        xonly_hex: String,
        secp: Secp256k1<secp256k1::All>,
    }

    impl OwnerKeys {
        fn from_secret_hex(secret_hex: &str) -> Self {
            let secret = SecretKey::from_str(secret_hex).expect("valid secret key");
            let secp = Secp256k1::new();
            let keypair = Keypair::from_secret_key(&secp, &secret);
            let (xonly, _) = keypair.x_only_public_key();
            Self {
                secret,
                keypair,
                xonly_hex: hex::encode(xonly.serialize()),
                secp,
            }
        }

        fn sign_event(&self, normalized: &NormalizedNostrEvent) -> SignedNostrEvent {
            let mut filled = normalized.clone();
            filled.pubkey = Some(self.xonly_hex.clone());
            if filled.created_at.is_none() {
                filled.created_at = Some(1_700_000_000);
            }
            let canonical = canonical_payload(&filled).expect("canonical payload");
            let id = event_hash_hex(&canonical);
            let digest: [u8; 32] = hex::decode(&id).unwrap().try_into().unwrap();
            let sig = self
                .secp
                .sign_schnorr_no_aux_rand(digest.as_slice(), &self.keypair);
            SignedNostrEvent {
                id,
                pubkey: self.xonly_hex.clone(),
                created_at: filled.created_at.unwrap(),
                kind: filled.kind,
                tags: filled.tags,
                content: filled.content,
                sig: hex::encode(sig.to_byte_array()),
            }
        }
    }

    fn backend_signer() -> Arc<HexBackendSigner> {
        Arc::new(
            HexBackendSigner::from_private_key_hex(BACKEND_SECRET_HEX)
                .expect("backend signer must load"),
        )
    }

    fn pubkey_hex(fill_byte: u8) -> String {
        let secret_bytes = [fill_byte; 32];
        let secret = SecretKey::from_byte_array(secret_bytes).expect("valid secret");
        let secp = Secp256k1::new();
        let keypair = Keypair::from_secret_key(&secp, &secret);
        let (xonly, _) = keypair.x_only_public_key();
        hex::encode(xonly.serialize())
    }

    fn unique_temp_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time after epoch")
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "tenex-reconciler-{label}-{}-{counter}-{nanos}",
            std::process::id()
        ))
    }

    fn write_agent(agents_dir_path: &Path, pubkey: &str, slug: &str) {
        fs::create_dir_all(agents_dir_path).expect("agents dir must create");
        fs::write(
            agents_dir_path.join(format!("{pubkey}.json")),
            serde_json::to_vec_pretty(&serde_json::json!({
                "slug": slug,
                "status": "active",
            }))
            .expect("agent json must serialize"),
        )
        .expect("agent file must write");
    }

    fn reconciler_deps_with_registered_client(
        backend: Arc<HexBackendSigner>,
        owner: &OwnerKeys,
        outbox: Arc<dyn PublishOutboxHandle + Send + Sync>,
        snapshot_state: Arc<SnapshotState>,
        tenex_base_dir: PathBuf,
        client_timeout: Duration,
        max_retries: u8,
    ) -> (ReconcilerDeps, Arc<NIP46Registry>, PendingNip46Requests) {
        let pending = PendingNip46Requests::default();
        let registry = Arc::new(NIP46Registry::new(
            Arc::clone(&backend),
            pending.clone(),
            Arc::clone(&outbox),
        ));

        let mut owners_config = std::collections::HashMap::new();
        owners_config.insert(
            owner.xonly_hex.clone(),
            crate::backend_config::OwnerNip46Config {
                bunker_uri: Some(format!(
                    "bunker://{}?relay=wss://relay.test/",
                    owner.xonly_hex
                )),
            },
        );
        let nip46_config = Nip46Config {
            signing_timeout_ms: client_timeout.as_millis() as u64,
            max_retries,
            owners: owners_config,
        };

        let deps = ReconcilerDeps {
            tenex_base_dir,
            backend_pubkey: backend.pubkey_hex().to_string(),
            owners: Arc::new(RwLock::new(vec![owner.xonly_hex.clone()])),
            snapshot_state,
            nip46_registry: Arc::clone(&registry),
            nip46_config,
            default_relay: "wss://relay.test/".to_string(),
            outbox,
            debounce: Duration::from_millis(50),
            idle_retry: Duration::from_millis(200),
        };

        (deps, registry, pending)
    }

    fn decrypt_request(
        owner: &OwnerKeys,
        backend_pubkey: &str,
        captured: &SignedNostrEvent,
    ) -> Nip46Request {
        let backend_pk =
            PublicKey::from_str(&format!("02{backend_pubkey}")).expect("valid backend pk");
        let conversation_key =
            nip44::conversation_key(&owner.secret, &backend_pk).expect("conversation key");
        let plaintext =
            nip44::decrypt(&conversation_key, &captured.content).expect("decrypt ciphertext");
        serde_json::from_slice(&plaintext).expect("parse request")
    }

    fn encrypt_response(
        owner: &OwnerKeys,
        backend_pubkey: &str,
        response: &Nip46Response,
    ) -> String {
        let backend_pk =
            PublicKey::from_str(&format!("02{backend_pubkey}")).expect("valid backend pk");
        let conversation_key =
            nip44::conversation_key(&owner.secret, &backend_pk).expect("conversation key");
        let plaintext = serde_json::to_string(response).expect("serialize response");
        nip44::encrypt(&conversation_key, plaintext.as_bytes()).expect("encrypt response")
    }

    fn wait_for_nip46_request_at_index(
        outbox: &MockOutbox,
        index: usize,
        timeout: Duration,
    ) -> Option<SignedNostrEvent> {
        let deadline = Instant::now() + timeout;
        loop {
            let captured = outbox.captured();
            // The outbox accumulates BOTH bunker-directed kind 24133
            // envelopes (from `client.sign_event` internals) AND the final
            // signed 14199 event enqueued by the reconciler. Callers that
            // expect a specific position must filter by kind if needed.
            if let Some(entry) = captured.get(index) {
                return Some(entry.0.clone());
            }
            if Instant::now() >= deadline {
                return None;
            }
            thread::sleep(Duration::from_millis(5));
        }
    }

    /// Spawn a mock bunker thread that:
    /// 1. Acks the initial `connect` request.
    /// 2. For each expected sign request, reads the unsigned template,
    ///    signs it with the owner's secret key, and dispatches the response.
    fn spawn_mock_bunker(
        registry: Arc<NIP46Registry>,
        owner_pubkey: &str,
        config: &Nip46Config,
        default_relay: &str,
        backend_pubkey: String,
        outbox: Arc<MockOutbox>,
        sign_rounds: usize,
    ) -> JoinHandle<()> {
        let owner_pubkey = owner_pubkey.to_string();
        let default_relay = default_relay.to_string();
        let config = config.clone();
        thread::spawn(move || {
            let owner_keys = OwnerKeys::from_secret_hex(OWNER_SECRET_HEX);
            // Trigger client materialisation so `dispatch_incoming` has a
            // target. The reconciler will also call `client_for_owner`; the
            // registry deduplicates, so this is safe.
            let client = registry
                .client_for_owner(&owner_pubkey, &config, &default_relay)
                .expect("client must build");

            // First captured event is always the connect envelope.
            let connect_event = wait_for_nip46_request_at_index(&outbox, 0, Duration::from_secs(5))
                .expect("connect request must be enqueued");
            let connect_request = decrypt_request(&owner_keys, &backend_pubkey, &connect_event);
            assert_eq!(connect_request.method, "connect");
            let connect_response = Nip46Response {
                id: connect_request.id,
                result: Some("ack".to_string()),
                error: None,
            };
            let encrypted_connect =
                encrypt_response(&owner_keys, &backend_pubkey, &connect_response);
            client
                .dispatch_incoming(&encrypted_connect)
                .expect("connect dispatch");

            for round in 0..sign_rounds {
                // Index 1, 2, ... are the sign_event envelopes for each
                // round.
                let sign_event =
                    wait_for_nip46_request_at_index(&outbox, 1 + round, Duration::from_secs(5))
                        .expect("sign_event request must be enqueued");
                let sign_request = decrypt_request(&owner_keys, &backend_pubkey, &sign_event);
                assert_eq!(sign_request.method, "sign_event");
                let unsigned: NormalizedNostrEvent =
                    serde_json::from_str(&sign_request.params[0]).unwrap();
                let signed = owner_keys.sign_event(&unsigned);
                let sign_response = Nip46Response {
                    id: sign_request.id,
                    result: Some(serde_json::to_string(&signed).unwrap()),
                    error: None,
                };
                let encrypted_sign = encrypt_response(&owner_keys, &backend_pubkey, &sign_response);
                client
                    .dispatch_incoming(&encrypted_sign)
                    .expect("sign dispatch");
            }
        })
    }

    #[test]
    fn reconcile_owner_no_change_when_local_equals_cached_snapshot() {
        let temp = unique_temp_dir("no-change");
        fs::create_dir_all(&temp).expect("temp dir");
        let agents = agents_dir(&temp);
        let agent_a = pubkey_hex(0x21);
        let agent_b = pubkey_hex(0x22);
        write_agent(&agents, &agent_a, "alpha");
        write_agent(&agents, &agent_b, "beta");

        let owner = OwnerKeys::from_secret_hex(OWNER_SECRET_HEX);
        let backend_pubkey = backend_signer().pubkey_hex().to_string();
        let snapshot_state = Arc::new(SnapshotState::new());
        let expected: BTreeSet<String> = [agent_a.clone(), agent_b.clone(), backend_pubkey.clone()]
            .into_iter()
            .collect();
        // Prime cache with a signed event whose p-tags match the inventory.
        let prime_event = SignedNostrEvent {
            id: "0".repeat(64),
            pubkey: owner.xonly_hex.clone(),
            created_at: 100,
            kind: PROJECT_AGENT_SNAPSHOT_KIND,
            tags: expected
                .iter()
                .map(|pk| vec!["p".to_string(), pk.clone()])
                .collect(),
            content: String::new(),
            sig: "0".repeat(128),
        };
        assert!(snapshot_state.observe(&prime_event));

        let outbox = MockOutbox::new();
        let outbox_handle: Arc<dyn PublishOutboxHandle + Send + Sync> = Arc::clone(&outbox) as _;
        let (deps, _registry, _pending) = reconciler_deps_with_registered_client(
            backend_signer(),
            &owner,
            outbox_handle,
            snapshot_state,
            temp.clone(),
            Duration::from_millis(200),
            0,
        );

        let outcome = reconcile_owner(&deps, &owner.xonly_hex).expect("reconcile succeeds");
        assert_eq!(outcome, ReconcileOutcome::NoChange);
        assert_eq!(outbox.len(), 0);
    }

    #[test]
    fn reconcile_owner_publishes_new_14199_when_local_has_extra_pubkey() {
        let temp = unique_temp_dir("extra-pubkey");
        fs::create_dir_all(&temp).expect("temp dir");
        let agents = agents_dir(&temp);
        let agent_a = pubkey_hex(0x21);
        let agent_b = pubkey_hex(0x22);
        write_agent(&agents, &agent_a, "alpha");
        write_agent(&agents, &agent_b, "beta");

        let owner = OwnerKeys::from_secret_hex(OWNER_SECRET_HEX);
        let snapshot_state = Arc::new(SnapshotState::new());
        // Cache has only agent_a.
        let prime_event = SignedNostrEvent {
            id: "0".repeat(64),
            pubkey: owner.xonly_hex.clone(),
            created_at: 100,
            kind: PROJECT_AGENT_SNAPSHOT_KIND,
            tags: vec![vec!["p".to_string(), agent_a.clone()]],
            content: String::new(),
            sig: "0".repeat(128),
        };
        assert!(snapshot_state.observe(&prime_event));

        let outbox = MockOutbox::new();
        let outbox_handle: Arc<dyn PublishOutboxHandle + Send + Sync> = Arc::clone(&outbox) as _;
        let (deps, registry, _pending) = reconciler_deps_with_registered_client(
            backend_signer(),
            &owner,
            outbox_handle,
            snapshot_state,
            temp.clone(),
            Duration::from_secs(2),
            0,
        );
        let backend_pubkey = backend_signer().pubkey_hex().to_string();

        let completer = spawn_mock_bunker(
            Arc::clone(&registry),
            &owner.xonly_hex,
            &deps.nip46_config,
            &deps.default_relay,
            backend_pubkey.clone(),
            Arc::clone(&outbox),
            1,
        );

        let outcome = reconcile_owner(&deps, &owner.xonly_hex).expect("reconcile succeeds");
        completer.join().expect("bunker thread");

        assert_eq!(outcome, ReconcileOutcome::Published { p_tag_count: 3 });
        // Outbox contains: connect envelope, sign_event envelope, final signed 14199.
        let captured = outbox.captured();
        assert_eq!(captured.len(), 3);
        let (final_event, final_relays) = captured.last().expect("final event").clone();
        assert_eq!(final_event.kind, PROJECT_AGENT_SNAPSHOT_KIND);
        assert_eq!(final_event.pubkey, owner.xonly_hex);
        assert_eq!(final_event.content, "");
        assert_eq!(final_relays, vec!["wss://relay.test/".to_string()]);
        let p_tags: BTreeSet<String> = final_event
            .tags
            .iter()
            .filter_map(|tag| match tag.as_slice() {
                [name, value, ..] if name == "p" => Some(value.clone()),
                _ => None,
            })
            .collect();
        let expected: BTreeSet<String> = [agent_a, agent_b, backend_pubkey].into_iter().collect();
        assert_eq!(p_tags, expected);
    }

    #[test]
    fn reconcile_owner_waits_for_snapshot_catchup_before_first_publish() {
        let temp = unique_temp_dir("wait-for-catchup");
        fs::create_dir_all(&temp).expect("temp dir");
        let agents = agents_dir(&temp);
        let agent_a = pubkey_hex(0x21);
        write_agent(&agents, &agent_a, "alpha");

        let owner = OwnerKeys::from_secret_hex(OWNER_SECRET_HEX);
        let snapshot_state = Arc::new(SnapshotState::new());
        let outbox = MockOutbox::new();
        let outbox_handle: Arc<dyn PublishOutboxHandle + Send + Sync> = Arc::clone(&outbox) as _;
        let (deps, _registry, _pending) = reconciler_deps_with_registered_client(
            backend_signer(),
            &owner,
            outbox_handle,
            snapshot_state,
            temp.clone(),
            Duration::from_millis(200),
            0,
        );

        let outcome = reconcile_owner(&deps, &owner.xonly_hex).expect("reconcile succeeds");

        assert_eq!(outcome, ReconcileOutcome::NoChange);
        assert_eq!(outbox.len(), 0);
    }

    #[test]
    fn reconcile_owner_skips_backend_only_publish_after_empty_catchup() {
        let temp = unique_temp_dir("backend-only");
        fs::create_dir_all(agents_dir(&temp)).expect("agents dir");

        let owner = OwnerKeys::from_secret_hex(OWNER_SECRET_HEX);
        let snapshot_state = Arc::new(SnapshotState::new());
        snapshot_state.mark_catchup_complete();
        let outbox = MockOutbox::new();
        let outbox_handle: Arc<dyn PublishOutboxHandle + Send + Sync> = Arc::clone(&outbox) as _;
        let (deps, _registry, _pending) = reconciler_deps_with_registered_client(
            backend_signer(),
            &owner,
            outbox_handle,
            snapshot_state,
            temp.clone(),
            Duration::from_millis(200),
            0,
        );

        let outcome = reconcile_owner(&deps, &owner.xonly_hex).expect("reconcile succeeds");

        assert_eq!(outcome, ReconcileOutcome::NoChange);
        assert_eq!(outbox.len(), 0);
    }

    #[test]
    fn reconcile_owner_preserves_existing_pubkeys_when_agent_removed() {
        let temp = unique_temp_dir("removed-agent");
        fs::create_dir_all(&temp).expect("temp dir");
        let agents = agents_dir(&temp);
        let agent_a = pubkey_hex(0x21);
        let agent_b = pubkey_hex(0x22);
        let agent_c = pubkey_hex(0x23);
        write_agent(&agents, &agent_a, "alpha");
        write_agent(&agents, &agent_b, "beta");
        // agent_c exists in cache but not on disk.

        let owner = OwnerKeys::from_secret_hex(OWNER_SECRET_HEX);
        let snapshot_state = Arc::new(SnapshotState::new());
        let cached_set: BTreeSet<String> = [agent_a.clone(), agent_b.clone(), agent_c.clone()]
            .into_iter()
            .collect();
        let prime_event = SignedNostrEvent {
            id: "0".repeat(64),
            pubkey: owner.xonly_hex.clone(),
            created_at: 100,
            kind: PROJECT_AGENT_SNAPSHOT_KIND,
            tags: cached_set
                .iter()
                .map(|pk| vec!["p".to_string(), pk.clone()])
                .collect(),
            content: String::new(),
            sig: "0".repeat(128),
        };
        assert!(snapshot_state.observe(&prime_event));

        let outbox = MockOutbox::new();
        let outbox_handle: Arc<dyn PublishOutboxHandle + Send + Sync> = Arc::clone(&outbox) as _;
        let (deps, registry, _pending) = reconciler_deps_with_registered_client(
            backend_signer(),
            &owner,
            outbox_handle,
            snapshot_state,
            temp.clone(),
            Duration::from_secs(2),
            0,
        );
        let backend_pubkey = backend_signer().pubkey_hex().to_string();

        let completer = spawn_mock_bunker(
            Arc::clone(&registry),
            &owner.xonly_hex,
            &deps.nip46_config,
            &deps.default_relay,
            backend_pubkey.clone(),
            Arc::clone(&outbox),
            1,
        );

        let outcome = reconcile_owner(&deps, &owner.xonly_hex).expect("reconcile succeeds");
        completer.join().expect("bunker thread");

        assert_eq!(outcome, ReconcileOutcome::Published { p_tag_count: 4 });
        let final_event = outbox.captured().last().expect("final event").0.clone();
        let p_tags: BTreeSet<String> = final_event
            .tags
            .iter()
            .filter_map(|tag| match tag.as_slice() {
                [name, value, ..] if name == "p" => Some(value.clone()),
                _ => None,
            })
            .collect();
        let expected: BTreeSet<String> = [agent_a, agent_b, agent_c.clone(), backend_pubkey]
            .into_iter()
            .collect();
        assert_eq!(p_tags, expected);
        assert!(p_tags.contains(&agent_c));
    }

    #[test]
    fn reconcile_owner_propagates_timeout_from_nip46_client() {
        let temp = unique_temp_dir("timeout");
        fs::create_dir_all(&temp).expect("temp dir");
        let agents = agents_dir(&temp);
        let agent_a = pubkey_hex(0x21);
        write_agent(&agents, &agent_a, "alpha");

        let owner = OwnerKeys::from_secret_hex(OWNER_SECRET_HEX);
        let snapshot_state = Arc::new(SnapshotState::new());
        snapshot_state.mark_catchup_complete();

        let outbox = MockOutbox::new();
        let outbox_handle: Arc<dyn PublishOutboxHandle + Send + Sync> = Arc::clone(&outbox) as _;
        let (deps, _registry, _pending) = reconciler_deps_with_registered_client(
            backend_signer(),
            &owner,
            outbox_handle,
            snapshot_state,
            temp.clone(),
            Duration::from_millis(50),
            0,
        );

        let result = reconcile_owner(&deps, &owner.xonly_hex);
        match result {
            Err(ReconcilerError::Sign(SignError::Timeout)) => {}
            other => panic!("expected Sign(Timeout), got {other:?}"),
        }
    }

    #[test]
    fn run_reconciler_loop_debounces_multiple_triggers_into_single_reconcile() {
        let temp = unique_temp_dir("debounce");
        fs::create_dir_all(&temp).expect("temp dir");
        let agents = agents_dir(&temp);
        let agent_a = pubkey_hex(0x21);
        let agent_b = pubkey_hex(0x22);
        write_agent(&agents, &agent_a, "alpha");
        write_agent(&agents, &agent_b, "beta");

        let owner = OwnerKeys::from_secret_hex(OWNER_SECRET_HEX);
        let snapshot_state = Arc::new(SnapshotState::new());
        // Cache has only agent_a, so reconcile is needed.
        let prime_event = SignedNostrEvent {
            id: "0".repeat(64),
            pubkey: owner.xonly_hex.clone(),
            created_at: 100,
            kind: PROJECT_AGENT_SNAPSHOT_KIND,
            tags: vec![vec!["p".to_string(), agent_a.clone()]],
            content: String::new(),
            sig: "0".repeat(128),
        };
        assert!(snapshot_state.observe(&prime_event));

        let outbox = MockOutbox::new();
        let outbox_handle: Arc<dyn PublishOutboxHandle + Send + Sync> = Arc::clone(&outbox) as _;
        let (deps, registry, _pending) = reconciler_deps_with_registered_client(
            backend_signer(),
            &owner,
            outbox_handle,
            snapshot_state,
            temp.clone(),
            Duration::from_secs(2),
            0,
        );
        let backend_pubkey = backend_signer().pubkey_hex().to_string();

        let completer = spawn_mock_bunker(
            Arc::clone(&registry),
            &owner.xonly_hex,
            &deps.nip46_config,
            &deps.default_relay,
            backend_pubkey,
            Arc::clone(&outbox),
            1,
        );

        let (tx, rx) = mpsc::channel();
        let owner_for_loop = owner.xonly_hex.clone();
        tx.send(owner_for_loop.clone()).unwrap();
        tx.send(owner_for_loop.clone()).unwrap();
        tx.send(owner_for_loop.clone()).unwrap();

        let loop_handle = thread::spawn(move || {
            run_reconciler_loop(deps, rx);
        });

        // Wait for the final 14199 to land in the outbox, then close the
        // trigger sender so the loop exits cleanly.
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let final_landed = outbox
                .captured()
                .iter()
                .any(|(event, _)| event.kind == PROJECT_AGENT_SNAPSHOT_KIND);
            if final_landed {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for 14199 publication"
            );
            thread::sleep(Duration::from_millis(5));
        }
        drop(tx);
        loop_handle.join().expect("loop thread joins");
        completer.join().expect("bunker thread");

        let sign_requests = outbox
            .captured()
            .iter()
            .filter(|(event, _)| event.kind == 24133)
            .count();
        // One connect envelope + one sign_event envelope = exactly 2.
        assert_eq!(sign_requests, 2);
        let final_events = outbox
            .captured()
            .iter()
            .filter(|(event, _)| event.kind == PROJECT_AGENT_SNAPSHOT_KIND)
            .count();
        assert_eq!(final_events, 1);
    }

    #[test]
    fn run_reconciler_loop_reschedules_on_sign_error() {
        let temp = unique_temp_dir("reschedule");
        fs::create_dir_all(&temp).expect("temp dir");
        let agents = agents_dir(&temp);
        let agent_a = pubkey_hex(0x21);
        let agent_b = pubkey_hex(0x22);
        write_agent(&agents, &agent_a, "alpha");
        write_agent(&agents, &agent_b, "beta");

        let owner = OwnerKeys::from_secret_hex(OWNER_SECRET_HEX);
        let snapshot_state = Arc::new(SnapshotState::new());
        let prime_event = SignedNostrEvent {
            id: "0".repeat(64),
            pubkey: owner.xonly_hex.clone(),
            created_at: 100,
            kind: PROJECT_AGENT_SNAPSHOT_KIND,
            tags: vec![vec!["p".to_string(), agent_a.clone()]],
            content: String::new(),
            sig: "0".repeat(128),
        };
        assert!(snapshot_state.observe(&prime_event));

        let outbox = MockOutbox::new();
        let outbox_handle: Arc<dyn PublishOutboxHandle + Send + Sync> = Arc::clone(&outbox) as _;
        let (deps, registry, _pending) = reconciler_deps_with_registered_client(
            backend_signer(),
            &owner,
            outbox_handle,
            snapshot_state,
            temp.clone(),
            Duration::from_secs(2),
            0,
        );
        let backend_pubkey = backend_signer().pubkey_hex().to_string();

        // Mock bunker: deny the first sign request, approve the second.
        let registry_for_bunker = Arc::clone(&registry);
        let owner_pubkey_for_bunker = owner.xonly_hex.clone();
        let config_for_bunker = deps.nip46_config.clone();
        let default_relay_for_bunker = deps.default_relay.clone();
        let outbox_for_bunker = Arc::clone(&outbox);
        let backend_pubkey_for_bunker = backend_pubkey.clone();
        let completer = thread::spawn(move || {
            let owner_keys = OwnerKeys::from_secret_hex(OWNER_SECRET_HEX);
            let client = registry_for_bunker
                .client_for_owner(
                    &owner_pubkey_for_bunker,
                    &config_for_bunker,
                    &default_relay_for_bunker,
                )
                .expect("client must build");

            // Connect.
            let connect_event =
                wait_for_nip46_request_at_index(&outbox_for_bunker, 0, Duration::from_secs(5))
                    .expect("connect must enqueue");
            let connect_request =
                decrypt_request(&owner_keys, &backend_pubkey_for_bunker, &connect_event);
            let connect_response = Nip46Response {
                id: connect_request.id,
                result: Some("ack".to_string()),
                error: None,
            };
            let encrypted_connect =
                encrypt_response(&owner_keys, &backend_pubkey_for_bunker, &connect_response);
            client
                .dispatch_incoming(&encrypted_connect)
                .expect("connect dispatch");

            // First sign_event → deny.
            let sign_event_one =
                wait_for_nip46_request_at_index(&outbox_for_bunker, 1, Duration::from_secs(5))
                    .expect("first sign must enqueue");
            let sign_request_one =
                decrypt_request(&owner_keys, &backend_pubkey_for_bunker, &sign_event_one);
            let deny_response = Nip46Response {
                id: sign_request_one.id,
                result: None,
                error: Some("denied".to_string()),
            };
            let encrypted_deny =
                encrypt_response(&owner_keys, &backend_pubkey_for_bunker, &deny_response);
            client
                .dispatch_incoming(&encrypted_deny)
                .expect("deny dispatch");

            // Second sign_event → approve.
            let sign_event_two =
                wait_for_nip46_request_at_index(&outbox_for_bunker, 2, Duration::from_secs(5))
                    .expect("second sign must enqueue");
            let sign_request_two =
                decrypt_request(&owner_keys, &backend_pubkey_for_bunker, &sign_event_two);
            let unsigned: NormalizedNostrEvent =
                serde_json::from_str(&sign_request_two.params[0]).unwrap();
            let signed = owner_keys.sign_event(&unsigned);
            let approve_response = Nip46Response {
                id: sign_request_two.id,
                result: Some(serde_json::to_string(&signed).unwrap()),
                error: None,
            };
            let encrypted_approve =
                encrypt_response(&owner_keys, &backend_pubkey_for_bunker, &approve_response);
            client
                .dispatch_incoming(&encrypted_approve)
                .expect("approve dispatch");
        });

        let (tx, rx) = mpsc::channel();
        tx.send(owner.xonly_hex.clone()).unwrap();

        let loop_handle = thread::spawn(move || {
            run_reconciler_loop(deps, rx);
        });

        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let final_landed = outbox
                .captured()
                .iter()
                .any(|(event, _)| event.kind == PROJECT_AGENT_SNAPSHOT_KIND);
            if final_landed {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for final 14199 publication after retry"
            );
            thread::sleep(Duration::from_millis(10));
        }
        drop(tx);
        loop_handle.join().expect("loop thread joins");
        completer.join().expect("bunker thread");

        let final_events = outbox
            .captured()
            .iter()
            .filter(|(event, _)| event.kind == PROJECT_AGENT_SNAPSHOT_KIND)
            .count();
        assert_eq!(final_events, 1);
    }
}
