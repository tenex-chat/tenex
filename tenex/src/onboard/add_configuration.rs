//! Pure helpers for the `addConfiguration` and `addMultiModalConfiguration`
//! flows. The interactive driver (which wires per-provider model
//! selectors — OpenRouter, Ollama, Codex, models.dev — together with
//! these helpers and the user-facing prompts) lands in subsequent
//! iterations as each model-list backend is ported.
//!
//! Source citations:
//!
//! - Provider filter (`configuredProviders`): `ConfigurationManager.ts:22-27`.
//! - Name validation: `:127-129` (single-config flow) and `:185-187`
//!   (multi-modal flow). The two prompts use *identical* validators —
//!   reproduced here in a single helper.
//! - Default config name format: `:118` `${provider}/${modelDisplayName ?? model}`.
//! - Multi-modal eligibility: `:160-169`. At least 2 standard (non-meta)
//!   configurations are required.

use crate::store::llms::{LlmConfigKind, LlmsDoc};
use crate::store::providers::ProvidersDoc;

/// Provider IDs that have a credential entry usable by `addConfiguration`.
/// Source: `ConfigurationManager.ts:22-27`. A provider qualifies when the
/// `apiKey` field has at least one real key (TS `hasApiKey == true`) OR
/// the explicit `"none"` sentinel used by `codex` / `claude-code`.
///
/// `ProviderEntry::api_keys` returns the raw apiKey field unfiltered, so
/// this helper applies the same filter as `getApiKeyEntries` at
/// `key-manager.ts:312-313`: drop entries whose first whitespace-split
/// token is empty or `"none"`.
pub fn configured_providers(doc: &ProvidersDoc) -> Vec<String> {
    doc.provider_ids()
        .into_iter()
        .filter(|pid| {
            let entry = match doc.get(pid) {
                Some(e) => e,
                None => return false,
            };
            let has_real = entry.api_keys().iter().any(|raw| {
                let head = raw.trim().split_whitespace().next().unwrap_or("");
                !head.is_empty() && head != "none"
            });
            if has_real {
                return true;
            }
            entry
                .raw()
                .get("apiKey")
                .and_then(|v| v.as_str())
                .map(str::trim)
                == Some("none")
        })
        .collect()
}

/// Validate a configuration name. Errors are byte-for-byte identical to
/// the TS source:
///
/// - `"Name is required"` (`:127, :185`)
/// - `"Configuration already exists"` (`:128, :186`)
pub fn validate_config_name(name: &str, doc: &LlmsDoc) -> Result<(), &'static str> {
    if name.trim().is_empty() {
        return Err("Name is required");
    }
    if doc.get(name).is_some() {
        return Err("Configuration already exists");
    }
    Ok(())
}

/// Build the default configuration name shown in the input prompt.
/// Source: `:118` `\`${provider}/${modelDisplayName || model}\``.
pub fn default_config_name(provider: &str, model_display: &str) -> String {
    format!("{provider}/{model_display}")
}

/// Count of standard (non-meta) configurations in `doc`. Used by the
/// multi-modal eligibility gate at `:160-169`.
pub fn standard_config_count(doc: &LlmsDoc) -> usize {
    doc.config_names()
        .into_iter()
        .filter(|name| match doc.get(name) {
            Some(e) => e.kind() != LlmConfigKind::Meta,
            None => false,
        })
        .count()
}

