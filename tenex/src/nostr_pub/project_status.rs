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
//!         + ["agent", <pk>, <slug>]  or  ["agent", <pk>, <slug>, "pm"]
//! ```
//!
//! Model, MCP, and skill tags are NOT emitted on 24010 — every per-agent
//! capability lives on the per-agent kind:34011 events.
//!
//! tool/branch/scheduled-task tags are not emitted — they require
//! infrastructure (tool registry, git, scheduler storage) not yet available
//! in the Rust runtime.
//!
//! Signed with the backend signer.

use std::collections::HashSet;

use anyhow::{anyhow, Result};
use nostr_sdk::{Event, EventBuilder, Keys, Kind, Tag, TagKind};

use tenex_project::{models::ProjectAgent, Agent, ProjectMetadata};

const KIND: u16 = 24010;

/// Build (but do not send) a kind:24010 project status event.
pub fn build_project_status_event(
    keys: &Keys,
    meta: &ProjectMetadata,
    agents: &[Agent],
    project_agents: &[ProjectAgent],
    whitelisted_pubkeys: &[String],
) -> Result<Event> {
    let owner_pk = meta
        .owner_pubkey
        .as_deref()
        .ok_or_else(|| anyhow!("project metadata has no owner_pubkey"))?;
    let project_ref = format!("31933:{}:{}", owner_pk, meta.d_tag);

    let pm_pubkey: Option<&str> = project_agents
        .iter()
        .find(|pa| pa.is_pm)
        .map(|pa| pa.agent_pubkey.as_str());

    let mut tags: Vec<Tag> = Vec::new();

    tags.push(Tag::parse(["a", project_ref.as_str()]).map_err(|e| anyhow!("a tag: {e}"))?);

    // p-tags: owner first, then whitelisted (deduped)
    let mut seen = HashSet::new();
    for pk in std::iter::once(owner_pk).chain(whitelisted_pubkeys.iter().map(String::as_str)) {
        if seen.insert(pk) {
            tags.push(Tag::parse(["p", pk]).map_err(|e| anyhow!("p tag: {e}"))?);
        }
    }

    for agent in agents {
        let is_pm = pm_pubkey == Some(agent.pubkey.as_str());
        let mut vals = vec![agent.pubkey.clone(), agent.slug.clone()];
        if is_pm {
            vals.push("pm".to_string());
        }
        tags.push(Tag::custom(TagKind::Custom("agent".into()), vals));
    }

    let event = EventBuilder::new(Kind::Custom(KIND), "")
        .tags(tags)
        .sign_with_keys(keys)
        .map_err(|e| anyhow!("sign project status event: {e}"))?;

    Ok(event)
}
