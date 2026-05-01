use anyhow::{anyhow, Result};
use tenex_agent_registry::{AgentCategory, AgentStorage, VALID_CATEGORIES};

use crate::agent_cmd::create_llm;
use crate::store::llms::LlmsDoc;
use crate::store::project_members::list_assignable_project_dtags;
use crate::tui::{display, prompts};

pub async fn maybe_refine_with_llm(
    base_dir: &std::path::Path,
    name: &str,
    slug: &str,
    role: &str,
    description: &str,
    use_criteria: &str,
    draft: &str,
) -> Result<String> {
    let choices = role_choices(base_dir)?;
    if choices.is_empty() {
        display::hint("No LLM roles are configured; keeping the manual system prompt.");
        return Ok(draft.to_owned());
    }
    let use_llm = match prompts::confirm("Use an LLM role to refine the system prompt?")
        .with_default(true)
        .prompt()
    {
        Ok(value) => value,
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => return Ok(draft.to_owned()),
        Err(e) => return Err(anyhow!("LLM refine confirm prompt: {e}")),
    };
    if !use_llm {
        return Ok(draft.to_owned());
    }

    let choice = match prompts::select("LLM role for prompt refinement:", choices).prompt() {
        Ok(choice) => choice,
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => return Ok(draft.to_owned()),
        Err(e) => return Err(anyhow!("LLM role prompt: {e}")),
    };
    let model = match create_llm::resolve_role_model(base_dir, choice.role_key) {
        Ok(model) => model,
        Err(e) => {
            display::hint(&format!("Could not resolve role '{}': {e}", choice.label));
            return Ok(draft.to_owned());
        }
    };
    let prompt =
        create_llm::build_refinement_prompt(name, slug, role, description, use_criteria, draft);
    display::hint(&format!(
        "Refining with {} role ({})...",
        choice.label, choice.config_name
    ));
    let refined = match create_llm::refine_system_prompt(&model, &prompt).await {
        Ok(text) if !text.trim().is_empty() => text,
        Ok(_) => {
            display::hint("LLM returned an empty prompt; keeping the manual system prompt.");
            return Ok(draft.to_owned());
        }
        Err(e) => {
            display::hint(&format!("LLM refinement failed: {e}"));
            return Ok(draft.to_owned());
        }
    };

    let review = match prompts::confirm("Review/edit the refined system prompt?")
        .with_default(true)
        .prompt()
    {
        Ok(value) => value,
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => false,
        Err(e) => return Err(anyhow!("refined prompt review prompt: {e}")),
    };
    if !review {
        return Ok(refined);
    }
    Ok(prompt_editor("Final system prompt", &refined)?.unwrap_or(refined))
}

pub fn prompt_required(message: &str) -> Result<Option<String>> {
    loop {
        let value = match prompts::input(message).prompt() {
            Ok(value) => value.trim().to_owned(),
            Err(inquire::InquireError::OperationCanceled)
            | Err(inquire::InquireError::OperationInterrupted) => return Ok(None),
            Err(e) => return Err(anyhow!("{message} prompt: {e}")),
        };
        if !value.is_empty() {
            return Ok(Some(value));
        }
        display::hint("Enter a non-empty value.");
    }
}

pub fn prompt_optional(message: &str) -> Result<Option<String>> {
    match prompts::input(message).prompt() {
        Ok(value) => Ok(Some(value.trim().to_owned())),
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => Ok(None),
        Err(e) => Err(anyhow!("{message} prompt: {e}")),
    }
}

pub fn prompt_slug(existing: &[String], default_slug: &str) -> Result<Option<String>> {
    loop {
        let value = match prompts::input("Agent slug:")
            .with_default(default_slug)
            .prompt()
        {
            Ok(value) => value.trim().to_owned(),
            Err(inquire::InquireError::OperationCanceled)
            | Err(inquire::InquireError::OperationInterrupted) => return Ok(None),
            Err(e) => return Err(anyhow!("agent slug prompt: {e}")),
        };
        match validate_slug(&value) {
            Ok(()) if !existing.iter().any(|s| s == &value) => return Ok(Some(value)),
            Ok(()) => display::hint("That slug is already in use."),
            Err(msg) => display::hint(msg),
        }
    }
}

pub fn prompt_editor(message: &str, initial: &str) -> Result<Option<String>> {
    match inquire::Editor::new(message)
        .with_render_config(prompts::theme())
        .with_file_extension(".md")
        .with_predefined_text(initial)
        .prompt()
    {
        Ok(value) => Ok(Some(value.trim().to_owned())),
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => Ok(None),
        Err(e) => Err(anyhow!("{message} editor prompt: {e}")),
    }
}

pub fn prompt_category() -> Result<Option<Option<AgentCategory>>> {
    let mut choices = vec![CategoryChoice {
        label: "none".to_owned(),
        category: None,
    }];
    choices.extend(VALID_CATEGORIES.iter().map(|category| CategoryChoice {
        label: category.as_str().to_owned(),
        category: Some(*category),
    }));
    match prompts::select("Agent category:", choices).prompt() {
        Ok(choice) => Ok(Some(choice.category)),
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => Ok(None),
        Err(e) => Err(anyhow!("agent category prompt: {e}")),
    }
}

