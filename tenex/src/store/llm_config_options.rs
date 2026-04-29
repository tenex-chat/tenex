//! Codex-specific LLM configuration enum values.
//!
//! Mirrors the string-literal unions in `LLMConfiguration` at
//! `src/services/config/types.ts:269-296` and the matching zod
//! validators at `:345-365`.
//!
//! Five Codex-specific enum fields:
//! - `effort` (reasoning effort)
//! - `summary` (reasoning-summary detail)
//! - `personality` (system personality)
//! - `approvalPolicy` (execution approval policy)
//! - `sandboxPolicy` (sandbox policy)
//!
//! Each has a fixed canonical string set + a slice of all values for
//! enumeration in select prompts. `is_valid_*` validators reject unknown
//! input case-sensitively (matching zod's enum guard).
//!
//! These constants land ahead of the LLM-config-add flow so the
//! per-provider model + effort + personality select prompts can compose
//! cleanly when the model-list HTTP/SDK substrate ships.

/// `effort` — Codex reasoning-effort level.
/// Source: `types.ts:276` + zod `:352`.
pub const EFFORTS: &[&str] = &["none", "minimal", "low", "medium", "high", "xhigh"];

pub fn is_valid_effort(s: &str) -> bool {
    EFFORTS.contains(&s)
}

/// `summary` — Codex reasoning-summary detail.
/// Source: `types.ts:278` + zod (the schema).
pub const SUMMARIES: &[&str] = &["auto", "concise", "detailed", "none"];

pub fn is_valid_summary(s: &str) -> bool {
    SUMMARIES.contains(&s)
}

/// `personality` — Codex system personality.
/// Source: `types.ts:280` + zod `:354`.
pub const PERSONALITIES: &[&str] = &["none", "friendly", "pragmatic"];

pub fn is_valid_personality(s: &str) -> bool {
    PERSONALITIES.contains(&s)
}

/// `approvalPolicy` — Codex execution approval policy.
/// Source: `types.ts:282`.
pub const APPROVAL_POLICIES: &[&str] = &["untrusted", "on-failure", "on-request", "never"];

pub fn is_valid_approval_policy(s: &str) -> bool {
    APPROVAL_POLICIES.contains(&s)
}

/// `sandboxPolicy` — Codex sandbox policy.
/// Source: `types.ts:284`.
pub const SANDBOX_POLICIES: &[&str] = &["read-only", "workspace-write", "danger-full-access"];

pub fn is_valid_sandbox_policy(s: &str) -> bool {
    SANDBOX_POLICIES.contains(&s)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── effort ─────────────────────────────────────────────────────────

    #[test]
    fn effort_values_in_canonical_order() {
        // Source: types.ts:276 — `"none" | "minimal" | "low" | "medium" |
        // "high" | "xhigh"`. The zod enum at :352 preserves declaration
        // order, which doubles as the order shown in select prompts.
        assert_eq!(
            EFFORTS,
            &["none", "minimal", "low", "medium", "high", "xhigh"]
        );
    }

    #[test]
    fn effort_validator_accepts_canonical_values() {
        for v in EFFORTS {
            assert!(is_valid_effort(v), "should accept: {v}");
        }
    }

    #[test]
    fn effort_validator_rejects_unknown_or_misspelled() {
        // Note: spec uses "xhigh" (no separator), not "x-high" or "extreme".
        assert!(!is_valid_effort(""));
        assert!(!is_valid_effort("xhighhh"));
        assert!(!is_valid_effort("medium-high")); // plausible but not canonical
        assert!(!is_valid_effort("HIGH")); // case-sensitive
    }

    // ── summary ────────────────────────────────────────────────────────

    #[test]
    fn summary_values_in_canonical_order() {
        // Source: types.ts:278.
        assert_eq!(SUMMARIES, &["auto", "concise", "detailed", "none"]);
    }

    #[test]
    fn summary_validator_accepts_canonical_values() {
        for v in SUMMARIES {
            assert!(is_valid_summary(v), "should accept: {v}");
        }
    }

    #[test]
    fn summary_validator_rejects_unknown() {
        assert!(!is_valid_summary(""));
        assert!(!is_valid_summary("verbose"));
        assert!(!is_valid_summary("auto-detailed"));
    }

    // ── personality ────────────────────────────────────────────────────

    #[test]
    fn personality_values_in_canonical_order() {
        // Source: types.ts:280.
        assert_eq!(PERSONALITIES, &["none", "friendly", "pragmatic"]);
    }

    #[test]
    fn personality_validator_accepts_canonical_values() {
        for v in PERSONALITIES {
            assert!(is_valid_personality(v), "should accept: {v}");
        }
    }

    #[test]
    fn personality_validator_rejects_unknown() {
        assert!(!is_valid_personality(""));
        assert!(!is_valid_personality("formal"));
        assert!(!is_valid_personality("Friendly")); // case-sensitive
    }

    // ── approvalPolicy ─────────────────────────────────────────────────

    #[test]
    fn approval_policy_values_in_canonical_order() {
        // Source: types.ts:282.
        assert_eq!(
            APPROVAL_POLICIES,
            &["untrusted", "on-failure", "on-request", "never"]
        );
    }

    #[test]
    fn approval_policy_validator_accepts_canonical_values() {
        for v in APPROVAL_POLICIES {
            assert!(is_valid_approval_policy(v), "should accept: {v}");
        }
    }

    #[test]
    fn approval_policy_validator_rejects_unknown_or_underscore_form() {
        // Spec uses dashes, not underscores.
        assert!(!is_valid_approval_policy(""));
        assert!(!is_valid_approval_policy("on_request"));
        assert!(!is_valid_approval_policy("always"));
    }

    // ── sandboxPolicy ──────────────────────────────────────────────────

    #[test]
    fn sandbox_policy_values_in_canonical_order() {
        // Source: types.ts:284.
        assert_eq!(
            SANDBOX_POLICIES,
            &["read-only", "workspace-write", "danger-full-access"]
        );
    }

    #[test]
    fn sandbox_policy_validator_accepts_canonical_values() {
        for v in SANDBOX_POLICIES {
            assert!(is_valid_sandbox_policy(v), "should accept: {v}");
        }
    }

    #[test]
    fn sandbox_policy_validator_rejects_unknown() {
        assert!(!is_valid_sandbox_policy(""));
        assert!(!is_valid_sandbox_policy("readonly")); // missing dash
        assert!(!is_valid_sandbox_policy("read-write")); // not canonical
    }

    // ── disjointness ───────────────────────────────────────────────────

    #[test]
    fn effort_personality_share_none_literal_intentionally() {
        // Both `effort` and `personality` accept literal "none". This is
        // intentional in the TS source — they're independent enum
        // namespaces. Pin this so a future "unify" attempt is caught.
        assert!(is_valid_effort("none"));
        assert!(is_valid_personality("none"));
        assert!(is_valid_summary("none"));
        // But "none" is NOT in approval_policy or sandbox_policy.
        assert!(!is_valid_approval_policy("none"));
        assert!(!is_valid_sandbox_policy("none"));
    }
}
