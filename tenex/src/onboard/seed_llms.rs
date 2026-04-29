//! Onboarding Screen 4 (sub-step A): seed default LLM configurations.
//!
//! Source: `src/commands/onboard.ts:503-557` `seedDefaultLLMConfigs`. Pure
//! logic — given the set of provider IDs that have credentials configured,
//! pre-populate `llms.json` with sensible standard + meta-model defaults.
//!
//! Behaviours (TS lines cited in tests):
//!
//! - **Early-return** when `llms.json` already has configurations
//!   (`:507`) — never overwrite existing user-curated configs.
//! - **Anthropic present** (`:512-538`): inserts `Sonnet`
//!   (`anthropic/claude-sonnet-4-6`), `Opus` (`anthropic/claude-opus-4-6`),
//!   and a meta-model `Auto` with `fast → Sonnet` (keywords `quick, fast`)
//!   and `powerful → Opus` (keywords `think, ultrathink, ponder`,
//!   `default: "fast"`. Sets `default = "Auto"`.
//! - **OpenAI present** (`:540-548`): inserts `GPT-4o`
//!   (`openai/gpt-4o`). Sets `default = "GPT-4o"` only if no default
//!   was already assigned in the Anthropic branch.
//! - Returns the list of seeded entries — the caller renders one
//!   `display::success("Seeded: <name> (<detail>)")` line per entry per
//!   `:552-554`.

use crate::store::llms::{LlmsDoc, MetaConfig, MetaVariant, StandardConfig};

/// One seeded entry; the caller renders this as
/// `Seeded: <name> (<detail>)`. `detail` is `meta-model` for the `Auto`
/// entry and `<provider>/<model>` for standard entries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeededEntry {
    pub name: String,
    pub detail: String,
}

const PROVIDER_ID_ANTHROPIC: &str = "anthropic";
const PROVIDER_ID_OPENAI: &str = "openai";

