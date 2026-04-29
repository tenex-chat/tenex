use anyhow::{anyhow, Result};
use nostr_sdk::nips::nip19::FromBech32;
use nostr_sdk::{Keys, SecretKey};

/// `new NDKPrivateKeySigner(nsec).pubkey` (`AgentStorage.ts:156-159`), which
/// accepts **both** bech32 (`nsec1…`) and 64-char hex strings.
pub fn derive_agent_pubkey_from_nsec(nsec: &str) -> Result<String> {
    // Try bech32 first.
    if let Ok(sk) = SecretKey::from_bech32(nsec) {
        return Ok(Keys::new(sk).public_key().to_hex());
    }
    // Fall back to hex.
    let bytes = hex_to_bytes32(nsec)
        .ok_or_else(|| anyhow!("invalid nsec: must be bech32 (`nsec1…`) or 64-char hex string"))?;
    let sk = SecretKey::from_slice(&bytes).map_err(|e| anyhow!("invalid secret key bytes: {e}"))?;
    Ok(Keys::new(sk).public_key().to_hex())
}

fn hex_to_bytes32(s: &str) -> Option<[u8; 32]> {
    if s.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        let hi = hex_nibble(s.as_bytes()[2 * i])?;
        let lo = hex_nibble(s.as_bytes()[2 * i + 1])?;
        *byte = (hi << 4) | lo;
    }
    Some(out)
}

fn hex_nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Generate a fresh keypair as bech32 nsec. Used by importers and the
/// interactive add-agent flow that mints a new identity.
pub fn generate_nsec_bech32() -> Result<String> {
    use nostr_sdk::ToBech32;
    let keys = Keys::generate();
    keys.secret_key()
        .to_bech32()
        .map_err(|e| anyhow!("encode generated nsec: {e}"))
}
