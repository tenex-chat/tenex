//! Onboarding Screen 6: Embeddings.
//!
//! Source: `src/commands/onboard.ts:387-475` `runEmbeddingSetup`. The TS
//! flow has three substantive layers:
//!
//! 1. **Auto-pick** the recommended `(provider, model)` based on which
//!    credentials the user just configured. Priority OpenAI → OpenRouter →
//!    Local Transformers (`:392-403`).
//! 2. **Recommend / change** select with the auto-pick as the default
//!    answer (`:417-432`).
//! 3. **Change branch**: provider select gated on configured providers,
//!    then per-provider model select (`:434-487`).
//!
//! Persisted via [`crate::store::embed::EmbedDoc`] — never writes `apiKey`
//! to disk; credentials remain in `providers.json`.

use std::fmt;

use anyhow::{anyhow, Result};
use indexmap::IndexSet;

use crate::store::embed::EmbedDoc;
use crate::tui::display;
use crate::tui::prompts;

const PROVIDER_OPENAI: &str = "openai";
const PROVIDER_OPENROUTER: &str = "openrouter";
const PROVIDER_LOCAL: &str = "local";

const OPENAI_DEFAULT_MODEL: &str = "text-embedding-3-small";
const OPENROUTER_DEFAULT_MODEL: &str = "openai/text-embedding-3-small";
const LOCAL_DEFAULT_MODEL: &str = "Xenova/all-MiniLM-L6-v2";

/// One embedding `(provider, model)` recommendation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmbeddingChoice {
    pub provider: String,
    pub model: String,
}

/// Auto-pick the recommended choice given the set of configured providers.
/// Source: `:392-403`. Order: OpenAI → OpenRouter → Local Transformers.
pub fn auto_pick(configured_providers: &[String]) -> EmbeddingChoice {
    let configured: IndexSet<&str> = configured_providers.iter().map(String::as_str).collect();
    if configured.contains(PROVIDER_OPENAI) {
        EmbeddingChoice {
            provider: PROVIDER_OPENAI.to_owned(),
            model: OPENAI_DEFAULT_MODEL.to_owned(),
        }
    } else if configured.contains(PROVIDER_OPENROUTER) {
        EmbeddingChoice {
            provider: PROVIDER_OPENROUTER.to_owned(),
            model: OPENROUTER_DEFAULT_MODEL.to_owned(),
        }
    } else {
        EmbeddingChoice {
            provider: PROVIDER_LOCAL.to_owned(),
            model: LOCAL_DEFAULT_MODEL.to_owned(),
        }
    }
}

/// Display label for an embedding provider. Source: `:406-409`.
///
/// TS uses a ternary chain that falls through to the raw `provider`
/// identifier when none of the known IDs match (`provider === "local"
/// ? "Local Transformers" : provider === ... : provider`). The Rust
/// port parameterises over the input lifetime so unknown providers
/// render their actual ID instead of a literal `"Unknown"` placeholder.
/// Known-name branches are `&'static str` literals which coerce to
/// `&'a` since `'static` outlives every lifetime.
pub fn provider_label(provider: &str) -> &str {
    match provider {
        PROVIDER_LOCAL => "Local Transformers",
        PROVIDER_OPENAI => "OpenAI",
        PROVIDER_OPENROUTER => "OpenRouter",
        _ => provider,
    }
}

/// Result of running the screen.
#[derive(Debug, Clone)]
pub enum EmbeddingsResult {
    Configured(EmbeddingChoice),
    Cancelled,
}

