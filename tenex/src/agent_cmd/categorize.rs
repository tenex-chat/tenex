//! `tenex doctor agents categorize` backfill orchestrator.
//!
//! Mirrors `backfillAgentCategories` (`src/agents/backfillAgentCategories.ts`)
//! and the doctor command surface at `src/commands/doctor.ts:23-41`.
//!
//! The actual classification call (`categorizeAgent` — sends the
//! agent's metadata to a configured LLM and parses the kebab-case
//! category from the response) lives behind the [`Categoriser`] trait.
//! When the LLM substrate lands, it implements this trait and the
//! orchestrator runs unchanged. Tests stub the trait with an in-memory
//! lookup so every other piece of the flow can be verified in isolation.

use anyhow::Result;
use indexmap::IndexMap;

use crate::store::agent_storage::{
    derive_agent_pubkey_from_nsec, AgentDoc, AgentStorage,
};
use crate::store::role_categories::AgentCategory;

/// Mirror of `BackfillResult` (`backfillAgentCategories.ts:9-14`).
///
/// `processed` = uncategorized agents fed to the LLM
/// `categorized` = LLM returned a valid category
/// `skipped` = agents that already had a category or inferredCategory
/// `failed` = LLM call returned no category, OR the persist step failed
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BackfillResult {
    pub processed: usize,
    pub categorized: usize,
    pub skipped: usize,
    pub failed: usize,
}

/// Per-agent metadata fed to the LLM. Mirrors `AgentMetadata`
/// (`categorizeAgent.ts`) and `toMetadata`
/// (`backfillAgentCategories.ts:16-24`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentMetadata {
    pub name: String,
    pub role: String,
    pub description: Option<String>,
    pub instructions: Option<String>,
    pub use_criteria: Option<String>,
}

/// Pull the LLM-prompt-input fields off an [`AgentDoc`].
pub fn to_metadata(agent: &AgentDoc) -> AgentMetadata {
    AgentMetadata {
        name: agent.name().unwrap_or("").to_owned(),
        role: agent.role().unwrap_or("").to_owned(),
        description: agent.description().map(str::to_owned),
        instructions: agent.instructions().map(str::to_owned),
        use_criteria: agent.use_criteria().map(str::to_owned),
    }
}

/// LLM-side classification interface.
///
/// `classify` returns:
/// - `Ok(Some(category))` — successful classification
/// - `Ok(None)` — LLM declined to classify (e.g. metadata too sparse,
///   model returned an unknown literal). TS path increments `failed` and
///   continues. `Ok` here is intentional — a legitimate "no answer" is
///   not an error.
/// - `Err(_)` — hard transport error (connection failure, malformed
///   response). Propagates up.
pub trait Categoriser {
    fn classify(&self, metadata: &AgentMetadata) -> Result<Option<AgentCategory>>;
}

/// `BackfillOptions` (`backfillAgentCategories.ts:5-7`):
/// `dry_run` skips the persist step but still invokes the LLM.
#[derive(Debug, Clone, Copy, Default)]
pub struct BackfillOptions {
    pub dry_run: bool,
}

