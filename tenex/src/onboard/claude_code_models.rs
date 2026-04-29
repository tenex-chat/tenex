//! Claude Code provider model aliases.
//!
//! Mirrors `src/llm/utils/claude-code-models.ts` verbatim. These three
//! aliases are resolved by the `ai-sdk-provider-claude-code` package to
//! actual Claude model versions; TENEX never sends a literal version
//! number for the Claude Code provider — only one of the three aliases.
//!
//! Consumed by the LLM-config-add flow in `tenex config llm` / onboarding
//! Step 4 when the user picks the `claude-code` provider — the model
//! select renders these three options as
//! `"<displayName> — <description>"`.

/// One Claude Code model option. Mirrors `ClaudeCodeModelOption`
/// (`claude-code-models.ts:8-12`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeCodeModelOption {
    pub id: &'static str,
    pub display_name: &'static str,
    pub description: &'static str,
}

/// Known Claude Code model aliases. Source: `claude-code-models.ts:17-33`.
/// Order matters — it is the order shown in the model-select prompt.
pub const CLAUDE_CODE_MODELS: &[ClaudeCodeModelOption] = &[
    ClaudeCodeModelOption {
        id: "sonnet",
        display_name: "Claude Sonnet",
        description: "Balanced performance and cost — recommended for most tasks",
    },
    ClaudeCodeModelOption {
        id: "opus",
        display_name: "Claude Opus",
        description: "Most capable — best for complex reasoning and coding",
    },
    ClaudeCodeModelOption {
        id: "haiku",
        display_name: "Claude Haiku",
        description: "Fastest and most cost-effective — best for simple tasks",
    },
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn three_aliases_in_canonical_order() {
        let ids: Vec<&str> = CLAUDE_CODE_MODELS.iter().map(|m| m.id).collect();
        assert_eq!(ids, vec!["sonnet", "opus", "haiku"]);
    }

    #[test]
    fn display_names_match_ts_verbatim() {
        let names: Vec<&str> = CLAUDE_CODE_MODELS.iter().map(|m| m.display_name).collect();
        assert_eq!(names, vec!["Claude Sonnet", "Claude Opus", "Claude Haiku"]);
    }

    #[test]
    fn descriptions_match_ts_verbatim() {
        // Pin every description verbatim — these are user-visible.
        assert_eq!(
            CLAUDE_CODE_MODELS[0].description,
            "Balanced performance and cost — recommended for most tasks"
        );
        assert_eq!(
            CLAUDE_CODE_MODELS[1].description,
            "Most capable — best for complex reasoning and coding"
        );
        assert_eq!(
            CLAUDE_CODE_MODELS[2].description,
            "Fastest and most cost-effective — best for simple tasks"
        );
    }

    #[test]
    fn descriptions_use_unicode_em_dash() {
        // The TS source uses `—` (U+2014). Pin it so a future
        // unicode-confusion edit (`--` or `-`) gets caught.
        for option in CLAUDE_CODE_MODELS {
            assert!(
                option.description.contains('—'),
                "expected em-dash in: {}",
                option.description
            );
        }
    }

    #[test]
    fn lookup_by_id_works() {
        // Convenience pin — when the LLM editor's add-flow lands it'll
        // need to map the user's selected id back to the option.
        let sonnet = CLAUDE_CODE_MODELS
            .iter()
            .find(|m| m.id == "sonnet")
            .unwrap();
        assert_eq!(sonnet.display_name, "Claude Sonnet");
    }
}
