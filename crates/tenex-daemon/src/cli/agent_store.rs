use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};

use anyhow::Context;
use serde_json::{Value, json};

#[derive(Debug, Clone)]
pub struct AgentEntry {
    pub pubkey: String,
    pub path: PathBuf,
    pub doc: Value,
    pub name: String,
    pub slug: String,
    pub status: Option<String>,
    /// Project dTags this agent is assigned to (from index.json byProject).
    pub projects: Vec<String>,
}

impl AgentEntry {
    pub fn is_active(&self) -> bool {
        self.status.as_deref() != Some("inactive")
    }
}

/// Load all agent JSON files from `agents_dir`, annotated with their project memberships.
pub fn load_agents(agents_dir: &Path) -> anyhow::Result<Vec<AgentEntry>> {
    let pubkey_projects = pubkey_to_projects(agents_dir);
    let mut agents = Vec::new();

    let read_dir = match std::fs::read_dir(agents_dir) {
        Ok(rd) => rd,
        Err(_) => return Ok(agents),
    };

    for entry in read_dir.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let stem = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) if s != "index" => s.to_string(),
            _ => continue,
        };
        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let doc: Value = match serde_json::from_str(&content) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let name = doc.get("name").and_then(|v| v.as_str()).unwrap_or(&stem).to_string();
        let slug = doc.get("slug").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let status = doc.get("status").and_then(|v| v.as_str()).map(|s| s.to_string());
        let projects = pubkey_projects.get(&stem).cloned().unwrap_or_default();

        agents.push(AgentEntry { pubkey: stem, path, doc, name, slug, status, projects });
    }

    agents.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(agents)
}

/// Returns groups of indices (into `agents`) that share the same slug.
/// Only groups with 2+ members are returned.
pub fn find_duplicate_slug_groups(agents: &[AgentEntry]) -> Vec<Vec<usize>> {
    let mut by_slug: HashMap<&str, Vec<usize>> = HashMap::new();
    for (i, agent) in agents.iter().enumerate() {
        by_slug.entry(agent.slug.as_str()).or_default().push(i);
    }
    let mut groups: Vec<Vec<usize>> = by_slug.into_values().filter(|g| g.len() > 1).collect();
    groups.sort_by_key(|g| agents[g[0]].slug.clone());
    groups
}

/// Pick the best survivor from a group: prefer active, then most projects, then earliest in list.
pub fn pick_survivor(group: &[usize], agents: &[AgentEntry]) -> usize {
    *group
        .iter()
        .max_by_key(|&&i| {
            let a = &agents[i];
            (a.is_active() as usize, a.projects.len())
        })
        .unwrap_or(&group[0])
}

