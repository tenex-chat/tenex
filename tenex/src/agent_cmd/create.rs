use anyhow::{anyhow, Result};
use indexmap::IndexMap;
use serde_json::Value;
use tenex_agent_registry::{AgentCategory, AgentDoc, AgentStorage};

use crate::agent_cmd::create_prompts::{
    default_instructions, existing_slugs, maybe_refine_with_llm, prompt_category, prompt_editor,
    prompt_model_config, prompt_optional, prompt_projects, prompt_required, prompt_slug,
    slug_from_name,
};
use crate::nostr_pub::owner_signer::resolve_owner_signer;
use crate::nostr_pub::project_mutation::sync_many_project_memberships;
use crate::tui::{display, prompts};

pub async fn run(base_dir: &std::path::Path) -> Result<()> {
    display::blank();
    display::step(0, 0, "Create Agent");
    display::context("Create a local installed agent, then optionally assign it to projects.");

    let existing_slugs = existing_slugs(base_dir)?;
    let Some(name) = prompt_required("Agent display name:")? else {
        return Ok(());
    };
    let default_slug = slug_from_name(&name);
    let Some(slug) = prompt_slug(&existing_slugs, &default_slug)? else {
        return Ok(());
    };
    let Some(role) = prompt_required("Role / expertise:")? else {
        return Ok(());
    };
    let Some(description) = prompt_optional("One-sentence description:")? else {
        return Ok(());
    };
    let Some(use_criteria) = prompt_optional("Use this agent when:")? else {
        return Ok(());
    };
    let Some(category) = prompt_category()? else {
        return Ok(());
    };
    let Some(model_config) = prompt_model_config(base_dir)? else {
        return Ok(());
    };

    let initial = default_instructions(&name, &role, &description, &use_criteria);
    let Some(mut instructions) = prompt_editor("Initial system prompt", &initial)? else {
        return Ok(());
    };
    instructions = maybe_refine_with_llm(
        base_dir,
        &name,
        &slug,
        &role,
        &description,
        &use_criteria,
        &instructions,
    )
    .await?;

    let Some(projects) = prompt_projects(base_dir)? else {
        return Ok(());
    };

    display::blank();
    display::summary_line("Name", &name);
    display::summary_line("Slug", &slug);
    display::summary_line("Role", &role);
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
        name,
        role,
        description,
        use_criteria,
        instructions,
        model_config,
        category,
    };
    let pubkey = save_created_agent(base_dir, &draft, &projects).await?;
    display::blank();
    display::success(&format!("Created \"{}\" ({})", draft.name, draft.slug));
    display::context(&format!("Pubkey: {pubkey}"));
    Ok(())
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
) -> Result<String> {
    let doc = build_agent_doc(draft)?;
    let mut storage = AgentStorage::open(base_dir)?;
    if storage.slug_exists(&draft.slug) {
        return Err(anyhow!("agent slug '{}' already exists", draft.slug));
    }
    let pubkey = storage.save_agent(&doc)?;
    drop(storage);

    if !projects.is_empty() {
        let keys = resolve_owner_signer(base_dir)?;
        let mut storage = AgentStorage::open(base_dir)?;
        for project in projects {
            storage.add_agent_to_project(&pubkey, project)?;
        }
        drop(storage);
        sync_many_project_memberships(base_dir, &keys, projects).await?;
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
}
