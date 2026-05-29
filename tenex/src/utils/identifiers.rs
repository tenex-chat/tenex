//! Centralized helpers for shortening Nostr event IDs, conversation IDs,
//! and pubkeys for display.
//!
//! Mirrors `src/utils/conversation-id.ts` verbatim:
//! - Conversation / event IDs → 10-char lowercase prefix
//! - Pubkeys → 6-char lowercase prefix
//! - Telegram conversation IDs (`tg_*`) get sha256-hashed first, then
//!   prefix-truncated to 10 hex chars — this avoids collisions between
//!   numerically-similar IDs like `tg_599309204_123` and
//!   `tg_599309204_124` that would otherwise share the same 10-char
//!   prefix `tg_5993092`.

use sha2::{Digest, Sha256};

/// Source: `utils/nostr-entity-parser.ts:21` (`PUBKEY_DISPLAY_LENGTH`).
#[cfg(test)]
const PUBKEY_DISPLAY_LENGTH: usize = 6;

const TELEGRAM_PREFIX: &str = "tg_";

fn shorten_event_identifier(value: &str) -> String {
    if value.starts_with(TELEGRAM_PREFIX) {
        let mut hasher = Sha256::new();
        hasher.update(value.as_bytes());
        let digest = hasher.finalize();
        // Hex-encode the 32-byte digest, take the first 10 chars (5 bytes).
        let mut hex = String::with_capacity(20);
        for byte in digest.iter().take(5) {
            use std::fmt::Write as _;
            let _ = write!(hex, "{byte:02x}");
        }
        return hex;
    }
    tenex_ids::shorten_full_event_id(value).to_lowercase()
}

/// Mirror `shortenConversationId` (`conversation-id.ts:49-51`).
#[cfg(test)]
fn shorten_conversation_id(conversation_id: &str) -> String {
    shorten_event_identifier(conversation_id)
}

/// Mirror `shortenOptionalConversationId` (`:53-57`).
#[cfg(test)]
fn shorten_optional_conversation_id(conversation_id: Option<&str>) -> Option<String> {
    conversation_id
        .filter(|s| !s.is_empty())
        .map(shorten_conversation_id)
}

/// Mirror `shortenEventId` (`:59-61`).
pub fn shorten_event_id(event_id: &str) -> String {
    shorten_event_identifier(event_id)
}

/// Mirror `shortenOptionalEventId` (`:63-67`).
#[cfg(test)]
fn shorten_optional_event_id(event_id: Option<&str>) -> Option<String> {
    event_id.filter(|s| !s.is_empty()).map(shorten_event_id)
}

/// Mirror `shortenPubkey` (`:69-71`):
/// first 6 chars lowercased.
#[cfg(test)]
fn shorten_pubkey(pubkey: &str) -> String {
    let prefix: String = pubkey.chars().take(PUBKEY_DISPLAY_LENGTH).collect();
    prefix.to_lowercase()
}

/// Mirror `shortenOptionalPubkey` (`:73-75`).
#[cfg(test)]
fn shorten_optional_pubkey(pubkey: Option<&str>) -> Option<String> {
    pubkey.filter(|s| !s.is_empty()).map(shorten_pubkey)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── shorten_event_id ────────────────────────────────────────────────

    #[test]
    fn shorten_event_id_takes_first_10_chars_lowercase() {
        assert_eq!(shorten_event_id("ABCDEF1234567890"), "abcdef1234");
        assert_eq!(shorten_event_id("0123456789abcdef"), "0123456789");
    }

    #[test]
    fn shorten_event_id_pads_short_input() {
        // TS `value.substring(0, 10)` returns the input as-is when shorter
        // than 10 chars. We mirror that — no panic, no padding.
        assert_eq!(shorten_event_id("abc"), "abc");
        assert_eq!(shorten_event_id(""), "");
    }

    #[test]
    fn shorten_event_id_lowercases_uppercase_input() {
        assert_eq!(shorten_event_id("ABCDEFGHIJ"), "abcdefghij");
    }

    // ── tg_ prefix branch ───────────────────────────────────────────────

    #[test]
    fn shorten_event_id_hashes_telegram_ids_to_10_hex_chars() {
        let result = shorten_event_id("tg_599309204_123");
        // The output is 10 lowercase hex chars; deterministic per input.
        assert_eq!(result.len(), 10);
        assert!(result.chars().all(|c| c.is_ascii_hexdigit()));
        // Distinct from the prefix-truncated version.
        assert_ne!(result, "tg_599309");
    }

    #[test]
    fn shorten_event_id_telegram_hash_is_deterministic() {
        let a = shorten_event_id("tg_some_id_here");
        let b = shorten_event_id("tg_some_id_here");
        assert_eq!(a, b);
    }

    #[test]
    fn shorten_event_id_telegram_distinguishes_similar_ids() {
        // The whole point of the hash branch — two near-identical
        // numeric tail Telegram IDs should not share a prefix.
        let a = shorten_event_id("tg_599309204_123");
        let b = shorten_event_id("tg_599309204_124");
        assert_ne!(a, b);
    }

    // ── shorten_pubkey ──────────────────────────────────────────────────

    #[test]
    fn shorten_pubkey_takes_first_6_chars_lowercase() {
        assert_eq!(shorten_pubkey("ABCDEF1234567890ABCDEF1234567890"), "abcdef");
    }

    #[test]
    fn shorten_pubkey_pads_short_input() {
        assert_eq!(shorten_pubkey("ab"), "ab");
        assert_eq!(shorten_pubkey(""), "");
    }

    #[test]
    fn pubkey_display_length_constant_matches_ts() {
        assert_eq!(PUBKEY_DISPLAY_LENGTH, 6);
    }

    // ── optional variants ───────────────────────────────────────────────

    #[test]
    fn optional_event_id_returns_none_for_none_or_empty() {
        assert_eq!(shorten_optional_event_id(None), None);
        assert_eq!(shorten_optional_event_id(Some("")), None);
    }

    #[test]
    fn optional_event_id_returns_some_for_non_empty() {
        assert_eq!(
            shorten_optional_event_id(Some("0123456789ab")),
            Some("0123456789".to_string())
        );
    }

    #[test]
    fn optional_pubkey_returns_none_for_none_or_empty() {
        assert_eq!(shorten_optional_pubkey(None), None);
        assert_eq!(shorten_optional_pubkey(Some("")), None);
    }

    #[test]
    fn optional_conversation_id_returns_none_for_none_or_empty() {
        assert_eq!(shorten_optional_conversation_id(None), None);
        assert_eq!(shorten_optional_conversation_id(Some("")), None);
    }

    // ── conversation alias ──────────────────────────────────────────────

    #[test]
    fn shorten_conversation_id_routes_through_event_path() {
        // Same code path as shorten_event_id — both hit
        // shorten_event_identifier.
        assert_eq!(
            shorten_conversation_id("ABCDEF1234567890"),
            shorten_event_id("ABCDEF1234567890")
        );
    }
}
