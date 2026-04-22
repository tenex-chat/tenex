use std::fmt;
use std::str::FromStr;

use secp256k1::{Keypair, Secp256k1, SecretKey};
use thiserror::Error;

use crate::backend_events::heartbeat::BackendSigner;

#[derive(Error, Debug, Clone, PartialEq, Eq)]
pub enum BackendSignerError {
    #[error("backend private key hex is empty")]
    EmptyPrivateKey,
    #[error("backend private key hex is invalid: {reason}")]
    InvalidPrivateKey { reason: String },
}

pub struct HexBackendSigner {
    secp: Secp256k1<secp256k1::All>,
    keypair: Keypair,
    xonly_hex: String,
}

impl fmt::Debug for HexBackendSigner {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HexBackendSigner")
            .field("xonly_hex", &self.xonly_hex)
            .finish_non_exhaustive()
    }
}

impl HexBackendSigner {
    pub fn from_private_key_hex(
        private_key_hex: impl AsRef<str>,
    ) -> Result<Self, BackendSignerError> {
        let private_key_hex = private_key_hex.as_ref().trim();
        if private_key_hex.is_empty() {
            return Err(BackendSignerError::EmptyPrivateKey);
        }

        let secret = SecretKey::from_str(private_key_hex).map_err(|err| {
            BackendSignerError::InvalidPrivateKey {
                reason: err.to_string(),
            }
        })?;
        let secp = Secp256k1::new();
        let keypair = Keypair::from_secret_key(&secp, &secret);
        let (xonly, _) = keypair.x_only_public_key();

        Ok(Self {
            secp,
            keypair,
            xonly_hex: hex::encode(xonly.serialize()),
        })
    }

    pub fn pubkey_hex(&self) -> &str {
        &self.xonly_hex
    }

    pub(crate) fn secret_key(&self) -> SecretKey {
        self.keypair.secret_key()
    }
}

impl BackendSigner for HexBackendSigner {
    fn xonly_pubkey_hex(&self) -> String {
        self.xonly_hex.clone()
    }

    fn sign_schnorr(&self, digest: &[u8; 32]) -> Result<String, secp256k1::Error> {
        let sig = self
            .secp
            .sign_schnorr_no_aux_rand(digest.as_slice(), &self.keypair);
        Ok(hex::encode(sig.to_byte_array()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend_events::heartbeat::{HeartbeatInputs, encode_heartbeat};
    use crate::nostr_event::verify_signed_event;

    const TEST_SECRET_KEY_HEX: &str =
        "0101010101010101010101010101010101010101010101010101010101010101";
    const TEST_PUBKEY_HEX: &str =
        "1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f";

    #[test]
    fn loads_typescript_backend_private_key_hex_and_signs_events() {
        let signer = HexBackendSigner::from_private_key_hex(TEST_SECRET_KEY_HEX)
            .expect("backend signer must load from raw hex");
        let owners =
            vec!["4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766".to_string()];
        let inputs = HeartbeatInputs {
            created_at: 1_700_000_000,
            owner_pubkeys: &owners,
        };

        let event = encode_heartbeat(&inputs, &signer).expect("heartbeat must encode");

        assert_eq!(signer.pubkey_hex(), TEST_PUBKEY_HEX);
        assert_eq!(event.pubkey, TEST_PUBKEY_HEX);
        verify_signed_event(&event).expect("signature must verify");
    }

    #[test]
    fn trims_config_private_key_hex() {
        let signer = HexBackendSigner::from_private_key_hex(format!("  {TEST_SECRET_KEY_HEX}\n"))
            .expect("backend signer must trim config value");

        assert_eq!(signer.pubkey_hex(), TEST_PUBKEY_HEX);
    }

    #[test]
    fn rejects_empty_private_key_hex() {
        assert_eq!(
            HexBackendSigner::from_private_key_hex(" \n ").expect_err("empty key must fail"),
            BackendSignerError::EmptyPrivateKey
        );
    }

    #[test]
    fn rejects_invalid_private_key_hex() {
        let error = HexBackendSigner::from_private_key_hex("not-a-hex-key")
            .expect_err("invalid key must fail");

        assert!(matches!(
            error,
            BackendSignerError::InvalidPrivateKey { .. }
        ));
    }

    #[test]
    fn debug_output_does_not_include_private_key_material() {
        let signer = HexBackendSigner::from_private_key_hex(TEST_SECRET_KEY_HEX)
            .expect("backend signer must load");
        let debug = format!("{signer:?}");

        assert!(debug.contains(TEST_PUBKEY_HEX));
        assert!(!debug.contains(TEST_SECRET_KEY_HEX));
    }
}
