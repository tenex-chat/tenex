//! Signer abstraction.
//!
//! Agent JSON stores a signer reference (`signer_ref`) — an opaque
//! scheme-prefixed handle projected from the persisted `nsec` field.
//!
//! | Scheme  | Form                       | Status     |
//! |---------|----------------------------|------------|
//! | `nsec`  | `nsec:<bech32>`            | implemented |
//! | `bunker`| `bunker://<remote-signer>` | implemented with `nip46` feature |
//!
//! `bunker:` references use NIP-46 remote signing. The signer asks the bunker
//! for the actual user pubkey before building events, because the remote-signer
//! key and user key can differ.

#[cfg(feature = "nip46")]
use std::time::Duration;

use async_trait::async_trait;
#[cfg(feature = "nip46")]
use nostr::NostrSigner;
use nostr::{Event, EventBuilder, Keys};
#[cfg(feature = "nip46")]
use nostr_connect::prelude::{NostrConnect, NostrConnectURI};
use thiserror::Error;

use crate::models::Agent;

#[derive(Debug, Error)]
pub enum SignerError {
    #[error("agent {pubkey} has no signer reference")]
    Missing { pubkey: String },

    #[error("unsupported signer scheme: {scheme}")]
    UnsupportedScheme { scheme: String },

    #[error("malformed signer reference: {0}")]
    Malformed(String),

    #[error("nostr error: {0}")]
    Nostr(String),

    #[error("NIP-46 error: {0}")]
    Nip46(String),
}

/// Recognized signer-reference schemes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignerScheme {
    Nsec,
    Bunker,
}

impl SignerScheme {
    pub fn parse(reference: &str) -> std::result::Result<(Self, &str), SignerError> {
        if reference.starts_with("bunker://") {
            return Ok((Self::Bunker, reference));
        }

        let (scheme, payload) = reference
            .split_once(':')
            .ok_or_else(|| SignerError::Malformed(reference.to_string()))?;
        match scheme {
            "nsec" => Ok((Self::Nsec, payload)),
            "bunker" => Ok((Self::Bunker, payload)),
            other => Err(SignerError::UnsupportedScheme {
                scheme: other.to_string(),
            }),
        }
    }
}

/// A signer for one agent. Single method by design — every other concern
/// (relay publishing, NIP-44 encryption helpers) is the caller's.
#[async_trait]
pub trait Signer: Send + Sync {
    async fn pubkey(&self) -> std::result::Result<String, SignerError>;
    async fn sign(&self, builder: EventBuilder) -> std::result::Result<Event, SignerError>;
}

/// Resolve the [`Signer`] for an agent projection.
pub fn signer_for(agent: &Agent) -> std::result::Result<Box<dyn Signer>, SignerError> {
    let reference = agent
        .signer_ref
        .as_deref()
        .ok_or_else(|| SignerError::Missing {
            pubkey: agent.pubkey.clone(),
        })?;

    let (scheme, payload) = SignerScheme::parse(reference)?;
    match scheme {
        SignerScheme::Nsec => Ok(Box::new(NsecSigner::from_bech32(payload)?)),
        #[cfg(feature = "nip46")]
        SignerScheme::Bunker => Ok(Box::new(BunkerSigner::from_uri(payload)?)),
        #[cfg(not(feature = "nip46"))]
        SignerScheme::Bunker => Err(SignerError::UnsupportedScheme {
            scheme: "bunker".to_string(),
        }),
    }
}

/// Local-key signer backed by an in-memory `nostr::Keys`.
pub struct NsecSigner {
    keys: Keys,
    pubkey_hex: String,
}

impl NsecSigner {
    pub fn from_bech32(bech32: &str) -> std::result::Result<Self, SignerError> {
        let keys = Keys::parse(bech32).map_err(|e| SignerError::Nostr(e.to_string()))?;
        let pubkey_hex = keys.public_key().to_hex();
        Ok(Self { keys, pubkey_hex })
    }
}

#[async_trait]
impl Signer for NsecSigner {
    async fn pubkey(&self) -> std::result::Result<String, SignerError> {
        Ok(self.pubkey_hex.clone())
    }

    async fn sign(&self, builder: EventBuilder) -> std::result::Result<Event, SignerError> {
        builder
            .sign_with_keys(&self.keys)
            .map_err(|e| SignerError::Nostr(e.to_string()))
    }
}

impl std::fmt::Debug for NsecSigner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NsecSigner")
            .field("pubkey", &self.pubkey_hex)
            .finish()
    }
}

/// NIP-46 signer backed by a bunker URI.
#[cfg(feature = "nip46")]
pub struct BunkerSigner {
    signer: NostrConnect,
}

#[cfg(feature = "nip46")]
impl BunkerSigner {
    pub fn from_uri(uri: &str) -> std::result::Result<Self, SignerError> {
        Self::from_uri_with_client_keys(uri, Keys::generate())
    }

    pub fn from_uri_with_client_keys(
        uri: &str,
        client_keys: Keys,
    ) -> std::result::Result<Self, SignerError> {
        Self::from_uri_with_client_keys_and_timeout(uri, client_keys, Duration::from_secs(120))
    }

    pub fn from_uri_with_client_keys_and_timeout(
        uri: &str,
        client_keys: Keys,
        timeout: Duration,
    ) -> std::result::Result<Self, SignerError> {
        let uri = NostrConnectURI::parse(uri).map_err(|e| SignerError::Nip46(e.to_string()))?;
        let signer = NostrConnect::new(uri, client_keys, timeout, None)
            .map_err(|e| SignerError::Nip46(e.to_string()))?;
        Ok(Self { signer })
    }

    pub async fn shutdown(self) {
        self.signer.shutdown().await;
    }
}

#[cfg(feature = "nip46")]
#[async_trait]
impl Signer for BunkerSigner {
    async fn pubkey(&self) -> std::result::Result<String, SignerError> {
        self.signer
            .get_public_key()
            .await
            .map(|p| p.to_hex())
            .map_err(|e| SignerError::Nip46(e.to_string()))
    }

    async fn sign(&self, builder: EventBuilder) -> std::result::Result<Event, SignerError> {
        builder
            .sign(&self.signer)
            .await
            .map_err(|e| SignerError::Nostr(e.to_string()))
    }
}

#[cfg(feature = "nip46")]
impl std::fmt::Debug for BunkerSigner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BunkerSigner").finish_non_exhaustive()
    }
}
