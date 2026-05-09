use anyhow::{anyhow, Result};
use indexmap::IndexMap;
use serde_json::Value;
use tenex_agent_registry::{AgentCategory, AgentDoc, AgentStorage};

use crate::agent_cmd::create_llm;
use crate::agent_cmd::create_prompts::{
    existing_slugs, prompt_category, prompt_editor, prompt_model_config, prompt_optional,
    prompt_projects, prompt_required, prompt_required_with_default, slug_from_name,
};
use crate::nostr_pub::owner_signer::try_resolve_owner_signer;
use crate::nostr_pub::project_mutation::sync_many_project_memberships;
use crate::tui::{display, prompts};
use nostr_sdk::Keys;

pub async fn run(base_dir: &std::path::Path) -> Result<()> {
    display::blank();
    display::step(0, 0, "Create Agent");

    let supervision_model = create_llm::resolve_supervision_model(base_dir).ok();
    let existing = existing_slugs(base_dir)?;

    let partial = match supervision_model.as_ref() {
        Some(model) => {
            display::context(
                "Describe the agent and the LLM will fill in the details. \
                 Press Esc to fill in the fields manually.",
            );
            match prompt_required("Describe the agent you want to create:")? {
                Some(description) => {
                    display::hint("Generating agent definition…");
                    match create_llm::generate_agent_from_description(model, &description).await {
                        Ok(generated) => DraftPartial::from_generated(generated),
                        Err(e) => {
                            display::hint(&format!("LLM generation failed: {e}"));
                            return Ok(());
                        }
                    }
                }
                None => match prompt_manual_fields(&existing)? {
                    Some(p) => p,
                    None => return Ok(()),
                },
            }
        }
        None => {
            display::context("Supervision LLM is not configured. Filling in fields manually.");
            match prompt_manual_fields(&existing)? {
                Some(p) => p,
                None => return Ok(()),
            }
        }
    };

    let base_slug = slug_from_name(&partial.slug);
    let slug = ensure_unique_slug(&base_slug, &existing);

    display::blank();
    display::summary_line("Name", &partial.name);
    display::summary_line("Slug", &slug);
    display::summary_line("Role", &partial.role);
    if !partial.description.is_empty() {
        display::summary_line("Description", &partial.description);
    }
    if !partial.use_criteria.is_empty() {
        display::summary_line("Use when", &partial.use_criteria);
    }
    display::summary_line(
        "Category",
        partial.category.map(|c| c.as_str()).unwrap_or("none"),
    );

    let editor_label = if partial.instructions.is_empty() {
        "System prompt"
    } else {
        "Review system prompt"
    };
    let Some(instructions) = prompt_editor(editor_label, &partial.instructions)? else {
        return Ok(());
    };

    let Some(model_config) = prompt_model_config(base_dir)? else {
        return Ok(());
    };

    // Project assignment publishes a kind:31933 update, which needs an owner
    // signer. When none is configured we skip the prompt entirely — the agent
    // is created locally with no project memberships.
    let owner_keys: Option<Keys> = try_resolve_owner_signer(base_dir)?;
    let projects: Vec<String> = if owner_keys.is_some() {
        let Some(selected) = prompt_projects(base_dir)? else {
            return Ok(());
        };
        selected
    } else {
        Vec::new()
    };

    display::blank();
    display::summary_line("Name", &partial.name);
    display::summary_line("Slug", &slug);
    display::summary_line("Role", &partial.role);
    display::summary_line("Model", model_config.as_deref().unwrap_or("TENEX default"));
    let projects_summary = if projects.is_empty() {
        "none".to_owned()
    } else {
        projects.join(", ")
    };
    display::summary_line("Projects", &projects_summary);

    let confirmed = match prompts::confirm("Create this agent?")
        .with_default(true)
        .prompt()
    {
        Ok(value) => value,
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => return Ok(()),
        Err(e) => return Err(anyhow!("create confirm prompt: {e}")),
    };
    if !confirmed {
        return Ok(());
    }

    let draft = AgentCreateDraft {
        slug,
        name: partial.name,
        role: partial.role,
        description: partial.description,
        use_criteria: partial.use_criteria,
        instructions,
        model_config,
        category: partial.category,
    };
    let pubkey = save_created_agent(base_dir, &draft, &projects, owner_keys.as_ref()).await?;
    display::blank();
    display::success(&format!("Created \"{}\" ({})", draft.name, draft.slug));
    display::context(&format!("Pubkey: {pubkey}"));
    Ok(())
}

#[derive(Debug, Clone)]
struct DraftPartial {
    name: String,
    slug: String,
    role: String,
    description: String,
    use_criteria: String,
    category: Option<AgentCategory>,
    instructions: String,
}

impl DraftPartial {
    fn from_generated(g: create_llm::AgentGenerationResult) -> Self {
        Self {
            name: g.name,
            slug: g.slug,
            role: g.role,
            description: g.description,
            use_criteria: g.use_criteria,
            category: g.category,
            instructions: g.instructions,
        }
    }
}

fn prompt_manual_fields(existing: &[String]) -> Result<Option<DraftPartial>> {
    let Some(name) = prompt_required("Name:")? else {
        return Ok(None);
    };
    let suggested_slug = slug_from_name(&name);
    let suggested_slug = ensure_unique_slug(&suggested_slug, existing);
    let Some(slug) = prompt_required_with_default("Slug:", &suggested_slug)? else {
        return Ok(None);
    };
    let Some(role) = prompt_required("Role:")? else {
        return Ok(None);
    };
    let Some(description) = prompt_optional("Description (optional):")? else {
        return Ok(None);
    };
    let Some(use_criteria) = prompt_optional("Use when (optional):")? else {
        return Ok(None);
    };
    let Some(category) = prompt_category()? else {
        return Ok(None);
    };
    Ok(Some(DraftPartial {
        name,
        slug,
        role,
        description,
        use_criteria,
        category,
        instructions: String::new(),
    }))
}

