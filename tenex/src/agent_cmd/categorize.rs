//! `tenex doctor agents categorize` backfill orchestrator.
//!
//! The actual classification call (sends the agent's metadata to a
//! configured LLM and parses the kebab-case category from the response)
//! lives behind the [`Categorizer`] trait. The runtime self-heals on
//! boot via the same trait; this orchestrator is the operator-driven
//! batch path. Tests stub the trait with an in-memory lookup.

use anyhow::Result;
use indexmap::IndexMap;

use tenex_agent_registry::{
    derive_agent_pubkey_from_nsec, to_metadata, AgentCategory, AgentDoc, AgentMetadata,
    AgentStorage,
};

/// `processed` = uncategorized agents fed to the LLM
/// `categorized` = LLM returned a valid category
/// `skipped` = agents that already had a category
/// `failed` = LLM call returned no category, OR the persist step failed
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BackfillResult {
    pub processed: usize,
    pub categorized: usize,
    pub skipped: usize,
    pub failed: usize,
}

/// LLM-side classification interface.
///
/// `classify` returns:
/// - `Ok(Some(category))` — successful classification
/// - `Ok(None)` — LLM declined to classify (sparse metadata, unknown literal)
/// - `Err(_)` — hard transport error
pub trait Categorizer {
    fn classify(&self, metadata: &AgentMetadata) -> Result<Option<AgentCategory>>;
}

#[derive(Debug, Clone, Copy, Default)]
pub struct BackfillOptions {
    /// Skip the persist step but still invoke the LLM.
    pub dry_run: bool,
}

/// Run the LLM on every active agent that lacks a category and persist
/// the result via [`AgentStorage::update_category`].
pub fn backfill_agent_categories(
    storage: &mut AgentStorage,
    categorizer: &dyn Categorizer,
    options: BackfillOptions,
) -> Result<BackfillResult> {
    let all = storage.get_canonical_active_agents()?;
    let mut uncategorized: Vec<(String, AgentDoc)> = Vec::new();
    let mut already_categorized: usize = 0;
    for agent in all {
        if agent.category().is_some() {
            already_categorized += 1;
            continue;
        }
        let nsec = match agent.nsec() {
            Some(n) => n,
            None => {
                already_categorized += 1;
                continue;
            }
        };
        let pubkey = derive_agent_pubkey_from_nsec(nsec)?;
        uncategorized.push((pubkey, agent));
    }

    let mut result = BackfillResult {
        processed: uncategorized.len(),
        categorized: 0,
        skipped: already_categorized,
        failed: 0,
    };

    for (pubkey, agent) in uncategorized {
        let metadata = to_metadata(&agent);
        let category = match categorizer.classify(&metadata)? {
            Some(c) => c,
            None => {
                result.failed += 1;
                continue;
            }
        };
        result.categorized += 1;
        if options.dry_run {
            continue;
        }
        match storage.update_category(&pubkey, category)? {
            true => {}
            false => result.failed += 1,
        }
    }

    Ok(result)
}

/// Test-friendly classification stub: maps `slug → category` from a
/// supplied table; missing slugs produce `Ok(None)`.
pub struct StubCategorizer {
    pub by_name: IndexMap<String, AgentCategory>,
}

