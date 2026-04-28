//! Signer abstraction.
//!
//! The `agents` table stores a signer reference (`signer_ref`) — an opaque
//! scheme-prefixed handle. The two schemes the spec calls out:
//!
//! | Scheme  | Form                       | Status     |
//! |---------|----------------------------|------------|
//! | `nsec`  | `nsec:<bech32>`            | implemented |
//! | `bunker`| `bunker:<connection-uri>`  | reserved    |
//!
//! Adding `bunker` later means adding one new [`Signer`] impl. Callsites that
//! ask the project for an agent's signer don't change.

use nostr::{Event, EventBuilder, Keys};
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
}

/// Recognized signer-reference schemes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignerScheme {
    Nsec,
    Bunker,
}

impl SignerScheme {
    pub fn parse(reference: &str) -> std::result::Result<(Self, &str), SignerError> {
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
pub trait Signer: Send + Sync {
    fn pubkey(&self) -> &str;
    fn sign(&self, builder: EventBuilder) -> std::result::Result<Event, SignerError>;
}

/// Resolve the [`Signer`] for an agent row.
///
/// Returns `Err(UnsupportedScheme)` for `bunker:` references — the abstraction
/// is in place, the implementation lands when NIP-46 does.
pub fn signer_for(agent: &Agent) -> std::result::Result<Box<dyn Signer>, SignerError> {
    let reference = agent.signer_ref.as_deref().ok_or_else(|| SignerError::Missing {
        pubkey: agent.pubkey.clone(),
    })?;

    let (scheme, payload) = SignerScheme::parse(reference)?;
    match scheme {
        SignerScheme::Nsec => Ok(Box::new(NsecSigner::from_bech32(payload)?)),
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

impl Signer for NsecSigner {
    fn pubkey(&self) -> &str {
        &self.pubkey_hex
    }

    fn sign(&self, builder: EventBuilder) -> std::result::Result<Event, SignerError> {
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

