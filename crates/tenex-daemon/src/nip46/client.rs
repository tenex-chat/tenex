use std::str::FromStr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use secp256k1::PublicKey;
use tracing::debug;

use crate::backend_events::heartbeat::BackendSigner;
use crate::backend_signer::HexBackendSigner;
use crate::nip44::{self, Nip44Error};
use crate::nip46::bunker_uri::BunkerUri;
use crate::nip46::pending::PendingNip46Requests;
use crate::nip46::protocol::{
    Nip46ProtocolError, Nip46Request, Nip46Response, build_connect_request, build_nip46_event,
    build_sign_event_request, extract_result,
};
use crate::nostr_event::{NormalizedNostrEvent, SignedNostrEvent, verify_signed_event};

pub trait PublishOutboxHandle: Send + Sync {
    fn enqueue(&self, event: SignedNostrEvent, relay_urls: Vec<String>) -> Result<(), String>;
}

#[derive(Debug, thiserror::Error)]
pub enum SignError {
    #[error("nip-46 sign timed out")]
    Timeout,
    #[error("nip-46 signer rejected request: {0}")]
    Rejected(String),
    #[error("nip-46 bunker returned invalid signed event: {0}")]
    InvalidSignedEvent(String),
    #[error("nip-46 encryption error: {0}")]
    Crypto(#[from] Nip44Error),
    #[error("nip-46 protocol error: {0}")]
    Protocol(#[from] Nip46ProtocolError),
    #[error("nip-46 outbox error: {0}")]
    Outbox(String),
    #[error("nip-46 invalid owner pubkey hex: {0}")]
    InvalidOwnerPubkey(String),
}

#[derive(Debug, Clone)]
pub struct NIP46ClientConfig {
    pub timeout: Duration,
    pub max_retries: u8,
}

impl Default for NIP46ClientConfig {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(30),
            max_retries: 2,
        }
    }
}

pub struct NIP46Client {
    owner_pubkey: String,
    bunker: BunkerUri,
    backend_signer: Arc<HexBackendSigner>,
    conversation_key: [u8; 32],
    pending: PendingNip46Requests,
    outbox: Arc<dyn PublishOutboxHandle>,
    config: NIP46ClientConfig,
    sign_mutex: Mutex<()>,
    connected: Mutex<bool>,
}

impl NIP46Client {
    pub fn new(
        owner_pubkey: String,
        bunker: BunkerUri,
        backend_signer: Arc<HexBackendSigner>,
        pending: PendingNip46Requests,
        outbox: Arc<dyn PublishOutboxHandle>,
        config: NIP46ClientConfig,
    ) -> Result<Self, SignError> {
        let owner_public = PublicKey::from_str(&format!("02{owner_pubkey}"))
            .map_err(|err| SignError::InvalidOwnerPubkey(err.to_string()))?;
        let conversation_key = nip44::conversation_key(&backend_signer.secret_key(), &owner_public)?;

        Ok(Self {
            owner_pubkey,
            bunker,
            backend_signer,
            conversation_key,
            pending,
            outbox,
            config,
            sign_mutex: Mutex::new(()),
            connected: Mutex::new(false),
        })
    }

    pub fn pending(&self) -> &PendingNip46Requests {
        &self.pending
    }

    pub fn owner_pubkey(&self) -> &str {
        &self.owner_pubkey
    }

    pub fn sign_event(
        &self,
        unsigned: &NormalizedNostrEvent,
    ) -> Result<SignedNostrEvent, SignError> {
        let _guard = self
            .sign_mutex
            .lock()
            .expect("nip-46 sign mutex must not be poisoned");

        if !*self
            .connected
            .lock()
            .expect("nip-46 connected mutex must not be poisoned")
        {
            let (id, request) =
                build_connect_request(&self.bunker.remote_pubkey, self.bunker.secret.as_deref());
            let _ = self.exchange(id, request)?;
            *self
                .connected
                .lock()
                .expect("nip-46 connected mutex must not be poisoned") = true;
        }

        let unsigned_json = serde_json::to_string(unsigned)
            .map_err(|err| SignError::Protocol(Nip46ProtocolError::Json(err)))?;
        let (id, request) = build_sign_event_request(&unsigned_json);
        let result_text = self.exchange(id, request)?;

        let signed: SignedNostrEvent = serde_json::from_str(&result_text)
            .map_err(|err| SignError::InvalidSignedEvent(err.to_string()))?;
        verify_signed_event(&signed)
            .map_err(|err| SignError::InvalidSignedEvent(err.to_string()))?;
        if signed.pubkey != self.owner_pubkey {
            return Err(SignError::InvalidSignedEvent(format!(
                "signed event pubkey {} does not match owner {}",
                signed.pubkey, self.owner_pubkey
            )));
        }
        Ok(signed)
    }

