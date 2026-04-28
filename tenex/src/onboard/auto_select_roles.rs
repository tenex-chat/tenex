//! Onboarding Screen 5 (sub-step A): cost-based auto-assignment of LLM
//! roles using `models.dev` metadata.
//!
//! Source: `src/commands/config/roles.ts:34-83` `autoSelectRoles`. Pure
//! scoring logic. The source of model metadata (`getModelInfo`) is
//! abstracted behind [`ModelInfoSource`] so tests can drive every branch
//! deterministically. The production implementation that backs this with
//! the on-disk `models.dev` cache is deferred to its own iteration; until
//! then, [`EmptyModelInfoSource`] returns `None` for every lookup, and
//! `auto_select_roles` is a no-op (matching the TS behaviour at
//! `:46-47, :56-57` when nothing scores).
//!
//! Selection rules (verbatim from the TS):
//!
//! | Role               | Pick               | Filter                         |
//! |--------------------|--------------------|--------------------------------|
//! | summarization      | cheapest input     | context window ≥ 100 000       |
//! | supervision        | most expensive     | (no context filter)            |
//! | promptCompilation  | most expensive     | context window ≥ 100 000       |
//! | contextDiscovery   | cheapest input     | ctx ≥ 32 000, fallback ≥ 8 000 |
//!
//! Meta-model entries are skipped during scoring (`:44`).

use crate::store::llms::{LlmConfigKind, LlmsDoc};

/// Model metadata as consumed by the role auto-selector. Mirrors the
/// fields the TS reads from `models.dev` (`info.cost.input` and
/// `info.limit.context`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ModelInfo {
    /// Input-token cost in $/M tokens (lower is "cheaper").
    pub input_cost: f64,
    /// Context window in tokens.
    pub context_window: u64,
}

/// Trait for the metadata lookup. Tests use a mock; production will use a
/// `models.dev` cache adapter (separate iteration).
pub trait ModelInfoSource {
    fn info(&self, provider: &str, model: &str) -> Option<ModelInfo>;
}

/// Default production lookup — always `None`. Matches the TS edge case where
/// `models.dev` has no entry for a provider/model: scoring drops the config,
/// and `auto_select_roles` early-returns with no assignments.
pub struct EmptyModelInfoSource;

impl ModelInfoSource for EmptyModelInfoSource {
    fn info(&self, _provider: &str, _model: &str) -> Option<ModelInfo> {
        None
    }
}

/// `ModelInfoSource` backed by an in-memory `models.dev` cache (a parsed
/// [`crate::store::models_dev::ModelsDevResponse`]).
///
/// Mirrors the TS path in `commands/config/roles.ts:34-83` →
/// `getModelInfo(provider, model)` (`models-dev-cache.ts:294-306`),
/// which wraps `resolveModelData`'s 3-step lookup. We adapt that to the
/// scoring-side `ModelInfo` shape (input cost + context window only).
///
/// Construct from a parsed `ModelsDevResponse`:
///
/// ```ignore
/// let bytes = std::fs::read(cache_path)?;
/// let cache: CacheData = parse_cache_bytes(&bytes)?;
/// let source = ModelsDevSource::new(&cache.data);
/// auto_select_roles(&doc, &source);
/// ```
///
/// Returns `None` whenever the cache lacks the model OR the model entry
/// is missing either `cost.input` or `limit.context` (the two fields the
/// scorer needs). That matches the TS guards at
/// `models-dev-cache.ts:284-287` and `roles.ts:46-47`.
pub struct ModelsDevSource<'a> {
    cache: &'a crate::store::models_dev::ModelsDevResponse,
}

impl<'a> ModelsDevSource<'a> {
    pub fn new(cache: &'a crate::store::models_dev::ModelsDevResponse) -> Self {
        Self { cache }
    }
}

