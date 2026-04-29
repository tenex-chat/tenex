use std::collections::HashSet;
use std::path::Path;

use anyhow::Result;
use nostr_sdk::prelude::*;
use tenex_agent_registry::{AgentDefaultConfigUpdate, AgentStorage};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ConfigUpdateOutcome {
    pub agent_pubkey: Option<String>,
    pub config_updated: bool,
    pub ignored_reason: Option<&'static str>,
    pub has_reset: bool,
    pub has_model: bool,
    pub skill_count: usize,
    pub mcp_count: usize,
}

impl ConfigUpdateOutcome {
    fn ignored(reason: &'static str, agent_pubkey: Option<String>) -> Self {
        Self {
            agent_pubkey,
            config_updated: false,
            ignored_reason: Some(reason),
            has_reset: false,
            has_model: false,
            skill_count: 0,
            mcp_count: 0,
        }
    }
}

pub(crate) fn apply_event(
    base_dir: &Path,
    event: &Event,
    project_addr: &str,
    project_dtag: &str,
    agent_pubkeys: &HashSet<String>,
) -> Result<ConfigUpdateOutcome> {
    let Some(agent_pubkey) = first_tag_value(event, "p") else {
        return Ok(ConfigUpdateOutcome::ignored("missing p tag", None));
    };

    if !agent_pubkeys.contains(&agent_pubkey) {
        return Ok(ConfigUpdateOutcome::ignored(
            "agent not in this project",
            Some(agent_pubkey),
        ));
    }

    if !targets_project(event, project_addr, project_dtag) {
        return Ok(ConfigUpdateOutcome::ignored(
            "a tag targets another project",
            Some(agent_pubkey),
        ));
    }

    let mut storage = AgentStorage::open(base_dir)?;
    let has_reset = has_tag(event, "reset");
    if has_reset {
        let config_updated = storage.reset_default_config(&agent_pubkey)?;
        return Ok(ConfigUpdateOutcome {
            agent_pubkey: Some(agent_pubkey),
            config_updated,
            ignored_reason: None,
            has_reset: true,
            has_model: false,
            skill_count: 0,
            mcp_count: 0,
        });
    }

    let has_model_tag = has_tag(event, "model");
    let blocked_skill_tag_values = tag_values(event, "blocked-skill");
    let skill_tag_values = tag_values(event, "skill");
    let mcp_server_slugs = tag_values(event, "mcp");
    let new_model = if has_model_tag {
        first_tag_value(event, "model")
    } else {
        None
    };

    let updates = AgentDefaultConfigUpdate {
        model: new_model.clone(),
        blocked_skills: has_tag(event, "blocked-skill").then_some(blocked_skill_tag_values),
        skills: has_tag(event, "skill").then_some(skill_tag_values.clone()),
        mcp: has_tag(event, "mcp").then_some(mcp_server_slugs.clone()),
    };

    let default_updated = if updates.is_empty() {
        false
    } else {
        storage.update_default_config(&agent_pubkey, &updates)?
    };
    let pm_updated = storage.update_agent_is_pm(&agent_pubkey, has_tag(event, "pm"))?;

    Ok(ConfigUpdateOutcome {
        agent_pubkey: Some(agent_pubkey),
        config_updated: default_updated || pm_updated,
        ignored_reason: None,
        has_reset: false,
        has_model: new_model.is_some(),
        skill_count: skill_tag_values.len(),
        mcp_count: mcp_server_slugs.len(),
    })
}

fn targets_project(event: &Event, project_addr: &str, project_dtag: &str) -> bool {
    let Some(a_tag) = first_raw_tag_value(event, "a") else {
        return true;
    };
    a_tag == project_addr || extract_project_dtag(&a_tag).as_deref() == Some(project_dtag)
}

fn extract_project_dtag(a_tag: &str) -> Option<String> {
    let parts: Vec<&str> = a_tag.split(':').collect();
    if parts.len() >= 3 && parts.first() == Some(&"31933") {
        return Some(parts[2..].join(":"));
    }
    Some(a_tag.to_string())
}

fn has_tag(event: &Event, name: &str) -> bool {
    event
        .tags
        .iter()
        .any(|tag| tag.as_slice().first().is_some_and(|head| head == name))
}

