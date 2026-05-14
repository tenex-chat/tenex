//! Onboarding-facing wrappers over the shared [`tenex_models_dev`] crate.
//!
//! The cache types, on-disk parsing, and `resolve_model_data` lookup live
//! in [`tenex_models_dev`] so agent runtimes can read them without pulling
//! in the rest of the supervisor. This module keeps the picker / default
//! / provider-listing helpers used by the onboarding TUI and re-exports
//! the shared types so existing call sites stay one import away.

#[allow(unused_imports)] // re-exported for `crate::store::models_dev::*` users; some are test-only
pub use tenex_models_dev::{
    load_from_disk, map_to_models_dev_provider, resolve_model_data, CacheData, ModelCost,
    ModelLimits, ModelsDevModel, ModelsDevResponse, ProviderModels,
};

/// Returns every model under the mapped provider's section, sorted by
/// `last_updated` descending (newest first). Empty for unmapped or
/// local-only providers (`ollama`, `codex`) and for providers absent
/// from the cache.
///
/// Empty `id`/`name` fields fall back to the map key (which is the
/// authoritative model ID for each entry).
///
/// Entries with a `last_updated` timestamp sort before those without
/// (descending order puts non-empty strings first).
pub fn get_provider_models(cache: &ModelsDevResponse, provider: &str) -> Vec<ModelsDevModel> {
    let Some(models_dev_provider) = map_to_models_dev_provider(provider) else {
        return Vec::new();
    };
    let Some(provider_data) = cache.get(models_dev_provider) else {
        return Vec::new();
    };

    let mut out: Vec<ModelsDevModel> = provider_data
        .models
        .iter()
        .map(|(model_id, data)| ModelsDevModel {
            id: if data.id.is_empty() {
                model_id.clone()
            } else {
                data.id.clone()
            },
            name: if data.name.is_empty() {
                model_id.clone()
            } else {
                data.name.clone()
            },
            cost: data.cost.clone(),
            limit: data.limit.clone(),
            modalities: data.modalities.clone(),
            last_updated: data.last_updated.clone(),
        })
        .collect();
    out.sort_by(|a, b| {
        let a_key = a.last_updated.as_deref().unwrap_or("");
        let b_key = b.last_updated.as_deref().unwrap_or("");
        b_key.cmp(a_key)
    });
    out
}

/// Returns the raw segments for one row of the model picker:
/// `(human_name, "(id)", "- {ctx}k ctx, ${input}/${output}/M")`.
///
/// The meta segment is empty when neither `limit.context` nor `cost`
/// is available. Callers wrap individual segments with style at render
/// time (the picker greys out the `(id)` and meta segments).
pub fn picker_label_segments(model: &ModelsDevModel) -> (String, String, String) {
    let id_segment = format!("({})", model.id);
    let ctx_str = model
        .limit
        .as_ref()
        .map(|l| format!("{}k ctx", (l.context as f64 / 1000.0).round() as u64));
    let pricing_str = model
        .cost
        .as_ref()
        .map(|c| format!("${}/${}/M", c.input, c.output));
    let meta_pieces: Vec<String> = [ctx_str, pricing_str].into_iter().flatten().collect();
    let meta_segment = if meta_pieces.is_empty() {
        String::new()
    } else {
        format!("- {}", meta_pieces.join(", "))
    };
    (model.name.clone(), id_segment, meta_segment)
}

