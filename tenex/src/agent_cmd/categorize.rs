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
use regex::Regex;

use crate::store::agent_storage::{
    derive_agent_pubkey_from_nsec, AgentDoc, AgentStorage,
};
use crate::store::role_categories::{is_valid_category, AgentCategory, VALID_CATEGORIES};

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

/// Mirror `SYSTEM_PROMPT` (`categorizeAgent.ts:13-24`).
///
/// The trailing `Valid categories: <list>` line is generated from
/// [`VALID_CATEGORIES`] joined with `", "` — keeping the source-of-truth
/// in [`crate::store::role_categories`] so adding/removing a category
/// updates the prompt automatically. Built lazily because formatting at
/// item-init isn't available for `static`.
pub fn system_prompt() -> String {
    let valid: Vec<&str> = VALID_CATEGORIES.iter().map(|c| c.as_str()).collect();
    let valid_joined = valid.join(", ");
    format!(
        "You classify TENEX agents into exactly one category.\n\
         \n\
         Choose one of these values only:\n\
         - principal: the human user or a direct human representative\n\
         - orchestrator: routes, delegates, and coordinates work across agents\n\
         - worker: implements tasks directly and makes changes\n\
         - reviewer: evaluates quality, validates work, and enforces standards\n\
         - domain-expert: has deep specialist knowledge in a specific domain\n\
         - generalist: a broad-purpose agent that does not fit the other roles\n\
         \n\
         Return only the category name. No explanation, no punctuation, no extra text.\n\
         Valid categories: {valid_joined}"
    )
}

/// Mirror `parseCategory` (`categorizeAgent.ts:35-48`).
///
/// Two-step parse:
/// 1. Trim, lowercase, and check against [`is_valid_category`] for the
///    direct-match fast path (`"  reviewer\n"` → `Reviewer`).
/// 2. Otherwise, scan the raw input (case-insensitive, word-boundary
///    bracketed) for the first canonical literal and return that.
/// 3. Returns `None` if neither yields a valid category.
///
/// The regex is `\b(<cat1>|<cat2>|...)\b` with case-insensitive flag.
/// The word-boundary anchors ensure `expert` doesn't match inside
/// `domain-expert` (TS uses the JS regex `\b`; Rust's `regex` crate
/// matches that semantics).
pub fn parse_category(raw: &str) -> Option<AgentCategory> {
    let normalized = raw.trim().to_lowercase();
    if is_valid_category(&normalized) {
        return AgentCategory::from_str_strict(&normalized);
    }

    // Build the alternation. Order is canonical-declaration order.
    // `regex::escape` mirrors the TS `escapeRegex` helper at
    // `categorizeAgent.ts:26-28`. The `(?i)` inline flag matches the TS
    // `/.../i` flag.
    let alternation = VALID_CATEGORIES
        .iter()
        .map(|c| regex::escape(c.as_str()))
        .collect::<Vec<_>>()
        .join("|");
    let pattern = format!(r"(?i)\b({alternation})\b");
    let re = Regex::new(&pattern).expect("valid alternation regex");

    let captures = re.captures(raw)?;
    let candidate = captures.get(1)?.as_str().to_lowercase();
    AgentCategory::from_str_strict(&candidate)
}

