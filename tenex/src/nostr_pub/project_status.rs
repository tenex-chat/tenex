//! kind:24010 `TenexProjectStatus` — per-project runtime status event.
//!
//! Mirrors `ProjectStatusService.createStatusEvent` +
//! `publishStatusEvent` (src/services/status/ProjectStatusService.ts).
//!
//! Event shape:
//!
//! ```text
//! kind    = 24010
//! content = ""
//! tags    = ["a", "31933:<owner_pk>:<d_tag>"]
//!         + ["p", <owner_pk>] (+ ["p", <whitelisted_pk>]..., deduped)
//!         + ["skill", <id>]                              (universe — project-scoped only)
//!         + ["skill", <id>, <slug_1>, <slug_2>, ...]     (assignments — agents that enabled it)
//! ```
//!
//! Skills emitted here are **only** project-scoped — the flat per-project
//! source `{project_path}/.agents/skills/<id>/SKILL.md`. The skill universe
//! is shared across all agents in the project; per-agent assignments come
//! from each agent's `default_config_json["skills"]`. All other skill scopes
//! (built-in, agent-home, user-global) live on the per-agent kind:34011 events.
//!
//! Agent, model, and MCP tags are NOT emitted on 24010 — the available agents
//! on a backend are published on kind:24011 (`TenexInstalledAgentList`), and
//! per-agent model/MCP capabilities live on the per-agent kind:34011 events.
//!
//! tool/branch/scheduled-task tags are not emitted — they require
//! infrastructure (tool registry, git, scheduler storage) not yet available
//! in the Rust runtime.
//!
//! Signed with the backend signer.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::Path;

use anyhow::{anyhow, Result};
use nostr_sdk::{Event, EventBuilder, Keys, Kind, Tag, TagKind};
use serde_json::Value;

use tenex_project::{Agent, ProjectMetadata};

const KIND: u16 = 24010;

/// Return the set of project-scoped skill IDs available in this project.
///
/// Reads `{project_path}/.agents/skills/` (flat, shared across all agents in
/// the project) and includes every subdirectory that contains a `SKILL.md`
/// file. Returns an empty set if the directory does not exist (does not panic).
pub fn project_scoped_skill_ids(project_path: &Path) -> HashSet<String> {
    let dir = project_path.join(".agents").join("skills");

    let mut out = HashSet::new();
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if !path.join("SKILL.md").exists() {
            continue;
        }
        if let Some(id) = path.file_name().and_then(|n| n.to_str()) {
            out.insert(id.to_string());
        }
    }
    out
}

/// Pull the array of enabled skill IDs out of an agent's `default_config_json`.
fn parse_enabled_skill_ids(agent: &Agent) -> HashSet<String> {
    let mut out = HashSet::new();
    let Some(raw) = agent.default_config_json.as_deref() else {
        return out;
    };
    let Ok(Value::Object(map)) = serde_json::from_str::<Value>(raw) else {
        return out;
    };
    if let Some(Value::Array(skills)) = map.get("skills") {
        for v in skills {
            if let Some(s) = v.as_str() {
                if !s.is_empty() {
                    out.insert(s.to_string());
                }
            }
        }
    }
    out
}

/// Build (but do not send) a kind:24010 project status event.
pub fn build_project_status_event(
    keys: &Keys,
    meta: &ProjectMetadata,
    project_path: &Path,
    agents: &[Agent],
    whitelisted_pubkeys: &[String],
) -> Result<Event> {
    let owner_pk = meta
        .owner_pubkey
        .as_deref()
        .ok_or_else(|| anyhow!("project metadata has no owner_pubkey"))?;
    let project_ref = format!("31933:{}:{}", owner_pk, meta.d_tag);

    let mut tags: Vec<Tag> = Vec::new();

    tags.push(Tag::parse(["a", project_ref.as_str()]).map_err(|e| anyhow!("a tag: {e}"))?);

    // p-tags: owner first, then whitelisted (deduped)
    let mut seen = HashSet::new();
    for pk in std::iter::once(owner_pk).chain(whitelisted_pubkeys.iter().map(String::as_str)) {
        if seen.insert(pk) {
            tags.push(Tag::parse(["p", pk]).map_err(|e| anyhow!("p tag: {e}"))?);
        }
    }

    // ─── Project-scoped skill emission ────────────────────────────────────────
    //
    // The skill universe is a single set per project (flat directory, shared
    // across all agents). Per-agent assignments come from each agent's
    // `default_config_json["skills"]`; an agent "owns" an assignment iff the
    // skill is present in the project universe AND listed in its config.
    let on_disk: HashSet<String> = project_scoped_skill_ids(project_path);
    let universe: BTreeSet<String> = on_disk.iter().cloned().collect();
    let mut assignments: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();

    for agent in agents {
        let enabled = parse_enabled_skill_ids(agent);
        for id in enabled.intersection(&on_disk) {
            assignments
                .entry(id.clone())
                .or_default()
                .insert(agent.slug.clone());
        }
    }

    // Pass 2: emit tags grouped by skill ID, sorted ascending.
    for id in &universe {
        tags.push(Tag::custom(
            TagKind::Custom("skill".into()),
            vec![id.clone()],
        ));
        if let Some(slugs) = assignments.get(id) {
            if !slugs.is_empty() {
                let mut vals = vec![id.clone()];
                vals.extend(slugs.iter().cloned());
                tags.push(Tag::custom(TagKind::Custom("skill".into()), vals));
            }
        }
    }

    let event = EventBuilder::new(Kind::Custom(KIND), "")
        .tags(tags)
        .sign_with_keys(keys)
        .map_err(|e| anyhow!("sign project status event: {e}"))?;

    Ok(event)
}