/// Initial value of the model picker for a given provider.
///
/// Returns `""` for unknown providers and for `claude-code`, which has
/// no concept of a model in the source TS.
pub fn default_model_for_provider(provider: &str) -> &'static str {
    match provider {
        "openrouter" => "openai/gpt-4",
        "anthropic" => "claude-3-5-sonnet-latest",
        "openai" => "gpt-4",
        "ollama" => "deepseek-v4-flash:cloud",
        "codex" => "gpt-5.1-codex-max",
        "claude-code" => "",
        _ => "",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn build_cache(entries: &[(&str, &str, ModelsDevModel)]) -> ModelsDevResponse {
        let mut out: ModelsDevResponse = BTreeMap::new();
        for (provider, model_id, data) in entries {
            let entry = out.entry((*provider).to_owned()).or_default();
            entry.models.insert((*model_id).to_owned(), data.clone());
        }
        out
    }

    fn model(id: &str, ctx: u64, input_cost: f64) -> ModelsDevModel {
        ModelsDevModel {
            id: id.into(),
            name: id.into(),
            cost: Some(ModelCost {
                input: input_cost,
                output: input_cost * 5.0,
            }),
            limit: Some(ModelLimits {
                context: ctx,
                output: 4096,
            }),
            modalities: None,
            last_updated: None,
        }
    }

    #[test]
    fn get_provider_models_returns_empty_for_unmapped_provider() {
        let cache = build_cache(&[("anthropic", "claude-x", model("claude-x", 100_000, 3.0))]);
        assert!(get_provider_models(&cache, "ollama").is_empty());
        assert!(get_provider_models(&cache, "totally-unknown").is_empty());
    }

    #[test]
    fn get_provider_models_returns_empty_when_provider_section_missing() {
        let cache = build_cache(&[("openai", "gpt-4o", model("gpt-4o", 128_000, 2.5))]);
        assert!(get_provider_models(&cache, "anthropic").is_empty());
    }

    #[test]
    fn get_provider_models_lists_every_model_under_the_mapped_provider() {
        let cache = build_cache(&[
            ("anthropic", "a", model("a", 100, 1.0)),
            ("anthropic", "b", model("b", 200, 2.0)),
            ("anthropic", "c", model("c", 300, 3.0)),
        ]);
        let models = get_provider_models(&cache, "anthropic");
        assert_eq!(models.len(), 3);
        let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["a", "b", "c"]);
    }

    #[test]
    fn get_provider_models_sorts_by_last_updated_descending() {
        let mut older = model("old", 100, 1.0);
        older.last_updated = Some("2023-06-01".into());
        let mut newer = model("new", 100, 1.0);
        newer.last_updated = Some("2024-12-01".into());
        let mut middle = model("mid", 100, 1.0);
        middle.last_updated = Some("2024-01-01".into());

        let cache = build_cache(&[
            ("anthropic", "old", older),
            ("anthropic", "new", newer),
            ("anthropic", "mid", middle),
        ]);
        let models = get_provider_models(&cache, "anthropic");
        let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["new", "mid", "old"]);
    }

    #[test]
    fn get_provider_models_entries_with_last_updated_sort_before_those_without() {
        let mut dated = model("dated", 100, 1.0);
        dated.last_updated = Some("2024-01-01".into());
        let undated = model("undated", 100, 1.0);
        let cache = build_cache(&[
            ("anthropic", "dated", dated),
            ("anthropic", "undated", undated),
        ]);
        let models = get_provider_models(&cache, "anthropic");
        let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["dated", "undated"]);
    }

    #[test]
    fn get_provider_models_id_falls_back_to_map_key_when_empty() {
        let mut empty_id = model("ignored", 100, 1.0);
        empty_id.id = String::new();
        empty_id.name = String::new();
        let cache = build_cache(&[("anthropic", "the-key", empty_id)]);
        let models = get_provider_models(&cache, "anthropic");
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "the-key");
        assert_eq!(models[0].name, "the-key");
    }

    #[test]
    fn get_provider_models_handles_openrouter_section() {
        let cache = build_cache(&[(
            "openrouter",
            "anthropic/claude-3.5-sonnet",
            model("anthropic/claude-3.5-sonnet", 200_000, 3.0),
        )]);
        let models = get_provider_models(&cache, "openrouter");
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "anthropic/claude-3.5-sonnet");
    }

    #[test]
    fn picker_label_segments_full_with_ctx_and_cost() {
        let m = ModelsDevModel {
            id: "claude-sonnet-4-6".into(),
            name: "Claude Sonnet 4.6".into(),
            cost: Some(ModelCost {
                input: 3.0,
                output: 15.0,
            }),
            limit: Some(ModelLimits {
                context: 200_000,
                output: 8192,
            }),
            modalities: None,
            last_updated: None,
        };
        let (name, id_seg, meta) = picker_label_segments(&m);
        assert_eq!(name, "Claude Sonnet 4.6");
        assert_eq!(id_seg, "(claude-sonnet-4-6)");
        assert_eq!(meta, "- 200k ctx, $3/$15/M");
    }

    #[test]
    fn picker_label_segments_rounds_ctx_to_nearest_thousand() {
        let mut m = model("x", 199_999, 1.0);
        m.cost = None;
        let (_, _, meta) = picker_label_segments(&m);
        assert_eq!(meta, "- 200k ctx");
    }

    #[test]
    fn picker_label_segments_no_meta_when_both_fields_absent() {
        let mut m = model("x", 0, 1.0);
        m.limit = None;
        m.cost = None;
        let (_, _, meta) = picker_label_segments(&m);
        assert_eq!(meta, "");
    }

    #[test]
    fn picker_label_segments_only_ctx_when_cost_absent() {
        let mut m = model("x", 100_000, 1.0);
        m.cost = None;
        let (_, _, meta) = picker_label_segments(&m);
        assert_eq!(meta, "- 100k ctx");
    }

    #[test]
    fn picker_label_segments_only_cost_when_limit_absent() {
        let mut m = model("x", 0, 2.5);
        m.limit = None;
        let (_, _, meta) = picker_label_segments(&m);
        assert_eq!(meta, "- $2.5/$12.5/M");
    }

    #[test]
    fn default_model_for_each_canonical_provider_matches_ts_table() {
        assert_eq!(default_model_for_provider("openrouter"), "openai/gpt-4");
        assert_eq!(
            default_model_for_provider("anthropic"),
            "claude-3-5-sonnet-latest"
        );
        assert_eq!(default_model_for_provider("openai"), "gpt-4");
        assert_eq!(
            default_model_for_provider("ollama"),
            "deepseek-v4-flash:cloud"
        );
        assert_eq!(default_model_for_provider("codex"), "gpt-5.1-codex-max");
        assert_eq!(default_model_for_provider("claude-code"), "");
    }

    #[test]
    fn default_model_for_unknown_provider_is_empty_string() {
        assert_eq!(default_model_for_provider("totally-made-up"), "");
        assert_eq!(default_model_for_provider(""), "");
    }
}
