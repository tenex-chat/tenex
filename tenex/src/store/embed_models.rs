//! Embedding-model catalog for `tenex config embed`.
//!
//! Source: `src/commands/config/embed.ts:14-50` — the three top-level
//! constants `EMBEDDING_CAPABLE_PROVIDERS`, `PROVIDER_DISPLAY_NAMES`,
//! and `EMBEDDING_MODELS`. These are pure data lookups consumed by
//! the standalone `tenex config embed` command (which is a separate
//! flow from `tenex onboard`'s Step 6 — see QUESTIONS.md).
//!
//! Important: this is the FULL list (3 OpenAI models including
//! ada-002, 3 OpenRouter models including ada-002, 4 Ollama models).
//! The onboard Step 6 flow has a smaller list (no ada-002, three
//! Xenova local models) and lives in `crate::onboard::embeddings` —
//! do not unify the two until the project-scope persistence and
//! Ollama embedding adapter substrates land.

/// One row in the picker. Mirrors the `{ name, value }` objects in the
/// TS source's `Array<{ name: string; value: string }>`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmbeddingModelChoice {
    /// Visible label (left side of the picker row).
    pub name: &'static str,
    /// Stable model ID persisted to disk.
    pub value: &'static str,
}

/// Mirror `EMBEDDING_CAPABLE_PROVIDERS` (`embed.ts:17-20`).
///
/// The two providers `tenex config embed` lets the user pick between
/// (in addition to ollama, which is a separate code-path). OpenAI and
/// OpenRouter both speak the OpenAI-compatible embeddings API.
pub const EMBEDDING_CAPABLE_PROVIDERS: &[&str] = &["openai", "openrouter"];

/// Mirror `PROVIDER_DISPLAY_NAMES` (`embed.ts:25-28`).
///
/// Note: this is *distinct* from the broader `provider_display_name`
/// in `crate::store::provider_ids` — that one returns the full
/// "OpenRouter (300+ models)" / "Anthropic (Claude)" flavour-text
/// labels. The embed flow uses bare provider names because the screen
/// already says "Embedding provider" — the flavour text would be
/// noise.
pub fn embed_provider_display_name(provider: &str) -> Option<&'static str> {
    match provider {
        "openai" => Some("OpenAI"),
        "openrouter" => Some("OpenRouter"),
        _ => None,
    }
}

/// Mirror `EMBEDDING_MODELS` (`embed.ts:33-50`).
///
/// Returns the canonical model list for a provider, in TS source
/// order. Empty for unknown providers.
///
/// Per-provider counts:
/// - `openai`: 3 (incl. `text-embedding-ada-002` legacy)
/// - `openrouter`: 3 (incl. `openai/text-embedding-ada-002`)
/// - `ollama`: 4 (`nomic-embed-text`, `mxbai-embed-large`, `all-minilm`,
///   `snowflake-arctic-embed`)
pub fn embedding_models(provider: &str) -> &'static [EmbeddingModelChoice] {
    match provider {
        "openai" => &OPENAI_MODELS,
        "openrouter" => &OPENROUTER_MODELS,
        "ollama" => &OLLAMA_MODELS,
        _ => &[],
    }
}

const OPENAI_MODELS: [EmbeddingModelChoice; 3] = [
    EmbeddingModelChoice {
        name: "text-embedding-3-small (fast, good quality)",
        value: "text-embedding-3-small",
    },
    EmbeddingModelChoice {
        name: "text-embedding-3-large (slower, best quality)",
        value: "text-embedding-3-large",
    },
    EmbeddingModelChoice {
        name: "text-embedding-ada-002 (legacy)",
        value: "text-embedding-ada-002",
    },
];

const OPENROUTER_MODELS: [EmbeddingModelChoice; 3] = [
    EmbeddingModelChoice {
        name: "openai/text-embedding-3-small",
        value: "openai/text-embedding-3-small",
    },
    EmbeddingModelChoice {
        name: "openai/text-embedding-3-large",
        value: "openai/text-embedding-3-large",
    },
    EmbeddingModelChoice {
        name: "openai/text-embedding-ada-002",
        value: "openai/text-embedding-ada-002",
    },
];