    pub fn dispatch_incoming(&self, encrypted_content: &str) -> Result<(), SignError> {
        let plaintext = nip44::decrypt(&self.conversation_key, encrypted_content)?;
        let response: Nip46Response = serde_json::from_slice(&plaintext)
            .map_err(|err| SignError::Protocol(Nip46ProtocolError::Json(err)))?;
        match self.pending.complete(response) {
            Ok(()) => Ok(()),
            Err(err) => {
                debug!(error = %err, "nip-46 dispatch ignoring stale response");
                Ok(())
            }
        }
    }

    fn exchange(&self, mut id: String, mut request: Nip46Request) -> Result<String, SignError> {
        let total_attempts = (self.config.max_retries as usize) + 1;
        for attempt in 0..total_attempts {
            let rx = self.pending.register(id.clone());
            match self.send_request(&request) {
                Ok(()) => {}
                Err(err) => {
                    self.pending.cancel(&id);
                    return Err(err);
                }
            }

            match self.pending.wait(&id, &rx, self.config.timeout) {
                Ok(response) => {
                    if let Some(error_text) = response.error.clone() {
                        return Err(SignError::Rejected(error_text));
                    }
                    let result = extract_result(&response, &id)?;
                    return Ok(result);
                }
                Err(_) => {
                    if attempt + 1 == total_attempts {
                        return Err(SignError::Timeout);
                    }
                    let (next_id, next_request) = match request.method.as_str() {
                        "connect" => build_connect_request(
                            &self.bunker.remote_pubkey,
                            self.bunker.secret.as_deref(),
                        ),
                        "sign_event" => {
                            let payload = request
                                .params
                                .first()
                                .cloned()
                                .unwrap_or_default();
                            build_sign_event_request(&payload)
                        }
                        other => {
                            return Err(SignError::Protocol(Nip46ProtocolError::Remote(
                                format!("unsupported nip-46 method for retry: {other}"),
                            )));
                        }
                    };
                    id = next_id;
                    request = next_request;
                }
            }
        }
        Err(SignError::Timeout)
    }

    fn send_request(&self, request: &Nip46Request) -> Result<(), SignError> {
        let request_json = serde_json::to_string(request)
            .map_err(|err| SignError::Protocol(Nip46ProtocolError::Json(err)))?;
        let encrypted = nip44::encrypt(&self.conversation_key, request_json.as_bytes())?;
        let envelope = build_nip46_event(
            &*self.backend_signer as &dyn BackendSigner,
            &self.owner_pubkey,
            &encrypted,
            now_unix(),
        )?;
        self.outbox
            .enqueue(envelope, self.bunker.relays.clone())
            .map_err(SignError::Outbox)
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
    use secp256k1::{Keypair, Secp256k1, SecretKey};
    use std::thread::{self, JoinHandle};

    const BACKEND_SECRET_HEX: &str =
        "0101010101010101010101010101010101010101010101010101010101010101";
    const OWNER_SECRET_HEX: &str =
        "0202020202020202020202020202020202020202020202020202020202020202";

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
    }

