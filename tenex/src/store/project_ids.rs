//! Project identifier validators + format helpers.
//!
//! Mirrors `src/types/project-ids.ts` byte-for-byte. Two distinct
//! identifier formats:
//!
//! 1. **D-tag** — internal id (e.g. `"TENEX-ff3ssq"`). Used for disk
//!    paths, conversation lookups, RAL registry entries — every
//!    internal state.
//! 2. **NIP-33 address** — `31933:<64-char-hex-pubkey>:<d-tag>`. Used
//!    only at Nostr publishing boundaries (`["a", …]` tag construction,
//!    `#a` subscription filter values).
//!
//! Rust port skips TypeScript's branded-type pattern — Rust callers
//! distinguish via separate newtypes if needed (`ProjectDTag(String)` /
//! `ProjectAddress(String)`), or pass plain `&str` and rely on these
//! validators to gate boundaries. The validation logic + verbatim error
//! strings are what matter.

use anyhow::{anyhow, Result};

/// `kind:pubkey:identifier` shape. Pubkey must be 64 lowercase hex.
fn is_project_address_shape(value: &str) -> bool {
    let mut parts = value.splitn(3, ':');
    let Some(kind) = parts.next() else { return false };
    let Some(pubkey) = parts.next() else { return false };
    let Some(rest) = parts.next() else { return false };
    if kind != "31933" {
        return false;
    }
    if pubkey.len() != 64 || !pubkey.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
        return false;
    }
    !rest.is_empty()
}

/// Mirror `isProjectAddress` (`project-ids.ts:60-62`).
///
/// `true` iff the input matches the regex `^31933:[0-9a-f]{64}:.+$`.
/// Case-sensitive — uppercase hex is rejected (matches the TS regex
/// character class `[0-9a-f]`).
pub fn is_project_address(value: &str) -> bool {
    is_project_address_shape(value)
}

/// Mirror `isProjectDTag` / `isDTagFormat` (`project-ids.ts:42-55`):
/// non-empty AND not a NIP-33 address.
pub fn is_project_d_tag(value: &str) -> bool {
    !value.is_empty() && !is_project_address(value)
}

/// Mirror `createProjectDTag` (`project-ids.ts:72-82`).
///
/// Validates that `value` looks like a d-tag (not a NIP-33 address) and
/// returns it as-is. Two error strings, both verbatim from TS:
///
/// - empty input → `"ProjectDTag cannot be empty"`
/// - looks like an address → `"Invalid ProjectDTag: \"<value>\" looks
///   like a NIP-33 address. Use extractDTagFromAddress() to extract
///   the d-tag."`
pub fn create_project_d_tag(value: &str) -> Result<String> {
    if value.is_empty() {
        return Err(anyhow!("ProjectDTag cannot be empty"));
    }
    if is_project_address(value) {
        return Err(anyhow!(
            "Invalid ProjectDTag: \"{value}\" looks like a NIP-33 address. \
             Use extractDTagFromAddress() to extract the d-tag."
        ));
    }
    Ok(value.to_owned())
}

/// Mirror `createProjectAddress` (`project-ids.ts:88-95`).
///
/// Validates that `value` matches the NIP-33 address shape and returns
/// it as-is. Verbatim TS error message on failure:
/// `"Invalid ProjectAddress: expected \"31933:<64-char-hex-pubkey>:<d-tag>\", got \"<value>\""`.
pub fn create_project_address(value: &str) -> Result<String> {
    if !is_project_address(value) {
        return Err(anyhow!(
            "Invalid ProjectAddress: expected \"31933:<64-char-hex-pubkey>:<d-tag>\", got \"{value}\""
        ));
    }
    Ok(value.to_owned())
}