const OLLAMA_MODELS: [EmbeddingModelChoice; 4] = [
    EmbeddingModelChoice {
        name: "nomic-embed-text (recommended, 768-dim)",
        value: "nomic-embed-text",
    },
    EmbeddingModelChoice {
        name: "mxbai-embed-large (higher quality, 1024-dim)",
        value: "mxbai-embed-large",
    },
    EmbeddingModelChoice {
        name: "all-minilm (fast, 384-dim)",
        value: "all-minilm",
    },
    EmbeddingModelChoice {
        name: "snowflake-arctic-embed (high quality, 1024-dim)",
        value: "snowflake-arctic-embed",
    },
];

/// Local-transformer model catalog used by `tenex config embed` (the
/// `local` provider branch at `embed.ts:197-242`).
///
/// **Note**: this list intentionally diverges from the smaller list in
/// `crate::onboard::embeddings`:
/// - The first row's label is `(default, fast, good for general use)`
///   — the embed.ts version, NOT onboard.ts's `(fast, good for general use)`.
/// - The third row's label is `(multilingual support)` — the embed.ts
///   version, NOT onboard.ts's `(multilingual)`.
/// - This list includes a Custom-model sentinel row; onboard.ts has no
///   such row in its local picker.
///
/// Until the standalone `config embed` port lands, both flows live in
/// their respective files; do NOT unify until then.
pub const LOCAL_TRANSFORMER_MODELS: &[EmbeddingModelChoice] = &[
    EmbeddingModelChoice {
        name: "all-MiniLM-L6-v2 (default, fast, good for general use)",
        value: "Xenova/all-MiniLM-L6-v2",
    },
    EmbeddingModelChoice {
        name: "all-mpnet-base-v2 (larger, better quality)",
        value: "Xenova/all-mpnet-base-v2",
    },
    EmbeddingModelChoice {
        name: "paraphrase-multilingual-MiniLM-L12-v2 (multilingual support)",
        value: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
    },
    EmbeddingModelChoice {
        name: "Custom model (enter HuggingFace model ID)",
        value: "custom",
    },
];

/// Default local model used when nothing is configured. Mirror
/// `embed.ts:223` `existing?.model || "Xenova/all-MiniLM-L6-v2"`.
pub const LOCAL_DEFAULT_MODEL: &str = "Xenova/all-MiniLM-L6-v2";

/// Sentinel value emitted when the user picks the "Custom model" row.
/// Mirror `embed.ts:163,168,182,194,220,227` — TS uses the bare
/// string `"custom"`.
pub const CUSTOM_MODEL_SENTINEL: &str = "custom";

/// Mirror the row appended to OpenAI-compatible model lists when the
/// `Custom` option isn't already present (`embed.ts:162-169`).
///
/// Returns the canonical label/value the TS source emits for that row.
/// Distinct from the local-picker custom row label
/// (`Custom model (enter HuggingFace model ID)`) — this is the
/// non-local-provider version.
pub const CUSTOM_OPENAI_COMPATIBLE_ROW: EmbeddingModelChoice = EmbeddingModelChoice {
    name: "Enter custom model ID",
    value: CUSTOM_MODEL_SENTINEL,
};

/// Mirror the custom-model row appended to Ollama's picker
/// (`embed.ts:131`). Distinct label from the local + OpenAI-compatible
/// custom rows — the TS source uses three different labels even though
/// they all funnel to the same `"custom"` value.
pub const CUSTOM_OLLAMA_ROW: EmbeddingModelChoice = EmbeddingModelChoice {
    name: "Custom Ollama model",
    value: CUSTOM_MODEL_SENTINEL,
};

/// Default Ollama model. Mirror `embed.ts:139` —
/// `existing?.provider === provider ? existing?.model : "nomic-embed-text"`.
/// When the user is switching providers (or no existing config), the
/// picker pre-selects this row.
pub const OLLAMA_DEFAULT_MODEL: &str = "nomic-embed-text";

/// Default provider used when `existing?.provider` is absent. Mirror
/// `embed.ts:119` — `existing?.provider || "local"`.
pub const DEFAULT_PROVIDER: &str = "local";

/// The non-OpenAI-compatible top-rows of the provider picker. Mirror
/// `embed.ts:97-100` — exactly two entries in this order.
pub const TOP_PROVIDER_ROWS: &[EmbeddingModelChoice] = &[
    EmbeddingModelChoice {
        name: "Ollama (local, recommended)",
        value: "ollama",
    },
    EmbeddingModelChoice {
        name: "Local Transformers (in-process)",
        value: "local",
    },
];

