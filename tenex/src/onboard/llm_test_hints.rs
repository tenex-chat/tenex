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

/// Generic prefixes that indicate the error message is a wrapper rather
/// than the actual cause. Matches `GENERIC_ERROR_PREFIXES` at
/// `error-formatter.ts:122-128`.
const GENERIC_ERROR_PREFIXES: &[&str] = &[
    AI_API_CALL_ERROR,
    PROVIDER_RETURNED_ERROR,
    HTTP_422_STATUS,
    "Unprocessable Entity",
    "Error:",
];

// AI-error markers used by both `is_meaningful_ai_message` (prefix
// check) and `format_stream_error` (substring check on the full
// `error.toString()`). Source: `error-formatter.ts:111-114`.

/// `AI_APICallError` — the AI SDK's generic API-error class name.
pub const AI_API_CALL_ERROR: &str = "AI_APICallError";

/// `Provider returned error` — wrapper used by some AI SDKs when the
/// upstream API returned a structured error.
pub const PROVIDER_RETURNED_ERROR: &str = "Provider returned error";

/// `openrouter` — substring marker (case-sensitive — the real provider
/// name in error strings is lowercase).
pub const OPENROUTER_MARKER: &str = "openrouter";

/// `422` — HTTP status code seen in a lot of AI-SDK error wrappers.
pub const HTTP_422_STATUS: &str = "422";

/// Mirror `isMeaningfulAiMessage` (`error-formatter.ts:139-159`).
///
/// Returns `true` when the input is a "real" error message worth
/// surfacing to the user; `false` when it's a generic wrapper that
/// callers should peel back via regex extraction or `error.toString()`
/// inspection.
///
/// Rejects:
/// - empty / whitespace-only messages (after trim)
/// - any message starting with one of the [`GENERIC_ERROR_PREFIXES`]
///   (using `starts_with` against the trimmed input — matches TS exactly)
/// - any message starting with a 3-digit HTTP status code followed by
///   a word boundary (`^\d{3}\b` — covers `"422"`, `"500 Internal
///   Server Error"`, etc., but not `"5000 tokens used"`)
pub fn is_meaningful_ai_message(message: Option<&str>) -> bool {
    let Some(raw) = message else {
        return false;
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return false;
    }
    for prefix in GENERIC_ERROR_PREFIXES {
        if trimmed.starts_with(prefix) {
            return false;
        }
    }
    // `^\d{3}\b` — three digits followed by a word boundary. We
    // approximate `\b` here via "char after digit is not a digit" since
    // an HTTP status is followed by either end-of-string or whitespace
    // (typical messages: "422", "500 Internal Server Error").
    let bytes = trimmed.as_bytes();
    if bytes.len() >= 3 && bytes[..3].iter().all(u8::is_ascii_digit) {
        let next = bytes.get(3);
        // `\b` at end-of-string OR followed by a non-word char (anything
        // that isn't `[A-Za-z0-9_]`). The TS regex is `\b`, which
        // matches word/non-word boundary — equivalent semantics here.
        let boundary = match next {
            None => true,
            Some(b) => !(b.is_ascii_alphanumeric() || *b == b'_'),
        };
        if boundary {
            return false;
        }
    }
    true
}

/// Categorises an error as either a system error or a flagged AI-API
/// error. The string literals are user-visible — `"system"` and
/// `"ai_api"` get logged + emitted to the chat UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamErrorType {
    System,
    AiApi,
}

impl StreamErrorType {
    /// Verbatim TS literal at `error-formatter.ts:166, 176`.
    pub fn as_str(self) -> &'static str {
        match self {
            StreamErrorType::System => "system",
            StreamErrorType::AiApi => "ai_api",
        }
    }
}

