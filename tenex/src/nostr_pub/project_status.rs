//! kind:24010 `TenexProjectStatus` — per-project runtime status event.
//!
//! Event shape:
//!
//! ```text
//! kind    = 24010
//! content = ""
//! tags    = ["a", "31933:<owner_pk>:<d_tag>"]
//!         + ["p", <owner_pk>] (+ ["p", <whitelisted_pk>]..., deduped)
//!         + ["skill", <id>]                              (one per project-scoped skill)
//!         + ["mcp", <name>]                              (one per project MCP server)
//! ```
//!
//! Skills and MCP servers emitted here are **project-scoped** — skills from
//! `{project_path}/.agents/skills/<id>/SKILL.md` and MCP servers from
//! `{project_path}/.mcp.json`. These are the same across every backend that
//! has access to the project directory.
//!
//! Built-in and user-global skills are backend-specific and live on each
//! agent's kind:0 profile, not here. Per-agent assignments and per-agent MCP
//! access are likewise on kind:0. Available agents are on kind:24011.
//!
//! tool/branch/scheduled-task tags are not emitted — they require
//! infrastructure (tool registry, git, scheduler storage) not yet available
//! in the Rust runtime.
//!
//! Signed with the backend signer.

use std::collections::{BTreeSet, HashSet};
use std::path::Path;

use anyhow::{anyhow, Result};
use nostr_sdk::{Event, EventBuilder, Keys, Kind, Tag, TagKind};
use tenex_mcp::ProjectMcpConfig;

use tenex_project::ProjectMetadata;

const KIND: u16 = 24010;

/// Enumerate skill IDs in a directory: every immediate subdirectory that
/// contains a `SKILL.md` file. Returns an empty set if `dir` does not exist.
fn skill_ids_in_dir(dir: &Path) -> HashSet<String> {
    let mut out = HashSet::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() || !path.join("SKILL.md").exists() {
            continue;
        }
        if let Some(id) = path.file_name().and_then(|n| n.to_str()) {
            out.insert(id.to_string());
        }
    }
    out
}

/// Return the set of project-scoped skill IDs (`{project_path}/.agents/skills/`).
pub fn project_scoped_skill_ids(project_path: &Path) -> HashSet<String> {
    skill_ids_in_dir(&project_path.join(".agents").join("skills"))
}

/// Build (but do not send) a kind:24010 project status event.
pub fn build_project_status_event(
    keys: &Keys,
    meta: &ProjectMetadata,
    project_path: &Path,
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
    let universe: BTreeSet<String> = project_scoped_skill_ids(project_path).into_iter().collect();
    for id in &universe {
        tags.push(Tag::custom(
            TagKind::Custom("skill".into()),
            vec![id.clone()],
        ));
    }

    // ─── Project MCP server emission ──────────────────────────────────────────
    let mcp_config = ProjectMcpConfig::load_project(project_path)
        .unwrap_or_default();
    let mcp_names: BTreeSet<String> = mcp_config.servers.keys().cloned().collect();
    for name in &mcp_names {
        tags.push(Tag::custom(
            TagKind::Custom("mcp".into()),
            vec![name.clone()],
        ));
    }

    let event = EventBuilder::new(Kind::Custom(KIND), "")
        .tags(tags)
        .sign_with_keys(keys)
        .map_err(|e| anyhow!("sign project status event: {e}"))?;

    Ok(event)
}
