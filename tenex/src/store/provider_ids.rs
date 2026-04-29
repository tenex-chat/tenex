//! Canonical provider ID constants.
//!
//! Mirrors `src/llm/providers/provider-ids.ts` verbatim. These literal
//! strings are the on-disk identifiers in `providers.json` and the input
//! keys for [`crate::store::models_dev::map_to_models_dev_provider`].
//! Magic-string usage anywhere else is a bug.

/// `claude-code` — provider that wraps the Claude Code CLI client.
pub const CLAUDE_CODE: &str = "claude-code";

/// `codex` — provider that wraps the OpenAI Codex CLI.
pub const CODEX: &str = "codex";

/// `openrouter` — multi-model proxy provider.
pub const OPENROUTER: &str = "openrouter";

/// `anthropic` — direct Claude API.
pub const ANTHROPIC: &str = "anthropic";

/// `openai` — direct OpenAI API.
pub const OPENAI: &str = "openai";

/// `ollama` — local model serving via Ollama.
pub const OLLAMA: &str = "ollama";

/// `mock` — used by tests; never appears in real `providers.json`.
#[cfg(test)]
pub const MOCK: &str = "mock";

/// All known provider IDs. Source: `provider-ids.ts:9-15`. Used by
/// validation paths that reject unknown providers and by enumeration
/// flows in the LLM editor.
#[cfg(test)]
pub const ALL_PROVIDER_IDS: &[&str] = &[
    CLAUDE_CODE,
    CODEX,
    OPENROUTER,
    ANTHROPIC,
    OPENAI,
    OLLAMA,
    MOCK,
];

/// `is_known_provider_id(s)` — `true` iff `s` is one of the seven
/// canonical provider IDs.
#[cfg(test)]
pub fn is_known_provider_id(s: &str) -> bool {
    ALL_PROVIDER_IDS.contains(&s)
}

/// Mirror `getProviderDisplayName`
/// (`src/llm/utils/ProviderConfigUI.ts:14-24`).
///
/// Maps a provider ID to its user-facing label. Unknown / unmapped
/// providers fall through to the raw input — matches TS `names[provider]
/// || provider` at `:23`.
///
/// `mock` is intentionally NOT mapped; if it ever surfaced in the UI
/// (which shouldn't happen in production) the user would see literal
/// `"mock"`.
pub fn provider_display_name(provider: &str) -> &str {
    match provider {
        OPENROUTER => "OpenRouter (300+ models)",
        ANTHROPIC => "Anthropic (Claude)",
        OPENAI => "OpenAI (GPT)",
        OLLAMA => "Ollama (Local models)",
        CODEX => "Codex",
        CLAUDE_CODE => "Claude Code (Agents)",
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_constants_match_ts_verbatim() {
        // Source: provider-ids.ts:9-15.
        assert_eq!(CLAUDE_CODE, "claude-code");
        assert_eq!(CODEX, "codex");
        assert_eq!(OPENROUTER, "openrouter");
        assert_eq!(ANTHROPIC, "anthropic");
        assert_eq!(OPENAI, "openai");
        assert_eq!(OLLAMA, "ollama");
        assert_eq!(MOCK, "mock");
    }

    #[test]
    fn all_provider_ids_in_canonical_order() {
        // The TS object literal preserves declaration order under
        // `Object.values(PROVIDER_IDS)`. Pin it.
        assert_eq!(
            ALL_PROVIDER_IDS,
            &[
                "claude-code",
                "codex",
                "openrouter",
                "anthropic",
                "openai",
                "ollama",
                "mock"
            ]
        );
    }

    #[test]
    fn is_known_accepts_all_canonical_ids() {
        for id in ALL_PROVIDER_IDS {
            assert!(is_known_provider_id(id), "should accept: {id}");
        }
    }

    #[test]
    fn is_known_rejects_unknown_or_misspelled() {
        assert!(!is_known_provider_id(""));
        assert!(!is_known_provider_id("Anthropic")); // case-sensitive
        assert!(!is_known_provider_id("claude_code")); // underscore not dash
        assert!(!is_known_provider_id("claude code")); // space not dash
        assert!(!is_known_provider_id("openai-direct"));
    }

    #[test]
    fn provider_display_name_matches_ts_verbatim() {
        // Source: ProviderConfigUI.ts:14-24.
        assert_eq!(
            provider_display_name("openrouter"),
            "OpenRouter (300+ models)"
        );
        assert_eq!(provider_display_name("anthropic"), "Anthropic (Claude)");
        assert_eq!(provider_display_name("openai"), "OpenAI (GPT)");
        assert_eq!(provider_display_name("ollama"), "Ollama (Local models)");
        assert_eq!(provider_display_name("codex"), "Codex");
        assert_eq!(provider_display_name("claude-code"), "Claude Code (Agents)");
    }

    #[test]
    fn provider_display_name_falls_through_for_unknown_or_mock() {
        // Source: TS `names[provider] || provider` at :23.
        assert_eq!(provider_display_name("mock"), "mock");
        assert_eq!(provider_display_name("does-not-exist"), "does-not-exist");
        assert_eq!(provider_display_name(""), "");
    }
}