/// Mirror `formatStreamError` (`error-formatter.ts:164-200`).
///
/// Inputs:
/// - `error_to_string` — what TS reads via `error.toString()`. For a
///   JS Error this is `"<name>: <message>"`. The Rust caller passes the
///   full formatted form (e.g. `format!("{e:?}")` on an
///   `anyhow::Error`).
/// - `error_message` — what TS reads via `error.message`. For a Rust
///   error this is `format!("{e}")` or the inner cause. `None` matches
///   the TS branch where `error` is not an `Error` instance — falls
///   through to the default system-error string.
///
/// Output:
/// - `message` — user-facing string ready to print
/// - `error_type` — `system` or `ai_api`
///
/// AI-API detection: the `error_to_string` contains any of
/// `AI_APICallError`, `Provider returned error`, `422`, or `openrouter`.
/// On match, the type flips to `ai_api` and the message either:
/// 1. uses `error.message` directly (`"AI Error: <msg>"`) when
///    `is_meaningful_ai_message` returns `true`, OR
/// 2. extracts `provider_name` + `raw` via regex from the full string
///    and renders the verbose fallback.
pub fn format_stream_error(
    error_to_string: Option<&str>,
    error_message: Option<&str>,
) -> (String, StreamErrorType) {
    let default_msg = "An error occurred while processing your request.";
    let Some(error_str) = error_to_string else {
        return (default_msg.to_owned(), StreamErrorType::System);
    };

    let is_ai_api = error_str.contains(AI_API_CALL_ERROR)
        || error_str.contains(PROVIDER_RETURNED_ERROR)
        || error_str.contains(HTTP_422_STATUS)
        || error_str.contains(OPENROUTER_MARKER);

    if !is_ai_api {
        // Plain Error path: `Error: <message>`.
        let msg = match error_message {
            Some(m) => format!("Error: {m}"),
            None => default_msg.to_owned(),
        };
        return (msg, StreamErrorType::System);
    }

    if is_meaningful_ai_message(error_message) {
        let msg = format!(
            "AI Error: {}",
            error_message.expect("checked by is_meaningful_ai_message")
        );
        return (msg, StreamErrorType::AiApi);
    }

    // Verbose fallback — extract `provider_name` + `raw` from the full
    // error string. Regexes mirror `error-formatter.ts:185, 189`
    // verbatim.
    let provider = extract_quoted_field(error_str, "provider_name")
        .unwrap_or_else(|| "AI provider".to_owned());
    let mut msg = format!(
        "Failed to process request with {provider}. The AI service returned an error."
    );
    if let Some(raw) = extract_quoted_field(error_str, "raw") {
        msg.push_str(&format!(" Details: {raw}"));
    }
    (msg, StreamErrorType::AiApi)
}

