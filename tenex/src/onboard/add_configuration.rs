//! Standard LLM configuration wizard + pure helpers.
//!
//! Source: `src/llm/utils/ConfigurationManager.ts:21-154`.
//!
//! Pure-helper source citations:
//!
//! - Provider filter (`configuredProviders`): `:22-27`.
//! - Name validation: `:127-129` (single-config) and `:185-187`
//!   (multi-modal). Identical validators — one helper here.
//! - Default config name format: `:118` `${provider}/${modelDisplayName ?? model}`.
//! - Multi-modal eligibility: `:160-169`. ≥2 standard configs required.
//!
//! Interactive driver: `pub fn run(base_dir)`.
//!
//! Model selection strategy by provider (TS uses per-provider API calls
//! that are not yet ported):
//!
//! - `claude-code`: static `CLAUDE_CODE_MODELS` list (3 aliases, no HTTP).
//! - `codex`:       hardcoded model list + effort select (no IPC yet).
//! - `anthropic`, `openai`: models.dev disk-cache picker; text-input when
//!   the cache is absent or returns no models for that provider.
//! - `openrouter`, `ollama`, others: text-input with provider-specific help.

use std::path::Path;

use anyhow::{anyhow, Result};
use inquire::InquireError;
use serde_json::Value;

use crate::store::llms::{LlmConfigKind, LlmsDoc, StandardConfig};
use crate::store::providers::ProvidersDoc;
use crate::tui::{display, prompts};

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
                let head = raw.split_whitespace().next().unwrap_or("");
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

// ── Interactive wizard ────────────────────────────────────────────────────────

/// A selectable model entry shown in the picker.
struct ModelChoice {
    /// The model ID to persist to `llms.json`.
    id: String,
    /// Human-readable label shown in the picker list.
    label: String,
}

impl std::fmt::Display for ModelChoice {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.label)
    }
}

/// Hardcoded Codex model options used when the Codex CLI IPC is not yet
/// available. Mirrors the shape of `listCodexModels()` output.
const CODEX_MODELS: &[(&str, bool)] = &[
    ("gpt-5.4", true),
    ("gpt-5.4-mini", false),
    ("gpt-5.1-codex-max", false),
    ("gpt-5.1-codex", false),
];

/// Prompt to select a model for the `claude-code` provider.
/// Returns `(model_id, display_name)`.
fn select_claude_code_model() -> Result<Option<(String, String)>> {
    use crate::onboard::claude_code_models::CLAUDE_CODE_MODELS;
    let choices: Vec<ModelChoice> = CLAUDE_CODE_MODELS
        .iter()
        .map(|m| ModelChoice {
            id: m.id.to_owned(),
            label: format!(
                "{} {} {}",
                m.display_name,
                crate::tui::theme::chalk_dim(&format!("({})", m.id)),
                crate::tui::theme::chalk_dim(&format!("— {}", m.description)),
            ),
        })
        .collect();

    match prompts::select("Select model:", choices).prompt() {
        Ok(c) => Ok(Some((c.id.clone(), c.id))),
        Err(InquireError::OperationCanceled | InquireError::OperationInterrupted) => Ok(None),
        Err(e) => Err(anyhow!("model select: {e}")),
    }
}

/// Prompt to select a Codex model + effort level.
/// Returns `(model_id, effort_override)`.
fn select_codex_model() -> Result<Option<(String, Option<String>)>> {
    let dim = |s: &str| crate::tui::theme::chalk_dim(s);
    let choices: Vec<ModelChoice> = CODEX_MODELS
        .iter()
        .map(|(id, is_default)| ModelChoice {
            id: (*id).to_owned(),
            label: if *is_default {
                format!("{} {}", id, dim("(default)"))
            } else {
                (*id).to_owned()
            },
        })
        .collect();

    let model = match prompts::select("Select Codex model:", choices).prompt() {
        Ok(c) => c.id,
        Err(InquireError::OperationCanceled | InquireError::OperationInterrupted) => {
            return Ok(None)
        }
        Err(e) => return Err(anyhow!("model select: {e}")),
    };

    let effort_choices = vec![
        "use model default",
        "low",
        "medium",
        "high",
        "xhigh",
    ];
    let effort = match prompts::select("Select effort:", effort_choices).prompt() {
        Ok("use model default") => None,
        Ok(e) => Some(e.to_owned()),
        Err(InquireError::OperationCanceled | InquireError::OperationInterrupted) => {
            return Ok(None)
        }
        Err(e) => return Err(anyhow!("effort select: {e}")),
    };

    Ok(Some((model, effort)))
}

/// Prompt to pick from a models.dev cache list for `provider`.
/// Returns `(model_id, display_name)`.
/// Falls back to text input when the cache is empty for this provider.
fn select_models_dev_model(
    provider: &str,
    base_dir: &Path,
) -> Result<Option<(String, String)>> {
    use crate::store::models_dev;
    let default_model = models_dev::default_model_for_provider(provider);

    // Try loading the models.dev cache.
    let cache_opt = models_dev::load_from_disk(base_dir).ok().flatten();
    if let Some(cache) = cache_opt {
        let models = models_dev::get_provider_models(&cache.data, provider);
        if !models.is_empty() {
            let choices: Vec<ModelChoice> = models
                .iter()
                .map(|m| {
                    let (name, id_seg, meta_seg) = models_dev::picker_label_segments(m);
                    ModelChoice {
                        id: m.id.clone(),
                        label: format!(
                            "{} {} {}",
                            name,
                            crate::tui::theme::chalk_dim(&id_seg),
                            crate::tui::theme::chalk_dim(&meta_seg),
                        )
                        .trim()
                        .to_owned(),
                    }
                })
                .collect();

            return match prompts::select("Select model:", choices).prompt() {
                Ok(c) => Ok(Some((c.id.clone(), c.id))),
                Err(InquireError::OperationCanceled | InquireError::OperationInterrupted) => {
                    Ok(None)
                }
                Err(e) => Err(anyhow!("model select: {e}")),
            };
        }
    }

    // Cache absent or empty for this provider — fall through to text input.
    let prompt = prompts::input("Model ID:")
        .with_help_message("e.g. claude-sonnet-4-6, gpt-4o");
    let result = if default_model.is_empty() {
        prompt.prompt()
    } else {
        prompt.with_default(default_model).prompt()
    };
    match result {
        Ok(m) => Ok(Some((m.clone(), m))),
        Err(InquireError::OperationCanceled | InquireError::OperationInterrupted) => Ok(None),
        Err(e) => Err(anyhow!("model input: {e}")),
    }
}