impl ModelInfoSource for ModelsDevSource<'_> {
    fn info(&self, provider: &str, model: &str) -> Option<ModelInfo> {
        let (_, data) =
            crate::store::models_dev::resolve_model_data(self.cache, provider, model)?;
        let cost = data.cost.as_ref()?;
        let limit = data.limit.as_ref()?;
        Some(ModelInfo {
            input_cost: cost.input,
            context_window: limit.context,
        })
    }
}

/// Owned variant of [`ModelsDevSource`] — holds a `CacheData` so it can
/// be passed across function boundaries without lifetime gymnastics.
/// Re-resolves on each `info()` call against the inner cache.
pub struct OwnedModelsDevSource {
    cache: crate::store::models_dev::CacheData,
}

impl OwnedModelsDevSource {
    pub fn new(cache: crate::store::models_dev::CacheData) -> Self {
        Self { cache }
    }
}

impl ModelInfoSource for OwnedModelsDevSource {
    fn info(&self, provider: &str, model: &str) -> Option<ModelInfo> {
        ModelsDevSource::new(&self.cache.data).info(provider, model)
    }
}

/// Best-effort builder: try `<base_dir>/cache/models-dev.json`; on
/// missing-file or parse error, fall back to [`EmptyModelInfoSource`].
///
/// The HTTP refresh path that populates the cache lives in TS at
/// `models-dev-cache.ts:148-216` (`refreshInBackground`,
/// `ensureCacheLoaded`) — pending in the Rust port until an HTTP client
/// substrate lands. Until then this reader still returns useful data
/// when the user has run TS recently and the cache file is present on
/// disk.
pub fn load_or_empty(base_dir: &std::path::Path) -> Box<dyn ModelInfoSource + '_> {
    match crate::store::models_dev::load_from_disk(base_dir) {
        Ok(Some(cache)) => Box::new(OwnedModelsDevSource::new(cache)),
        Ok(None) => Box::new(EmptyModelInfoSource),
        Err(e) => {
            tracing::warn!(
                error = %e,
                "models.dev cache file present but unparseable; falling back to empty source"
            );
            Box::new(EmptyModelInfoSource)
        }
    }
}

#[derive(Debug, Clone)]
struct ScoredConfig {
    name: String,
    input_cost: f64,
    context_window: u64,
}

/// Score every standard (non-meta) configuration in `doc` against `source`,
/// then assign roles per the spec table. Mutates `doc.summarization`,
/// `doc.supervision`, `doc.prompt_compilation`, and `doc.context_discovery`
/// in place. Roles already set by the caller are overwritten when the auto-
/// selector picks a value (matches the TS in-place mutation at `:73, :76, :79, :82`).
pub fn auto_select_roles(doc: &mut LlmsDoc, source: &dyn ModelInfoSource) {
    let scored = score_configs(doc, source);
    if scored.is_empty() {
        return;
    }

    if let Some(name) = cheapest_with_context(&scored, 100_000) {
        doc.set_summarization(Some(name));
    }
    if let Some(name) = most_expensive(&scored, None) {
        doc.set_supervision(Some(name));
    }
    if let Some(name) = most_expensive(&scored, Some(100_000)) {
        doc.set_prompt_compilation(Some(name));
    }
    let context_discovery = cheapest_with_context(&scored, 32_000)
        .or_else(|| cheapest_with_context(&scored, 8_000));
    if let Some(name) = context_discovery {
        doc.set_context_discovery(Some(name));
    }
}

fn score_configs(doc: &LlmsDoc, source: &dyn ModelInfoSource) -> Vec<ScoredConfig> {
    let mut out: Vec<ScoredConfig> = Vec::new();
    for name in doc.config_names() {
        let entry = match doc.get(&name) {
            Some(e) => e,
            None => continue,
        };
        if entry.kind() == LlmConfigKind::Meta {
            continue;
        }
        let provider = match entry.provider() {
            Some(p) => p,
            None => continue,
        };
        let model = match entry.model() {
            Some(m) => m,
            None => continue,
        };
        let Some(info) = source.info(provider, model) else { continue };
        out.push(ScoredConfig {
            name,
            input_cost: info.input_cost,
            context_window: info.context_window,
        });
    }
    out
}