pub fn prompt_model_config(base_dir: &std::path::Path) -> Result<Option<Option<String>>> {
    let doc = LlmsDoc::load(base_dir)?;
    let configs = doc.config_names();
    if configs.is_empty() {
        display::hint("No LLM configurations found; agent will use the TENEX default.");
        return Ok(Some(None));
    }
    let mut choices = vec![ModelChoice {
        label: "TENEX default".to_owned(),
        config: None,
    }];
    choices.extend(configs.into_iter().map(|config| ModelChoice {
        label: config.clone(),
        config: Some(config),
    }));
    match prompts::select("Agent model config:", choices).prompt() {
        Ok(choice) => Ok(Some(choice.config)),
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => Ok(None),
        Err(e) => Err(anyhow!("agent model prompt: {e}")),
    }
}

pub fn prompt_projects(base_dir: &std::path::Path) -> Result<Option<Vec<String>>> {
    let projects = list_assignable_project_dtags(base_dir)?;
    if projects.is_empty() {
        return Ok(Some(Vec::new()));
    }
    match prompts::multi_select("Assign to projects:", projects.clone()).prompt() {
        Ok(selected) => Ok(Some(selected)),
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => Ok(None),
        Err(e) => Err(anyhow!("project assignment prompt: {e}")),
    }
}

pub fn existing_slugs(base_dir: &std::path::Path) -> Result<Vec<String>> {
    let storage = AgentStorage::open(base_dir)?;
    Ok(storage
        .get_all_stored_agents()?
        .into_iter()
        .filter_map(|(_, agent)| agent.slug().map(str::to_owned))
        .collect())
}

pub fn default_instructions(
    name: &str,
    role: &str,
    description: &str,
    use_criteria: &str,
) -> String {
    format!(
        "You are {name}, {role}.\n\nDescription: {description}\n\nUse criteria: {use_criteria}\n\nBehavior:\n- Stay focused on the requested work.\n- Be explicit about assumptions and tradeoffs.\n- Hand back concise, actionable results."
    )
}

pub fn slug_from_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut last_dash = true;
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    out.trim_matches('-').to_owned()
}

fn role_choices(base_dir: &std::path::Path) -> Result<Vec<RoleChoice>> {
    let doc = LlmsDoc::load(base_dir)?;
    let roles = [
        (
            "Prompt Compilation",
            "promptCompilation",
            doc.prompt_compilation(),
        ),
        ("Default", "default", doc.default_config()),
        ("Supervision", "supervision", doc.supervision()),
        ("Categorization", "categorization", doc.categorization()),
        (
            "Context Discovery",
            "contextDiscovery",
            doc.context_discovery(),
        ),
        ("Summarization", "summarization", doc.summarization()),
        ("Firewall", "firewall", doc.firewall()),
    ];
    Ok(roles
        .into_iter()
        .filter_map(|(label, role_key, config)| {
            config.map(|config_name| RoleChoice {
                label,
                role_key,
                config_name: config_name.to_owned(),
            })
        })
        .collect())
}

fn validate_slug(slug: &str) -> std::result::Result<(), &'static str> {
    if slug.is_empty() {
        return Err("Slug cannot be empty.");
    }
    if slug
        .chars()
        .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
        && !slug.starts_with('-')
        && !slug.ends_with('-')
        && !slug.contains("--")
    {
        Ok(())
    } else {
        Err("Use lowercase letters, numbers, and single hyphens.")
    }
}

#[derive(Clone)]
struct RoleChoice {
    label: &'static str,
    role_key: &'static str,
    config_name: String,
}

impl std::fmt::Display for RoleChoice {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} ({})", self.label, self.config_name)
    }
}

#[derive(Clone)]
struct ModelChoice {
    label: String,
    config: Option<String>,
}

impl std::fmt::Display for ModelChoice {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.label)
    }
}

#[derive(Clone)]
struct CategoryChoice {
    label: String,
    category: Option<AgentCategory>,
}

impl std::fmt::Display for CategoryChoice {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.label)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_from_name_kebab_cases_ascii_names() {
        assert_eq!(slug_from_name("Code Reviewer"), "code-reviewer");
        assert_eq!(slug_from_name("  Agent (v2)! "), "agent-v2");
        assert_eq!(slug_from_name("A---B"), "a-b");
    }

    #[test]
    fn validate_slug_accepts_canonical_slugs() {
        assert!(validate_slug("code-reviewer-2").is_ok());
    }

    #[test]
    fn validate_slug_rejects_ambiguous_slugs() {
        assert!(validate_slug("").is_err());
        assert!(validate_slug("Code").is_err());
        assert!(validate_slug("-code").is_err());
        assert!(validate_slug("code--reviewer").is_err());
    }
}