/// Prompt for a model ID via free-text input (used for openrouter, ollama,
/// and any provider that doesn't have a structured picker).
fn select_model_text_input(provider: &str) -> Result<Option<(String, String)>> {
    use crate::store::models_dev::default_model_for_provider;
    let default = default_model_for_provider(provider);
    let help = match provider {
        "openrouter" => "e.g. openai/gpt-4o, anthropic/claude-sonnet-4-6",
        "ollama" => "e.g. llama3.1:8b, mistral:latest",
        _ => "e.g. provider-model-id",
    };
    let prompt = prompts::input("Model ID:").with_help_message(help);
    let result = if default.is_empty() {
        prompt.prompt()
    } else {
        prompt.with_default(default).prompt()
    };
    match result {
        Ok(m) => Ok(Some((m.clone(), m))),
        Err(InquireError::OperationCanceled | InquireError::OperationInterrupted) => Ok(None),
        Err(e) => Err(anyhow!("model input: {e}")),
    }
}

/// Run the standard-configuration wizard against `<base_dir>/llms.json`.
///
/// Mirrors `addConfiguration` at `ConfigurationManager.ts:21-154`.
/// Returns `Ok(())` on success or user cancellation.
pub fn run(base_dir: &Path) -> Result<()> {
    let doc = LlmsDoc::load(base_dir)?;
    let providers_doc = ProvidersDoc::load(base_dir)?;
    let avail = configured_providers(&providers_doc);

    if avail.is_empty() {
        display::hint("No providers configured. Please configure API keys first.");
        display::context(
            "Run `tenex config providers` to add a provider before adding model configs.",
        );
        return Ok(());
    }

    display::blank();
    display::step(0, 0, "Add Configuration");
    display::blank();

    // Step 1: Provider selection.
    let provider_choices: Vec<ModelChoice> = avail
        .iter()
        .map(|p| ModelChoice {
            id: p.clone(),
            label: crate::store::provider_ids::provider_display_name(p).to_owned(),
        })
        .collect();

    let provider = match prompts::select("Select provider:", provider_choices).prompt() {
        Ok(c) => c.id,
        Err(InquireError::OperationCanceled | InquireError::OperationInterrupted) => {
            return Ok(())
        }
        Err(e) => return Err(anyhow!("provider select: {e}")),
    };

    // Step 2: Model selection (provider-dependent).
    let (model_id, model_display, effort_override) = match provider.as_str() {
        "claude-code" => match select_claude_code_model()? {
            Some((id, disp)) => (id, disp, None),
            None => return Ok(()),
        },
        "codex" => match select_codex_model()? {
            Some((id, effort)) => (id.clone(), id, effort),
            None => return Ok(()),
        },
        "anthropic" | "openai" => match select_models_dev_model(&provider, base_dir)? {
            Some((id, disp)) => (id, disp, None),
            None => return Ok(()),
        },
        _ => match select_model_text_input(&provider)? {
            Some((id, disp)) => (id, disp, None),
            None => return Ok(()),
        },
    };

    // Step 3: Configuration name.
    let default_name = default_config_name(&provider, &model_display);
    let existing = doc.config_names();
    let name = match prompts::input("Configuration name:")
        .with_default(&default_name)
        .with_validator(move |input: &str| {
            if input.trim().is_empty() {
                return Ok(inquire::validator::Validation::Invalid(
                    "Name is required".into(),
                ));
            }
            if existing.contains(&input.to_owned()) {
                return Ok(inquire::validator::Validation::Invalid(
                    "Configuration already exists".into(),
                ));
            }
            Ok(inquire::validator::Validation::Valid)
        })
        .prompt()
    {
        Ok(n) => n,
        Err(InquireError::OperationCanceled | InquireError::OperationInterrupted) => {
            return Ok(())
        }
        Err(e) => return Err(anyhow!("name input: {e}")),
    };

    // Step 4: Persist.
    let mut overrides: Vec<(String, Option<Value>)> = vec![];
    if let Some(eff) = effort_override {
        overrides.push(("effort".to_owned(), Some(Value::String(eff))));
    }
    let config = StandardConfig {
        provider: provider.clone(),
        model: model_id,
        overrides,
    };

    let mut doc = LlmsDoc::load(base_dir)?;
    let is_first = doc.default_config().is_none();
    doc.set_standard_config(&name, config);
    if is_first {
        doc.set_default_config(Some(name.clone()));
    }
    doc.save(base_dir)?;

    if is_first {
        display::success(&format!(
            "Configuration \"{name}\" created and set as default"
        ));
    } else {
        display::success(&format!("Configuration \"{name}\" created"));
    }

    Ok(())
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
        let doc =
            doc_with_providers(&[("openrouter", "k1"), ("anthropic", "k2"), ("openai", "k3")]);
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
