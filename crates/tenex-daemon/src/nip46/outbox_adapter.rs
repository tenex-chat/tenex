use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::nip46::client::PublishOutboxHandle;
use crate::nostr_event::SignedNostrEvent;
use crate::publish_outbox::{BackendPublishOutboxInput, accept_backend_signed_publish_event};

const NIP46_OUTBOX_REQUEST_PREFIX: &str = "nip46";
const NIP46_OUTBOX_CORRELATION_PREFIX: &str = "nip46-correlation";
const NIP46_OUTBOX_PROJECT_ID: &str = "nip46";
const NIP46_OUTBOX_CONVERSATION_ID: &str = "nip46";

pub struct PublishOutboxAdapter {
    pub outbox_root: PathBuf,
    pub publisher_pubkey: String,
}

impl PublishOutboxAdapter {
    pub fn new(outbox_root: PathBuf, publisher_pubkey: String) -> Self {
        Self {
            outbox_root,
            publisher_pubkey,
        }
    }
}

impl PublishOutboxHandle for PublishOutboxAdapter {
    fn enqueue(&self, event: SignedNostrEvent, _: Vec<String>) -> Result<(), String> {
        let accepted_at = current_millis();
        let request_id = format!("{NIP46_OUTBOX_REQUEST_PREFIX}:{}", event.id);
        let correlation_id = format!("{NIP46_OUTBOX_CORRELATION_PREFIX}:{}", event.id);

        let input = BackendPublishOutboxInput {
            request_id,
            request_sequence: 0,
            request_timestamp: accepted_at,
            correlation_id,
            project_id: NIP46_OUTBOX_PROJECT_ID.to_string(),
            conversation_id: NIP46_OUTBOX_CONVERSATION_ID.to_string(),
            publisher_pubkey: self.publisher_pubkey.clone(),
            ral_number: 0,
            wait_for_relay_ok: false,
            timeout_ms: 0,
            event,
        };

        accept_backend_signed_publish_event(&self.outbox_root, input, accepted_at)
            .map(|_| ())
            .map_err(|err| err.to_string())
    }
}

fn current_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time must be after UNIX_EPOCH")
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend_signer::HexBackendSigner;
    use crate::nip46::protocol::build_nip46_event;
    use crate::publish_outbox::read_pending_publish_outbox_record;

    const BACKEND_SECRET_HEX: &str =
        "0101010101010101010101010101010101010101010101010101010101010101";
    const REMOTE_PUBKEY_HEX: &str =
        "1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f";

    fn backend_signer() -> HexBackendSigner {
        HexBackendSigner::from_private_key_hex(BACKEND_SECRET_HEX).expect("signer must load")
    }

    fn signed_nip46_event(signer: &HexBackendSigner) -> SignedNostrEvent {
        build_nip46_event(signer, REMOTE_PUBKEY_HEX, "ciphertext", 1_700_000_000)
            .expect("nip-46 event must build")
    }

    #[test]
    fn adapter_enqueues_signed_event_into_pending_outbox() {
        let tmp = tempfile::tempdir().expect("tempdir must create");
        let signer = backend_signer();
        let event = signed_nip46_event(&signer);

        let adapter = PublishOutboxAdapter::new(
            tmp.path().to_path_buf(),
            signer.pubkey_hex().to_string(),
        );

        adapter
            .enqueue(event.clone(), vec!["wss://relay".to_string()])
            .expect("enqueue must succeed");

        let persisted = read_pending_publish_outbox_record(tmp.path(), &event.id)
            .expect("pending record read must succeed")
            .expect("pending record must exist");

        assert_eq!(persisted.event, event);
        assert_eq!(persisted.request.agent_pubkey, signer.pubkey_hex());
        assert!(
            persisted.request.request_id.starts_with(NIP46_OUTBOX_REQUEST_PREFIX),
            "request_id {} should carry nip46 prefix",
            persisted.request.request_id
        );
    }

    #[test]
    fn adapter_returns_error_string_when_outbox_root_missing() {
        let tmp = tempfile::tempdir().expect("tempdir must create");
        let blocking_file = tmp.path().join("not-a-dir");
        std::fs::write(&blocking_file, b"x").expect("blocking file must write");

        let signer = backend_signer();
        let event = signed_nip46_event(&signer);

        let adapter = PublishOutboxAdapter::new(
            blocking_file,
            signer.pubkey_hex().to_string(),
        );

        let err = adapter
            .enqueue(event, vec!["wss://relay".to_string()])
            .expect_err("enqueue must fail when outbox root is unwritable");

        assert!(!err.is_empty(), "error string must be non-empty");
    }
}
