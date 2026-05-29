//! Canonical event-ID validators, factories, and the single short-ID
//! shortener for the TENEX Rust workspace.
//!
//! This is the *one* place that defines the length of event IDs and the
//! translation from a long (full) ID to a short ID. Every crate that needs
//! to render or prefix-match an event ID depends on this crate rather than
//! hand-rolling `&id[..N]`.
//!
//! Mirrors `src/types/event-ids.ts` byte-for-byte. Three ID flavours flow
//! through TENEX:
//!
//! - **Full event ID** — 64-char lowercase hex (Nostr events,
//!   conversation IDs, agent pubkeys).
//! - **Short event ID** — 10-char lowercase hex (display + prefix
//!   lookups via PrefixKVStore).
//! - **Shell task ID** — 7-char lowercase alphanumeric (background
//!   shell-task tracking; in-memory only).
//!
//! TypeScript's branded-type pattern doesn't translate to Rust; Rust
//! callers use the validators + factory functions and pass plain
//! `String`s where the TS source uses `FullEventId`/`ShortEventId`.
//! Verbatim TS error strings are preserved.
//!
//! [`shorten_full_event_id`] is the canonical prefix-truncation shortener.
//! The Telegram-aware variant (hashing non-hex `tg_*` IDs before
//! truncation) lives in the `tenex` binary's `utils::identifiers` module
//! and delegates its hex path here so the two cannot drift.

use anyhow::{anyhow, Result};

/// 64 — full event ID length. `event-ids.ts:85`.
pub const FULL_EVENT_ID_LENGTH: usize = 64;

/// 10 — short event ID length. `event-ids.ts:88`.
pub const SHORT_EVENT_ID_LENGTH: usize = 10;

/// 7 — shell task ID length. `event-ids.ts:91`.
pub const SHELL_TASK_ID_LENGTH: usize = 7;

/// Mirror `isFullEventId` (`event-ids.ts:100-102`):
/// `^[0-9a-f]{64}$` — case-sensitive lowercase.
pub fn is_full_event_id(id: &str) -> bool {
    id.len() == FULL_EVENT_ID_LENGTH
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Mirror `isShortEventId` (`event-ids.ts:107-109`):
/// `^[0-9a-f]{10}$` — case-sensitive lowercase.
pub fn is_short_event_id(id: &str) -> bool {
    id.len() == SHORT_EVENT_ID_LENGTH
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Mirror `isShellTaskId` (`event-ids.ts:114-116`):
/// `^[a-z0-9]{7}$` — case-sensitive lowercase alphanumeric.
pub fn is_shell_task_id(id: &str) -> bool {
    id.len() == SHELL_TASK_ID_LENGTH
        && id
            .bytes()
            .all(|b: u8| b.is_ascii_digit() || b.is_ascii_lowercase())
}

/// Mirror `detectIdType` (`event-ids.ts:123-139`):
/// lowercases the input then dispatches to the three type guards in
/// `full → short → shell` source order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdType {
    Full,
    Short,
    Shell,
}

impl IdType {
    /// Verbatim TS string literal returned by `detectIdType`.
    pub fn as_str(self) -> &'static str {
        match self {
            IdType::Full => "full",
            IdType::Short => "short",
            IdType::Shell => "shell",
        }
    }
}

pub fn detect_id_type(id: &str) -> Option<IdType> {
    let lower = id.to_lowercase();
    if is_full_event_id(&lower) {
        return Some(IdType::Full);
    }
    if is_short_event_id(&lower) {
        return Some(IdType::Short);
    }
    if is_shell_task_id(&lower) {
        return Some(IdType::Shell);
    }
    None
}

// =====================================================================
// Factory functions — verbatim TS error strings.
// =====================================================================

