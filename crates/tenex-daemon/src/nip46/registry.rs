use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use crate::backend_config::Nip46Config;
use crate::backend_signer::HexBackendSigner;
use crate::nip46::bunker_uri::{derive_default_bunker_uri, parse_bunker_uri};
use crate::nip46::client::{NIP46Client, NIP46ClientConfig, PublishOutboxHandle, SignError};
use crate::nip46::pending::PendingNip46Requests;

#[derive(thiserror::Error, Debug)]
pub enum RegistryError {
    #[error("no bunker uri available for owner {0:?} (no config entry and no default relay)")]
    MissingBunker(String),
    #[error("invalid bunker uri for owner {owner:?}: {reason}")]
    InvalidBunker { owner: String, reason: String },
    #[error("nip-46 client error: {0}")]
    Client(#[from] SignError),
}

pub struct NIP46Registry {
    backend_signer: Arc<HexBackendSigner>,
    pending: PendingNip46Requests,
    outbox: Arc<dyn PublishOutboxHandle + Send + Sync>,
    clients: RwLock<HashMap<String, Arc<NIP46Client>>>,
}

impl NIP46Registry {
    pub fn new(
        backend_signer: Arc<HexBackendSigner>,
        pending: PendingNip46Requests,
        outbox: Arc<dyn PublishOutboxHandle + Send + Sync>,
    ) -> Self {
        Self {
            backend_signer,
            pending,
            outbox,
            clients: RwLock::new(HashMap::new()),
        }
    }

    pub fn pending(&self) -> &PendingNip46Requests {
        &self.pending
    }

    pub fn client_for_cached_owner(&self, owner_pubkey: &str) -> Option<Arc<NIP46Client>> {
        self.clients
            .read()
            .expect("nip-46 registry clients lock must not be poisoned")
            .get(owner_pubkey)
            .cloned()
    }

    pub fn reload(&self) {
        self.clients
            .write()
            .expect("nip-46 registry clients lock must not be poisoned")
            .clear();
    }