/// Merge all agents in `group` into the survivor (picked automatically).
/// Consolidates all project memberships into the survivor, deletes the others,
/// and updates index.json.
pub fn merge_agents(agents_dir: &Path, group: &[usize], agents: &[AgentEntry]) -> anyhow::Result<()> {
    let survivor_idx = pick_survivor(group, agents);
    let survivor = &agents[survivor_idx];
    let others: Vec<&AgentEntry> = group
        .iter()
        .filter(|&&i| i != survivor_idx)
        .map(|&i| &agents[i])
        .collect();
    let other_pubkeys: HashSet<&str> = others.iter().map(|a| a.pubkey.as_str()).collect();

    let all_projects: Vec<String> = group
        .iter()
        .flat_map(|&i| agents[i].projects.iter().cloned())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();

    let index_path = agents_dir.join("index.json");
    let mut index = load_index(&index_path);

    // bySlug: point survivor's entry to all merged projects
    if let Some(by_slug) = index.get_mut("bySlug").and_then(|v| v.as_object_mut()) {
        by_slug.insert(
            survivor.slug.clone(),
            json!({ "pubkey": survivor.pubkey, "projectIds": all_projects }),
        );
    }

    // byProject: ensure survivor in each merged project, scrub others everywhere
    if let Some(by_project) = index.get_mut("byProject").and_then(|v| v.as_object_mut()) {
        for project in &all_projects {
            let entry = by_project.entry(project.clone()).or_insert(json!([]));
            if let Some(arr) = entry.as_array_mut() {
                arr.retain(|pk| pk.as_str().map(|s| !other_pubkeys.contains(s)).unwrap_or(true));
                if !arr.iter().any(|pk| pk.as_str() == Some(&survivor.pubkey)) {
                    arr.push(json!(&survivor.pubkey));
                }
            }
        }
        for pubkeys in by_project.values_mut() {
            if let Some(arr) = pubkeys.as_array_mut() {
                arr.retain(|pk| pk.as_str().map(|s| !other_pubkeys.contains(s)).unwrap_or(true));
            }
        }
    }

    // byEventId: remove other pubkeys
    if let Some(by_event_id) = index.get_mut("byEventId").and_then(|v| v.as_object_mut()) {
        by_event_id.retain(|_, v| v.as_str().map(|s| !other_pubkeys.contains(s)).unwrap_or(true));
    }

    // Mark survivor active
    let mut survivor_doc = survivor.doc.clone();
    if let Some(obj) = survivor_doc.as_object_mut() {
        obj.insert("status".to_string(), json!("active"));
    }
    write_agent_file(&survivor.path, &survivor_doc)?;

    // Delete losers
    for other in &others {
        std::fs::remove_file(&other.path)
            .with_context(|| format!("delete {}", other.path.display()))?;
    }

    write_json_file(&index_path, &index)?;
    Ok(())
}

/// Permanently delete one agent: removes the file and scrubs it from index.json.
pub fn delete_agent(agents_dir: &Path, agent: &AgentEntry) -> anyhow::Result<()> {
    let index_path = agents_dir.join("index.json");
    let mut index = load_index(&index_path);

    if let Some(by_slug) = index.get_mut("bySlug").and_then(|v| v.as_object_mut()) {
        let is_owner = by_slug
            .get(&agent.slug)
            .and_then(|e| e.get("pubkey"))
            .and_then(|v| v.as_str())
            == Some(&agent.pubkey);
        if is_owner {
            by_slug.remove(&agent.slug);
        }
    }

    if let Some(by_project) = index.get_mut("byProject").and_then(|v| v.as_object_mut()) {
        for pubkeys in by_project.values_mut() {
            if let Some(arr) = pubkeys.as_array_mut() {
                arr.retain(|pk| pk.as_str() != Some(&agent.pubkey));
            }
        }
    }

    if let Some(by_event_id) = index.get_mut("byEventId").and_then(|v| v.as_object_mut()) {
        by_event_id.retain(|_, v| v.as_str() != Some(&agent.pubkey));
    }

    write_json_file(&index_path, &index)?;

    std::fs::remove_file(&agent.path)
        .with_context(|| format!("delete {}", agent.path.display()))?;

    Ok(())
}

pub fn write_agent_file(path: &Path, doc: &Value) -> anyhow::Result<()> {
    write_json_file(path, doc)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn pubkey_to_projects(agents_dir: &Path) -> HashMap<String, Vec<String>> {
    let mut map: HashMap<String, Vec<String>> = HashMap::new();
    let content = match std::fs::read_to_string(agents_dir.join("index.json")) {
        Ok(c) => c,
        Err(_) => return map,
    };
    let index: Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return map,
    };
    if let Some(by_project) = index.get("byProject").and_then(|v| v.as_object()) {
        for (dtag, pubkeys) in by_project {
            if let Some(arr) = pubkeys.as_array() {
                for pk in arr.iter().filter_map(|v| v.as_str()) {
                    map.entry(pk.to_string()).or_default().push(dtag.clone());
                }
            }
        }
    }
    map
}

fn load_index(path: &Path) -> Value {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_else(|| json!({ "bySlug": {}, "byEventId": {}, "byProject": {} }))
}

fn write_json_file(path: &Path, value: &Value) -> anyhow::Result<()> {
    let content = serde_json::to_string_pretty(value)? + "\n";
    std::fs::write(path, content)?;
    Ok(())
}
