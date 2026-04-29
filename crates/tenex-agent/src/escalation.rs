//! Escalation agent resolution.
//!
//! Reads `escalation.agent` from `~/.tenex/config.json` and resolves the
//! configured slug to a pubkey. The pubkey is looked up first in the project's
//! known agents list; if missing there, the global agent index is consulted.
//!
//! The resolved pubkey is passed to [`crate::tools::ask::AskTool`] at
//! construction time so the ask tool can route to the escalation agent instead
//! of the owner when appropriate.

use std::path::Path;

use tenex_agent_registry::AgentIndexDoc;
use tenex_project::Agent;

/// Resolve the escalation agent's pubkey from config and agent registries.
///
/// Returns `None` if:
/// - no `escalation.agent` slug is configured,
/// - the config file cannot be read, or
/// - the slug cannot be resolved to a pubkey.
///
/// Callers should fall back to the owner pubkey on `None`.
pub fn resolve_escalation_pubkey(base_dir: &Path, project_agents: &[Agent]) -> Option<String> {
    let slug = read_escalation_slug(base_dir)?;

    // Fast path: agent is already a member of the current project.
    if let Some(agent) = project_agents.iter().find(|a| a.slug == slug) {
        return Some(agent.pubkey.clone());
    }

    // Slow path: look up in the global agent index.
    let index = AgentIndexDoc::load(base_dir).ok()?;
    index.lookup_pubkey_by_slug(&slug).map(str::to_owned)
}

/// Read `escalation.agent` from `<base_dir>/config.json`.
///
/// Returns `None` if the file is missing, unreadable, or the field is absent.
fn read_escalation_slug(base_dir: &Path) -> Option<String> {
    let path = base_dir.join("config.json");
    let bytes = std::fs::read(&path).ok()?;
    let raw: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    raw.get("escalation")
        .and_then(|e| e.get("agent"))
        .and_then(|a| a.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}
