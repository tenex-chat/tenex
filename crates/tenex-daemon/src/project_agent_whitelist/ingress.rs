use std::fmt;
use std::sync::{Arc, Mutex, RwLock};

use tokio::sync::mpsc;

use crate::backend_heartbeat_latch::BackendHeartbeatLatchPlanner;
use crate::nip46::protocol::NIP46_KIND;
use crate::nip46::registry::NIP46Registry;
use crate::nostr_event::SignedNostrEvent;
use crate::project_agent_whitelist::snapshot_state::{PROJECT_AGENT_SNAPSHOT_KIND, SnapshotState};

/// Routes verified incoming Nostr events to the project-agent-whitelist and
/// NIP-46 subsystems.
///
/// Both kinds this ingress cares about (14199 and 24133) are signed by the
/// project owner: kind-14199 is the owner's project agent snapshot, and
/// kind-24133 bunker replies are signed by the owner key as well. All other
/// kinds are ignored.
pub struct WhitelistIngress {
    pub snapshot_state: Arc<SnapshotState>,
    pub heartbeat_latch: Arc<Mutex<BackendHeartbeatLatchPlanner>>,
    pub owners: Arc<RwLock<Vec<String>>>,
    pub reconciler_trigger: mpsc::Sender<String>,
    pub nip46_registry: Arc<NIP46Registry>,
}

impl fmt::Debug for WhitelistIngress {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WhitelistIngress")
            .finish_non_exhaustive()
    }
}

impl WhitelistIngress {
    pub fn handle_event(&self, event: &SignedNostrEvent) {
        match event.kind {
            PROJECT_AGENT_SNAPSHOT_KIND => {
                if self.snapshot_state.observe(event) {
                    let _ = self.reconciler_trigger.try_send(event.pubkey.clone());
                }
                if let Ok(mut latch) = self.heartbeat_latch.lock() {
                    latch.observe_signed_event(event);
                }
            }
            NIP46_KIND => {
                if let Some(client) = self.nip46_registry.client_for_cached_owner(&event.pubkey) {
                    let _ = client.dispatch_incoming(&event.content);
                }
            }
            _ => {}
        }
    }