/// Seed defaults into `doc` based on which providers have credentials.
/// No-op when `doc` already has at least one configuration. Returns the
/// new entries for the caller to render.
pub fn seed_default_llm_configs(provider_ids: &[String], doc: &mut LlmsDoc) -> Vec<SeededEntry> {
    if !doc.config_names().is_empty() {
        return Vec::new();
    }

    let has = |id: &str| provider_ids.iter().any(|p| p == id);
    let mut seeded: Vec<SeededEntry> = Vec::new();

    if has(PROVIDER_ID_ANTHROPIC) {
        doc.set_standard_config(
            "Sonnet",
            StandardConfig::new(PROVIDER_ID_ANTHROPIC, "claude-sonnet-4-6"),
        );
        doc.set_standard_config(
            "Opus",
            StandardConfig::new(PROVIDER_ID_ANTHROPIC, "claude-opus-4-6"),
        );
        doc.set_meta_config(
            "Auto",
            MetaConfig {
                variants: vec![
                    MetaVariant {
                        name: "fast".to_owned(),
                        model: "Sonnet".to_owned(),
                        keywords: Some(vec!["quick".to_owned(), "fast".to_owned()]),
                        description: Some("Fast, lightweight tasks".to_owned()),
                        system_prompt: None,
                    },
                    MetaVariant {
                        name: "powerful".to_owned(),
                        model: "Opus".to_owned(),
                        keywords: Some(vec![
                            "think".to_owned(),
                            "ultrathink".to_owned(),
                            "ponder".to_owned(),
                        ]),
                        description: Some("Most capable, complex reasoning".to_owned()),
                        system_prompt: None,
                    },
                ],
                default: "fast".to_owned(),
            },
        );
        doc.set_default_config(Some("Auto".to_owned()));

        seeded.push(SeededEntry {
            name: "Sonnet".to_owned(),
            detail: "anthropic/claude-sonnet-4-6".to_owned(),
        });
        seeded.push(SeededEntry {
            name: "Opus".to_owned(),
            detail: "anthropic/claude-opus-4-6".to_owned(),
        });
        seeded.push(SeededEntry {
            name: "Auto".to_owned(),
            detail: "meta-model".to_owned(),
        });
    }

    if has(PROVIDER_ID_OPENAI) {
        doc.set_standard_config("GPT-4o", StandardConfig::new(PROVIDER_ID_OPENAI, "gpt-4o"));
        if doc.default_config().is_none() {
            doc.set_default_config(Some("GPT-4o".to_owned()));
        }
        seeded.push(SeededEntry {
            name: "GPT-4o".to_owned(),
            detail: "openai/gpt-4o".to_owned(),
        });
    }

    seeded
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pids(values: &[&str]) -> Vec<String> {
        values.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn empty_providers_seeds_nothing() {
        let mut doc = LlmsDoc::new();
        let seeded = seed_default_llm_configs(&[], &mut doc);
        assert!(seeded.is_empty());
        assert!(doc.config_names().is_empty());
    }

    #[test]
    fn existing_configs_short_circuit_no_op() {
        let mut doc = LlmsDoc::new();
        doc.set_standard_config("user-cfg", StandardConfig::new("anthropic", "claude-foo"));
        let seeded = seed_default_llm_configs(&pids(&["anthropic", "openai"]), &mut doc);
        assert!(seeded.is_empty(), "expected no-op when user has configs");
        // The user's cfg is unchanged.
        let entry = doc.get("user-cfg").unwrap();
        assert_eq!(entry.provider(), Some("anthropic"));
        assert_eq!(entry.model(), Some("claude-foo"));
        // No defaults should be set when seed early-returns.
        assert!(doc.default_config().is_none());
    }

    #[test]
    fn anthropic_only_seeds_sonnet_opus_auto_with_default_auto() {
        let mut doc = LlmsDoc::new();
        let seeded = seed_default_llm_configs(&pids(&["anthropic"]), &mut doc);

        // Names + details verbatim.
        assert_eq!(seeded.len(), 3);
        assert_eq!(seeded[0].name, "Sonnet");
        assert_eq!(seeded[0].detail, "anthropic/claude-sonnet-4-6");
        assert_eq!(seeded[1].name, "Opus");
        assert_eq!(seeded[1].detail, "anthropic/claude-opus-4-6");
        assert_eq!(seeded[2].name, "Auto");
        assert_eq!(seeded[2].detail, "meta-model");

        // On-disk shape.
        assert_eq!(doc.config_names(), vec!["Sonnet", "Opus", "Auto"]);
        let sonnet = doc.get("Sonnet").unwrap();
        assert_eq!(sonnet.model(), Some("claude-sonnet-4-6"));
        let opus = doc.get("Opus").unwrap();
        assert_eq!(opus.model(), Some("claude-opus-4-6"));
        let auto = doc.get("Auto").unwrap();
        assert_eq!(auto.kind(), crate::store::llms::LlmConfigKind::Meta);
        assert_eq!(auto.meta_default_variant(), Some("fast"));
        assert_eq!(auto.variant_names(), vec!["fast", "powerful"]);
        assert_eq!(doc.default_config(), Some("Auto"));
    }

    #[test]
    fn auto_meta_variants_use_verbatim_keywords_and_descriptions() {
        let mut doc = LlmsDoc::new();
        let _ = seed_default_llm_configs(&pids(&["anthropic"]), &mut doc);
        let auto = doc.get("Auto").unwrap();

        let fast = auto.variant("fast").unwrap();
        assert_eq!(fast.model(), Some("Sonnet"));
        assert_eq!(fast.keywords(), vec!["quick", "fast"]);
        assert_eq!(fast.description(), Some("Fast, lightweight tasks"));

        let powerful = auto.variant("powerful").unwrap();
        assert_eq!(powerful.model(), Some("Opus"));
        assert_eq!(powerful.keywords(), vec!["think", "ultrathink", "ponder"]);
        assert_eq!(
            powerful.description(),
            Some("Most capable, complex reasoning")
        );
    }

    #[test]
    fn openai_only_seeds_gpt4o_with_default_gpt4o() {
        let mut doc = LlmsDoc::new();
        let seeded = seed_default_llm_configs(&pids(&["openai"]), &mut doc);
        assert_eq!(seeded.len(), 1);
        assert_eq!(seeded[0].name, "GPT-4o");
        assert_eq!(seeded[0].detail, "openai/gpt-4o");
        assert_eq!(doc.default_config(), Some("GPT-4o"));
    }

    #[test]
    fn both_anthropic_and_openai_keeps_auto_as_default() {
        // Per `:545-547`, when default already set by the Anthropic branch
        // OpenAI does NOT override.
        let mut doc = LlmsDoc::new();
        let seeded = seed_default_llm_configs(&pids(&["anthropic", "openai"]), &mut doc);
        assert_eq!(seeded.len(), 4);
        assert_eq!(doc.default_config(), Some("Auto"));
    }

    #[test]
    fn other_providers_do_not_seed() {
        // Per `:510-512` only Anthropic and OpenAI are seeded; Ollama,
        // OpenRouter, Codex, Claude Code never trigger a seed.
        let mut doc = LlmsDoc::new();
        let seeded = seed_default_llm_configs(
            &pids(&["openrouter", "ollama", "codex", "claude-code"]),
            &mut doc,
        );
        assert!(seeded.is_empty());
        assert!(doc.config_names().is_empty());
        assert!(doc.default_config().is_none());
    }

    #[test]
    fn standard_configs_have_correct_provider_and_model() {
        let mut doc = LlmsDoc::new();
        let _ = seed_default_llm_configs(&pids(&["anthropic", "openai"]), &mut doc);
        for (name, expected_provider, expected_model) in [
            ("Sonnet", "anthropic", "claude-sonnet-4-6"),
            ("Opus", "anthropic", "claude-opus-4-6"),
            ("GPT-4o", "openai", "gpt-4o"),
        ] {
            let entry = doc.get(name).unwrap_or_else(|| panic!("missing {name}"));
            assert_eq!(
                entry.provider(),
                Some(expected_provider),
                "provider for {name}"
            );
            assert_eq!(entry.model(), Some(expected_model), "model for {name}");
        }
    }

    #[test]
    fn meta_model_default_variant_is_fast() {
        let mut doc = LlmsDoc::new();
        let _ = seed_default_llm_configs(&pids(&["anthropic"]), &mut doc);
        let auto = doc.get("Auto").unwrap();
        assert_eq!(auto.meta_default_variant(), Some("fast"));
    }

    #[test]
    fn seeded_order_anthropic_before_openai() {
        let mut doc = LlmsDoc::new();
        let _ = seed_default_llm_configs(&pids(&["anthropic", "openai"]), &mut doc);
        // Insertion order on disk: Sonnet, Opus, Auto, GPT-4o.
        assert_eq!(doc.config_names(), vec!["Sonnet", "Opus", "Auto", "GPT-4o"]);
    }
}
