//! LLM connectivity-test error-hint mapping.
//!
//! Mirrors `src/llm/utils/ConfigurationTester.ts:73-83` verbatim. Every
//! transport / API / timeout error from a configured LLM provider funnels
//! through one `catch` block and is mapped to one of three short hints
//! (or the raw error message when no pattern matches).
//!
//! Per spec doc 06 §6.2: these are the **only** human-readable failure
//! reasons the user sees on the screen. The strings must be byte-faithful.
//!
//! Pattern matching: substring + case-sensitive. The mapping is
//! mutually-exclusive in source order — if a message contains "401" the
//! hint is `"invalid or expired API key"`, even if it also contains
//! "rate limit".

/// Hint when the error message contains `"401"` OR `"Unauthorized"`.
pub const HINT_INVALID_KEY: &str = "invalid or expired API key";

/// Hint when the error message contains `"404"`.
pub const HINT_MODEL_NOT_AVAILABLE: &str = "model not available";

/// Hint when the error message contains `"rate limit"` (lowercase only —
/// `"Rate Limit"` would fall through to the raw error).
pub const HINT_RATE_LIMITED: &str = "rate limited";

/// Verbatim error returned by `runConfigurationTest` when called with an
/// unknown configuration name (`ConfigurationTester.ts:35-37`).
/// Cannot reach this from the UI in practice — rows reflect the current
/// config map — but preserved for parity in tests and any future
/// programmatic use.
pub const ERR_CONFIGURATION_NOT_FOUND: &str = "configuration not found";

/// Map an error message to its display hint. Returns a borrowed slice
/// when one of the three canned hints applies; otherwise returns the
/// original message unchanged (this is the timeout / unknown-error
/// fallback, including the literal `"timed out after 30s"` produced by
/// `ConfigurationTester.ts:60-62`).
pub fn map_error_to_hint(error_message: &str) -> &str {
    // Source order matters — mutually-exclusive checks per spec §6.2.
    if error_message.contains("401") || error_message.contains("Unauthorized") {
        return HINT_INVALID_KEY;
    }
    if error_message.contains("404") {
        return HINT_MODEL_NOT_AVAILABLE;
    }
    if error_message.contains("rate limit") {
        return HINT_RATE_LIMITED;
    }
    error_message
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hint_constants_match_spec_verbatim() {
        // Source: spec doc 06 §6.2.
        assert_eq!(HINT_INVALID_KEY, "invalid or expired API key");
        assert_eq!(HINT_MODEL_NOT_AVAILABLE, "model not available");
        assert_eq!(HINT_RATE_LIMITED, "rate limited");
        assert_eq!(ERR_CONFIGURATION_NOT_FOUND, "configuration not found");
    }

    #[test]
    fn maps_401_substring_to_invalid_key() {
        assert_eq!(map_error_to_hint("API returned 401"), HINT_INVALID_KEY);
        assert_eq!(map_error_to_hint("401"), HINT_INVALID_KEY);
        assert_eq!(
            map_error_to_hint("status=401 unauthorised"),
            HINT_INVALID_KEY
        );
    }

    #[test]
    fn maps_unauthorized_substring_to_invalid_key() {
        assert_eq!(map_error_to_hint("Unauthorized"), HINT_INVALID_KEY);
        assert_eq!(
            map_error_to_hint("HTTP/1.1 401 Unauthorized"),
            HINT_INVALID_KEY
        );
        // Case-sensitive — lowercased "unauthorized" should NOT match.
        assert_eq!(map_error_to_hint("unauthorized"), "unauthorized");
    }

    #[test]
    fn maps_404_substring_to_model_not_available() {
        assert_eq!(
            map_error_to_hint("model returned 404"),
            HINT_MODEL_NOT_AVAILABLE
        );
        assert_eq!(map_error_to_hint("404"), HINT_MODEL_NOT_AVAILABLE);
    }

    #[test]
    fn maps_lowercase_rate_limit_to_rate_limited() {
        assert_eq!(
            map_error_to_hint("provider says: rate limit exceeded"),
            HINT_RATE_LIMITED
        );
        // Source order — 401 wins over rate_limit.
        assert_eq!(
            map_error_to_hint("401 rate limit"),
            HINT_INVALID_KEY,
            "401 takes precedence over rate limit per source order"
        );
    }

    #[test]
    fn does_not_map_uppercase_rate_limit() {
        // Spec §6.2 calls out: `"rate limit"` matches lowercase only.
        let raw = "Rate Limit hit";
        assert_eq!(map_error_to_hint(raw), raw);
    }

    #[test]
    fn timeout_falls_through_to_raw_message() {
        // The literal produced by ConfigurationTester.ts:60-62.
        let raw = "timed out after 30s";
        assert_eq!(map_error_to_hint(raw), raw);
    }

    #[test]
    fn unknown_error_falls_through_to_raw_message() {
        let raw = "ECONNREFUSED 127.0.0.1:443";
        assert_eq!(map_error_to_hint(raw), raw);
    }

    #[test]
    fn empty_message_returns_empty() {
        assert_eq!(map_error_to_hint(""), "");
    }

    #[test]
    fn source_order_is_mutually_exclusive() {
        // 401 → invalid key, even if 404/rate-limit present
        assert_eq!(
            map_error_to_hint("401 plus 404 plus rate limit"),
            HINT_INVALID_KEY
        );
        // 404 → model not available, even if rate-limit present (no 401)
        assert_eq!(
            map_error_to_hint("404 and rate limit"),
            HINT_MODEL_NOT_AVAILABLE
        );
    }
}