fn first_tag_value(event: &Event, name: &str) -> Option<String> {
    first_raw_tag_value(event, name).and_then(|value| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}

fn first_raw_tag_value(event: &Event, name: &str) -> Option<String> {
    event.tags.iter().find_map(|tag| {
        let parts = tag.as_slice();
        if parts.first().is_some_and(|head| head == name) {
            parts.get(1).cloned()
        } else {
            None
        }
    })
}

fn tag_values(event: &Event, name: &str) -> Vec<String> {
    event
        .tags
        .iter()
        .filter_map(|tag| {
            let parts = tag.as_slice();
            if !parts.first().is_some_and(|head| head == name) {
                return None;
            }
            let value = parts.get(1)?.trim();
            (!value.is_empty()).then(|| value.to_string())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use indexmap::IndexMap;
    use serde_json::Value;
    use std::sync::atomic::{AtomicU64, Ordering};
    use tenex_agent_registry::{generate_nsec_bech32, AgentDoc};

    fn unique_temp() -> std::path::PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!(
            "tenex-runtime-config-update-{}-{}-{n}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn tag(parts: &[&str]) -> Tag {
        Tag::parse(parts.iter().copied()).unwrap()
    }

    fn event(tags: Vec<Tag>) -> Event {
        EventBuilder::new(
            Kind::Custom(tenex_protocol::nostr::kinds::AGENT_CONFIG_UPDATE),
            "",
        )
        .tags(tags)
        .sign_with_keys(&Keys::generate())
        .unwrap()
    }

    fn stored_agent(storage: &mut AgentStorage) -> String {
        let mut raw = IndexMap::<String, Value>::new();
        raw.insert(
            "nsec".into(),
            Value::String(generate_nsec_bech32().unwrap()),
        );
        raw.insert("slug".into(), Value::String("worker".into()));
        raw.insert("name".into(), Value::String("Worker".into()));
        raw.insert("role".into(), Value::String("do work".into()));
        storage.save_agent(&AgentDoc::from_raw(raw)).unwrap()
    }

    #[test]
    fn applies_snapshot_to_agent_default_config() {
        let base = unique_temp();
        let mut storage = AgentStorage::open(&base).unwrap();
        let pubkey = stored_agent(&mut storage);
        let agent_pubkeys = HashSet::from([pubkey.clone()]);
        let ev = event(vec![
            tag(&["a", "31933:owner:project"]),
            tag(&["p", &pubkey]),
            tag(&["model", "gpt-5.4 mini"]),
            tag(&["skill", "read-access"]),
            tag(&["skill", "shell"]),
            tag(&["skill", "write-access"]),
            tag(&["mcp"]),
        ]);

        let outcome =
            apply_event(&base, &ev, "31933:owner:project", "project", &agent_pubkeys).unwrap();

        assert!(outcome.config_updated);
        assert!(outcome.has_model);
        assert_eq!(outcome.skill_count, 3);
        assert_eq!(outcome.mcp_count, 0);
        let loaded = AgentDoc::load(&base, &pubkey).unwrap().unwrap();
        let default = loaded.raw().get("default").unwrap().as_object().unwrap();
        assert_eq!(
            default.get("model").and_then(Value::as_str),
            Some("gpt-5.4 mini")
        );
        assert!(default.get("mcp").is_none());
        assert_eq!(
            default
                .get("skills")
                .and_then(Value::as_array)
                .unwrap()
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>(),
            vec!["read-access", "shell", "write-access"]
        );
        assert_eq!(
            loaded.raw().get("isPM").and_then(Value::as_bool),
            Some(false)
        );
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn ignores_events_for_other_projects() {
        let base = unique_temp();
        let mut storage = AgentStorage::open(&base).unwrap();
        let pubkey = stored_agent(&mut storage);
        let agent_pubkeys = HashSet::from([pubkey.clone()]);
        let ev = event(vec![
            tag(&["a", "31933:owner:other"]),
            tag(&["p", &pubkey]),
            tag(&["model", "updated"]),
        ]);

        let outcome =
            apply_event(&base, &ev, "31933:owner:project", "project", &agent_pubkeys).unwrap();

        assert_eq!(
            outcome.ignored_reason,
            Some("a tag targets another project")
        );
        let loaded = AgentDoc::load(&base, &pubkey).unwrap().unwrap();
        assert!(loaded.raw().get("default").is_none());
        std::fs::remove_dir_all(&base).ok();
    }
}