/// Mirror `buildUserPrompt` (`categorizeAgent.ts:50-63`).
///
/// Assembles up to five lines from non-empty metadata fields, in this
/// order:
///
/// - `Name: <metadata.name>` (always present — TS treats name as
///   required; the Rust port mirrors that)
/// - `Role: <metadata.role>` (only when non-empty — TS guard:
///   `metadata.role ? ... : undefined` then filter-Boolean)
/// - `Description: <metadata.description>` (only when present)
/// - `Use criteria: <metadata.useCriteria>` (only when present)
/// - `Instructions excerpt: <metadata.instructions[..500]>` (only when
///   present — truncated to 500 *characters*, matching TS `String.slice`
///   semantics on a UTF-16 string but applied on Rust char boundaries
///   to avoid mid-codepoint slices)
///
/// Lines are joined with `\n` (single newline, no trailing newline).
pub fn build_user_prompt(metadata: &AgentMetadata) -> String {
    let mut parts: Vec<String> = Vec::with_capacity(5);
    parts.push(format!("Name: {}", metadata.name));
    if !metadata.role.is_empty() {
        parts.push(format!("Role: {}", metadata.role));
    }
    if let Some(desc) = metadata.description.as_deref() {
        if !desc.is_empty() {
            parts.push(format!("Description: {desc}"));
        }
    }
    if let Some(uc) = metadata.use_criteria.as_deref() {
        if !uc.is_empty() {
            parts.push(format!("Use criteria: {uc}"));
        }
    }
    if let Some(inst) = metadata.instructions.as_deref() {
        if !inst.is_empty() {
            // TS `metadata.instructions.slice(0, 500)` — UTF-16
            // codepoint indexing. Use char-boundary truncation here.
            let truncated: String = inst.chars().take(500).collect();
            parts.push(format!("Instructions excerpt: {truncated}"));
        }
    }
    parts.join("\n")
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

    // ── system_prompt ──────────────────────────────────────────────────

    #[test]
    fn system_prompt_full_output_byte_for_byte_match_ts_template() {
        // Pin every byte against the TS template at categorizeAgent.ts:13-24.
        let prompt = system_prompt();
        let expected = "\
You classify TENEX agents into exactly one category.

Choose one of these values only:
- principal: the human user or a direct human representative
- orchestrator: routes, delegates, and coordinates work across agents
- worker: implements tasks directly and makes changes
- reviewer: evaluates quality, validates work, and enforces standards
- domain-expert: has deep specialist knowledge in a specific domain
- generalist: a broad-purpose agent that does not fit the other roles

Return only the category name. No explanation, no punctuation, no extra text.
Valid categories: principal, orchestrator, worker, reviewer, domain-expert, generalist";
        assert_eq!(prompt, expected);
    }

    // ── parse_category ─────────────────────────────────────────────────

    #[test]
    fn parse_category_direct_match_after_trim_and_lowercase() {
        // Fast-path: input trims + lowercases to a canonical literal.
        assert_eq!(parse_category("worker"), Some(AgentCategory::Worker));
        assert_eq!(parse_category("WORKER"), Some(AgentCategory::Worker));
        assert_eq!(parse_category("  reviewer \n"), Some(AgentCategory::Reviewer));
        assert_eq!(
            parse_category("DOMAIN-EXPERT"),
            Some(AgentCategory::DomainExpert)
        );
    }

    #[test]
    fn parse_category_extracts_from_verbose_llm_output() {
        // Mirror TS test (`categorizeAgent.test.ts:39`) — verbose
        // wrapping text but the canonical literal appears bracketed by
        // word boundaries.
        assert_eq!(
            parse_category("The agent is a domain-expert in NDK"),
            Some(AgentCategory::DomainExpert)
        );
        assert_eq!(
            parse_category("Best fit: orchestrator."),
            Some(AgentCategory::Orchestrator)
        );
    }

    #[test]
    fn parse_category_returns_none_when_no_canonical_literal_present() {
        assert_eq!(parse_category(""), None);
        assert_eq!(parse_category("   "), None);
        assert_eq!(parse_category("nothing useful here"), None);
        // "expert" alone (without "domain-") is not a canonical literal.
        assert_eq!(parse_category("subject matter expert"), None);
    }

    #[test]
    fn parse_category_word_boundary_does_not_match_substring() {
        // `domain-expertise` should NOT match `domain-expert` — the
        // trailing `i` after `-expert` breaks the trailing word
        // boundary. Conversely `-expert` alone (no trailing letter)
        // does match.
        assert_eq!(parse_category("the agent has domain-expertise"), None);
        assert_eq!(
            parse_category("agent classified as domain-expert today"),
            Some(AgentCategory::DomainExpert)
        );
    }

    #[test]
    fn parse_category_first_match_wins_when_multiple_present() {
        // Regex returns the first match in the input. If two canonical
        // literals appear, the leftmost wins (TS `regex.exec` returns
        // the first match too).
        assert_eq!(
            parse_category("worker, then reviewer"),
            Some(AgentCategory::Worker)
        );
    }

    #[test]
    fn parse_category_case_insensitive_match_returns_lowercase_canonical() {
        // The regex flag is `(?i)` — uppercase input matches but the
        // returned category enum is the canonical lowercase one.
        assert_eq!(
            parse_category("This is a Reviewer in disguise"),
            Some(AgentCategory::Reviewer)
        );
    }

    // ── build_user_prompt ──────────────────────────────────────────────

    #[test]
    fn build_user_prompt_full_byte_for_byte_match_ts_template() {
        // All five fields populated → all five lines, in canonical order.
        let m = AgentMetadata {
            name: "Build Bot".into(),
            role: "code writer".into(),
            description: Some("ships changes".into()),
            instructions: Some("Be careful.".into()),
            use_criteria: Some("when code needs writing".into()),
        };
        let prompt = build_user_prompt(&m);
        let expected = "\
Name: Build Bot
Role: code writer
Description: ships changes
Use criteria: when code needs writing
Instructions excerpt: Be careful.";
        assert_eq!(prompt, expected);
    }

    #[test]
    fn build_user_prompt_omits_empty_optional_fields() {
        let m = AgentMetadata {
            name: "Solo".into(),
            role: "".into(),
            description: None,
            instructions: None,
            use_criteria: None,
        };
        // Only `Name:` line should remain.
        assert_eq!(build_user_prompt(&m), "Name: Solo");
    }

    #[test]
    fn build_user_prompt_omits_empty_string_optional_fields() {
        // TS `metadata.description ? ... : undefined` treats `""` as
        // falsy. Mirror that: empty-string optionals do not produce a
        // line.
        let m = AgentMetadata {
            name: "Solo".into(),
            role: "".into(),
            description: Some("".into()),
            instructions: Some("".into()),
            use_criteria: Some("".into()),
        };
        assert_eq!(build_user_prompt(&m), "Name: Solo");
    }

    #[test]
    fn build_user_prompt_truncates_instructions_to_500_chars() {
        // Build an 800-char instructions string; expect 500 in output.
        let inst: String = "x".repeat(800);
        let m = AgentMetadata {
            name: "n".into(),
            role: "".into(),
            description: None,
            instructions: Some(inst),
            use_criteria: None,
        };
        let prompt = build_user_prompt(&m);
        let last_line = prompt.lines().last().unwrap();
        assert!(last_line.starts_with("Instructions excerpt: "));
        let payload = &last_line["Instructions excerpt: ".len()..];
        assert_eq!(payload.chars().count(), 500);
    }

    #[test]
    fn build_user_prompt_handles_multibyte_instructions_without_panicking() {
        // Mid-codepoint slicing in TS would emit lone surrogates; in
        // Rust we slice on char boundaries. Pin: 800 'é' chars (2 bytes
        // each) → first 500 chars in output.
        let inst: String = "é".repeat(800);
        let m = AgentMetadata {
            name: "n".into(),
            role: "".into(),
            description: None,
            instructions: Some(inst),
            use_criteria: None,
        };
        let prompt = build_user_prompt(&m);
        let last_line = prompt.lines().last().unwrap();
        let payload = &last_line["Instructions excerpt: ".len()..];
        assert_eq!(payload.chars().count(), 500);
    }

    #[test]
    fn build_user_prompt_field_order_is_canonical_in_partial_input() {
        // Skip role, keep description, drop instructions, keep useCriteria.
        let m = AgentMetadata {
            name: "Solo".into(),
            role: "".into(),
            description: Some("d".into()),
            instructions: None,
            use_criteria: Some("u".into()),
        };
        // Order from TS: Name, Role, Description, Use criteria, Instructions excerpt.
        // With role/instructions omitted: Name, Description, Use criteria.
        assert_eq!(
            build_user_prompt(&m),
            "Name: Solo\nDescription: d\nUse criteria: u"
        );
    }
}