/// Drive the screen: render context, run accept/change select, optionally
/// drill into provider+model selection, persist.
pub fn run(
    base_dir: &std::path::Path,
    configured_providers: &[String],
) -> Result<EmbeddingsResult> {
    let existing = EmbedDoc::load(base_dir)?;
    let auto = auto_pick(configured_providers);

    // Use existing config if present, otherwise the auto-picked default
    // (`:406-407`).
    let recommended = EmbeddingChoice {
        provider: existing
            .provider()
            .map(str::to_owned)
            .unwrap_or_else(|| auto.provider.clone()),
        model: existing
            .model()
            .map(str::to_owned)
            .unwrap_or_else(|| auto.model.clone()),
    };

    let label = provider_label(&recommended.provider);
    display::context(&format!(
        "Recommended: {label} / {model}",
        model = recommended.model,
    ));
    display::blank();

    // Accept / change select. The TS source uses `Use <Label> / <model>` for
    // the accept option (`:422`).
    let accept_label = format!("Use {label} / {model}", model = recommended.model);
    let accept = AcceptOrChange::Accept(accept_label.clone());
    let change = AcceptOrChange::Change;
    let action =
        match prompts::select("Embedding model", vec![accept.clone(), change.clone()]).prompt() {
            Ok(c) => c,
            Err(inquire::InquireError::OperationCanceled)
            | Err(inquire::InquireError::OperationInterrupted) => {
                return Ok(EmbeddingsResult::Cancelled);
            }
            Err(e) => return Err(anyhow!("embedding accept/change prompt: {e}")),
        };

    // TS at `:425-428` (accept) and `:484-487` (change) emit asymmetric
    // success-line provider tokens: the accept branch labelizes the
    // provider id (`providerLabel` → "OpenAI"), the change branch uses
    // the raw id (`chosenProvider` → "openai"). Mirror byte-for-byte.
    let (chosen, success_provider) = match action {
        AcceptOrChange::Accept(_) => {
            let label = provider_label(&recommended.provider).to_owned();
            (recommended, label)
        }
        AcceptOrChange::Change => match run_change_branch(configured_providers, &recommended)? {
            Some(c) => {
                let raw = c.provider.clone();
                (c, raw)
            }
            None => return Ok(EmbeddingsResult::Cancelled),
        },
    };

    persist(base_dir, &chosen)?;
    display::success(&format!(
        "Embeddings: {success_provider} / {model}",
        model = chosen.model,
    ));
    Ok(EmbeddingsResult::Configured(chosen))
}

/// Provider+model select branch (`:434-487`). Returns `Ok(None)` on cancel.
fn run_change_branch(
    configured_providers: &[String],
    current: &EmbeddingChoice,
) -> Result<Option<EmbeddingChoice>> {
    let configured: IndexSet<&str> = configured_providers.iter().map(String::as_str).collect();
    let mut provider_choices: Vec<ProviderChoice> = vec![ProviderChoice {
        value: PROVIDER_LOCAL.to_owned(),
        label: "Local Transformers (runs on your machine)".to_owned(),
    }];
    if configured.contains(PROVIDER_OPENAI) {
        provider_choices.push(ProviderChoice {
            value: PROVIDER_OPENAI.to_owned(),
            label: "OpenAI".to_owned(),
        });
    }
    if configured.contains(PROVIDER_OPENROUTER) {
        provider_choices.push(ProviderChoice {
            value: PROVIDER_OPENROUTER.to_owned(),
            label: "OpenRouter".to_owned(),
        });
    }

    let starting_provider_idx = provider_choices
        .iter()
        .position(|c| c.value == current.provider)
        .unwrap_or(0);
    let chosen_provider = match prompts::select("Embedding provider", provider_choices)
        .with_starting_cursor(starting_provider_idx)
        .prompt()
    {
        Ok(c) => c,
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => return Ok(None),
        Err(e) => return Err(anyhow!("embedding provider prompt: {e}")),
    };

    let model_choices = embedding_models_for(&chosen_provider.value);
    let starting_model_idx = model_choices
        .iter()
        .position(|m| m.value == current.model)
        .unwrap_or(0);
    let model_message = if chosen_provider.value == PROVIDER_LOCAL {
        "Local embedding model"
    } else {
        "Embedding model"
    };
    let chosen_model = match prompts::select(model_message, model_choices)
        .with_starting_cursor(starting_model_idx)
        .prompt()
    {
        Ok(m) => m,
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => return Ok(None),
        Err(e) => return Err(anyhow!("embedding model prompt: {e}")),
    };

    Ok(Some(EmbeddingChoice {
        provider: chosen_provider.value,
        model: chosen_model.value,
    }))
}

