//! Workflow files persisted under `$AGENT_HOME/workflows/<name>.yaml`.
//!
//! Each file defines a named, multi-step procedure the agent can later
//! dispatch via `run_workflow`. The structure intentionally mirrors what an
//! orchestrator would otherwise re-derive from its base system prompt every
//! turn: a `name`, a `description` shown in the prompt fragment, and a
//! `system_prompt` body that drives todo-list generation.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workflow {
    pub name: String,
    pub description: String,
    pub system_prompt: String,
}

pub fn workflows_dir(agent_home: &Path) -> PathBuf {
    agent_home.join("workflows")
}

fn workflow_path(agent_home: &Path, name: &str) -> PathBuf {
    workflows_dir(agent_home).join(format!("{name}.yaml"))
}

/// Reject names that could traverse the workflows directory or collide with
/// hidden files. Workflow names must be a single non-empty path segment
/// containing only `[A-Za-z0-9_-]`.
pub fn validate_name(name: &str) -> Result<()> {
    if name.is_empty() {
        return Err(anyhow!("workflow name must not be empty"));
    }
    if name.len() > 64 {
        return Err(anyhow!("workflow name too long (max 64 chars)"));
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(anyhow!(
            "workflow name must only contain letters, digits, '_' or '-' (got '{name}')"
        ));
    }
    Ok(())
}

pub fn write_workflow(agent_home: &Path, workflow: &Workflow) -> Result<PathBuf> {
    validate_name(&workflow.name)?;
    let dir = workflows_dir(agent_home);
    std::fs::create_dir_all(&dir)
        .map_err(|e| anyhow!("failed to create workflows dir: {e}"))?;
    let path = workflow_path(agent_home, &workflow.name);
    let yaml = serde_yml::to_string(workflow)
        .map_err(|e| anyhow!("failed to serialize workflow: {e}"))?;
    let tmp_path = path.with_extension("yaml.tmp");
    std::fs::write(&tmp_path, yaml).map_err(|e| anyhow!("failed to write workflow: {e}"))?;
    std::fs::rename(&tmp_path, &path)
        .map_err(|e| anyhow!("failed to finalize workflow: {e}"))?;
    Ok(path)
}

pub fn read_workflow(agent_home: &Path, name: &str) -> Result<Workflow> {
    validate_name(name)?;
    let path = workflow_path(agent_home, name);
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| anyhow!("workflow '{name}' not found: {e}"))?;
    let workflow: Workflow = serde_yml::from_str(&raw)
        .map_err(|e| anyhow!("failed to parse workflow '{name}': {e}"))?;
    Ok(workflow)
}

/// List all workflow files under `$AGENT_HOME/workflows/`. Files that fail
/// to parse are skipped (with a stderr log) — a malformed workflow shouldn't
/// stop the agent from booting.
pub fn list_workflows(agent_home: &Path) -> Vec<Workflow> {
    let dir = workflows_dir(agent_home);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };

    let mut workflows: Vec<Workflow> = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            entry
                .file_type()
                .map(|ft| ft.is_file())
                .unwrap_or(false)
                && entry
                    .path()
                    .extension()
                    .and_then(|ext| ext.to_str())
                    == Some("yaml")
        })
        .filter_map(|entry| {
            let raw = std::fs::read_to_string(entry.path()).ok()?;
            match serde_yml::from_str::<Workflow>(&raw) {
                Ok(w) => Some(w),
                Err(e) => {
                    eprintln!(
                        "[tenex-agent] skipping malformed workflow '{}': {e}",
                        entry.path().display()
                    );
                    None
                }
            }
        })
        .collect();

    workflows.sort_by(|a, b| a.name.cmp(&b.name));
    workflows
}

/// Render the `<available-workflows>` system-prompt fragment, or `None`
/// when the agent has no workflow files.
pub fn render_workflows_fragment(workflows: &[Workflow]) -> Option<String> {
    if workflows.is_empty() {
        return None;
    }
    let mut out = String::from(
        "<available-workflows>\n\
You have authored the following workflows. Dispatch one with \
`run_workflow(\"<name>\", \"<task>\")` — that call replaces your current \
todo list with checklist items derived from the workflow's instructions.\n",
    );
    for w in workflows {
        out.push_str(&format!("- {}: {}\n", w.name, w.description));
    }
    out.push_str("</available-workflows>");
    Some(out)
}
