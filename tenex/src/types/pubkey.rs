//! Nostr pubkey parsing.
//!
//! TS has two distinct entry points with different strictness:
//!
//! - **`tenex onboard --pubkey` / decodeToPubkey** (`src/commands/onboard.ts:120-133`)
//!   accepts hex64, `npub1...`, or `nprofile1...` and returns hex.
//! - **`tenex setup` interactive** uses a strict regex `/^[a-f0-9]{64}$/i` —
//!   hex only, no bech32.
//! - **`tenex config identity → Add`** (per spec doc 07 §1) does NOT decode;
//!   it stores the verbatim trimmed string. The Rust port preserves that
//!   asymmetry by NOT routing the identity-add prompt through this module —
//!   only screens that explicitly want decoding call here.

use std::fmt;

use nostr_sdk::nips::nip19::{FromBech32, Nip19};
use nostr_sdk::PublicKey;

/// A parsed Nostr pubkey, always represented as 64-char lowercase hex on the
/// way out so callers can persist a single canonical form.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Pubkey(String);

impl Pubkey {
    /// Hex-only constructor. Matches the `tenex setup` validator at
    /// `src/commands/onboard.ts:1502` (regex `/^[a-f0-9]{64}$/i`).
    /// Accepts upper- or lower-case input; output is lowercased.
    pub fn parse_hex64(input: &str) -> Result<Self, PubkeyError> {
        if input.len() != 64 {
            return Err(PubkeyError::Hex64WrongLength { len: input.len() });
        }
        if !input.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f' | b'A'..=b'F')) {
            return Err(PubkeyError::Hex64NotHex);
        }
        Ok(Self(input.to_ascii_lowercase()))
    }

    /// Decode `hex | npub1... | nprofile1...` into hex. Matches
    /// `decodeToPubkey` at `src/commands/onboard.ts:120-133`.
    ///
    /// Used by `tenex onboard --pubkey <pubkeys...>` and any flow that wants
    /// to be permissive about input form.
    pub fn parse_decoding(input: &str) -> Result<Self, PubkeyError> {
        let trimmed = input.trim();

        // hex64 fast path matches the TS regex case-insensitively.
        if let Ok(p) = Self::parse_hex64(trimmed) {
            return Ok(p);
        }

        if trimmed.starts_with("npub1") {
            return PublicKey::from_bech32(trimmed)
                .map(|pk| Self(pk.to_hex()))
                .map_err(|e| PubkeyError::Bech32 {
                    kind: "npub",
                    message: e.to_string(),
                });
        }

        if trimmed.starts_with("nprofile1") {
            return Nip19::from_bech32(trimmed)
                .map_err(|e| PubkeyError::Bech32 {
                    kind: "nprofile",
                    message: e.to_string(),
                })
                .and_then(|nip| match nip {
                    Nip19::Profile(p) => Ok(Self(p.public_key.to_hex())),
                    other => Err(PubkeyError::UnsupportedNip19Variant {
                        variant: nip19_variant_name(&other).to_string(),
                    }),
                });
        }

        // Mirror the TS error wording at `src/commands/onboard.ts:131`:
        // `Unsupported identifier type: <type>`. Without a type prefix we don't
        // have a "type" to name, so report the more specific
        // "not hex64, npub1, or nprofile1".
        Err(PubkeyError::UnknownForm)
    }

    /// Hex (lowercase) form. Always 64 chars.
    pub fn as_hex(&self) -> &str {
        &self.0
    }

    /// Take ownership of the hex string.
    pub fn into_hex(self) -> String {
        self.0
    }
}

impl fmt::Display for Pubkey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PubkeyError {
    Hex64WrongLength { len: usize },
    Hex64NotHex,
    Bech32 { kind: &'static str, message: String },
    UnsupportedNip19Variant { variant: String },
    UnknownForm,
}

impl fmt::Display for PubkeyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Hex64WrongLength { len } => write!(
                f,
                "must be 64 hex characters; got {len} characters"
            ),
            Self::Hex64NotHex => write!(f, "must be hex characters only (0-9, a-f)"),
            Self::Bech32 { kind, message } => write!(f, "invalid {kind}: {message}"),
            Self::UnsupportedNip19Variant { variant } => {
                write!(f, "Unsupported identifier type: {variant}")
            }
            Self::UnknownForm => write!(
                f,
                "must be 64-char hex, npub1..., or nprofile1..."
            ),
        }
    }
}

impl std::error::Error for PubkeyError {}

fn nip19_variant_name(nip: &Nip19) -> &'static str {
    match nip {
        Nip19::Pubkey(_) => "npub",
        Nip19::Profile(_) => "nprofile",
        Nip19::EventId(_) => "note",
        Nip19::Event(_) => "nevent",
        Nip19::Coordinate(_) => "naddr",
        Nip19::Secret(_) => "nsec",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEX: &str = "09d48a1a5dbe13404a729634f1d6ba722d40513468dd713c8ea38ca9b7b6f2c7";

    #[test]
    fn parse_hex64_lowercase_passes() {
        let pk = Pubkey::parse_hex64(HEX).unwrap();
        assert_eq!(pk.as_hex(), HEX);
    }

    #[test]
    fn parse_hex64_uppercase_lowercases_output() {
        let upper = HEX.to_ascii_uppercase();
        let pk = Pubkey::parse_hex64(&upper).unwrap();
        assert_eq!(pk.as_hex(), HEX);
    }

    #[test]
    fn parse_hex64_rejects_short_input() {
        let err = Pubkey::parse_hex64("abc").unwrap_err();
        assert!(matches!(err, PubkeyError::Hex64WrongLength { len: 3 }));
    }

    #[test]
    fn parse_hex64_rejects_non_hex_chars() {
        let bad = "0".repeat(63) + "g";
        let err = Pubkey::parse_hex64(&bad).unwrap_err();
        assert_eq!(err, PubkeyError::Hex64NotHex);
    }

    #[test]
    fn parse_decoding_accepts_hex64_directly() {
        let pk = Pubkey::parse_decoding(HEX).unwrap();
        assert_eq!(pk.as_hex(), HEX);
    }

    #[test]
    fn parse_decoding_accepts_hex64_with_surrounding_whitespace() {
        let s = format!("  {HEX}  ");
        let pk = Pubkey::parse_decoding(&s).unwrap();
        assert_eq!(pk.as_hex(), HEX);
    }

    #[test]
    fn parse_decoding_decodes_npub() {
        // Round-trip: hex → npub → hex through nostr-sdk to get a valid bech32.
        use nostr_sdk::ToBech32;
        let pk = nostr_sdk::PublicKey::from_hex(HEX).unwrap();
        let npub = pk.to_bech32().unwrap();
        assert!(npub.starts_with("npub1"));
        let parsed = Pubkey::parse_decoding(&npub).unwrap();
        assert_eq!(parsed.as_hex(), HEX);
    }

    #[test]
    fn parse_decoding_rejects_unknown_form() {
        let err = Pubkey::parse_decoding("not-a-pubkey").unwrap_err();
        assert!(matches!(err, PubkeyError::UnknownForm));
    }

    #[test]
    fn parse_decoding_rejects_malformed_bech32() {
        let err = Pubkey::parse_decoding("npub1notvalid").unwrap_err();
        assert!(matches!(err, PubkeyError::Bech32 { kind: "npub", .. }));
    }

    #[test]
    fn display_yields_hex() {
        let pk = Pubkey::parse_hex64(HEX).unwrap();
        assert_eq!(format!("{pk}"), HEX);
    }
}