/// Mirror `extractDTagFromAddress` (`project-ids.ts:107-116`).
///
/// Splits on the **first two** colons only — anything after the second
/// colon is the d-tag (which is allowed to contain `:` itself, though
/// that's rare).
///
/// Errors with verbatim TS message
/// `"Cannot extract d-tag from address: \"<value>\""` when the input
/// has fewer than two colons.
pub fn extract_d_tag_from_address(address: &str) -> Result<String> {
    let first = address
        .find(':')
        .ok_or_else(|| anyhow!("Cannot extract d-tag from address: \"{address}\""))?;
    let after_first = &address[first + 1..];
    let second_offset = after_first
        .find(':')
        .ok_or_else(|| anyhow!("Cannot extract d-tag from address: \"{address}\""))?;
    let second_absolute = first + 1 + second_offset;
    Ok(address[second_absolute + 1..].to_owned())
}

/// Mirror `buildProjectAddress` (`project-ids.ts:123-129`).
pub fn build_project_address(kind: u32, pubkey: &str, d_tag: &str) -> String {
    format!("{kind}:{pubkey}:{d_tag}")
}

/// Mirror `tryExtractDTagFromAddress` (`project-ids.ts:136-141`).
///
/// Returns `Some(d_tag)` if the input is a valid NIP-33 address;
/// `None` otherwise. Useful at parsing boundaries where untyped a-tag
/// values arrive.
pub fn try_extract_d_tag_from_address(value: &str) -> Option<String> {
    if !is_project_address(value) {
        return None;
    }
    extract_d_tag_from_address(value).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn good_pubkey() -> String {
        "0123456789abcdef".repeat(4)
    }

    // ── is_project_address ──────────────────────────────────────────────

    #[test]
    fn is_address_accepts_canonical_shape() {
        let pk = good_pubkey();
        assert!(is_project_address(&format!("31933:{pk}:dtag")));
        assert!(is_project_address(&format!("31933:{pk}:hyphen-tag")));
        // Non-empty d-tag — `.+$` requires ≥1 char.
        assert!(is_project_address(&format!("31933:{pk}:x")));
    }

    #[test]
    fn is_address_rejects_wrong_kind() {
        let pk = good_pubkey();
        assert!(!is_project_address(&format!("31934:{pk}:dtag")));
        assert!(!is_project_address(&format!("0:{pk}:dtag")));
    }

    #[test]
    fn is_address_rejects_short_pubkey() {
        // 63 chars instead of 64.
        assert!(!is_project_address("31933:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde:dtag"));
    }

    #[test]
    fn is_address_rejects_uppercase_hex_in_pubkey() {
        // The TS regex is `[0-9a-f]` — case-sensitive lowercase.
        assert!(!is_project_address("31933:ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789:dtag"));
    }

    #[test]
    fn is_address_rejects_non_hex_pubkey() {
        let bad: String = "g".repeat(64);
        assert!(!is_project_address(&format!("31933:{bad}:dtag")));
    }

    #[test]
    fn is_address_rejects_empty_dtag() {
        let pk = good_pubkey();
        assert!(!is_project_address(&format!("31933:{pk}:")));
    }

    #[test]
    fn is_address_rejects_missing_segments() {
        assert!(!is_project_address(""));
        assert!(!is_project_address("31933"));
        assert!(!is_project_address("31933:"));
    }

    // ── is_project_d_tag ────────────────────────────────────────────────

    #[test]
    fn is_d_tag_rejects_empty() {
        assert!(!is_project_d_tag(""));
    }

    #[test]
    fn is_d_tag_rejects_address_shape() {
        let pk = good_pubkey();
        assert!(!is_project_d_tag(&format!("31933:{pk}:dtag")));
    }

    #[test]
    fn is_d_tag_accepts_normal_strings() {
        assert!(is_project_d_tag("TENEX-ff3ssq"));
        assert!(is_project_d_tag("a"));
        assert!(is_project_d_tag("multi:colon:dtag")); // not the address shape
    }

    // ── create_project_d_tag ────────────────────────────────────────────

    #[test]
    fn create_d_tag_returns_input_unchanged_for_normal_value() {
        assert_eq!(create_project_d_tag("TENEX-ff3ssq").unwrap(), "TENEX-ff3ssq");
    }

    #[test]
    fn create_d_tag_empty_errors_with_verbatim_message() {
        let e = create_project_d_tag("").unwrap_err().to_string();
        assert_eq!(e, "ProjectDTag cannot be empty");
    }

    #[test]
    fn create_d_tag_address_shape_errors_with_verbatim_message() {
        let pk = good_pubkey();
        let addr = format!("31933:{pk}:foo");
        let e = create_project_d_tag(&addr).unwrap_err().to_string();
        assert!(e.contains("looks like a NIP-33 address"));
        assert!(e.contains("Use extractDTagFromAddress()"));
        assert!(e.contains(&addr));
    }

    // ── create_project_address ──────────────────────────────────────────

    #[test]
    fn create_address_returns_input_unchanged_for_valid() {
        let pk = good_pubkey();
        let v = format!("31933:{pk}:dtag");
        assert_eq!(create_project_address(&v).unwrap(), v);
    }

    #[test]
    fn create_address_invalid_errors_with_verbatim_message() {
        let e = create_project_address("not-an-address").unwrap_err().to_string();
        assert!(e.starts_with(
            "Invalid ProjectAddress: expected \"31933:<64-char-hex-pubkey>:<d-tag>\", got "
        ));
        assert!(e.contains("not-an-address"));
    }

    // ── extract_d_tag_from_address ──────────────────────────────────────

    #[test]
    fn extract_d_tag_simple_case() {
        let pk = good_pubkey();
        let addr = format!("31933:{pk}:TENEX-ff3ssq");
        assert_eq!(
            extract_d_tag_from_address(&addr).unwrap(),
            "TENEX-ff3ssq"
        );
    }

    #[test]
    fn extract_d_tag_preserves_colons_in_dtag() {
        // The TS source splits on the first two colons only — any `:`
        // in the d-tag is preserved.
        let pk = good_pubkey();
        let addr = format!("31933:{pk}:multi:colon:dtag");
        assert_eq!(
            extract_d_tag_from_address(&addr).unwrap(),
            "multi:colon:dtag"
        );
    }

    #[test]
    fn extract_d_tag_errors_when_no_second_colon() {
        let e = extract_d_tag_from_address("31933:noproblem")
            .unwrap_err()
            .to_string();
        assert_eq!(
            e,
            "Cannot extract d-tag from address: \"31933:noproblem\""
        );
    }

    #[test]
    fn extract_d_tag_errors_when_no_colons() {
        let e = extract_d_tag_from_address("just-a-dtag").unwrap_err().to_string();
        assert!(e.contains("Cannot extract d-tag from address"));
    }

    // ── build_project_address ───────────────────────────────────────────

    #[test]
    fn build_address_concatenates_with_colons() {
        let pk = good_pubkey();
        assert_eq!(
            build_project_address(31933, &pk, "TENEX-ff3ssq"),
            format!("31933:{pk}:TENEX-ff3ssq")
        );
    }

    #[test]
    fn build_address_does_not_validate_inputs() {
        // The TS source's `buildProjectAddress` is also unvalidated —
        // the typed wrapper with the brand assertion just trusts the
        // caller. Reproduce by accepting any inputs.
        assert_eq!(
            build_project_address(0, "tooshort", "dtag"),
            "0:tooshort:dtag"
        );
    }

    // ── try_extract_d_tag_from_address ──────────────────────────────────

    #[test]
    fn try_extract_returns_some_for_valid_address() {
        let pk = good_pubkey();
        let addr = format!("31933:{pk}:dtag");
        assert_eq!(
            try_extract_d_tag_from_address(&addr).as_deref(),
            Some("dtag")
        );
    }

    #[test]
    fn try_extract_returns_none_for_invalid_address() {
        assert!(try_extract_d_tag_from_address("not-an-address").is_none());
        assert!(try_extract_d_tag_from_address("just-a-dtag").is_none());
        assert!(try_extract_d_tag_from_address("").is_none());
        // Wrong kind.
        let pk = good_pubkey();
        assert!(try_extract_d_tag_from_address(&format!("31934:{pk}:dtag")).is_none());
    }
}