fn ensure_unique_slug(base: &str, existing: &[String]) -> String {
    if !existing.iter().any(|s| s == base) {
        return base.to_owned();
    }
    let mut n = 2u32;
    loop {
        let candidate = format!("{base}-{n}");
        if !existing.iter().any(|s| s == &candidate) {
            return candidate;
        }
        n += 1;
    }
}

#[derive(Debug, Clone)]
struct AgentCreateDraft {
    slug: String,
    name: String,
    role: String,
    description: String,
    use_criteria: String,
    instructions: String,
    model_config: Option<String>,
    category: Option<AgentCategory>,
}

async fn save_created_agent(
    base_dir: &std::path::Path,
    draft: &AgentCreateDraft,
    projects: &[String],
    owner_keys: Option<&Keys>,
) -> Result<String> {
    let doc = build_agent_doc(draft)?;
    let mut storage = AgentStorage::open(base_dir)?;
    if storage.slug_exists(&draft.slug) {
        return Err(anyhow!("agent slug '{}' already exists", draft.slug));
    }
    let pubkey = storage.save_agent(&doc)?;
    drop(storage);

    if !projects.is_empty() {
        let keys = owner_keys.ok_or_else(|| {
            anyhow!("create flow received project assignments without an owner signer")
        })?;
        let mut storage = AgentStorage::open(base_dir)?;
        for project in projects {
            storage.add_agent_to_project(&pubkey, project)?;
        }
        drop(storage);
        sync_many_project_memberships(base_dir, keys, projects).await?;
    }

    if let Err(e) =
        crate::nostr_pub::installed_agents::publish_installed_agents_inventory(base_dir).await
    {
        eprintln!(
            "{}",
            crate::tui::theme::chalk_yellow(&format!(
                "Warning: failed to publish installed-agent inventory: {e}"
            )),
        );
    }

    Ok(pubkey)
}

fn build_agent_doc(draft: &AgentCreateDraft) -> Result<AgentDoc> {
    let nsec = tenex_agent_registry::generate_nsec_bech32()?;
    let mut raw = IndexMap::<String, Value>::new();
    raw.insert("nsec".into(), Value::String(nsec));
    raw.insert("slug".into(), Value::String(draft.slug.clone()));
    raw.insert("name".into(), Value::String(draft.name.clone()));
    raw.insert("role".into(), Value::String(draft.role.clone()));
    raw.insert("status".into(), Value::String("active".into()));
    insert_nonempty(&mut raw, "description", &draft.description);
    insert_nonempty(&mut raw, "instructions", &draft.instructions);
    insert_nonempty(&mut raw, "useCriteria", &draft.use_criteria);
    if let Some(category) = draft.category {
        raw.insert("category".into(), Value::String(category.as_str().into()));
    }
    if let Some(model) = draft.model_config.as_ref().filter(|s| !s.trim().is_empty()) {
        let mut default = serde_json::Map::new();
        default.insert("model".into(), Value::String(model.trim().to_owned()));
        raw.insert("default".into(), Value::Object(default));
    }
    Ok(AgentDoc::from_raw(raw))
}

fn insert_nonempty(raw: &mut IndexMap<String, Value>, key: &str, value: &str) {
    let trimmed = value.trim();
    if !trimmed.is_empty() {
        raw.insert(key.into(), Value::String(trimmed.to_owned()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_agent_doc_writes_expected_fields() {
        let draft = AgentCreateDraft {
            slug: "planner".into(),
            name: "Planner".into(),
            role: "planning specialist".into(),
            description: "Plans work".into(),
            use_criteria: "Use for planning".into(),
            instructions: "Plan carefully".into(),
            model_config: Some("smart".into()),
            category: Some(AgentCategory::Orchestrator),
        };
        let doc = build_agent_doc(&draft).unwrap();
        assert_eq!(doc.slug(), Some("planner"));
        assert_eq!(doc.name(), Some("Planner"));
        assert_eq!(doc.role(), Some("planning specialist"));
        assert_eq!(doc.instructions(), Some("Plan carefully"));
        assert_eq!(doc.use_criteria(), Some("Use for planning"));
        assert_eq!(doc.category(), Some(AgentCategory::Orchestrator));
        assert_eq!(
            doc.raw()
                .get("default")
                .and_then(Value::as_object)
                .and_then(|obj| obj.get("model"))
                .and_then(Value::as_str),
            Some("smart"),
        );
        assert!(doc.nsec().unwrap_or_default().starts_with("nsec1"));
    }

    #[test]
    fn ensure_unique_slug_returns_base_when_no_conflict() {
        assert_eq!(ensure_unique_slug("foo", &[]), "foo");
        assert_eq!(ensure_unique_slug("foo", &["bar".to_owned()]), "foo");
    }

    #[test]
    fn ensure_unique_slug_appends_suffix_on_conflict() {
        let existing = vec!["foo".to_owned()];
        assert_eq!(ensure_unique_slug("foo", &existing), "foo-2");
        let existing = vec!["foo".to_owned(), "foo-2".to_owned()];
        assert_eq!(ensure_unique_slug("foo", &existing), "foo-3");
    }
}