/// Format the row label used for an OpenAI-compatible provider that's
/// already configured in `providers.json`. Mirror `embed.ts:104-108` —
/// `"${displayName} (configured)"`. Returns `None` for providers that
/// are NOT in `EMBEDDING_CAPABLE_PROVIDERS` (no display name → don't
/// render the row).
pub fn configured_provider_row_label(provider: &str) -> Option<String> {
    let display = embed_provider_display_name(provider)?;
    Some(format!("{display} (configured)"))
}

/// Verbatim prompt-message strings used by `tenex config embed`.
/// Pinned as a single module so future audits can sweep them in one
/// pass against the TS source.
pub mod prompt_strings {
    /// `embed.ts:90` — red error when no providers configured.
    pub const NO_PROVIDERS_ERROR: &str =
        "❌ No providers configured. Run `tenex config providers` before configuring embeddings.";

    /// `embed.ts:117` — top-level provider picker.
    pub const SELECT_PROVIDER_MESSAGE: &str = "Select embedding provider:";

    /// `embed.ts:137` — Ollama branch model picker.
    pub const SELECT_OLLAMA_MODEL_MESSAGE: &str = "Select Ollama embedding model:";

    /// `embed.ts:175` — OpenAI-compatible branch model picker, with
    /// the provider's display name interpolated. The full TS template
    /// is `Select ${displayName} embedding model:` — this constant is
    /// the wrapper without the interpolation; pair with
    /// `embed_provider_display_name`.
    pub const SELECT_PROVIDER_MODEL_PREFIX: &str = "Select ";
    pub const SELECT_PROVIDER_MODEL_SUFFIX: &str = " embedding model:";

    /// `embed.ts:203` — local-transformer branch model picker.
    pub const SELECT_LOCAL_MODEL_MESSAGE: &str = "Select local embedding model:";

    /// `embed.ts:149` — Ollama custom-model input.
    pub const ENTER_OLLAMA_MODEL_MESSAGE: &str = "Enter Ollama model name:";

    /// `embed.ts:187` — OpenAI-compatible custom-model input.
    pub const ENTER_MODEL_ID_MESSAGE: &str = "Enter model ID:";

    /// `embed.ts:233` — local-transformer custom-model input.
    pub const ENTER_HF_MODEL_ID_MESSAGE: &str =
        "Enter HuggingFace model ID (e.g., sentence-transformers/all-MiniLM-L6-v2):";

    /// `embed.ts:152` — Ollama custom-model validator failure.
    pub const VALIDATE_MODEL_NAME_EMPTY: &str = "Model name cannot be empty";

    /// `embed.ts:190, 236` — OpenAI-compatible + local custom-model
    /// validator failure. (Same message used in two branches.)
    pub const VALIDATE_MODEL_ID_EMPTY: &str = "Model ID cannot be empty";
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── EMBEDDING_CAPABLE_PROVIDERS ─────────────────────────────────────

    #[test]
    fn capable_providers_match_ts_in_order() {
        // Source: embed.ts:17-20 — exactly two entries, OpenAI then
        // OpenRouter. Don't add ollama here; the TS source uses a
        // separate code-path for the local provider.
        assert_eq!(EMBEDDING_CAPABLE_PROVIDERS, &["openai", "openrouter"]);
    }

    // ── embed_provider_display_name ─────────────────────────────────────

    #[test]
    fn display_name_returns_bare_label_for_known_providers() {
        assert_eq!(embed_provider_display_name("openai"), Some("OpenAI"));
        assert_eq!(
            embed_provider_display_name("openrouter"),
            Some("OpenRouter"),
        );
    }

    #[test]
    fn display_name_returns_none_for_unknown_or_local() {
        // The TS map only has openai + openrouter — anything else
        // (including ollama) returns undefined. Mirror with None.
        assert_eq!(embed_provider_display_name("ollama"), None);
        assert_eq!(embed_provider_display_name("anthropic"), None);
        assert_eq!(embed_provider_display_name("totally-unknown"), None);
        assert_eq!(embed_provider_display_name(""), None);
    }

