//! LLM-prompt helpers for agent categorization.
//!
//! The registry owns these because the orchestrator (in the CLI crate)
//! and the runtime backfill path (in `tenex-agent`) both need them. The
//! actual LLM call lives at each consumer; this module is sync, no
//! network deps.

use regex::Regex;
use serde_json::Value;

use crate::category::{is_valid_category, AgentCategory, VALID_CATEGORIES};
use crate::doc::AgentDoc;

/// Per-agent metadata fed to the LLM.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentMetadata {
    pub name: String,
    pub role: String,
    pub description: Option<String>,
    pub instructions: Option<String>,
    pub use_criteria: Option<String>,
}

/// Build the LLM system prompt for category classification.
///
/// The trailing `Valid categories: <list>` line is generated from
/// [`VALID_CATEGORIES`] so adding/removing a category updates the prompt
/// automatically.
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

/// Parse a category from an LLM response.
///
/// 1. Trim, lowercase, and check for a direct match against the canonical
///    literal set.
/// 2. Otherwise scan the raw input (case-insensitive, word-boundary
///    bracketed) for the first canonical literal.
/// 3. Returns `None` if neither yields a valid category.
pub fn parse_category(raw: &str) -> Option<AgentCategory> {
    let normalized = raw.trim().to_lowercase();
    if is_valid_category(&normalized) {
        return AgentCategory::from_str_strict(&normalized);
    }

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

/// Build the LLM user prompt from agent metadata.
///
/// Up to five lines from non-empty fields, in this order: `Name`, `Role`,
/// `Description`, `Use criteria`, `Instructions excerpt` (instructions
/// truncated to 500 chars on a Rust char boundary). Joined with `\n`,
/// no trailing newline.
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

/// Convenience: pull the prompt inputs straight off an agent's on-disk
/// raw map (skips the typed `AgentDoc` path so callers without an
/// `AgentDoc` can use it).
pub fn metadata_from_raw(raw: &indexmap::IndexMap<String, Value>) -> AgentMetadata {
    let s = |k: &str| raw.get(k).and_then(Value::as_str);
    AgentMetadata {
        name: s("name").unwrap_or("").to_owned(),
        role: s("role").unwrap_or("").to_owned(),
        description: s("description").map(str::to_owned),
        instructions: s("instructions").map(str::to_owned),
        use_criteria: s("useCriteria").map(str::to_owned),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use indexmap::IndexMap;

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

    #[test]
    fn system_prompt_full_output_pinned() {
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

    #[test]
    fn parse_category_direct_match_after_trim_and_lowercase() {
        assert_eq!(parse_category("worker"), Some(AgentCategory::Worker));
        assert_eq!(parse_category("WORKER"), Some(AgentCategory::Worker));
        assert_eq!(
            parse_category("  reviewer \n"),
            Some(AgentCategory::Reviewer)
        );
        assert_eq!(
            parse_category("DOMAIN-EXPERT"),
            Some(AgentCategory::DomainExpert)
        );
    }

    #[test]
    fn parse_category_extracts_from_verbose_llm_output() {
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
        assert_eq!(parse_category("subject matter expert"), None);
    }

    #[test]
    fn parse_category_word_boundary_does_not_match_substring() {
        assert_eq!(parse_category("the agent has domain-expertise"), None);
        assert_eq!(
            parse_category("agent classified as domain-expert today"),
            Some(AgentCategory::DomainExpert)
        );
    }

    #[test]
    fn parse_category_first_match_wins_when_multiple_present() {
        assert_eq!(
            parse_category("worker, then reviewer"),
            Some(AgentCategory::Worker)
        );
    }

    #[test]
    fn parse_category_case_insensitive_match_returns_lowercase_canonical() {
        assert_eq!(
            parse_category("This is a Reviewer in disguise"),
            Some(AgentCategory::Reviewer)
        );
    }

    #[test]
    fn build_user_prompt_full_output_pinned() {
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
        assert_eq!(build_user_prompt(&m), "Name: Solo");
    }

    #[test]
    fn build_user_prompt_omits_empty_string_optional_fields() {
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
        let m = AgentMetadata {
            name: "Solo".into(),
            role: "".into(),
            description: Some("d".into()),
            instructions: None,
            use_criteria: Some("u".into()),
        };
        assert_eq!(
            build_user_prompt(&m),
            "Name: Solo\nDescription: d\nUse criteria: u"
        );
    }
}
