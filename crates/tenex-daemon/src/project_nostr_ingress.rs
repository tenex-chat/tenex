use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use thiserror::Error;

use crate::nostr_event::SignedNostrEvent;
use crate::project_status_agent_sources::AGENT_INDEX_FILE_NAME;
use crate::project_status_descriptors::{
    PROJECT_DESCRIPTOR_FILE_NAME, PROJECTS_DIR_NAME, project_descriptor_path,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProjectNostrIngressOutcome {
    pub project_d_tag: String,
    pub owner_pubkey: String,
    pub is_new_project: bool,
    pub agent_pubkeys: Vec<String>,
}

#[derive(Debug, Error)]
pub enum ProjectNostrIngressError {
    #[error("project event missing d tag")]
    MissingDTag,
    #[error("failed to create project directory: {0}")]
    CreateDir(io::Error),
    #[error("failed to write project descriptor: {0}")]
    WriteDescriptor(io::Error),
    #[error("failed to read agent index: {0}")]
    ReadAgentIndex(io::Error),
    #[error("failed to parse agent index: {0}")]
    ParseAgentIndex(serde_json::Error),
    #[error("failed to write agent index: {0}")]
    WriteAgentIndex(io::Error),
}

#[derive(Deserialize, Default)]
struct RawAgentIndex {
    #[serde(default, rename = "bySlug")]
    by_slug: BTreeMap<String, Value>,
    #[serde(default, rename = "byEventId")]
    by_event_id: BTreeMap<String, Value>,
    #[serde(default, rename = "byProject")]
    by_project: BTreeMap<String, Vec<String>>,
    #[serde(flatten)]
    extra_fields: BTreeMap<String, Value>,
}

impl Serialize for RawAgentIndex {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut value = serde_json::Map::new();
        for (key, field) in &self.extra_fields {
            if key != "bySlug" && key != "byEventId" && key != "byProject" {
                value.insert(key.clone(), field.clone());
            }
        }
        value.insert("bySlug".to_string(), json!(self.by_slug));
        value.insert("byEventId".to_string(), json!(self.by_event_id));
        value.insert("byProject".to_string(), json!(self.by_project));
        value.serialize(serializer)
    }
}

pub fn handle_project_nostr_event(
    tenex_base_dir: &Path,
    event: &SignedNostrEvent,
    projects_base: &str,
) -> Result<ProjectNostrIngressOutcome, ProjectNostrIngressError> {
    let d_tag = tag_value(event, "d").ok_or(ProjectNostrIngressError::MissingDTag)?;
    let owner_pubkey = event.pubkey.clone();
    let agent_pubkeys: Vec<String> = tag_values(event, "p")
        .into_iter()
        .map(str::to_string)
        .collect();
    let project_base_path = format!("{}/{}", projects_base.trim_end_matches('/'), d_tag);

    let descriptor_path = project_descriptor_path(tenex_base_dir, d_tag);
    let is_new_project = !descriptor_path.exists();

    let project_dir = tenex_base_dir.join(PROJECTS_DIR_NAME).join(d_tag);
    fs::create_dir_all(&project_dir).map_err(ProjectNostrIngressError::CreateDir)?;

    let descriptor = json!({
        "projectOwnerPubkey": owner_pubkey,
        "projectDTag": d_tag,
        "projectBasePath": project_base_path,
        "status": "active"
    });
    fs::write(
        project_dir.join(PROJECT_DESCRIPTOR_FILE_NAME),
        serde_json::to_string_pretty(&descriptor).expect("descriptor serializes"),
    )
    .map_err(ProjectNostrIngressError::WriteDescriptor)?;

    let agents_dir = tenex_base_dir.join("agents");
    fs::create_dir_all(&agents_dir).map_err(ProjectNostrIngressError::CreateDir)?;

    let index_path = agents_dir.join(AGENT_INDEX_FILE_NAME);
    let mut index: RawAgentIndex = if index_path.exists() {
        let content =
            fs::read_to_string(&index_path).map_err(ProjectNostrIngressError::ReadAgentIndex)?;
        serde_json::from_str(&content).map_err(ProjectNostrIngressError::ParseAgentIndex)?
    } else {
        RawAgentIndex::default()
    };

    index
        .by_project
        .insert(d_tag.to_string(), agent_pubkeys.clone());

    fs::write(
        &index_path,
        serde_json::to_string_pretty(&index).expect("agent index serializes"),
    )
    .map_err(ProjectNostrIngressError::WriteAgentIndex)?;

    Ok(ProjectNostrIngressOutcome {
        project_d_tag: d_tag.to_string(),
        owner_pubkey,
        is_new_project,
        agent_pubkeys,
    })
}

fn tag_value<'a>(event: &'a SignedNostrEvent, name: &str) -> Option<&'a str> {
    event
        .tags
        .iter()
        .find(|tag| tag.first().map(String::as_str) == Some(name))
        .and_then(|tag| tag.get(1))
        .map(String::as_str)
}