    #[test]
    fn display_name_distinct_from_full_provider_label() {
        // Sanity: this map intentionally returns 'OpenAI', NOT
        // 'OpenAI (GPT)'. The full label belongs to the broader
        // provider_display_name in store::provider_ids; using it here
        // would be a regression.
        assert_eq!(embed_provider_display_name("openai"), Some("OpenAI"));
        // This is not a test of the OTHER function, but a pin: the
        // embed-flow display name for OpenAI must be exactly 6 chars,
        // not the full label.
        assert_eq!(embed_provider_display_name("openai").unwrap().len(), 6);
    }

    // ── embedding_models ────────────────────────────────────────────────

    #[test]
    fn openai_models_match_ts_verbatim() {
        let m = embedding_models("openai");
        assert_eq!(m.len(), 3);
        assert_eq!(m[0].value, "text-embedding-3-small");
        assert_eq!(m[0].name, "text-embedding-3-small (fast, good quality)");
        assert_eq!(m[1].value, "text-embedding-3-large");
        assert_eq!(m[1].name, "text-embedding-3-large (slower, best quality)");
        assert_eq!(m[2].value, "text-embedding-ada-002");
        assert_eq!(m[2].name, "text-embedding-ada-002 (legacy)");
    }

    #[test]
    fn openrouter_models_match_ts_verbatim() {
        let m = embedding_models("openrouter");
        assert_eq!(m.len(), 3);
        assert_eq!(m[0].value, "openai/text-embedding-3-small");
        assert_eq!(m[0].name, "openai/text-embedding-3-small");
        assert_eq!(m[1].value, "openai/text-embedding-3-large");
        assert_eq!(m[2].value, "openai/text-embedding-ada-002");
    }

    #[test]
    fn ollama_models_match_ts_verbatim() {
        let m = embedding_models("ollama");
        assert_eq!(m.len(), 4);
        // Order matters — TS lists them in this exact order.
        assert_eq!(m[0].value, "nomic-embed-text");
        assert_eq!(m[0].name, "nomic-embed-text (recommended, 768-dim)");
        assert_eq!(m[1].value, "mxbai-embed-large");
        assert_eq!(m[1].name, "mxbai-embed-large (higher quality, 1024-dim)");
        assert_eq!(m[2].value, "all-minilm");
        assert_eq!(m[2].name, "all-minilm (fast, 384-dim)");
        assert_eq!(m[3].value, "snowflake-arctic-embed");
        assert_eq!(m[3].name, "snowflake-arctic-embed (high quality, 1024-dim)");
    }

    #[test]
    fn embedding_models_returns_empty_for_unknown_provider() {
        assert!(embedding_models("anthropic").is_empty());
        assert!(embedding_models("codex").is_empty());
        assert!(embedding_models("claude-code").is_empty());
        assert!(embedding_models("").is_empty());
    }

    #[test]
    fn every_model_value_renders_inside_its_name() {
        // Light invariant: the picker's `name` ALWAYS contains the
        // `value` as a substring (TS template `${value} (...)` for
        // descriptive labels, or bare `value` for the openrouter rows).
        // Catches drift where someone updates one but not the other.
        for provider in ["openai", "openrouter", "ollama"] {
            for choice in embedding_models(provider) {
                assert!(
                    choice.name.contains(choice.value),
                    "label `{}` does not contain value `{}` for provider `{provider}`",
                    choice.name,
                    choice.value,
                );
            }
        }
    }

    // ── LOCAL_TRANSFORMER_MODELS ────────────────────────────────────────

    #[test]
    fn local_transformer_models_match_embed_ts_verbatim() {
        // Source: embed.ts:205-222. Four rows, in this exact order,
        // with the embed.ts-specific labels (NOT the onboard.ts
        // labels — those are intentionally different).
        let m = LOCAL_TRANSFORMER_MODELS;
        assert_eq!(m.len(), 4);
        assert_eq!(m[0].value, "Xenova/all-MiniLM-L6-v2");
        assert_eq!(m[0].name, "all-MiniLM-L6-v2 (default, fast, good for general use)");
        assert_eq!(m[1].value, "Xenova/all-mpnet-base-v2");
        assert_eq!(m[1].name, "all-mpnet-base-v2 (larger, better quality)");
        assert_eq!(m[2].value, "Xenova/paraphrase-multilingual-MiniLM-L12-v2");
        assert_eq!(
            m[2].name,
            "paraphrase-multilingual-MiniLM-L12-v2 (multilingual support)"
        );
        assert_eq!(m[3].value, "custom");
        assert_eq!(m[3].name, "Custom model (enter HuggingFace model ID)");
    }