    pub fn client_for_owner(
        &self,
        owner_pubkey: &str,
        config: &Nip46Config,
        default_relay: &str,
    ) -> Result<Arc<NIP46Client>, RegistryError> {
        if let Some(existing) = self.client_for_cached_owner(owner_pubkey) {
            return Ok(existing);
        }

        let raw_uri = match config
            .owners
            .get(owner_pubkey)
            .and_then(|entry| entry.bunker_uri.clone())
        {
            Some(uri) => uri,
            None => {
                if default_relay.is_empty() {
                    return Err(RegistryError::MissingBunker(owner_pubkey.to_string()));
                }
                derive_default_bunker_uri(owner_pubkey, default_relay)
            }
        };

        let bunker = parse_bunker_uri(&raw_uri).map_err(|err| RegistryError::InvalidBunker {
            owner: owner_pubkey.to_string(),
            reason: err.to_string(),
        })?;

        let client_config = NIP46ClientConfig {
            timeout: std::time::Duration::from_millis(config.signing_timeout_ms),
            max_retries: config.max_retries,
        };

        let client = NIP46Client::new(
            owner_pubkey.to_string(),
            bunker,
            Arc::clone(&self.backend_signer),
            self.pending.clone(),
            Arc::clone(&self.outbox) as Arc<dyn PublishOutboxHandle>,
            client_config,
        )?;
        let new_client = Arc::new(client);

        let mut clients = self
            .clients
            .write()
            .expect("nip-46 registry clients lock must not be poisoned");
        if let Some(existing) = clients.get(owner_pubkey) {
            return Ok(Arc::clone(existing));
        }
        clients.insert(owner_pubkey.to_string(), Arc::clone(&new_client));
        Ok(new_client)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend_config::OwnerNip46Config;
    use crate::nostr_event::SignedNostrEvent;
    use secp256k1::{Keypair, Secp256k1, SecretKey};
    use std::sync::Mutex;

    const BACKEND_SECRET_HEX: &str =
        "0101010101010101010101010101010101010101010101010101010101010101";

    struct MockOutbox {
        captured: Mutex<Vec<(SignedNostrEvent, Vec<String>)>>,
    }

    impl MockOutbox {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                captured: Mutex::new(Vec::new()),
            })
        }
    }

    impl PublishOutboxHandle for MockOutbox {
        fn enqueue(&self, event: SignedNostrEvent, relay_urls: Vec<String>) -> Result<(), String> {
            self.captured.lock().unwrap().push((event, relay_urls));
            Ok(())
        }
    }

    fn owner_pubkey_from_byte(fill_byte: u8) -> String {
        let secret =
            SecretKey::from_byte_array([fill_byte; 32]).expect("fixture secret must be valid");
        let secp = Secp256k1::new();
        let keypair = Keypair::from_secret_key(&secp, &secret);
        let (xonly, _) = keypair.x_only_public_key();
        hex::encode(xonly.serialize())
    }

    fn backend_signer() -> Arc<HexBackendSigner> {
        Arc::new(
            HexBackendSigner::from_private_key_hex(BACKEND_SECRET_HEX)
                .expect("backend signer must load"),
        )
    }

    fn registry_for_tests() -> NIP46Registry {
        let outbox: Arc<dyn PublishOutboxHandle + Send + Sync> = MockOutbox::new();
        NIP46Registry::new(backend_signer(), PendingNip46Requests::default(), outbox)
    }

    fn explicit_config_for(owner: &str, bunker_uri: &str) -> Nip46Config {
        let mut owners = HashMap::new();
        owners.insert(
            owner.to_string(),
            OwnerNip46Config {
                bunker_uri: Some(bunker_uri.to_string()),
            },
        );
        Nip46Config {
            signing_timeout_ms: 15_000,
            max_retries: 1,
            owners,
        }
    }

    #[test]
    fn client_for_owner_uses_explicit_bunker_uri_when_configured() {
        let registry = registry_for_tests();
        let owner = owner_pubkey_from_byte(0x11);
        let explicit_remote = owner_pubkey_from_byte(0x22);
        let bunker_uri =
            format!("bunker://{explicit_remote}?relay=wss://explicit.relay/&secret=sup");
        let config = explicit_config_for(&owner, &bunker_uri);

        let client = registry
            .client_for_owner(&owner, &config, "wss://default.relay/")
            .expect("client must build");

        assert_eq!(client.owner_pubkey(), owner);
    }

    #[test]
    fn client_for_owner_derives_default_when_owner_missing_from_config() {
        let registry = registry_for_tests();
        let owner = owner_pubkey_from_byte(0x33);
        let config = Nip46Config::default();

        let client = registry
            .client_for_owner(&owner, &config, "wss://default.relay/")
            .expect("client must build from derived default bunker uri");

        assert_eq!(client.owner_pubkey(), owner);
    }

    #[test]
    fn client_for_owner_returns_same_arc_on_repeated_call() {
        let registry = registry_for_tests();
        let owner = owner_pubkey_from_byte(0x44);
        let config = Nip46Config::default();

        let first = registry
            .client_for_owner(&owner, &config, "wss://default.relay/")
            .expect("first build must succeed");
        let second = registry
            .client_for_owner(&owner, &config, "wss://default.relay/")
            .expect("second call must reuse cached client");

        assert!(Arc::ptr_eq(&first, &second));
    }

    #[test]
    fn reload_clears_cache_and_next_call_rebuilds() {
        let registry = registry_for_tests();
        let owner = owner_pubkey_from_byte(0x55);
        let config = Nip46Config::default();

        let first = registry
            .client_for_owner(&owner, &config, "wss://default.relay/")
            .expect("first build must succeed");

        registry.reload();

        let rebuilt = registry
            .client_for_owner(&owner, &config, "wss://default.relay/")
            .expect("rebuild must succeed after reload");

        assert!(!Arc::ptr_eq(&first, &rebuilt));
        assert_eq!(rebuilt.owner_pubkey(), owner);
    }

    #[test]
    fn client_for_owner_returns_missing_bunker_when_no_config_and_empty_default_relay() {
        let registry = registry_for_tests();
        let owner = owner_pubkey_from_byte(0x66);
        let config = Nip46Config::default();

        match registry.client_for_owner(&owner, &config, "") {
            Err(RegistryError::MissingBunker(missing_owner)) => {
                assert_eq!(missing_owner, owner);
            }
            Err(other) => panic!("expected MissingBunker, got {other:?}"),
            Ok(_) => panic!("empty default relay with no owner entry must fail"),
        }
    }

    #[test]
    fn client_for_owner_returns_invalid_bunker_for_malformed_uri() {
        let registry = registry_for_tests();
        let owner = owner_pubkey_from_byte(0x77);
        let config = explicit_config_for(&owner, "not-a-bunker-uri");

        match registry.client_for_owner(&owner, &config, "wss://default.relay/") {
            Err(RegistryError::InvalidBunker {
                owner: reported_owner,
                reason,
            }) => {
                assert_eq!(reported_owner, owner);
                assert!(
                    !reason.is_empty(),
                    "reason must describe the parse failure"
                );
            }
            Err(other) => panic!("expected InvalidBunker, got {other:?}"),
            Ok(_) => panic!("malformed bunker uri must fail"),
        }
    }

    #[test]
    fn client_for_cached_owner_returns_none_when_absent() {
        let registry = registry_for_tests();
        let owner = owner_pubkey_from_byte(0x88);

        assert!(registry.client_for_cached_owner(&owner).is_none());
    }

    #[test]
    fn client_for_cached_owner_returns_same_arc_as_client_for_owner() {
        let registry = registry_for_tests();
        let owner = owner_pubkey_from_byte(0x99);
        let config = Nip46Config::default();

        let built = registry
            .client_for_owner(&owner, &config, "wss://default.relay/")
            .expect("initial build must succeed");
        let cached = registry
            .client_for_cached_owner(&owner)
            .expect("cached lookup must return client");

        assert!(Arc::ptr_eq(&built, &cached));
    }
}