/// Mirror `backfillAgentCategories` (`:26-81`):
/// 1. Read every canonical-active agent
/// 2. Filter out any that already have a `category` OR `inferredCategory`
/// 3. For each remaining: classify via [`Categoriser`]; on success either
///    skip persist (dry-run) or write via
///    [`AgentStorage::update_inferred_category`]
/// 4. Return [`BackfillResult`] with counters
pub fn backfill_agent_categories(
    storage: &mut AgentStorage,
    categoriser: &dyn Categoriser,
    options: BackfillOptions,
) -> Result<BackfillResult> {
    let all = storage.get_canonical_active_agents()?;
    let mut uncategorized: Vec<(String, AgentDoc)> = Vec::new();
    let mut already_categorized: usize = 0;
    for agent in all {
        let has_explicit = agent.category().is_some();
        let has_inferred = agent.inferred_category().is_some();
        if has_explicit || has_inferred {
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
        let inferred = match categoriser.classify(&metadata)? {
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
        match storage.update_inferred_category(&pubkey, inferred)? {
            true => {}
            false => result.failed += 1,
        }
    }

    Ok(result)
}

/// Test-friendly classification stub: maps `slug → category` from a
/// supplied table; missing slugs produce `Ok(None)`.
#[cfg(test)]
pub struct StubCategoriser {
    pub by_name: IndexMap<String, AgentCategory>,
}

#[cfg(test)]
impl Categoriser for StubCategoriser {
    fn classify(&self, metadata: &AgentMetadata) -> Result<Option<AgentCategory>> {
        Ok(self.by_name.get(&metadata.name).copied())
    }
}

// Avoid an "unused import" warning in non-test builds — IndexMap is used
// only by the cfg(test) StubCategoriser.
const _: fn() = || {
    let _: IndexMap<String, AgentCategory> = IndexMap::new();
};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::agent_storage::generate_nsec_bech32;
    use serde_json::Value;
    use std::sync::atomic::{AtomicU64, Ordering};

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

    fn save_agent(
        base: &std::path::Path,
        slug: &str,
        category: Option<&str>,
        inferred: Option<&str>,
    ) -> String {
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
        if let Some(i) = inferred {
            raw.insert("inferredCategory".into(), Value::String(i.into()));
        }
        let doc = AgentDoc::from_raw(raw);
        storage.save_agent(&doc).unwrap()
    }

    fn stub(by_name: &[(&str, AgentCategory)]) -> StubCategoriser {
        let mut m: IndexMap<String, AgentCategory> = IndexMap::new();
        for (n, c) in by_name {
            m.insert((*n).into(), *c);
        }
        StubCategoriser { by_name: m }
    }

    // ── update_inferred_category storage-method check ──────────────────

    #[test]
    fn update_inferred_category_persists_kebab_literal() {
        let base = unique_temp();
        let pk = save_agent(&base, "alpha", None, None);
        {
            let mut storage = AgentStorage::open(&base).unwrap();
            let updated = storage
                .update_inferred_category(&pk, AgentCategory::DomainExpert)
                .unwrap();
            assert!(updated);
        }
        let storage = AgentStorage::open(&base).unwrap();
        let agent = storage.load_agent(&pk).unwrap().unwrap();
        assert_eq!(agent.inferred_category(), Some(AgentCategory::DomainExpert));
        // And the on-disk literal is exactly the kebab spelling.
        let raw = agent
            .raw()
            .get("inferredCategory")
            .and_then(Value::as_str)
            .unwrap();
        assert_eq!(raw, "domain-expert");
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn update_inferred_category_returns_false_for_missing_agent() {
        let base = unique_temp();
        let mut storage = AgentStorage::open(&base).unwrap();
        let result = storage
            .update_inferred_category("not-real", AgentCategory::Worker)
            .unwrap();
        assert!(!result);
        std::fs::remove_dir_all(&base).ok();
    }

    // ── to_metadata ────────────────────────────────────────────────────

    #[test]
    fn to_metadata_carries_through_optional_fields() {
        let mut raw = IndexMap::<String, Value>::new();
        raw.insert("name".into(), Value::String("Friedrich Hayek".into()));
        raw.insert("role".into(), Value::String("thinker".into()));
        raw.insert("description".into(), Value::String("desc".into()));
        raw.insert("instructions".into(), Value::String("inst".into()));
        raw.insert("useCriteria".into(), Value::String("use".into()));
        let doc = AgentDoc::from_raw(raw);
        let m = to_metadata(&doc);
        assert_eq!(m.name, "Friedrich Hayek");
        assert_eq!(m.role, "thinker");
        assert_eq!(m.description.as_deref(), Some("desc"));
        assert_eq!(m.instructions.as_deref(), Some("inst"));
        assert_eq!(m.use_criteria.as_deref(), Some("use"));
    }

    #[test]
    fn to_metadata_uses_empty_string_for_missing_name_and_role() {
        let raw = IndexMap::<String, Value>::new();
        let doc = AgentDoc::from_raw(raw);
        let m = to_metadata(&doc);
        assert_eq!(m.name, "");
        assert_eq!(m.role, "");
        assert!(m.description.is_none());
    }

    // ── backfill_agent_categories ──────────────────────────────────────

    #[test]
    fn backfill_skips_agents_with_explicit_category() {
        let base = unique_temp();
        save_agent(&base, "with-category", Some("worker"), None);
        save_agent(&base, "without", None, None);
        let mut storage = AgentStorage::open(&base).unwrap();
        let stub_cat = stub(&[("without", AgentCategory::Worker)]);
        let result =
            backfill_agent_categories(&mut storage, &stub_cat, BackfillOptions::default())
                .unwrap();
        assert_eq!(result.processed, 1);
        assert_eq!(result.categorized, 1);
        assert_eq!(result.skipped, 1);
        assert_eq!(result.failed, 0);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn backfill_skips_agents_with_inferred_category() {
        let base = unique_temp();
        save_agent(&base, "already-inferred", None, Some("worker"));
        let mut storage = AgentStorage::open(&base).unwrap();
        let stub_cat = stub(&[("already-inferred", AgentCategory::Reviewer)]);
        let result =
            backfill_agent_categories(&mut storage, &stub_cat, BackfillOptions::default())
                .unwrap();
        assert_eq!(result.processed, 0);
        assert_eq!(result.skipped, 1);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn backfill_increments_failed_when_classifier_returns_none() {
        let base = unique_temp();
        save_agent(&base, "alpha", None, None);
        let mut storage = AgentStorage::open(&base).unwrap();
        // Empty stub: classify returns None → failed++.
        let stub_cat = stub(&[]);
        let result =
            backfill_agent_categories(&mut storage, &stub_cat, BackfillOptions::default())
                .unwrap();
        assert_eq!(result.processed, 1);
        assert_eq!(result.categorized, 0);
        assert_eq!(result.failed, 1);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn backfill_persists_inferred_category_on_success() {
        let base = unique_temp();
        let pk = save_agent(&base, "alpha", None, None);
        {
            let mut storage = AgentStorage::open(&base).unwrap();
            let stub_cat = stub(&[("alpha", AgentCategory::Generalist)]);
            backfill_agent_categories(&mut storage, &stub_cat, BackfillOptions::default())
                .unwrap();
        }
        let storage = AgentStorage::open(&base).unwrap();
        let agent = storage.load_agent(&pk).unwrap().unwrap();
        assert_eq!(agent.inferred_category(), Some(AgentCategory::Generalist));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn backfill_dry_run_skips_persist_but_counts_categorized() {
        let base = unique_temp();
        let pk = save_agent(&base, "alpha", None, None);
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
        // On disk: no inferredCategory written.
        let storage = AgentStorage::open(&base).unwrap();
        let agent = storage.load_agent(&pk).unwrap().unwrap();
        assert_eq!(agent.inferred_category(), None);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn backfill_empty_storage_returns_zero_counters() {
        let base = unique_temp();
        let mut storage = AgentStorage::open(&base).unwrap();
        let stub_cat = stub(&[]);
        let result =
            backfill_agent_categories(&mut storage, &stub_cat, BackfillOptions::default())
                .unwrap();
        assert_eq!(result, BackfillResult::default());
        std::fs::remove_dir_all(&base).ok();
    }
}