    #[test]
    fn local_transformer_first_row_label_diverges_from_onboard_ts() {
        // Pin the divergence between the two TS flows so a future
        // unifier doesn't silently regress. embed.ts uses
        // 'all-MiniLM-L6-v2 (default, fast, good for general use)'
        // — note the leading 'default,' word. onboard.ts at
        // src/commands/onboard.ts:455 uses
        // 'all-MiniLM-L6-v2 (fast, good for general use)' (no 'default').
        assert!(LOCAL_TRANSFORMER_MODELS[0].name.contains("(default, fast"));
        // Sanity: the bare 'fast,' (without 'default,') only matches
        // because the substring 'default, fast' contains 'fast', so
        // we additionally pin the 'default,' part on its own.
        assert!(LOCAL_TRANSFORMER_MODELS[0].name.contains("default,"));
    }

    #[test]
    fn local_transformer_multilingual_row_diverges_from_onboard_ts() {
        // embed.ts: 'paraphrase-multilingual-MiniLM-L12-v2 (multilingual support)'
        // onboard.ts: 'paraphrase-multilingual-MiniLM-L12-v2 (multilingual)'
        // The 'support' suffix is unique to embed.ts.
        assert!(LOCAL_TRANSFORMER_MODELS[2].name.contains("(multilingual support)"));
    }

    // ── LOCAL_DEFAULT_MODEL ─────────────────────────────────────────────

    #[test]
    fn local_default_model_pins_to_xenova_all_minilm() {
        assert_eq!(LOCAL_DEFAULT_MODEL, "Xenova/all-MiniLM-L6-v2");
    }

    // ── CUSTOM_MODEL_SENTINEL ───────────────────────────────────────────

    #[test]
    fn custom_model_sentinel_is_bare_lowercase_string() {
        assert_eq!(CUSTOM_MODEL_SENTINEL, "custom");
    }

    // ── CUSTOM_OPENAI_COMPATIBLE_ROW ────────────────────────────────────

    #[test]
    fn custom_openai_compatible_row_label_is_distinct_from_local_label() {
        // The OpenAI-compatible custom row is the bare 'Enter custom
        // model ID' (embed.ts:163,168). The LOCAL list's custom row
        // is the longer 'Custom model (enter HuggingFace model ID)'
        // (embed.ts:219). Don't conflate them.
        assert_eq!(CUSTOM_OPENAI_COMPATIBLE_ROW.name, "Enter custom model ID");
        assert_eq!(CUSTOM_OPENAI_COMPATIBLE_ROW.value, "custom");
        // And it differs from the local picker's custom row.
        let local_custom = LOCAL_TRANSFORMER_MODELS
            .iter()
            .find(|m| m.value == CUSTOM_MODEL_SENTINEL)
            .unwrap();
        assert_ne!(CUSTOM_OPENAI_COMPATIBLE_ROW.name, local_custom.name);
    }

    // ── CUSTOM_OLLAMA_ROW ───────────────────────────────────────────────

    #[test]
    fn custom_ollama_row_has_distinct_label_from_other_custom_rows() {
        assert_eq!(CUSTOM_OLLAMA_ROW.name, "Custom Ollama model");
        assert_eq!(CUSTOM_OLLAMA_ROW.value, "custom");
        // Distinct from the other two custom-row labels.
        assert_ne!(CUSTOM_OLLAMA_ROW.name, CUSTOM_OPENAI_COMPATIBLE_ROW.name);
        let local_custom = LOCAL_TRANSFORMER_MODELS
            .iter()
            .find(|m| m.value == CUSTOM_MODEL_SENTINEL)
            .unwrap();
        assert_ne!(CUSTOM_OLLAMA_ROW.name, local_custom.name);
    }

    // ── default constants ───────────────────────────────────────────────

