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
//!         + ["model", <config_slug>, <agent_slug>...]
//!         + ["skill", <skill_id>, <agent_slug>...]
//!         + ["mcp", <server_slug>, <agent_slug>...]
//! ```
//!
//! tool/branch/scheduled-task tags are not emitted — they require
//! infrastructure (tool registry, git, scheduler storage) not yet available
//! in the Rust runtime.
//!
//! Signed with the backend signer.

use std::collections::HashMap;

use anyhow::{anyhow, Result};
use nostr_sdk::{Event, EventBuilder, Keys, Kind, Tag, TagKind};
use serde_json::Value;

use crate::store::llms::LlmsDoc;
use tenex_project::{models::ProjectAgent, Agent, ProjectMetadata};

const KIND: u16 = 24010;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelAccess {
    pub slug: String,
    pub agents: Vec<String>,
}

/// Build the `["model", config_slug, agent_slug...]` rows for kind:24010.
///
/// Mirrors `ProjectStatusService.gatherModelInfo`: every configured model is
/// announced, agents map to their `default.model` when it names an existing
/// config, and otherwise fall back to the global default config when present.
pub fn collect_model_access(llms: &LlmsDoc, agents: &[Agent]) -> Vec<ModelAccess> {
    let mut model_names = llms.config_names();
    model_names.sort();

    let mut config_to_agents: HashMap<String, Vec<String>> = model_names
        .iter()
        .map(|name| (name.clone(), Vec::new()))
        .collect();
    let global_default = llms
        .default_config()
        .filter(|name| config_to_agents.contains_key(*name))
        .map(str::to_owned);

    for agent in agents {
        let agent_config = agent_default_model(agent).unwrap_or_else(|| "default".to_string());
        let selected = if config_to_agents.contains_key(&agent_config) {
            Some(agent_config)
        } else {
            global_default.clone()
        };

        if let Some(config_name) = selected {
            if let Some(agent_slugs) = config_to_agents.get_mut(&config_name) {
                agent_slugs.push(agent.slug.clone());
            }
        }
    }

    model_names
        .into_iter()
        .map(|slug| {
            let mut agents = config_to_agents.remove(&slug).unwrap_or_default();
            agents.sort();
            ModelAccess { slug, agents }
        })
        .collect()
}

fn agent_default_model(agent: &Agent) -> Option<String> {
    let json = agent.default_config_json.as_ref()?;
    let Value::Object(map) = serde_json::from_str::<Value>(json).ok()? else {
        return None;
    };
    map.get("model")
        .and_then(Value::as_str)
        .filter(|model| !model.is_empty())
        .map(str::to_owned)
}

/// Build (but do not send) a kind:24010 project status event.
pub fn build_project_status_event(
    keys: &Keys,
    meta: &ProjectMetadata,
    agents: &[Agent],
    project_agents: &[ProjectAgent],
    models: &[ModelAccess],
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
    let mut seen = std::collections::HashSet::new();
    for pk in std::iter::once(owner_pk).chain(whitelisted_pubkeys.iter().map(String::as_str)) {
        if seen.insert(pk) {
            tags.push(Tag::parse(["p", pk]).map_err(|e| anyhow!("p tag: {e}"))?);
        }
    }

    // agent tags + gather skill / mcp maps
    let mut skill_agents: HashMap<String, Vec<String>> = HashMap::new();
    let mut mcp_agents: HashMap<String, Vec<String>> = HashMap::new();

    for agent in agents {
        let is_pm = pm_pubkey == Some(agent.pubkey.as_str());
        let mut vals = vec![agent.pubkey.clone(), agent.slug.clone()];
        if is_pm {
            vals.push("pm".to_string());
        }
        tags.push(Tag::custom(TagKind::Custom("agent".into()), vals));

        if let Some(ref json) = agent.default_config_json {
            if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(json) {
                if let Some(Value::Array(skills)) = map.get("skills") {
                    for skill in skills {
                        if let Some(id) = skill.as_str() {
                            skill_agents
                                .entry(id.to_string())
                                .or_default()
                                .push(agent.slug.clone());
                        }
                    }
                }
            }
        }

        if let Some(ref json) = agent.mcp_servers_json {
            if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(json) {
                for slug in map.keys() {
                    mcp_agents
                        .entry(slug.clone())
                        .or_default()
                        .push(agent.slug.clone());
                }
            }
        }
    }

    for model in models {
        let mut vals = vec![model.slug.clone()];
        vals.extend(model.agents.clone());
        tags.push(Tag::custom(TagKind::Custom("model".into()), vals));
    }

    // skill tags (sorted by id)
    let mut skills: Vec<(String, Vec<String>)> = skill_agents.into_iter().collect();
    skills.sort_by(|(a, _), (b, _)| a.cmp(b));
    for (id, mut agent_slugs) in skills {
        agent_slugs.sort();
        let mut vals = vec![id];
        vals.extend(agent_slugs);
        tags.push(Tag::custom(TagKind::Custom("skill".into()), vals));
    }

    // mcp tags (sorted by slug)
    let mut mcps: Vec<(String, Vec<String>)> = mcp_agents.into_iter().collect();
    mcps.sort_by(|(a, _), (b, _)| a.cmp(b));
    for (slug, mut agent_slugs) in mcps {
        agent_slugs.sort();
        let mut vals = vec![slug];
        vals.extend(agent_slugs);
        tags.push(Tag::custom(TagKind::Custom("mcp".into()), vals));
    }

    let event = EventBuilder::new(Kind::Custom(KIND), "")
        .tags(tags)
        .sign_with_keys(keys)
        .map_err(|e| anyhow!("sign project status event: {e}"))?;

    Ok(event)
}