fn tag_values<'a>(event: &'a SignedNostrEvent, name: &str) -> Vec<&'a str> {
    event
        .tags
        .iter()
        .filter(|tag| tag.first().map(String::as_str) == Some(name))
        .filter_map(|tag| tag.get(1))
        .map(String::as_str)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nostr_event::SignedNostrEvent;
    use serde_json::Value;
    use tempfile::tempdir;

    fn project_event(pubkey: &str, d_tag: &str, p_tags: &[&str]) -> SignedNostrEvent {
        let mut tags = vec![vec!["d".to_string(), d_tag.to_string()]];
        for p in p_tags {
            tags.push(vec!["p".to_string(), p.to_string()]);
        }
        SignedNostrEvent {
            id: "a".repeat(64),
            pubkey: pubkey.to_string(),
            created_at: 1_710_001_000,
            kind: 31933,
            tags,
            content: String::new(),
            sig: "b".repeat(128),
        }
    }

    #[test]
    fn writes_project_descriptor_and_agent_index_on_first_event() {
        let tmp = tempdir().expect("temp dir");
        let base = tmp.path();
        let owner = "a".repeat(64);
        let agent1 = "c".repeat(64);
        let agent2 = "d".repeat(64);

        let outcome = handle_project_nostr_event(
            base,
            &project_event(&owner, "my-project", &[&agent1, &agent2]),
            "/workspace/projects",
        )
        .expect("handle must succeed");

        assert_eq!(outcome.project_d_tag, "my-project");
        assert_eq!(outcome.owner_pubkey, owner);
        assert!(outcome.is_new_project);
        assert_eq!(outcome.agent_pubkeys, vec![agent1.clone(), agent2.clone()]);

        let descriptor_path = base
            .join("projects")
            .join("my-project")
            .join("project.json");
        assert!(descriptor_path.exists());
        let descriptor: Value =
            serde_json::from_str(&fs::read_to_string(&descriptor_path).unwrap()).unwrap();
        assert_eq!(descriptor["projectOwnerPubkey"], owner.as_str());
        assert_eq!(descriptor["projectDTag"], "my-project");
        assert_eq!(
            descriptor["projectBasePath"],
            "/workspace/projects/my-project"
        );
        assert_eq!(descriptor["status"], "active");

        let index_path = base.join("agents").join("index.json");
        assert!(index_path.exists());
        let index: Value = serde_json::from_str(&fs::read_to_string(&index_path).unwrap()).unwrap();
        assert!(index["bySlug"].is_object());
        assert!(index["byEventId"].is_object());
        let by_project = &index["byProject"]["my-project"];
        assert_eq!(by_project[0], agent1.as_str());
        assert_eq!(by_project[1], agent2.as_str());
    }

    #[test]
    fn preserves_other_projects_in_agent_index_on_update() {
        let tmp = tempdir().expect("temp dir");
        let base = tmp.path();
        let owner = "a".repeat(64);
        let agent = "c".repeat(64);

        let existing_index = json!({
            "bySlug": {
                "existing-agent": {
                    "pubkey": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
                    "projectIds": ["other-project"]
                }
            },
            "byEventId": {
                "event-alpha": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
            },
            "byProject": {
                "other-project": ["eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"]
            }
        });
        let agents_dir = base.join("agents");
        fs::create_dir_all(&agents_dir).unwrap();
        fs::write(
            agents_dir.join("index.json"),
            serde_json::to_string_pretty(&existing_index).unwrap(),
        )
        .unwrap();

        handle_project_nostr_event(
            base,
            &project_event(&owner, "new-project", &[&agent]),
            "/workspace",
        )
        .expect("handle must succeed");

        let index: Value = serde_json::from_str(
            &fs::read_to_string(base.join("agents").join("index.json")).unwrap(),
        )
        .unwrap();
        assert!(
            index["byProject"]["other-project"].is_array(),
            "other-project preserved"
        );
        assert!(
            index["byProject"]["new-project"].is_array(),
            "new-project added"
        );
        assert!(
            index["bySlug"]["existing-agent"].is_object(),
            "slug index preserved"
        );
        assert_eq!(
            index["byEventId"]["event-alpha"],
            "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
        );
    }

    #[test]
    fn missing_d_tag_returns_error() {
        let tmp = tempdir().expect("temp dir");
        let event = SignedNostrEvent {
            id: "a".repeat(64),
            pubkey: "b".repeat(64),
            created_at: 1_710_001_000,
            kind: 31933,
            tags: vec![],
            content: String::new(),
            sig: "c".repeat(128),
        };
        let err = handle_project_nostr_event(tmp.path(), &event, "/workspace")
            .expect_err("must fail without d tag");
        assert!(matches!(err, ProjectNostrIngressError::MissingDTag));
    }
}