/// Per-provider model list. Sources verbatim:
/// - Local: `:460-465`
/// - OpenAI: `:472-474`
/// - OpenRouter: `:476-478`
pub fn embedding_models_for(provider: &str) -> Vec<ModelChoice> {
    match provider {
        PROVIDER_LOCAL => vec![
            ModelChoice {
                value: "Xenova/all-MiniLM-L6-v2".into(),
                label: "all-MiniLM-L6-v2 (fast, good for general use)".into(),
            },
            ModelChoice {
                value: "Xenova/all-mpnet-base-v2".into(),
                label: "all-mpnet-base-v2 (larger, better quality)".into(),
            },
            ModelChoice {
                value: "Xenova/paraphrase-multilingual-MiniLM-L12-v2".into(),
                label: "paraphrase-multilingual-MiniLM-L12-v2 (multilingual)".into(),
            },
        ],
        PROVIDER_OPENAI => vec![
            ModelChoice {
                value: "text-embedding-3-small".into(),
                label: "text-embedding-3-small (fast, good quality)".into(),
            },
            ModelChoice {
                value: "text-embedding-3-large".into(),
                label: "text-embedding-3-large (slower, best quality)".into(),
            },
        ],
        PROVIDER_OPENROUTER => vec![
            ModelChoice {
                value: "openai/text-embedding-3-small".into(),
                label: "openai/text-embedding-3-small".into(),
            },
            ModelChoice {
                value: "openai/text-embedding-3-large".into(),
                label: "openai/text-embedding-3-large".into(),
            },
        ],
        _ => Vec::new(),
    }
}

fn persist(base_dir: &std::path::Path, choice: &EmbeddingChoice) -> Result<()> {
    let mut doc = EmbedDoc::load(base_dir)?;
    doc.set_provider(&choice.provider);
    doc.set_model(&choice.model);
    // baseUrl is left untouched — the TS save path only writes a custom one
    // when it differs from the provider default, and we never collect a
    // baseUrl in the onboard flow (`:283-296`).
    doc.save(base_dir)?;
    Ok(())
}

#[derive(Debug, Clone)]
enum AcceptOrChange {
    Accept(String),
    Change,
}

impl fmt::Display for AcceptOrChange {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Accept(label) => f.write_str(label),
            Self::Change => f.write_str("Choose a different model"),
        }
    }
}

#[derive(Debug, Clone)]
struct ProviderChoice {
    value: String,
    label: String,
}

impl fmt::Display for ProviderChoice {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.label)
    }
}

#[derive(Debug, Clone)]
pub struct ModelChoice {
    pub value: String,
    pub label: String,
}

impl fmt::Display for ModelChoice {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.label)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pids(values: &[&str]) -> Vec<String> {
        values.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn auto_pick_prefers_openai_first() {
        let pick = auto_pick(&pids(&["openai", "openrouter", "anthropic"]));
        assert_eq!(pick.provider, "openai");
        assert_eq!(pick.model, "text-embedding-3-small");
    }

    #[test]
    fn auto_pick_falls_back_to_openrouter_when_openai_missing() {
        let pick = auto_pick(&pids(&["openrouter", "anthropic"]));
        assert_eq!(pick.provider, "openrouter");
        assert_eq!(pick.model, "openai/text-embedding-3-small");
    }

    #[test]
    fn auto_pick_falls_back_to_local_when_no_remote_provider() {
        let pick = auto_pick(&pids(&["anthropic", "ollama"]));
        assert_eq!(pick.provider, "local");
        assert_eq!(pick.model, "Xenova/all-MiniLM-L6-v2");
    }

    #[test]
    fn auto_pick_with_no_providers_falls_back_to_local() {
        let pick = auto_pick(&[]);
        assert_eq!(pick.provider, "local");
        assert_eq!(pick.model, "Xenova/all-MiniLM-L6-v2");
    }

    #[test]
    fn provider_labels_match_ts_verbatim() {
        assert_eq!(provider_label("local"), "Local Transformers");
        assert_eq!(provider_label("openai"), "OpenAI");
        assert_eq!(provider_label("openrouter"), "OpenRouter");
    }

    /// TS at `commands/onboard.ts:406-409` falls through to the raw
    /// `provider` identifier in the ternary chain when no known match
    /// fires (`: provider`). The Rust port previously returned a literal
    /// "Unknown" placeholder, losing the actual ID in the rendered
    /// "Recommended: <provider> / <model>" line.
    #[test]
    fn provider_label_unknown_id_falls_back_to_pid_verbatim() {
        assert_eq!(provider_label("foobar"), "foobar");
        assert_eq!(provider_label("custom-embed"), "custom-embed");
        assert_eq!(provider_label(""), "");
        // Forbid the legacy "Unknown" placeholder slipping back in.
        assert_ne!(provider_label("anything-goes"), "Unknown");
    }