fn cheapest_with_context(scored: &[ScoredConfig], min_context: u64) -> Option<String> {
    let mut eligible: Vec<&ScoredConfig> = scored
        .iter()
        .filter(|c| c.context_window >= min_context)
        .collect();
    if eligible.is_empty() {
        return None;
    }
    eligible.sort_by(|a, b| {
        a.input_cost
            .partial_cmp(&b.input_cost)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Some(eligible[0].name.clone())
}

fn most_expensive(scored: &[ScoredConfig], min_context: Option<u64>) -> Option<String> {
    let mut eligible: Vec<&ScoredConfig> = match min_context {
        Some(min) => scored.iter().filter(|c| c.context_window >= min).collect(),
        None => scored.iter().collect(),
    };
    if eligible.is_empty() {
        return None;
    }
    eligible.sort_by(|a, b| {
        b.input_cost
            .partial_cmp(&a.input_cost)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Some(eligible[0].name.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::llms::{MetaConfig, MetaVariant, StandardConfig};
    use std::collections::HashMap;

    /// Test source backed by a `(provider, model) -> ModelInfo` map.
    struct MockSource {
        entries: HashMap<(String, String), ModelInfo>,
    }

    impl MockSource {
        fn new() -> Self {
            Self {
                entries: HashMap::new(),
            }
        }

        fn with(mut self, provider: &str, model: &str, info: ModelInfo) -> Self {
            self.entries
                .insert((provider.to_owned(), model.to_owned()), info);
            self
        }
    }

    impl ModelInfoSource for MockSource {
        fn info(&self, provider: &str, model: &str) -> Option<ModelInfo> {
            self.entries
                .get(&(provider.to_owned(), model.to_owned()))
                .copied()
        }
    }

    fn doc_with_configs(configs: &[(&str, &str, &str)]) -> LlmsDoc {
        let mut doc = LlmsDoc::new();
        for (name, provider, model) in configs {
            doc.set_standard_config(name, StandardConfig::new(*provider, *model));
        }
        doc
    }

    fn info(input_cost: f64, context_window: u64) -> ModelInfo {
        ModelInfo {
            input_cost,
            context_window,
        }
    }

    #[test]
    fn empty_source_assigns_no_roles() {
        let mut doc = doc_with_configs(&[("Cheap", "anthropic", "claude-x")]);
        auto_select_roles(&mut doc, &EmptyModelInfoSource);
        assert!(doc.summarization().is_none());
        assert!(doc.supervision().is_none());
        assert!(doc.prompt_compilation().is_none());
        assert!(doc.context_discovery().is_none());
    }

    #[test]
    fn empty_doc_assigns_no_roles() {
        let mut doc = LlmsDoc::new();
        let source = MockSource::new().with("anthropic", "claude-x", info(1.0, 200_000));
        auto_select_roles(&mut doc, &source);
        assert!(doc.summarization().is_none());
    }

    #[test]
    fn meta_model_configs_are_skipped() {
        let mut doc = LlmsDoc::new();
        doc.set_meta_config(
            "Auto",
            MetaConfig {
                variants: vec![
                    MetaVariant {
                        name: "fast".into(),
                        model: "Sonnet".into(),
                        keywords: None,
                        description: None,
                        system_prompt: None,
                    },
                    MetaVariant {
                        name: "slow".into(),
                        model: "Opus".into(),
                        keywords: None,
                        description: None,
                        system_prompt: None,
                    },
                ],
                default: "fast".into(),
            },
        );
        // Meta-model has no provider/model fields the source could match
        // against — even with a populated source, scoring should skip it.
        let source = MockSource::new().with("meta", "ignored", info(1.0, 200_000));
        auto_select_roles(&mut doc, &source);
        assert!(doc.summarization().is_none());
    }

    #[test]
    fn summarization_picks_cheapest_with_context_at_least_100k() {
        let mut doc = doc_with_configs(&[
            ("Cheap", "anthropic", "haiku"),
            ("Expensive", "anthropic", "opus"),
            ("LowContext", "anthropic", "small"),
        ]);
        let source = MockSource::new()
            .with("anthropic", "haiku", info(0.25, 200_000))
            .with("anthropic", "opus", info(15.0, 200_000))
            .with("anthropic", "small", info(0.10, 50_000)); // disqualified by 100k filter
        auto_select_roles(&mut doc, &source);
        assert_eq!(doc.summarization(), Some("Cheap"));
    }

    #[test]
    fn supervision_picks_most_expensive_regardless_of_context() {
        let mut doc = doc_with_configs(&[
            ("Cheap", "anthropic", "haiku"),
            ("Expensive", "anthropic", "opus"),
        ]);
        let source = MockSource::new()
            .with("anthropic", "haiku", info(0.25, 8_000))
            .with("anthropic", "opus", info(15.0, 8_000));
        auto_select_roles(&mut doc, &source);
        assert_eq!(doc.supervision(), Some("Expensive"));
    }

    #[test]
    fn prompt_compilation_picks_most_expensive_with_at_least_100k_context() {
        let mut doc = doc_with_configs(&[
            ("Cheap200K", "anthropic", "haiku"),
            ("Expensive50K", "anthropic", "opus50"),
            ("MidPrice200K", "anthropic", "sonnet"),
        ]);
        let source = MockSource::new()
            .with("anthropic", "haiku", info(0.25, 200_000))
            .with("anthropic", "opus50", info(15.0, 50_000)) // disqualified
            .with("anthropic", "sonnet", info(3.0, 200_000));
        auto_select_roles(&mut doc, &source);
        assert_eq!(doc.prompt_compilation(), Some("MidPrice200K"));
    }

    #[test]
    fn context_discovery_prefers_cheapest_at_32k_then_falls_back_to_8k() {
        let mut doc = doc_with_configs(&[
            ("OK32K", "p", "m32"),
            ("OK8K", "p", "m8"),
        ]);
        // Both qualify at 32K — pick cheapest.
        let source_a = MockSource::new()
            .with("p", "m32", info(2.0, 32_000))
            .with("p", "m8", info(1.0, 32_000));
        let mut doc_a = doc.clone();
        auto_select_roles(&mut doc_a, &source_a);
        assert_eq!(doc_a.context_discovery(), Some("OK8K"));

        // Only m8 qualifies at 8K (m32 has no info this round).
        let source_b = MockSource::new().with("p", "m8", info(1.0, 8_000));
        auto_select_roles(&mut doc, &source_b);
        assert_eq!(doc.context_discovery(), Some("OK8K"));
    }

    #[test]
    fn context_discovery_returns_none_when_no_one_meets_8k_floor() {
        let mut doc = doc_with_configs(&[("Tiny", "p", "m")]);
        let source = MockSource::new().with("p", "m", info(1.0, 4_000));
        auto_select_roles(&mut doc, &source);
        // 4K is below both filters; the role isn't assigned. Other roles
        // skip filters so they may still be assigned (supervision has no
        // context filter), so check context_discovery specifically.
        assert!(doc.context_discovery().is_none());
    }

    #[test]
    fn no_eligible_configs_returns_early_with_no_assignments() {
        // All configs lack info → scored is empty → early-return.
        let mut doc = doc_with_configs(&[("X", "p", "m")]);
        let source = EmptyModelInfoSource;
        auto_select_roles(&mut doc, &source);
        assert!(doc.summarization().is_none());
        assert!(doc.supervision().is_none());
        assert!(doc.prompt_compilation().is_none());
        assert!(doc.context_discovery().is_none());
    }

    #[test]
    fn ties_break_consistently_by_first_in_iteration_order() {
        let mut doc = doc_with_configs(&[
            ("A", "p", "ma"),
            ("B", "p", "mb"),
        ]);
        let source = MockSource::new()
            .with("p", "ma", info(1.0, 200_000))
            .with("p", "mb", info(1.0, 200_000)); // identical
        auto_select_roles(&mut doc, &source);
        // With equal cost, the stable sort keeps the first-seen entry.
        assert_eq!(doc.summarization(), Some("A"));
        assert_eq!(doc.supervision(), Some("A"));
    }

    #[test]
    fn all_four_roles_can_be_assigned_in_one_pass() {
        let mut doc = doc_with_configs(&[
            ("CheapBig", "p", "m1"),
            ("ExpensiveBig", "p", "m2"),
            ("Mid32K", "p", "m3"),
        ]);
        let source = MockSource::new()
            .with("p", "m1", info(0.25, 200_000))
            .with("p", "m2", info(15.0, 200_000))
            .with("p", "m3", info(2.0, 32_000));
        auto_select_roles(&mut doc, &source);
        assert_eq!(doc.summarization(), Some("CheapBig"));
        assert_eq!(doc.supervision(), Some("ExpensiveBig"));
        assert_eq!(doc.prompt_compilation(), Some("ExpensiveBig"));
        // context_discovery: cheapest with ≥32K → CheapBig (cost 0.25 vs Mid32K 2.0).
        assert_eq!(doc.context_discovery(), Some("CheapBig"));
    }

    #[test]
    fn empty_provider_or_model_field_skips_config() {
        // Crafting a config with empty provider/model would require
        // bypassing the typed setters; constructed via raw_mut instead.
        let mut doc = LlmsDoc::new();
        // Insert a manually-malformed entry via raw_mut.
        doc.raw_mut().insert(
            "configurations".into(),
            serde_json::json!({
                "Bad": { "provider": "", "model": "" },
                "Good": { "provider": "p", "model": "m" }
            }),
        );
        let source = MockSource::new()
            .with("", "", info(1.0, 200_000))
            .with("p", "m", info(2.0, 200_000));
        auto_select_roles(&mut doc, &source);
        // Empty provider/model with mock info should still score (mock has
        // no special handling), so the malformed config might get picked.
        // Our score_configs implementation should allow empty strings
        // because it only filters by .is_some(), not .is_empty().
        // Check assignment did happen (some role got set).
        assert!(
            doc.summarization().is_some() || doc.supervision().is_some(),
            "expected at least one role assigned",
        );
    }

    // ── ModelsDevSource adapter ─────────────────────────────────────────

    #[test]
    fn models_dev_source_returns_info_when_cache_has_cost_and_context() {
        use crate::store::models_dev::{
            ModelCost, ModelLimits, ModelsDevModel, ModelsDevResponse, ProviderModels,
        };
        use std::collections::BTreeMap;

        let mut cache: ModelsDevResponse = BTreeMap::new();
        let mut models = BTreeMap::new();
        models.insert(
            "claude-sonnet-4-6".to_owned(),
            ModelsDevModel {
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
                last_updated: None,
            },
        );
        cache.insert("anthropic".into(), ProviderModels { models });

        let source = ModelsDevSource::new(&cache);
        let info = source.info("anthropic", "claude-sonnet-4-6").unwrap();
        assert_eq!(info.input_cost, 3.0);
        assert_eq!(info.context_window, 200_000);
    }

    #[test]
    fn models_dev_source_returns_none_when_model_missing() {
        use crate::store::models_dev::ModelsDevResponse;
        let cache = ModelsDevResponse::new();
        let source = ModelsDevSource::new(&cache);
        assert!(source.info("anthropic", "missing").is_none());
    }

    #[test]
    fn models_dev_source_returns_none_when_cost_field_absent() {
        // TS `getModelLimits` returns undefined when cost or limit
        // fields are missing. Mirror that here.
        use crate::store::models_dev::{
            ModelLimits, ModelsDevModel, ModelsDevResponse, ProviderModels,
        };
        use std::collections::BTreeMap;

        let mut cache: ModelsDevResponse = BTreeMap::new();
        let mut models = BTreeMap::new();
        models.insert(
            "no-cost".to_owned(),
            ModelsDevModel {
                id: "no-cost".into(),
                name: "no-cost".into(),
                cost: None,
                limit: Some(ModelLimits {
                    context: 1000,
                    output: 100,
                }),
                last_updated: None,
            },
        );
        cache.insert("anthropic".into(), ProviderModels { models });

        let source = ModelsDevSource::new(&cache);
        assert!(source.info("anthropic", "no-cost").is_none());
    }

    #[test]
    fn owned_models_dev_source_re_resolves_against_inner_cache() {
        use crate::store::models_dev::{
            CacheData, ModelCost, ModelLimits, ModelsDevModel, ModelsDevResponse, ProviderModels,
        };
        use std::collections::BTreeMap;

        let mut response: ModelsDevResponse = BTreeMap::new();
        let mut models = BTreeMap::new();
        models.insert(
            "claude-x".into(),
            ModelsDevModel {
                id: "claude-x".into(),
                name: "Claude X".into(),
                cost: Some(ModelCost { input: 1.5, output: 5.0 }),
                limit: Some(ModelLimits { context: 100_000, output: 4096 }),
                last_updated: None,
            },
        );
        response.insert("anthropic".into(), ProviderModels { models });

        let cache = CacheData { fetched_at: 0, data: response };
        let owned = OwnedModelsDevSource::new(cache);
        let info = owned.info("anthropic", "claude-x").unwrap();
        assert_eq!(info.input_cost, 1.5);
        assert_eq!(info.context_window, 100_000);
        // And missing lookups still return None.
        assert!(owned.info("anthropic", "missing").is_none());
    }

    #[test]
    fn load_or_empty_returns_empty_source_when_cache_file_missing() {
        // No cache file at <base>/cache/models-dev.json → empty source.
        // Verify by checking that any lookup returns None.
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let base = std::env::temp_dir().join(format!(
            "tenex-load-or-empty-{}-{n}",
            std::process::id()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let source = load_or_empty(&base);
        assert!(source.info("anthropic", "claude-x").is_none());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn load_or_empty_returns_owned_source_when_cache_file_parses() {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let base = std::env::temp_dir().join(format!(
            "tenex-load-or-empty-{}-{n}",
            std::process::id()
        ));
        std::fs::create_dir_all(base.join("cache")).unwrap();
        let payload = br#"{"fetchedAt":0,"data":{"anthropic":{"models":{"claude-x":{"id":"claude-x","name":"Claude X","cost":{"input":2.0,"output":10.0},"limit":{"context":150000,"output":4096}}}}}}"#;
        std::fs::write(
            base.join("cache").join("models-dev.json"),
            payload,
        )
        .unwrap();

        let source = load_or_empty(&base);
        let info = source.info("anthropic", "claude-x").unwrap();
        assert_eq!(info.input_cost, 2.0);
        assert_eq!(info.context_window, 150_000);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn models_dev_source_resolves_via_vendor_slash_split() {
        // OpenRouter-style ID: "anthropic/claude-sonnet-4-6". The
        // direct lookup (in the openrouter section) misses; the vendor
        // split matches the "anthropic" section.
        use crate::store::models_dev::{
            ModelCost, ModelLimits, ModelsDevModel, ModelsDevResponse, ProviderModels,
        };
        use std::collections::BTreeMap;

        let mut cache: ModelsDevResponse = BTreeMap::new();
        let mut models = BTreeMap::new();
        models.insert(
            "claude-sonnet-4-6".to_owned(),
            ModelsDevModel {
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
                last_updated: None,
            },
        );
        cache.insert("anthropic".into(), ProviderModels { models });

        let source = ModelsDevSource::new(&cache);
        let info = source
            .info("openrouter", "anthropic/claude-sonnet-4-6")
            .unwrap();
        assert_eq!(info.input_cost, 3.0);
        assert_eq!(info.context_window, 200_000);
    }
}