/// Extract `<field>":"<value>"` from a JSON-like haystack. Mirrors the
/// two TS regexes `provider_name":"([^"]+)"` and `raw":"([^"]+)"` —
/// both use the same shape.
fn extract_quoted_field(haystack: &str, field: &str) -> Option<String> {
    use regex::Regex;
    // Build pattern: <field>":"([^"]+)"
    // `field` is a fixed literal here, but we still escape it for safety.
    let pattern = format!(r#"{}":"([^"]+)""#, regex::escape(field));
    let re = Regex::new(&pattern).ok()?;
    let captures = re.captures(haystack)?;
    captures.get(1).map(|m| m.as_str().to_owned())
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

    // ── is_meaningful_ai_message ────────────────────────────────────────

    #[test]
    fn meaningful_returns_false_for_none_or_empty_or_whitespace() {
        // Source: error-formatter.test.ts:154-156.
        assert!(!is_meaningful_ai_message(None));
        assert!(!is_meaningful_ai_message(Some("")));
        assert!(!is_meaningful_ai_message(Some("   ")));
        assert!(!is_meaningful_ai_message(Some("\t\n")));
    }

    #[test]
    fn meaningful_rejects_generic_prefixes() {
        // Source: error-formatter.test.ts:160-165 + GENERIC_ERROR_PREFIXES.
        assert!(!is_meaningful_ai_message(Some("AI_APICallError")));
        assert!(!is_meaningful_ai_message(Some(
            "AI_APICallError: some details"
        )));
        assert!(!is_meaningful_ai_message(Some("Provider returned error")));
        assert!(!is_meaningful_ai_message(Some("Unprocessable Entity")));
        assert!(!is_meaningful_ai_message(Some("Error: failed")));
    }

    #[test]
    fn meaningful_rejects_three_digit_status_at_start() {
        // The `^\d{3}\b` regex.
        assert!(!is_meaningful_ai_message(Some("422")));
        assert!(!is_meaningful_ai_message(Some("500 Internal Server Error")));
        assert!(!is_meaningful_ai_message(Some("404 Not Found")));
    }

    #[test]
    fn meaningful_accepts_messages_with_status_in_middle() {
        // The check is anchored at start — an embedded status code
        // doesn't disqualify.
        assert!(is_meaningful_ai_message(Some(
            "request failed with status 500"
        )));
    }

    #[test]
    fn meaningful_regex_uses_word_boundary_for_digits() {
        // The `^\d{3}\b` regex requires a word boundary after the
        // 3 digits — `"5000 tokens used"` does NOT trigger the regex
        // path because `5000` has a digit at position 3 (no boundary).
        // It IS however rejected by the "Error:" / "422" / etc. prefix
        // check if applicable. `"5000 tokens used"` doesn't start with
        // any of those, so it survives.
        assert!(is_meaningful_ai_message(Some("5000 tokens used")));
        // Conversely `"4220 retries"` IS rejected because it starts
        // with the "422" prefix (HTTP_422_STATUS) — the prefix check
        // runs before the regex check.
        assert!(!is_meaningful_ai_message(Some("4220 retries")));
    }

    #[test]
    fn meaningful_accepts_real_error_messages() {
        assert!(is_meaningful_ai_message(Some("Connection refused")));
        assert!(is_meaningful_ai_message(Some(
            "Model 'foo' not available on this provider"
        )));
        assert!(is_meaningful_ai_message(Some("Rate limit exceeded")));
    }

    #[test]
    fn meaningful_trims_before_checking_prefix() {
        // Leading whitespace must not bypass the rejection.
        assert!(!is_meaningful_ai_message(Some("   AI_APICallError")));
        assert!(!is_meaningful_ai_message(Some("\t422")));
    }

    // ── format_stream_error ────────────────────────────────────────────

    #[test]
    fn format_stream_error_none_returns_default_system() {
        // No error info at all — TS path: `error not instanceof Error`.
        let (msg, ty) = format_stream_error(None, None);
        assert_eq!(msg, "An error occurred while processing your request.");
        assert_eq!(ty, StreamErrorType::System);
    }

    #[test]
    fn format_stream_error_plain_error_uses_error_prefix() {
        // No AI markers in toString → "Error: <msg>".
        let (msg, ty) = format_stream_error(
            Some("Error: file not found"),
            Some("file not found"),
        );
        assert_eq!(msg, "Error: file not found");
        assert_eq!(ty, StreamErrorType::System);
    }

    #[test]
    fn format_stream_error_plain_no_message_falls_through_to_default() {
        let (msg, ty) = format_stream_error(Some("Error"), None);
        assert_eq!(msg, "An error occurred while processing your request.");
        assert_eq!(ty, StreamErrorType::System);
    }

    #[test]
    fn format_stream_error_ai_api_with_meaningful_message() {
        // AI marker present + meaningful message → "AI Error: <msg>".
        let to_string = "AI_APICallError: rate limit exceeded";
        let message = "rate limit exceeded";
        let (msg, ty) = format_stream_error(Some(to_string), Some(message));
        assert_eq!(msg, "AI Error: rate limit exceeded");
        assert_eq!(ty, StreamErrorType::AiApi);
    }

    #[test]
    fn format_stream_error_ai_api_extracts_provider_and_raw() {
        // AI marker present + non-meaningful message → regex extraction.
        let to_string = r#"AI_APICallError: Provider returned error {"provider_name":"openrouter","raw":"context window exceeded"}"#;
        let message = "AI_APICallError: Provider returned error";
        let (msg, ty) = format_stream_error(Some(to_string), Some(message));
        assert_eq!(
            msg,
            "Failed to process request with openrouter. The AI service returned an error. Details: context window exceeded"
        );
        assert_eq!(ty, StreamErrorType::AiApi);
    }

    #[test]
    fn format_stream_error_ai_api_falls_back_when_no_provider_match() {
        let to_string = "AI_APICallError: something broke";
        let message = "AI_APICallError: something broke";
        let (msg, ty) = format_stream_error(Some(to_string), Some(message));
        assert_eq!(
            msg,
            "Failed to process request with AI provider. The AI service returned an error."
        );
        assert_eq!(ty, StreamErrorType::AiApi);
    }

    #[test]
    fn format_stream_error_ai_api_only_provider_no_raw() {
        let to_string = r#"AI_APICallError: {"provider_name":"anthropic"}"#;
        let message = "AI_APICallError: details";
        let (msg, _) = format_stream_error(Some(to_string), Some(message));
        assert_eq!(
            msg,
            "Failed to process request with anthropic. The AI service returned an error."
        );
    }

    #[test]
    fn format_stream_error_recognises_all_four_markers() {
        for marker in [
            "AI_APICallError",
            "Provider returned error",
            "422",
            "openrouter",
        ] {
            let to_string = format!("Error: {marker} happened");
            let (_, ty) = format_stream_error(Some(&to_string), Some("x"));
            assert_eq!(
                ty,
                StreamErrorType::AiApi,
                "marker {marker:?} should flip to ai_api"
            );
        }
    }

    #[test]
    fn stream_error_type_str_matches_ts_literals() {
        assert_eq!(StreamErrorType::System.as_str(), "system");
        assert_eq!(StreamErrorType::AiApi.as_str(), "ai_api");
    }

    // ── extract_quoted_field ───────────────────────────────────────────

    #[test]
    fn extract_quoted_field_finds_simple_value() {
        let raw = r#"{"provider_name":"openrouter","raw":"x"}"#;
        assert_eq!(
            extract_quoted_field(raw, "provider_name").as_deref(),
            Some("openrouter")
        );
        assert_eq!(extract_quoted_field(raw, "raw").as_deref(), Some("x"));
    }

    #[test]
    fn extract_quoted_field_returns_none_on_miss() {
        assert!(extract_quoted_field("plain text", "anything").is_none());
        assert!(extract_quoted_field(r#"{"other":"val"}"#, "missing").is_none());
    }

    #[test]
    fn extract_quoted_field_accepts_dashes_and_dots_in_value() {
        let raw = r#"{"provider_name":"open-router-v2.1"}"#;
        assert_eq!(
            extract_quoted_field(raw, "provider_name").as_deref(),
            Some("open-router-v2.1")
        );
    }

    #[test]
    fn extract_quoted_field_empty_value_does_not_match() {
        // `[^"]+` requires at least one char — empty values don't match.
        let raw = r#"{"raw":""}"#;
        assert!(extract_quoted_field(raw, "raw").is_none());
    }
}
