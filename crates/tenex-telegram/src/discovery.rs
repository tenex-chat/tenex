use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::Deserialize;
use tenex_agent_registry::read_agent_projection_file;
use tracing::warn;

use crate::config::{parse_agent_config, TelegramAgentConfig};

#[derive(Debug, Clone)]
pub struct AgentRegistration {
    pub pubkey: String,
    pub config: TelegramAgentConfig,
    pub projects: Vec<ProjectRoute>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectRoute {
    pub project_id: String,
    pub title: Option<String>,
    pub owner_pubkey: Option<String>,
}

impl ProjectRoute {
    pub fn display_title(&self) -> &str {
        self.title.as_deref().unwrap_or(&self.project_id)
    }
}

pub fn discover_registrations() -> Vec<AgentRegistration> {
    discover_registrations_in(&tenex_project::paths::default_base_dir())
}

fn discover_registrations_in(base: &Path) -> Vec<AgentRegistration> {
    let agents = discover_telegram_agents(base);
    if agents.is_empty() {
        return Vec::new();
    }

    let telegram_pubkeys: HashSet<String> = agents.iter().map(|a| a.pubkey.clone()).collect();
    let projects_by_agent = discover_projects_by_agent(base, &telegram_pubkeys);

    let mut registrations = Vec::new();
    for agent in agents {
        let Some(projects) = projects_by_agent.get(&agent.pubkey) else {
            continue;
        };
        registrations.push(AgentRegistration {
            pubkey: agent.pubkey,
            config: agent.config,
            projects: projects.clone(),
        });
    }
    registrations
}

#[derive(Debug, Clone)]
struct TelegramAgent {
    pubkey: String,
    config: TelegramAgentConfig,
}

fn discover_telegram_agents(base: &Path) -> Vec<TelegramAgent> {
    let agents_dir = tenex_agent_registry::agents_dir(base);
    let entries = match sorted_dir_entries(&agents_dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(e) => {
            warn!(error = %e, path = %agents_dir.display(), "cannot read agents dir");
            return Vec::new();
        }
    };

    let mut agents = Vec::new();
    for path in entries {
        let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if file_name == "index.json" || !file_name.ends_with(".json") {
            continue;
        }

        let pubkey = file_name[..file_name.len() - 5].to_string();
        if !is_hex64(&pubkey) {
            continue;
        }
        let projection = match read_agent_projection_file(&path, &pubkey) {
            Ok(projection) => projection,
            Err(e) => {
                warn!(pubkey = %pubkey, error = %e, "skipping unreadable agent file");
                continue;
            }
        };

        let Some(cfg_json) = projection.telegram_config_json else {
            continue;
        };
        let Some(config) = parse_agent_config(&cfg_json) else {
            warn!(pubkey = %pubkey, "invalid telegram config JSON, skipping");
            continue;
        };
        if config.bot_token.is_empty() {
            continue;
        }

        agents.push(TelegramAgent {
            pubkey: projection.pubkey,
            config,
        });
    }
    agents
}

fn discover_projects_by_agent(
    base: &Path,
    telegram_pubkeys: &HashSet<String>,
) -> HashMap<String, Vec<ProjectRoute>> {
    let projects_dir = tenex_project::paths::projects_dir(base);
    let entries = match sorted_dir_entries(&projects_dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return HashMap::new(),
        Err(e) => {
            warn!(error = %e, path = %projects_dir.display(), "cannot read projects dir");
            return HashMap::new();
        }
    };

    let mut by_agent: HashMap<String, Vec<ProjectRoute>> = HashMap::new();
    for path in entries {
        let Some(d_tag) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let event_path = path.join("event.json");
        let event = match read_project_event(&event_path) {
            Ok(Some(event)) => event,
            Ok(None) => continue,
            Err(e) => {
                warn!(d_tag, error = %e, "cannot read project event");
                continue;
            }
        };
        let route = ProjectRoute {
            project_id: d_tag.to_string(),
            title: first_tag_value(&event.tags, "title"),
            owner_pubkey: event.pubkey.clone(),
        };

        let mut seen_in_project = HashSet::new();
        for pubkey in project_member_pubkeys(&event) {
            if !telegram_pubkeys.contains(&pubkey) || !seen_in_project.insert(pubkey.clone()) {
                continue;
            }
            by_agent.entry(pubkey).or_default().push(route.clone());
        }
    }

    by_agent
}

fn sorted_dir_entries(dir: &Path) -> std::io::Result<Vec<PathBuf>> {
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        entries.push(entry?.path());
    }
    entries.sort();
    Ok(entries)
}

#[derive(Debug, Deserialize)]
struct RawProjectEvent {
    #[serde(default)]
    pubkey: Option<String>,
    #[serde(default)]
    tags: Vec<Vec<String>>,
}

fn read_project_event(path: &Path) -> anyhow::Result<Option<RawProjectEvent>> {
    if !path.is_file() {
        return Ok(None);
    }
    let raw = std::fs::read(path)?;
    Ok(Some(serde_json::from_slice(&raw)?))
}