/// Names of standard (non-meta) configurations, in disk order. Used as
/// the variant-model selector pool in `addMultiModalConfiguration`.
pub fn standard_config_names(doc: &LlmsDoc) -> Vec<String> {
    doc.config_names()
        .into_iter()
        .filter(|name| match doc.get(name) {
            Some(e) => e.kind() != LlmConfigKind::Meta,
            None => false,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::llms::{MetaConfig, MetaVariant, StandardConfig};

    fn doc_with_providers(entries: &[(&str, &str)]) -> ProvidersDoc {
        let mut d = ProvidersDoc::new();
        for (pid, key) in entries {
            d.set_api_keys(pid, vec![(*key).to_owned()]);
        }
        d
    }

    // ---- configured_providers -------------------------------------------

    #[test]
    fn configured_providers_includes_real_keys() {
        let doc = doc_with_providers(&[("anthropic", "sk-ant-1"), ("openai", "sk-1")]);
        let mut got = configured_providers(&doc);
        got.sort();
        assert_eq!(got, vec!["anthropic".to_owned(), "openai".to_owned()]);
    }

    #[test]
    fn configured_providers_includes_none_sentinel() {
        let doc = doc_with_providers(&[("codex", "none"), ("claude-code", "none")]);
        let got = configured_providers(&doc);
        assert!(got.contains(&"codex".to_owned()));
        assert!(got.contains(&"claude-code".to_owned()));
    }

    #[test]
    fn configured_providers_excludes_empty_entries() {
        // An entry with an empty apiKey string is filtered out by
        // `entries()` and isn't a "none" sentinel either.
        let doc = doc_with_providers(&[("anthropic", "")]);
        assert!(configured_providers(&doc).is_empty());
    }

    #[test]
    fn configured_providers_preserves_disk_order() {
        let doc = doc_with_providers(&[
            ("openrouter", "k1"),
            ("anthropic", "k2"),
            ("openai", "k3"),
        ]);
        assert_eq!(
            configured_providers(&doc),
            vec!["openrouter", "anthropic", "openai"]
        );
    }

    // ---- validate_config_name ------------------------------------------

    #[test]
    fn validate_config_name_rejects_empty_with_ts_message() {
        let doc = LlmsDoc::new();
        assert_eq!(validate_config_name("", &doc), Err("Name is required"));
        assert_eq!(validate_config_name("   ", &doc), Err("Name is required"));
    }

    #[test]
    fn validate_config_name_rejects_existing_with_ts_message() {
        let mut doc = LlmsDoc::new();
        doc.set_standard_config("Sonnet", StandardConfig::new("anthropic", "x"));
        assert_eq!(
            validate_config_name("Sonnet", &doc),
            Err("Configuration already exists")
        );
    }

    #[test]
    fn validate_config_name_accepts_new_unique_name() {
        let doc = LlmsDoc::new();
        assert!(validate_config_name("New", &doc).is_ok());
    }

    #[test]
    fn validate_config_name_treats_whitespace_inside_as_valid() {
        // The TS validator only `trim()`s for the empty check; internal
        // whitespace is preserved as part of the name (matches `:127`).
        let doc = LlmsDoc::new();
        assert!(validate_config_name("Custom Name", &doc).is_ok());
    }

    // ---- default_config_name -------------------------------------------

    #[test]
    fn default_name_is_provider_slash_model() {
        assert_eq!(
            default_config_name("anthropic", "claude-sonnet-4-6"),
            "anthropic/claude-sonnet-4-6"
        );
    }

    #[test]
    fn default_name_uses_display_name_when_caller_passes_one() {
        // Per `:118`, `modelDisplayName || model` — the caller passes
        // whichever is meaningful for the user.
        assert_eq!(
            default_config_name("anthropic", "Claude Sonnet 4.6"),
            "anthropic/Claude Sonnet 4.6"
        );
    }

    // ---- standard_config_count + standard_config_names -----------------

    #[test]
    fn standard_count_zero_for_empty_doc() {
        let doc = LlmsDoc::new();
        assert_eq!(standard_config_count(&doc), 0);
        assert!(standard_config_names(&doc).is_empty());
    }

    #[test]
    fn standard_count_excludes_meta_configs() {
        let mut doc = LlmsDoc::new();
        doc.set_standard_config("Sonnet", StandardConfig::new("anthropic", "x"));
        doc.set_standard_config("Opus", StandardConfig::new("anthropic", "y"));
        doc.set_meta_config(
            "Auto",
            MetaConfig {
                variants: vec![MetaVariant {
                    name: "fast".into(),
                    model: "Sonnet".into(),
                    keywords: None,
                    description: None,
                    system_prompt: None,
                }],
                default: "fast".into(),
            },
        );
        assert_eq!(standard_config_count(&doc), 2);
        assert_eq!(standard_config_names(&doc), vec!["Sonnet", "Opus"]);
    }

    #[test]
    fn multi_modal_eligibility_requires_two_standard_configs() {
        // The TS gate at `:165` is `< 2`; helpers expose the count for
        // the driver to apply that condition.
        let mut doc = LlmsDoc::new();
        doc.set_standard_config("Only", StandardConfig::new("anthropic", "x"));
        assert!(standard_config_count(&doc) < 2);

        doc.set_standard_config("Second", StandardConfig::new("anthropic", "y"));
        assert!(standard_config_count(&doc) >= 2);
    }
}