/// Mirror `createFullEventId` (`event-ids.ts:150-160`).
///
/// Lowercases the input first, then validates. Errors with the verbatim
/// TS message including a 20-char prefix of the input + its length:
/// `"Invalid FullEventId: expected 64-char lowercase hex string, got \"<prefix>...\" (length: <n>)"`.
pub fn create_full_event_id(id: &str) -> Result<String> {
    let lower = id.to_lowercase();
    if !is_full_event_id(&lower) {
        let prefix: String = id.chars().take(20).collect();
        return Err(anyhow!(
            "Invalid FullEventId: expected 64-char lowercase hex string, got \"{prefix}...\" (length: {})",
            id.chars().count()
        ));
    }
    Ok(lower)
}

/// Mirror `createShortEventId` (`event-ids.ts:167-177`).
pub fn create_short_event_id(id: &str) -> Result<String> {
    let lower = id.to_lowercase();
    if !is_short_event_id(&lower) {
        return Err(anyhow!(
            "Invalid ShortEventId: expected 10-char lowercase hex string, got \"{id}\" (length: {})",
            id.chars().count()
        ));
    }
    Ok(lower)
}

/// Mirror `createShellTaskId` (`event-ids.ts:184-194`).
pub fn create_shell_task_id(id: &str) -> Result<String> {
    let lower = id.to_lowercase();
    if !is_shell_task_id(&lower) {
        return Err(anyhow!(
            "Invalid ShellTaskId: expected 7-char lowercase alphanumeric string, got \"{id}\" (length: {})",
            id.chars().count()
        ));
    }
    Ok(lower)
}

/// Mirror `tryCreateFullEventId` (`event-ids.ts:199-202`).
pub fn try_create_full_event_id(id: &str) -> Option<String> {
    let lower = id.to_lowercase();
    if is_full_event_id(&lower) {
        Some(lower)
    } else {
        None
    }
}

/// Mirror `tryCreateShortEventId` (`event-ids.ts:207-210`).
pub fn try_create_short_event_id(id: &str) -> Option<String> {
    let lower = id.to_lowercase();
    if is_short_event_id(&lower) {
        Some(lower)
    } else {
        None
    }
}

/// Mirror `tryCreateShellTaskId` (`event-ids.ts:215-218`).
pub fn try_create_shell_task_id(id: &str) -> Option<String> {
    let lower = id.to_lowercase();
    if is_shell_task_id(&lower) {
        Some(lower)
    } else {
        None
    }
}

/// The canonical short-ID shortener: first [`SHORT_EVENT_ID_LENGTH`] chars
/// of a full event ID. Mirror `shortenEventId` (`event-ids.ts:227-229`).
///
/// Caller is expected to pass an already-validated full event ID; this
/// function does not re-validate (matches TS — it's typed as
/// `FullEventId → ShortEventId`). Inputs shorter than
/// [`SHORT_EVENT_ID_LENGTH`] are returned unchanged.
pub fn shorten_full_event_id(full_id: &str) -> String {
    full_id.chars().take(SHORT_EVENT_ID_LENGTH).collect()
}

/// Parsed-ID enum returned by [`parse_event_id`]. Mirrors the TS
/// discriminated-union return of `parseEventId`
/// (`event-ids.ts:303-321`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParsedEventId {
    Full(String),
    Short(String),
    Shell(String),
}