    #[test]
    fn defaults_match_ts_source() {
        // embed.ts:139 — Ollama default.
        assert_eq!(OLLAMA_DEFAULT_MODEL, "nomic-embed-text");
        // embed.ts:119 — provider default.
        assert_eq!(DEFAULT_PROVIDER, "local");
    }

    // ── TOP_PROVIDER_ROWS ───────────────────────────────────────────────

    #[test]
    fn top_provider_rows_match_ts_in_order() {
        // embed.ts:97-100 — exactly two entries, Ollama then Local
        // Transformers.
        assert_eq!(TOP_PROVIDER_ROWS.len(), 2);
        assert_eq!(TOP_PROVIDER_ROWS[0].name, "Ollama (local, recommended)");
        assert_eq!(TOP_PROVIDER_ROWS[0].value, "ollama");
        assert_eq!(TOP_PROVIDER_ROWS[1].name, "Local Transformers (in-process)");
        assert_eq!(TOP_PROVIDER_ROWS[1].value, "local");
    }

    // ── configured_provider_row_label ───────────────────────────────────

    #[test]
    fn configured_provider_row_label_uses_bare_display_name() {
        // embed.ts:104-108 — `${displayName} (configured)`.
        assert_eq!(
            configured_provider_row_label("openai").as_deref(),
            Some("OpenAI (configured)")
        );
        assert_eq!(
            configured_provider_row_label("openrouter").as_deref(),
            Some("OpenRouter (configured)")
        );
    }

    #[test]
    fn configured_provider_row_label_returns_none_for_non_capable_providers() {
        // The TS for-loop iterates EMBEDDING_CAPABLE_PROVIDERS only —
        // anthropic / codex / claude-code are never in that list, so
        // they don't produce a row. Mirror with None so the caller
        // skips them.
        assert!(configured_provider_row_label("anthropic").is_none());
        assert!(configured_provider_row_label("codex").is_none());
        assert!(configured_provider_row_label("claude-code").is_none());
        assert!(configured_provider_row_label("ollama").is_none());
    }

    // ── prompt_strings ─────────────────────────────────────────────────

    #[test]
    fn prompt_strings_match_ts_verbatim() {
        use prompt_strings::*;
        assert_eq!(
            NO_PROVIDERS_ERROR,
            "❌ No providers configured. Run `tenex config providers` before configuring embeddings."
        );
        assert_eq!(SELECT_PROVIDER_MESSAGE, "Select embedding provider:");
        assert_eq!(SELECT_OLLAMA_MODEL_MESSAGE, "Select Ollama embedding model:");
        assert_eq!(SELECT_LOCAL_MODEL_MESSAGE, "Select local embedding model:");
        assert_eq!(ENTER_OLLAMA_MODEL_MESSAGE, "Enter Ollama model name:");
        assert_eq!(ENTER_MODEL_ID_MESSAGE, "Enter model ID:");
        assert_eq!(
            ENTER_HF_MODEL_ID_MESSAGE,
            "Enter HuggingFace model ID (e.g., sentence-transformers/all-MiniLM-L6-v2):"
        );
        assert_eq!(VALIDATE_MODEL_NAME_EMPTY, "Model name cannot be empty");
        assert_eq!(VALIDATE_MODEL_ID_EMPTY, "Model ID cannot be empty");
    }

    #[test]
    fn select_provider_model_prefix_suffix_compose_to_ts_template() {
        // The TS template is `Select ${displayName} embedding model:`.
        // The two halves should compose with the display name in
        // between to produce that exact string.
        use prompt_strings::*;
        let composed =
            format!("{SELECT_PROVIDER_MODEL_PREFIX}OpenAI{SELECT_PROVIDER_MODEL_SUFFIX}");
        assert_eq!(composed, "Select OpenAI embedding model:");
    }

    #[test]
    fn validators_use_ts_specific_phrasing_per_branch() {
        // embed.ts uses TWO distinct validation messages: 'Model name'
        // for Ollama, 'Model ID' for OpenAI-compatible + local. Pin
        // the asymmetry so a future cleanup doesn't unify them.
        use prompt_strings::*;
        assert!(VALIDATE_MODEL_NAME_EMPTY.contains("name"));
        assert!(VALIDATE_MODEL_ID_EMPTY.contains("ID"));
        assert_ne!(VALIDATE_MODEL_NAME_EMPTY, VALIDATE_MODEL_ID_EMPTY);
    }
}
