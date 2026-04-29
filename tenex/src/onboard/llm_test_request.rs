//! LLM connectivity-test request constants — the prompt, timeout, and
//! spinner protocol. Mirrors `ConfigurationTester.ts:42-68` and the
//! spinner block at `LLMConfigEditor.ts:39, 65-67, 148-150` byte-for-byte.
//!
//! Every constant in this module is part of the user-visible test
//! contract per spec doc 06 §2 + §3. The `llm_test_hints` sibling module
//! covers §6 (error rendering); together they define the full input/output
//! surface a future LLM-service substrate plugs into.

/// Hard-coded user-message content sent to the model. Spec doc 06 §2 +
/// `ConfigurationTester.ts:65-68`. Verbatim — no override flag, no
/// inquirer prompt, no validation.
pub const TEST_PROMPT: &str = "Say 'Hello, TENEX!' in exactly those words.";

/// Hard-coded message role for the test request. Spec doc 06 §2.
pub const TEST_PROMPT_ROLE: &str = "user";

/// Test request hard timeout (`Promise.race` 3rd leg at
/// `ConfigurationTester.ts:60-62`).
///
/// The timeout error literal `"timed out after 30s"` is matched
/// downstream by [`crate::onboard::llm_test_hints::map_error_to_hint`]
/// which falls through to the raw message — i.e. the user sees `"timed
/// out after 30s"` rather than one of the three canned hint strings.
pub const TEST_TIMEOUT_MS: u64 = 30_000;

/// Verbatim agent-name passed to `createService` per spec doc 06 §3.4.
/// Literal string, NOT slugified by the caller — the factory itself
/// slugifies (TS `LLMServiceFactory.ts:121-124`).
#[cfg(test)]
pub const TEST_AGENT_NAME: &str = "configuration-tester";

/// Spinner frames rendered while a test is in progress. Spec doc 06
/// §3.1, source: `LLMConfigEditor.ts:39`. Braille dots, 10 frames.
pub const SPINNER_FRAMES: &[&str] = &["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/// Spinner tick interval (`setInterval(…, 80)` at
/// `LLMConfigEditor.ts:65-67`). Yellow chalk; row format
/// `"<pfx><yellow frame> <highlight name>"`.
pub const SPINNER_TICK_MS: u64 = 80;

/// Verbatim error returned by `runConfigurationTest` when the request
/// happens to time out (`ConfigurationTester.ts:60-62`). Exposed as a
/// constant so tests can pin the literal — the `llm_test_hints` mapper
/// falls through to this raw message rather than mapping it to one of
/// the three canned hints.
pub const ERR_TIMED_OUT: &str = "timed out after 30s";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_prompt_matches_spec_verbatim() {
        // Source: spec doc 06 §2 / `ConfigurationTester.ts:65-68`.
        assert_eq!(TEST_PROMPT, "Say 'Hello, TENEX!' in exactly those words.");
        assert_eq!(TEST_PROMPT_ROLE, "user");
    }

    #[test]
    fn timeout_is_exactly_30_seconds() {
        // Source: spec doc 06 §3.3 — hard 30s.
        assert_eq!(TEST_TIMEOUT_MS, 30_000);
    }

    #[test]
    fn agent_name_literal_is_unmodified() {
        // Source: spec doc 06 §3.4. Note: spec calls out that the
        // factory slugifies — this Rust constant is the pre-slugified
        // input string the factory should accept.
        assert_eq!(TEST_AGENT_NAME, "configuration-tester");
    }

    #[test]
    fn spinner_frames_in_canonical_order() {
        // Source: `LLMConfigEditor.ts:39`. Each frame is a single Braille
        // codepoint in the U+2840-U+28FF range.
        assert_eq!(SPINNER_FRAMES.len(), 10);
        let expected: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
        for (i, frame) in SPINNER_FRAMES.iter().enumerate() {
            assert_eq!(*frame, expected[i]);
        }
    }

    #[test]
    fn spinner_tick_is_exactly_80ms() {
        assert_eq!(SPINNER_TICK_MS, 80);
    }

    #[test]
    fn timed_out_literal_matches_spec() {
        // Source: spec doc 06 §6.2 — the timeout falls through to the
        // raw error message, which is this exact string.
        assert_eq!(ERR_TIMED_OUT, "timed out after 30s");
    }

    #[test]
    fn timed_out_literal_is_not_mapped_to_a_hint() {
        // Cross-module sanity: the timeout literal must NOT be mapped
        // to one of the three hint strings — the user sees the raw
        // error per spec §6.2.
        use crate::onboard::llm_test_hints::map_error_to_hint;
        assert_eq!(map_error_to_hint(ERR_TIMED_OUT), ERR_TIMED_OUT);
    }
}