/// Mirror `parseEventId` (`event-ids.ts:303-321`):
/// trim → lowercase → dispatch in `full → short → shell` source order.
pub fn parse_event_id(input: &str) -> Option<ParsedEventId> {
    let normalized = input.trim().to_lowercase();
    if is_full_event_id(&normalized) {
        return Some(ParsedEventId::Full(normalized));
    }
    if is_short_event_id(&normalized) {
        return Some(ParsedEventId::Short(normalized));
    }
    if is_shell_task_id(&normalized) {
        return Some(ParsedEventId::Shell(normalized));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn full_id() -> String {
        "0123456789abcdef".repeat(4) // 64 chars
    }

    fn short_id() -> &'static str {
        "0123456789"
    }

    fn shell_id() -> &'static str {
        "abc1230"
    }

    // ── constants ───────────────────────────────────────────────────────

    #[test]
    fn lengths_match_ts() {
        assert_eq!(FULL_EVENT_ID_LENGTH, 64);
        assert_eq!(SHORT_EVENT_ID_LENGTH, 10);
        assert_eq!(SHELL_TASK_ID_LENGTH, 7);
    }

    // ── is_full_event_id ────────────────────────────────────────────────

    #[test]
    fn full_id_accepts_canonical_64_lowercase_hex() {
        assert!(is_full_event_id(&full_id()));
        assert!(is_full_event_id(&"a".repeat(64)));
    }

    #[test]
    fn full_id_rejects_wrong_length() {
        assert!(!is_full_event_id(&"a".repeat(63)));
        assert!(!is_full_event_id(&"a".repeat(65)));
        assert!(!is_full_event_id(""));
    }

    #[test]
    fn full_id_rejects_uppercase_hex() {
        assert!(!is_full_event_id(&"A".repeat(64)));
    }

    #[test]
    fn full_id_rejects_non_hex_chars() {
        let mut almost = full_id();
        almost.replace_range(0..1, "g");
        assert!(!is_full_event_id(&almost));
    }

    // ── is_short_event_id ───────────────────────────────────────────────

    #[test]
    fn short_id_accepts_canonical_10_lowercase_hex() {
        assert!(is_short_event_id(short_id()));
        assert!(is_short_event_id("ffffffffff"));
    }

    #[test]
    fn short_id_rejects_wrong_length_or_case() {
        assert!(!is_short_event_id("012345678")); // 9
        assert!(!is_short_event_id("0123456789a")); // 11
        assert!(!is_short_event_id("ABCDEF1234")); // uppercase
    }

    // ── is_shell_task_id ────────────────────────────────────────────────

    #[test]
    fn shell_id_accepts_canonical_7_lowercase_alnum() {
        assert!(is_shell_task_id(shell_id()));
        assert!(is_shell_task_id("zzzzzzz"));
        assert!(is_shell_task_id("9999999"));
    }

    #[test]
    fn shell_id_rejects_uppercase_or_punctuation() {
        assert!(!is_shell_task_id("ABCDEF1"));
        assert!(!is_shell_task_id("abcd-ef")); // dash
        assert!(!is_shell_task_id("abcdef")); // 6 chars
    }

    // ── detect_id_type ──────────────────────────────────────────────────

    #[test]
    fn detect_full_takes_precedence_over_short() {
        // 64-char hex matches `is_full` first — `detect` returns Full.
        assert_eq!(detect_id_type(&full_id()), Some(IdType::Full));
    }

    #[test]
    fn detect_short_when_only_10_hex() {
        assert_eq!(detect_id_type(short_id()), Some(IdType::Short));
    }

    #[test]
    fn detect_shell_when_alphanumeric_with_letters() {
        // 7 chars with at least one a-z that isn't a-f → not hex →
        // falls through to shell.
        assert_eq!(detect_id_type("zzz1234"), Some(IdType::Shell));
    }

    #[test]
    fn detect_lowercases_input_before_matching() {
        // Uppercase input gets lowercased by detect; `0xABC...` 64-char
        // becomes the same 64-char lowercase → Full.
        let upper: String =
            "ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789".to_string();
        assert_eq!(detect_id_type(&upper), Some(IdType::Full));
    }

    #[test]
    fn detect_returns_none_for_unrecognised() {
        assert_eq!(detect_id_type(""), None);
        assert_eq!(detect_id_type("hello world"), None);
        assert_eq!(detect_id_type(&"a".repeat(8)), None); // 8 != 7/10/64
    }

    #[test]
    fn id_type_str_matches_ts_literals() {
        assert_eq!(IdType::Full.as_str(), "full");
        assert_eq!(IdType::Short.as_str(), "short");
        assert_eq!(IdType::Shell.as_str(), "shell");
    }

    // ── create_full_event_id ────────────────────────────────────────────

    #[test]
    fn create_full_lowercases_and_returns() {
        // Mixed-case 64-char string. "ABCDEF01" repeated 8× = 64 chars.
        let upper = "ABCDEF01".repeat(8);
        let r = create_full_event_id(&upper).unwrap();
        assert_eq!(r, upper.to_lowercase());
    }

    #[test]
    fn create_full_invalid_length_errors_with_verbatim_message() {
        let e = create_full_event_id("short").unwrap_err().to_string();
        assert!(e.starts_with(
            "Invalid FullEventId: expected 64-char lowercase hex string, got \"short...\" "
        ));
        assert!(e.contains("(length: 5)"));
    }

    #[test]
    fn create_full_truncates_prefix_to_20_chars_in_error() {
        let long_invalid: String = "z".repeat(100);
        let e = create_full_event_id(&long_invalid).unwrap_err().to_string();
        // Prefix is the first 20 chars of input.
        assert!(e.contains(&format!("\"{}...\"", "z".repeat(20))));
        assert!(e.contains("(length: 100)"));
    }

    // ── create_short_event_id ───────────────────────────────────────────

    #[test]
    fn create_short_invalid_errors_with_verbatim_message() {
        let e = create_short_event_id("oops").unwrap_err().to_string();
        assert!(e.starts_with(
            "Invalid ShortEventId: expected 10-char lowercase hex string, got \"oops\" "
        ));
        assert!(e.contains("(length: 4)"));
    }

    // ── create_shell_task_id ────────────────────────────────────────────

    #[test]
    fn create_shell_invalid_errors_with_verbatim_message() {
        let e = create_shell_task_id("nope").unwrap_err().to_string();
        assert!(e.starts_with(
            "Invalid ShellTaskId: expected 7-char lowercase alphanumeric string, got \"nope\" "
        ));
        assert!(e.contains("(length: 4)"));
    }

    // ── try_create variants ─────────────────────────────────────────────

    #[test]
    fn try_create_returns_some_for_valid_or_normalisable() {
        assert!(try_create_full_event_id(&full_id()).is_some());
        assert!(try_create_short_event_id(short_id()).is_some());
        assert!(try_create_shell_task_id(shell_id()).is_some());
        // Uppercase normalises down.
        let upper: String = "ABCDEF1234".into();
        assert!(try_create_short_event_id(&upper).is_some());
    }

    #[test]
    fn try_create_returns_none_for_invalid() {
        assert!(try_create_full_event_id("nope").is_none());
        assert!(try_create_short_event_id("nope").is_none());
        assert!(try_create_shell_task_id("nope").is_none());
    }

    // ── shorten_full_event_id ───────────────────────────────────────────

    #[test]
    fn shorten_takes_first_10_chars() {
        let f = full_id();
        let s = shorten_full_event_id(&f);
        assert_eq!(s, &f[..10]);
        assert_eq!(s.len(), 10);
    }

    // ── parse_event_id ──────────────────────────────────────────────────

    #[test]
    fn parse_full_with_whitespace_and_uppercase() {
        let f = full_id();
        let with_pad = format!("  {}  ", f.to_uppercase());
        match parse_event_id(&with_pad) {
            Some(ParsedEventId::Full(s)) => assert_eq!(s, f),
            other => panic!("expected Full, got {other:?}"),
        }
    }

    #[test]
    fn parse_short_dispatch() {
        match parse_event_id(short_id()) {
            Some(ParsedEventId::Short(s)) => assert_eq!(s, short_id()),
            other => panic!("expected Short, got {other:?}"),
        }
    }

    #[test]
    fn parse_shell_dispatch() {
        match parse_event_id(shell_id()) {
            Some(ParsedEventId::Shell(s)) => assert_eq!(s, shell_id()),
            other => panic!("expected Shell, got {other:?}"),
        }
    }

    #[test]
    fn parse_returns_none_for_unrecognised() {
        assert!(parse_event_id("").is_none());
        assert!(parse_event_id("not an id").is_none());
        assert!(parse_event_id(&"x".repeat(20)).is_none());
    }
}