    impl PublishOutboxHandle for MockOutbox {
        fn enqueue(
            &self,
            event: SignedNostrEvent,
            relay_urls: Vec<String>,
        ) -> Result<(), String> {
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
            use crate::nostr_event::{canonical_payload, event_hash_hex};

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

    fn build_client(
        backend: Arc<HexBackendSigner>,
        owner: &OwnerKeys,
        outbox: Arc<dyn PublishOutboxHandle>,
        config: NIP46ClientConfig,
    ) -> (NIP46Client, PendingNip46Requests) {
        let bunker = BunkerUri {
            remote_pubkey: owner.xonly_hex.clone(),
            relays: vec!["wss://relay.test/".to_string()],
            secret: None,
        };
        let pending = PendingNip46Requests::default();
        let client = NIP46Client::new(
            owner.xonly_hex.clone(),
            bunker,
            backend,
            pending.clone(),
            outbox,
            config,
        )
        .expect("client must construct");
        (client, pending)
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

    fn wait_for_captured(outbox: &MockOutbox, index: usize) -> SignedNostrEvent {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let captured = outbox.captured();
            if captured.len() > index {
                return captured[index].0.clone();
            }
            if std::time::Instant::now() >= deadline {
                panic!("timed out waiting for captured event at index {index}");
            }
            thread::sleep(Duration::from_millis(5));
        }
    }

    fn backend_signer() -> Arc<HexBackendSigner> {
        Arc::new(
            HexBackendSigner::from_private_key_hex(BACKEND_SECRET_HEX)
                .expect("backend signer must load"),
        )
    }

    fn unsigned_note() -> NormalizedNostrEvent {
        NormalizedNostrEvent {
            kind: 1,
            content: "hello".to_string(),
            tags: vec![vec!["client".to_string(), "tenex".to_string()]],
            pubkey: None,
            created_at: None,
        }
    }

    #[test]
    fn sign_event_round_trips_through_mock_bunker() {
        let backend = backend_signer();
        let backend_pubkey = backend.pubkey_hex().to_string();
        let owner = OwnerKeys::from_secret_hex(OWNER_SECRET_HEX);
        let outbox = MockOutbox::new();
        let (client, _pending) = build_client(
            Arc::clone(&backend),
            &owner,
            outbox.clone() as Arc<dyn PublishOutboxHandle>,
            NIP46ClientConfig {
                timeout: Duration::from_secs(2),
                max_retries: 0,
            },
        );
        let client = Arc::new(client);

        let completer_client = Arc::clone(&client);
        let completer_outbox = Arc::clone(&outbox);
        let owner_for_completer = OwnerKeys::from_secret_hex(OWNER_SECRET_HEX);
        let backend_pubkey_for_completer = backend_pubkey.clone();
        let completer: JoinHandle<()> = thread::spawn(move || {
            // First request: connect
            let connect_event = wait_for_captured(&completer_outbox, 0);
            let connect_request =
                decrypt_request(&owner_for_completer, &backend_pubkey_for_completer, &connect_event);
            assert_eq!(connect_request.method, "connect");
            let connect_response = Nip46Response {
                id: connect_request.id,
                result: Some("ack".to_string()),
                error: None,
            };
            let encrypted_connect =
                encrypt_response(&owner_for_completer, &backend_pubkey_for_completer, &connect_response);
            completer_client.dispatch_incoming(&encrypted_connect).unwrap();

            // Second request: sign_event
            let sign_event = wait_for_captured(&completer_outbox, 1);
            let sign_request =
                decrypt_request(&owner_for_completer, &backend_pubkey_for_completer, &sign_event);
            assert_eq!(sign_request.method, "sign_event");
            let unsigned: NormalizedNostrEvent =
                serde_json::from_str(&sign_request.params[0]).unwrap();
            let signed = owner_for_completer.sign_event(&unsigned);
            let sign_response = Nip46Response {
                id: sign_request.id,
                result: Some(serde_json::to_string(&signed).unwrap()),
                error: None,
            };
            let encrypted_sign =
                encrypt_response(&owner_for_completer, &backend_pubkey_for_completer, &sign_response);
            completer_client.dispatch_incoming(&encrypted_sign).unwrap();
        });

        let unsigned = unsigned_note();
        let signed = client.sign_event(&unsigned).expect("sign must succeed");
        completer.join().expect("completer must finish");

        assert_eq!(signed.pubkey, owner.xonly_hex);
        verify_signed_event(&signed).expect("signed event must verify");
        assert_eq!(outbox.captured().len(), 2);
    }

    #[test]
    fn sign_event_times_out_when_bunker_silent() {
        let backend = backend_signer();
        let owner = OwnerKeys::from_secret_hex(OWNER_SECRET_HEX);
        let outbox = MockOutbox::new();
        let (client, _pending) = build_client(
            backend,
            &owner,
            outbox.clone() as Arc<dyn PublishOutboxHandle>,
            NIP46ClientConfig {
                timeout: Duration::from_millis(50),
                max_retries: 1,
            },
        );

        let result = client.sign_event(&unsigned_note());
        assert!(matches!(result, Err(SignError::Timeout)), "got {result:?}");
        // Connect attempts only: no sign_event ever queued. max_retries = 1 →
        // two connect attempts total.
        assert_eq!(outbox.captured().len(), 2);
    }

    #[test]
    fn sign_event_returns_rejected_on_remote_error() {
        let backend = backend_signer();
        let backend_pubkey = backend.pubkey_hex().to_string();
        let owner = OwnerKeys::from_secret_hex(OWNER_SECRET_HEX);
        let outbox = MockOutbox::new();
        let (client, _pending) = build_client(
            Arc::clone(&backend),
            &owner,
            outbox.clone() as Arc<dyn PublishOutboxHandle>,
            NIP46ClientConfig {
                timeout: Duration::from_secs(2),
                max_retries: 0,
            },
        );
        let client = Arc::new(client);

        let completer_client = Arc::clone(&client);
        let completer_outbox = Arc::clone(&outbox);
        let owner_for_completer = OwnerKeys::from_secret_hex(OWNER_SECRET_HEX);
        let backend_pubkey_for_completer = backend_pubkey.clone();
        let completer = thread::spawn(move || {
            // Connect ack
            let connect_event = wait_for_captured(&completer_outbox, 0);
            let connect_request =
                decrypt_request(&owner_for_completer, &backend_pubkey_for_completer, &connect_event);
            let connect_response = Nip46Response {
                id: connect_request.id,
                result: Some("ack".to_string()),
                error: None,
            };
            let encrypted_connect =
                encrypt_response(&owner_for_completer, &backend_pubkey_for_completer, &connect_response);
            completer_client.dispatch_incoming(&encrypted_connect).unwrap();

            // Sign request denied
            let sign_event = wait_for_captured(&completer_outbox, 1);
            let sign_request =
                decrypt_request(&owner_for_completer, &backend_pubkey_for_completer, &sign_event);
            let deny_response = Nip46Response {
                id: sign_request.id,
                result: None,
                error: Some("denied".to_string()),
            };
            let encrypted_deny =
                encrypt_response(&owner_for_completer, &backend_pubkey_for_completer, &deny_response);
            completer_client.dispatch_incoming(&encrypted_deny).unwrap();
        });

        let result = client.sign_event(&unsigned_note());
        completer.join().expect("completer must finish");

        match result {
            Err(SignError::Rejected(text)) => assert_eq!(text, "denied"),
            other => panic!("expected Rejected(denied), got {other:?}"),
        }
    }

    #[test]
    fn concurrent_sign_event_calls_are_serialized_per_owner() {
        let backend = backend_signer();
        let backend_pubkey = backend.pubkey_hex().to_string();
        let owner = OwnerKeys::from_secret_hex(OWNER_SECRET_HEX);
        let outbox = MockOutbox::new();
        let (client, _pending) = build_client(
            Arc::clone(&backend),
            &owner,
            outbox.clone() as Arc<dyn PublishOutboxHandle>,
            NIP46ClientConfig {
                timeout: Duration::from_secs(2),
                max_retries: 0,
            },
        );
        let client = Arc::new(client);

        let completer_client = Arc::clone(&client);
        let completer_outbox = Arc::clone(&outbox);
        let owner_for_completer = OwnerKeys::from_secret_hex(OWNER_SECRET_HEX);
        let backend_pubkey_for_completer = backend_pubkey.clone();
        let completer = thread::spawn(move || {
            // Connect (shared)
            let connect_event = wait_for_captured(&completer_outbox, 0);
            let connect_request =
                decrypt_request(&owner_for_completer, &backend_pubkey_for_completer, &connect_event);
            assert_eq!(connect_request.method, "connect");
            let connect_response = Nip46Response {
                id: connect_request.id,
                result: Some("ack".to_string()),
                error: None,
            };
            let encrypted_connect =
                encrypt_response(&owner_for_completer, &backend_pubkey_for_completer, &connect_response);
            completer_client.dispatch_incoming(&encrypted_connect).unwrap();

            for index in 1..=2 {
                let event = wait_for_captured(&completer_outbox, index);
                let request =
                    decrypt_request(&owner_for_completer, &backend_pubkey_for_completer, &event);
                assert_eq!(request.method, "sign_event");
                let unsigned: NormalizedNostrEvent =
                    serde_json::from_str(&request.params[0]).unwrap();
                let signed = owner_for_completer.sign_event(&unsigned);
                let response = Nip46Response {
                    id: request.id,
                    result: Some(serde_json::to_string(&signed).unwrap()),
                    error: None,
                };
                let encrypted =
                    encrypt_response(&owner_for_completer, &backend_pubkey_for_completer, &response);
                completer_client.dispatch_incoming(&encrypted).unwrap();
            }
        });

        let client_a = Arc::clone(&client);
        let client_b = Arc::clone(&client);
        let handle_a = thread::spawn(move || {
            let mut unsigned = unsigned_note();
            unsigned.content = "from-a".to_string();
            client_a.sign_event(&unsigned)
        });
        let handle_b = thread::spawn(move || {
            let mut unsigned = unsigned_note();
            unsigned.content = "from-b".to_string();
            client_b.sign_event(&unsigned)
        });

        let signed_a = handle_a.join().expect("thread a joins").expect("sign a ok");
        let signed_b = handle_b.join().expect("thread b joins").expect("sign b ok");
        completer.join().expect("completer must finish");

        assert_ne!(signed_a.id, signed_b.id);
        assert_eq!(signed_a.pubkey, owner.xonly_hex);
        assert_eq!(signed_b.pubkey, owner.xonly_hex);
        let contents: Vec<String> = vec![signed_a.content.clone(), signed_b.content.clone()];
        assert!(contents.contains(&"from-a".to_string()));
        assert!(contents.contains(&"from-b".to_string()));
    }

    #[test]
    fn dispatch_incoming_with_unknown_id_returns_ok() {
        let backend = backend_signer();
        let backend_pubkey = backend.pubkey_hex().to_string();
        let owner = OwnerKeys::from_secret_hex(OWNER_SECRET_HEX);
        let outbox = MockOutbox::new();
        let (client, _pending) = build_client(
            backend,
            &owner,
            outbox.clone() as Arc<dyn PublishOutboxHandle>,
            NIP46ClientConfig::default(),
        );

        let unknown_response = Nip46Response {
            id: "deadbeef".repeat(4),
            result: Some("nobody-listening".to_string()),
            error: None,
        };
        let encrypted = encrypt_response(&owner, &backend_pubkey, &unknown_response);
        client
            .dispatch_incoming(&encrypted)
            .expect("unknown id must not error");
    }

    #[test]
    fn new_rejects_invalid_owner_pubkey_hex() {
        let backend = backend_signer();
        let outbox: Arc<dyn PublishOutboxHandle> = MockOutbox::new();
        let pending = PendingNip46Requests::default();
        let bunker = BunkerUri {
            remote_pubkey: "not-hex".to_string(),
            relays: vec!["wss://relay.test/".to_string()],
            secret: None,
        };
        let err = NIP46Client::new(
            "not-hex".to_string(),
            bunker,
            backend,
            pending,
            outbox,
            NIP46ClientConfig::default(),
        )
        .err()
        .expect("construction must fail for invalid owner pubkey");
        match err {
            SignError::InvalidOwnerPubkey(_) => {}
            other => panic!("expected InvalidOwnerPubkey, got {other:?}"),
        }
    }

    #[test]
    fn owner_pubkey_accessor_returns_stored_pubkey() {
        let backend = backend_signer();
        let owner = OwnerKeys::from_secret_hex(OWNER_SECRET_HEX);
        let outbox = MockOutbox::new();
        let (client, pending) = build_client(
            backend,
            &owner,
            outbox as Arc<dyn PublishOutboxHandle>,
            NIP46ClientConfig::default(),
        );
        assert_eq!(client.owner_pubkey(), owner.xonly_hex);
        // Exercise the `pending()` accessor so it is not dead code.
        assert!(std::ptr::eq(
            client.pending() as *const PendingNip46Requests,
            &client.pending as *const PendingNip46Requests,
        ));
        drop(pending);
    }
}