fn project_member_pubkeys(event: &RawProjectEvent) -> impl Iterator<Item = String> + '_ {
    event.tags.iter().filter_map(|tag| {
        let mut parts = tag.iter();
        if parts.next().map(String::as_str) != Some("p") {
            return None;
        }
        let pubkey = parts.next()?;
        if is_hex64(pubkey) {
            Some(pubkey.clone())
        } else {
            None
        }
    })
}

fn first_tag_value(tags: &[Vec<String>], name: &str) -> Option<String> {
    tags.iter().find_map(|tag| {
        let mut iter = tag.iter();
        if iter.next().map(String::as_str) == Some(name) {
            iter.next().cloned()
        } else {
            None
        }
    })
}

fn is_hex64(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use super::*;

    const OWNER_PK: &str = "c506be742732723deaaf8260d2b43d75d33420c601c05a9e1fa3b7986cc1b957";
    const TELEGRAM_AGENT_PK: &str =
        "0eb926fe0fb742ed7970f6bcd3c009287d72ddb4b2cf2e0ec8480b5780325eb9";
    const UNAVAILABLE_AGENT_PK: &str =
        "24d40cf83c5a81c54c778e1c1e3a28e4cdfde6c9fc51936ab51369a1398a5d8a";
    const OTHER_AGENT_PK: &str = "98f634d4eb0ea48eb45b15252a8d973e8d2e0ec34ee68df3319236821c388e1a";

    fn write_agent(base: &Path, pubkey: &str, telegram: Option<serde_json::Value>) {
        let agents_dir = base.join("agents");
        fs::create_dir_all(&agents_dir).unwrap();
        let mut agent = serde_json::json!({
            "slug": pubkey[..8].to_string(),
            "name": pubkey[..8].to_string(),
        });
        if let Some(telegram) = telegram {
            agent["telegram"] = telegram;
        }
        fs::write(
            agents_dir.join(format!("{pubkey}.json")),
            serde_json::to_vec(&agent).unwrap(),
        )
        .unwrap();
    }

    fn write_project(base: &Path, d_tag: &str, members: &[&str]) {
        let project_dir = base.join("projects").join(d_tag);
        fs::create_dir_all(&project_dir).unwrap();
        let mut tags = vec![serde_json::json!(["d", d_tag])];
        for member in members {
            tags.push(serde_json::json!(["p", member]));
        }
        let event = serde_json::json!({
            "id": "project-event",
            "pubkey": OWNER_PK,
            "kind": 31933,
            "created_at": 1_700_000_000_i64,
            "tags": tags,
        });
        fs::write(
            project_dir.join("event.json"),
            serde_json::to_vec(&event).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn discovery_starts_from_telegram_enabled_agents() {
        let tmp = TempDir::new().unwrap();
        write_agent(
            tmp.path(),
            TELEGRAM_AGENT_PK,
            Some(serde_json::json!({"botToken": "1234:abcd"})),
        );
        write_project(
            tmp.path(),
            "project-one",
            &[UNAVAILABLE_AGENT_PK, TELEGRAM_AGENT_PK],
        );

        let registrations = discover_registrations_in(tmp.path());

        assert_eq!(registrations.len(), 1);
        assert_eq!(registrations[0].pubkey, TELEGRAM_AGENT_PK);
        assert_eq!(registrations[0].projects.len(), 1);
        assert_eq!(registrations[0].projects[0].project_id, "project-one");
        assert_eq!(registrations[0].projects[0].display_title(), "project-one");
        assert_eq!(registrations[0].config.bot_token, "1234:abcd");
    }

    #[test]
    fn discovery_ignores_local_agents_without_telegram_config() {
        let tmp = TempDir::new().unwrap();
        write_agent(tmp.path(), OTHER_AGENT_PK, None);
        write_project(tmp.path(), "project-one", &[OTHER_AGENT_PK]);

        let registrations = discover_registrations_in(tmp.path());

        assert!(registrations.is_empty());
    }

    #[test]
    fn discovery_deduplicates_duplicate_project_member_tags() {
        let tmp = TempDir::new().unwrap();
        write_agent(
            tmp.path(),
            TELEGRAM_AGENT_PK,
            Some(serde_json::json!({"botToken": "1234:abcd"})),
        );
        write_project(
            tmp.path(),
            "project-one",
            &[TELEGRAM_AGENT_PK, TELEGRAM_AGENT_PK],
        );

        let registrations = discover_registrations_in(tmp.path());

        assert_eq!(registrations.len(), 1);
        assert_eq!(registrations[0].projects.len(), 1);
        assert_eq!(registrations[0].projects[0].project_id, "project-one");
    }

    #[test]
    fn discovery_groups_multiple_projects_under_one_agent_registration() {
        let tmp = TempDir::new().unwrap();
        write_agent(
            tmp.path(),
            TELEGRAM_AGENT_PK,
            Some(serde_json::json!({"botToken": "1234:abcd"})),
        );
        write_project(tmp.path(), "project-one", &[TELEGRAM_AGENT_PK]);
        write_project(tmp.path(), "project-two", &[TELEGRAM_AGENT_PK]);

        let registrations = discover_registrations_in(tmp.path());

        assert_eq!(registrations.len(), 1);
        let project_ids: Vec<_> = registrations[0]
            .projects
            .iter()
            .map(|project| project.project_id.as_str())
            .collect();
        assert_eq!(project_ids, vec!["project-one", "project-two"]);
    }
}
