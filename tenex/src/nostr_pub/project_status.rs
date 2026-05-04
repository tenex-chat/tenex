//! kind:24010 `TenexProjectStatus` — per-project runtime status event.
//!
//! Event shape:
//!
//! ```text
//! kind    = 24010
//! content = ""
//! tags    = ["a", "31933:<owner_pk>:<d_tag>"]
//!         + ["p", <owner_pk>] (+ ["p", <whitelisted_pk>]..., deduped)
//!         + ["skill", <id>]                              (one per available skill)
//! ```
//!
//! Skills emitted here are the **shared** skill universe available to every
//! agent in the project:
//! - Project-scoped: `{project_path}/.agents/skills/<id>/SKILL.md`
//! - Built-in: `{base_dir}/skills/built-in/<id>/SKILL.md`
//! - User-global: `~/.agents/skills/<id>/SKILL.md`
//!
//! Per-agent assignments are not emitted on 24010 — they live on each agent's
//! kind:0 profile. Agent-home skills (installed per-agent) likewise live
//! exclusively on the agent's kind:0 profile. Agent, model, and MCP tags are
//! NOT emitted here — the available agents are on kind:24011, per-agent
//! capabilities on kind:0.
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

/// Return skill IDs from all shared (non-agent-home) sources:
/// built-in (`{base_dir}/skills/built-in`), user-global (`~/.agents/skills`),
/// and project-scoped (`{project_path}/.agents/skills/`).
fn shared_skill_ids(project_path: &Path, base_dir: &Path) -> HashSet<String> {
    let mut out = project_scoped_skill_ids(project_path);

    for id in skill_ids_in_dir(&base_dir.join("skills").join("built-in")) {
        out.insert(id);
    }

    if let Some(home) = dirs_next::home_dir() {
        for id in skill_ids_in_dir(&home.join(".agents").join("skills")) {
            out.insert(id);
        }
    }

    out
}

/// Build (but do not send) a kind:24010 project status event.
pub fn build_project_status_event(
    keys: &Keys,
    meta: &ProjectMetadata,
    project_path: &Path,
    base_dir: &Path,
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

    // ─── Shared skill emission ────────────────────────────────────────────────
    //
    // Emit one ["skill", <id>] tag per skill present in the shared universe
    // (project-scoped ∪ built-in ∪ user-global). Per-agent assignments are
    // carried on each agent's kind:0 profile, not here.
    let universe: BTreeSet<String> = shared_skill_ids(project_path, base_dir).into_iter().collect();
    for id in &universe {
        tags.push(Tag::custom(
            TagKind::Custom("skill".into()),
            vec![id.clone()],
        ));
    }

    let event = EventBuilder::new(Kind::Custom(KIND), "")
        .tags(tags)
        .sign_with_keys(keys)
        .map_err(|e| anyhow!("sign project status event: {e}"))?;

    Ok(event)
}