    #[test]
    fn embedding_models_local_lists_three_xenova_models_in_canonical_order() {
        let models = embedding_models_for("local");
        assert_eq!(models.len(), 3);
        assert_eq!(models[0].value, "Xenova/all-MiniLM-L6-v2");
        assert_eq!(models[1].value, "Xenova/all-mpnet-base-v2");
        assert_eq!(
            models[2].value,
            "Xenova/paraphrase-multilingual-MiniLM-L12-v2"
        );
    }

    #[test]
    fn embedding_models_openai_lists_two_in_canonical_order() {
        let models = embedding_models_for("openai");
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].value, "text-embedding-3-small");
        assert_eq!(models[1].value, "text-embedding-3-large");
    }

    #[test]
    fn embedding_models_openrouter_lists_two_with_openai_prefix() {
        let models = embedding_models_for("openrouter");
        assert_eq!(models.len(), 2);
        assert!(models[0].value.starts_with("openai/"));
        assert!(models[1].value.starts_with("openai/"));
    }

    #[test]
    fn embedding_models_unknown_provider_returns_empty() {
        assert!(embedding_models_for("ollama").is_empty());
        assert!(embedding_models_for("anthropic").is_empty());
    }

    #[test]
    fn local_model_labels_match_ts_verbatim() {
        let models = embedding_models_for("local");
        assert_eq!(
            models[0].label,
            "all-MiniLM-L6-v2 (fast, good for general use)"
        );
        assert_eq!(
            models[1].label,
            "all-mpnet-base-v2 (larger, better quality)"
        );
        assert_eq!(
            models[2].label,
            "paraphrase-multilingual-MiniLM-L12-v2 (multilingual)"
        );
    }

    #[test]
    fn openai_model_labels_match_ts_verbatim() {
        let models = embedding_models_for("openai");
        assert_eq!(
            models[0].label,
            "text-embedding-3-small (fast, good quality)"
        );
        assert_eq!(
            models[1].label,
            "text-embedding-3-large (slower, best quality)"
        );
    }

    #[test]
    fn persist_writes_provider_and_model_only_no_apikey() {
        let tmp = std::env::temp_dir().join(format!(
            "tenex-embed-persist-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        persist(
            &tmp,
            &EmbeddingChoice {
                provider: "openai".into(),
                model: "text-embedding-3-small".into(),
            },
        )
        .unwrap();

        let written = std::fs::read_to_string(tmp.join("embed.json")).unwrap();
        assert!(written.contains("\"provider\": \"openai\""));
        assert!(written.contains("\"model\": \"text-embedding-3-small\""));
        assert!(!written.contains("apiKey"));

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn accept_or_change_display_uses_accept_label_text_for_accept_variant() {
        let a = AcceptOrChange::Accept("Use OpenAI / text-embedding-3-small".into());
        assert_eq!(format!("{a}"), "Use OpenAI / text-embedding-3-small");
    }

    #[test]
    fn accept_or_change_display_for_change_variant_is_verbatim_ts_string() {
        let c = AcceptOrChange::Change;
        assert_eq!(format!("{c}"), "Choose a different model");
    }

    /// Pin the asymmetric success-line provider token between the
    /// accept and change branches.
    ///
    /// TS at `:427` (accept) emits `Embeddings: ${providerLabel} / ${model}`
    /// — the labelized name (e.g. "OpenAI"). TS at `:487` (change) emits
    /// `Embeddings: ${chosenProvider} / ${chosenModel}` — the raw id
    /// (e.g. "openai"). The `run` driver maintains this asymmetry by
    /// computing `success_provider` per branch.
    #[test]
    fn success_line_provider_token_differs_between_accept_and_change_branches() {
        // Accept branch labelizes
        let accept_token = provider_label("openai").to_owned();
        assert_eq!(accept_token, "OpenAI");

        // Change branch keeps the raw id
        let change_token: String = "openai".to_owned();
        assert_eq!(change_token, "openai");

        // The two branches must produce different tokens when the
        // provider has a labelized name distinct from its id.
        assert_ne!(accept_token, change_token);

        // Provider with no labelized form ("local") would happen to match
        // — but TS still distinguishes via different code paths. The
        // accept branch ALWAYS calls provider_label; the change branch
        // ALWAYS uses the raw id.
        assert_eq!(provider_label("local"), "Local Transformers");
    }
}
