use anyhow::{anyhow, Result};
use tenex_agent_registry::{AgentCategory, AgentStorage, VALID_CATEGORIES};

use crate::store::llms::LlmsDoc;
use crate::store::project_members::list_assignable_project_dtags;
use crate::tui::{display, prompts};

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

pub fn prompt_required_with_default(message: &str, default: &str) -> Result<Option<String>> {
    loop {
        let value = match prompts::input(message).with_default(default).prompt() {
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

pub fn prompt_category() -> Result<Option<Option<AgentCategory>>> {
    let mut choices: Vec<CategoryChoice> = vec![CategoryChoice {
        label: "none".to_owned(),
        category: None,
    }];
    for cat in VALID_CATEGORIES {
        choices.push(CategoryChoice {
            label: cat.as_str().to_owned(),
            category: Some(*cat),
        });
    }
    match prompts::select("Category:", choices).prompt() {
        Ok(c) => Ok(Some(c.category)),
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => Ok(None),
        Err(e) => Err(anyhow!("category prompt: {e}")),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_from_name_kebab_cases_ascii_names() {
        assert_eq!(slug_from_name("Code Reviewer"), "code-reviewer");
        assert_eq!(slug_from_name("  Agent (v2)! "), "agent-v2");
        assert_eq!(slug_from_name("A---B"), "a-b");
    }
}