impl Categorizer for StubCategorizer {
    fn classify(&self, metadata: &AgentMetadata) -> Result<Option<AgentCategory>> {
        Ok(self.by_name.get(&metadata.name).copied())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::sync::atomic::{AtomicU64, Ordering};
    use tenex_agent_registry::generate_nsec_bech32;

    fn unique_temp() -> std::path::PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!(
            "tenex-categorize-{}-{}-{n}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn save_agent(base: &std::path::Path, slug: &str, category: Option<&str>) -> String {
        let mut storage = AgentStorage::open(base).unwrap();
        let nsec = generate_nsec_bech32().unwrap();
        let mut raw = IndexMap::<String, Value>::new();
        raw.insert("nsec".into(), Value::String(nsec));
        raw.insert("slug".into(), Value::String(slug.into()));
        raw.insert("name".into(), Value::String(slug.into()));
        raw.insert("role".into(), Value::String("thinker".into()));
        raw.insert("status".into(), Value::String("active".into()));
        if let Some(c) = category {
            raw.insert("category".into(), Value::String(c.into()));
        }
        let doc = AgentDoc::from_raw(raw);
        storage.save_agent(&doc).unwrap()
    }

    fn stub(by_name: &[(&str, AgentCategory)]) -> StubCategorizer {
        let mut m: IndexMap<String, AgentCategory> = IndexMap::new();
        for (n, c) in by_name {
            m.insert((*n).into(), *c);
        }
        StubCategorizer { by_name: m }
    }

    // ── update_category storage-method check ──────────────────────────

    #[test]
    fn update_category_persists_kebab_literal() {
        let base = unique_temp();
        let pk = save_agent(&base, "alpha", None);
        {
            let mut storage = AgentStorage::open(&base).unwrap();
            let updated = storage
                .update_category(&pk, AgentCategory::DomainExpert)
                .unwrap();
            assert!(updated);
        }
        let storage = AgentStorage::open(&base).unwrap();
        let agent = storage.load_agent(&pk).unwrap().unwrap();
        assert_eq!(agent.category(), Some(AgentCategory::DomainExpert));
        let raw = agent.raw().get("category").and_then(Value::as_str).unwrap();
        assert_eq!(raw, "domain-expert");
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn update_category_returns_false_for_missing_agent() {
        let base = unique_temp();
        let mut storage = AgentStorage::open(&base).unwrap();
        let result = storage
            .update_category("not-real", AgentCategory::Worker)
            .unwrap();
        assert!(!result);
        std::fs::remove_dir_all(&base).ok();
    }

    // ── backfill_agent_categories ──────────────────────────────────────

    #[test]
    fn backfill_skips_agents_with_category() {
        let base = unique_temp();
        save_agent(&base, "with-category", Some("worker"));
        save_agent(&base, "without", None);
        let mut storage = AgentStorage::open(&base).unwrap();
        let stub_cat = stub(&[("without", AgentCategory::Worker)]);
        let result =
            backfill_agent_categories(&mut storage, &stub_cat, BackfillOptions::default()).unwrap();
        assert_eq!(result.processed, 1);
        assert_eq!(result.categorized, 1);
        assert_eq!(result.skipped, 1);
        assert_eq!(result.failed, 0);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn backfill_increments_failed_when_classifier_returns_none() {
        let base = unique_temp();
        save_agent(&base, "alpha", None);
        let mut storage = AgentStorage::open(&base).unwrap();
        let stub_cat = stub(&[]);
        let result =
            backfill_agent_categories(&mut storage, &stub_cat, BackfillOptions::default()).unwrap();
        assert_eq!(result.processed, 1);
        assert_eq!(result.categorized, 0);
        assert_eq!(result.failed, 1);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn backfill_persists_category_on_success() {
        let base = unique_temp();
        let pk = save_agent(&base, "alpha", None);
        {
            let mut storage = AgentStorage::open(&base).unwrap();
            let stub_cat = stub(&[("alpha", AgentCategory::Generalist)]);
            backfill_agent_categories(&mut storage, &stub_cat, BackfillOptions::default()).unwrap();
        }
        let storage = AgentStorage::open(&base).unwrap();
        let agent = storage.load_agent(&pk).unwrap().unwrap();
        assert_eq!(agent.category(), Some(AgentCategory::Generalist));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn backfill_dry_run_skips_persist_but_counts_categorized() {
        let base = unique_temp();
        let pk = save_agent(&base, "alpha", None);
        {
            let mut storage = AgentStorage::open(&base).unwrap();
            let stub_cat = stub(&[("alpha", AgentCategory::Generalist)]);
            let result = backfill_agent_categories(
                &mut storage,
                &stub_cat,
                BackfillOptions { dry_run: true },
            )
            .unwrap();
            assert_eq!(result.categorized, 1);
            assert_eq!(result.failed, 0);
        }
        let storage = AgentStorage::open(&base).unwrap();
        let agent = storage.load_agent(&pk).unwrap().unwrap();
        assert_eq!(agent.category(), None);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn backfill_empty_storage_returns_zero_counters() {
        let base = unique_temp();
        let mut storage = AgentStorage::open(&base).unwrap();
        let stub_cat = stub(&[]);
        let result =
            backfill_agent_categories(&mut storage, &stub_cat, BackfillOptions::default()).unwrap();
        assert_eq!(result, BackfillResult::default());
        std::fs::remove_dir_all(&base).ok();
    }
}