    pub fn handle_eose(&self) {
        if !self.snapshot_state.mark_catchup_complete() {
            return;
        }

        let owners = self
            .owners
            .read()
            .expect("whitelist owners lock must not be poisoned")
            .clone();
        for owner in owners {
            let _ = self.reconciler_trigger.try_send(owner);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;
    use std::time::Duration;
    use tokio::sync::mpsc as tokio_mpsc;

    use secp256k1::{Keypair, Secp256k1, SecretKey};

    use crate::backend_config::Nip46Config;
    use crate::backend_heartbeat_latch::BackendHeartbeatLatchState;
    use crate::backend_signer::HexBackendSigner;
    use crate::nip46::client::PublishOutboxHandle;
    use crate::nip46::pending::PendingNip46Requests;
    use crate::nip46::registry::NIP46Registry;
    use crate::nostr_event::{NormalizedNostrEvent, canonical_payload, event_hash_hex};

    const BACKEND_SECRET_HEX: &str =
        "0101010101010101010101010101010101010101010101010101010101010101";
    const OWNER_SECRET_HEX: &str =
        "0202020202020202020202020202020202020202020202020202020202020202";

    struct TestOutbox;

    impl PublishOutboxHandle for TestOutbox {
        fn enqueue(
            &self,
            _event: SignedNostrEvent,
            _relay_urls: Vec<String>,
        ) -> Result<(), String> {
            Ok(())
        }
    }

    struct OwnerKeys {
        keypair: Keypair,
        secp: Secp256k1<secp256k1::All>,
        xonly_hex: String,
    }

    impl OwnerKeys {
        fn from_secret_hex(secret_hex: &str) -> Self {
            let secret = SecretKey::from_str(secret_hex).expect("valid secret key");
            let secp = Secp256k1::new();
            let keypair = Keypair::from_secret_key(&secp, &secret);
            let (xonly, _) = keypair.x_only_public_key();
            Self {
                keypair,
                secp,
                xonly_hex: hex::encode(xonly.serialize()),
            }
        }

        fn sign(&self, normalized: NormalizedNostrEvent) -> SignedNostrEvent {
            let mut filled = normalized;
            if filled.pubkey.is_none() {
                filled.pubkey = Some(self.xonly_hex.clone());
            }
            if filled.created_at.is_none() {
                filled.created_at = Some(1_710_000_000);
            }
            let canonical = canonical_payload(&filled).expect("canonical payload");
            let id = event_hash_hex(&canonical);
            let digest: [u8; 32] = hex::decode(&id)
                .expect("event id hex decodes")
                .try_into()
                .expect("event id is 32 bytes");
            let sig = self
                .secp
                .sign_schnorr_no_aux_rand(digest.as_slice(), &self.keypair);
            SignedNostrEvent {
                id,
                pubkey: filled.pubkey.clone().expect("pubkey filled"),
                created_at: filled.created_at.expect("created_at filled"),
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

    fn empty_registry() -> Arc<NIP46Registry> {
        let outbox: Arc<dyn PublishOutboxHandle + Send + Sync> = Arc::new(TestOutbox);
        Arc::new(NIP46Registry::new(
            backend_signer(),
            PendingNip46Requests::default(),
            outbox,
        ))
    }

    fn ingress_with(
        snapshot_state: Arc<SnapshotState>,
        heartbeat_latch: Arc<Mutex<BackendHeartbeatLatchPlanner>>,
        registry: Arc<NIP46Registry>,
        owners: Vec<String>,
    ) -> (WhitelistIngress, tokio_mpsc::Receiver<String>) {
        let (tx, rx) = tokio_mpsc::channel(64);
        (
            WhitelistIngress {
                snapshot_state,
                heartbeat_latch,
                owners: Arc::new(RwLock::new(owners)),
                reconciler_trigger: tx,
                nip46_registry: registry,
            },
            rx,
        )
    }

    fn recv_with_timeout(
        rx: &mut tokio_mpsc::Receiver<String>,
        timeout: Duration,
    ) -> Option<String> {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .expect("runtime builds");
        rt.block_on(async { tokio::time::timeout(timeout, rx.recv()).await.ok().flatten() })
    }

    #[test]
    fn feeds_14199_event_updates_snapshot_and_triggers_reconciler_and_latch() {
        let owner = OwnerKeys::from_secret_hex(OWNER_SECRET_HEX);
        let backend = backend_signer();
        let backend_pubkey = backend.pubkey_hex().to_string();
        let agent_a = hex::encode([0x33_u8; 32]);
        let agent_b = hex::encode([0x44_u8; 32]);

        let snapshot_state = Arc::new(SnapshotState::new());
        let heartbeat_latch = Arc::new(Mutex::new(BackendHeartbeatLatchPlanner::new(
            backend_pubkey.clone(),
            vec![owner.xonly_hex.clone()],
        )));

        let (ingress, mut rx) = ingress_with(
            Arc::clone(&snapshot_state),
            Arc::clone(&heartbeat_latch),
            empty_registry(),
            vec![owner.xonly_hex.clone()],
        );

        let tags = vec![
            vec!["p".to_string(), agent_a.clone()],
            vec!["p".to_string(), agent_b.clone()],
            vec!["p".to_string(), backend_pubkey.clone()],
        ];
        let event = owner.sign(NormalizedNostrEvent {
            kind: PROJECT_AGENT_SNAPSHOT_KIND,
            content: String::new(),
            tags,
            pubkey: None,
            created_at: Some(1_710_000_500),
        });

        ingress.handle_event(&event);

        let expected: std::collections::BTreeSet<String> =
            [agent_a, agent_b, backend_pubkey.clone()]
                .into_iter()
                .collect();
        assert_eq!(snapshot_state.p_tags_for(&owner.xonly_hex), Some(expected));

        assert_eq!(
            recv_with_timeout(&mut rx, Duration::from_millis(100))
                .expect("reconciler must receive trigger"),
            owner.xonly_hex
        );

        assert_eq!(
            heartbeat_latch.lock().unwrap().state(),
            BackendHeartbeatLatchState::Stopped
        );
    }

    #[test]
    fn feeds_24133_event_from_unknown_owner_is_ignored() {
        let stranger = OwnerKeys::from_secret_hex(
            "0303030303030303030303030303030303030303030303030303030303030303",
        );

        let snapshot_state = Arc::new(SnapshotState::new());
        let heartbeat_latch = Arc::new(Mutex::new(BackendHeartbeatLatchPlanner::new(
            backend_signer().pubkey_hex().to_string(),
            Vec::<String>::new(),
        )));

        let (ingress, mut rx) = ingress_with(
            Arc::clone(&snapshot_state),
            Arc::clone(&heartbeat_latch),
            empty_registry(),
            Vec::new(),
        );

        let event = stranger.sign(NormalizedNostrEvent {
            kind: NIP46_KIND,
            content: "not-really-encrypted".to_string(),
            tags: vec![vec![
                "p".to_string(),
                backend_signer().pubkey_hex().to_string(),
            ]],
            pubkey: None,
            created_at: Some(1_710_000_600),
        });

        ingress.handle_event(&event);

        assert!(snapshot_state.p_tags_for(&stranger.xonly_hex).is_none());
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn feeds_24133_event_from_known_owner_dispatches_to_client() {
        let owner = OwnerKeys::from_secret_hex(OWNER_SECRET_HEX);

        let outbox: Arc<dyn PublishOutboxHandle + Send + Sync> = Arc::new(TestOutbox);
        let registry = Arc::new(NIP46Registry::new(
            backend_signer(),
            PendingNip46Requests::default(),
            outbox,
        ));

        let nip46_config = Nip46Config {
            signing_timeout_ms: 15_000,
            max_retries: 0,
            owners: Default::default(),
        };
        let client = registry
            .client_for_owner(&owner.xonly_hex, &nip46_config, "wss://default.relay/")
            .expect("client must build");
        assert_eq!(client.owner_pubkey(), owner.xonly_hex);

        let snapshot_state = Arc::new(SnapshotState::new());
        let heartbeat_latch = Arc::new(Mutex::new(BackendHeartbeatLatchPlanner::new(
            backend_signer().pubkey_hex().to_string(),
            Vec::<String>::new(),
        )));

        let (ingress, _rx) = ingress_with(
            snapshot_state,
            heartbeat_latch,
            Arc::clone(&registry),
            vec![owner.xonly_hex.clone()],
        );

        let event = owner.sign(NormalizedNostrEvent {
            kind: NIP46_KIND,
            content: "garbage-ciphertext".to_string(),
            tags: vec![vec![
                "p".to_string(),
                backend_signer().pubkey_hex().to_string(),
            ]],
            pubkey: None,
            created_at: Some(1_710_000_700),
        });

        ingress.handle_event(&event);
    }

    #[test]
    fn non_matching_kind_is_ignored() {
        let owner = OwnerKeys::from_secret_hex(OWNER_SECRET_HEX);

        let snapshot_state = Arc::new(SnapshotState::new());
        let heartbeat_latch = Arc::new(Mutex::new(BackendHeartbeatLatchPlanner::new(
            backend_signer().pubkey_hex().to_string(),
            vec![owner.xonly_hex.clone()],
        )));

        let (ingress, mut rx) = ingress_with(
            Arc::clone(&snapshot_state),
            Arc::clone(&heartbeat_latch),
            empty_registry(),
            vec![owner.xonly_hex.clone()],
        );

        let event = owner.sign(NormalizedNostrEvent {
            kind: 1,
            content: "hi".to_string(),
            tags: vec![],
            pubkey: None,
            created_at: Some(1_710_000_800),
        });

        ingress.handle_event(&event);

        assert!(snapshot_state.p_tags_for(&owner.xonly_hex).is_none());
        assert!(rx.try_recv().is_err());
        assert_eq!(
            heartbeat_latch.lock().unwrap().state(),
            BackendHeartbeatLatchState::Active
        );
    }

    #[test]
    fn duplicate_14199_does_not_re_trigger_reconciler() {
        let owner = OwnerKeys::from_secret_hex(OWNER_SECRET_HEX);
        let agent = hex::encode([0x55_u8; 32]);

        let snapshot_state = Arc::new(SnapshotState::new());
        let heartbeat_latch = Arc::new(Mutex::new(BackendHeartbeatLatchPlanner::new(
            backend_signer().pubkey_hex().to_string(),
            Vec::<String>::new(),
        )));

        let (ingress, mut rx) = ingress_with(
            Arc::clone(&snapshot_state),
            Arc::clone(&heartbeat_latch),
            empty_registry(),
            vec![owner.xonly_hex.clone()],
        );

        let event = owner.sign(NormalizedNostrEvent {
            kind: PROJECT_AGENT_SNAPSHOT_KIND,
            content: String::new(),
            tags: vec![vec!["p".to_string(), agent]],
            pubkey: None,
            created_at: Some(1_710_000_900),
        });

        ingress.handle_event(&event);
        assert_eq!(
            recv_with_timeout(&mut rx, Duration::from_millis(100))
                .expect("first event must trigger reconciler"),
            owner.xonly_hex
        );

        ingress.handle_event(&event);
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn eose_marks_snapshot_catchup_and_triggers_current_owners_once() {
        let owner_a = OwnerKeys::from_secret_hex(OWNER_SECRET_HEX);
        let owner_b = OwnerKeys::from_secret_hex(
            "0303030303030303030303030303030303030303030303030303030303030303",
        );

        let snapshot_state = Arc::new(SnapshotState::new());
        let heartbeat_latch = Arc::new(Mutex::new(BackendHeartbeatLatchPlanner::new(
            backend_signer().pubkey_hex().to_string(),
            vec![owner_a.xonly_hex.clone(), owner_b.xonly_hex.clone()],
        )));

        let (ingress, mut rx) = ingress_with(
            Arc::clone(&snapshot_state),
            Arc::clone(&heartbeat_latch),
            empty_registry(),
            vec![owner_a.xonly_hex.clone(), owner_b.xonly_hex.clone()],
        );

        ingress.handle_eose();
        assert!(snapshot_state.is_catchup_complete());

        let mut triggered = vec![
            recv_with_timeout(&mut rx, Duration::from_millis(100))
                .expect("owner a trigger"),
            recv_with_timeout(&mut rx, Duration::from_millis(100))
                .expect("owner b trigger"),
        ];
        triggered.sort();
        let mut expected = vec![owner_a.xonly_hex, owner_b.xonly_hex];
        expected.sort();
        assert_eq!(triggered, expected);

        ingress.handle_eose();
        assert!(rx.try_recv().is_err());
    }
}
