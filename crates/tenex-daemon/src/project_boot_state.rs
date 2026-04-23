use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::nostr_classification::KIND_PROJECT;
use crate::nostr_event::SignedNostrEvent;

pub const BOOTED_PROJECTS_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootedProjectsState {
    pub schema_version: u32,
    pub updated_at: u64,
    pub projects: Vec<BootedProject>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootedProject {
    pub project_owner_pubkey: String,
    pub project_d_tag: String,
    pub project_reference: String,
    pub boot_event_id: String,
    pub booted_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectBootOutcome {
    pub project_owner_pubkey: String,
    pub project_d_tag: String,
    pub project_reference: String,
    pub boot_event_id: String,
    pub already_booted: bool,
    pub booted_project_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectBootReference {
    pub project_owner_pubkey: String,
    pub project_d_tag: String,
    pub project_reference: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProjectBootState {
    updated_at: u64,
    projects: BTreeMap<(String, String), BootedProject>,
}

impl ProjectBootState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn snapshot(&self) -> BootedProjectsState {
        BootedProjectsState {
            schema_version: BOOTED_PROJECTS_SCHEMA_VERSION,
            updated_at: self.updated_at,
            projects: self.projects.values().cloned().collect(),
        }
    }

    pub fn record_boot_event(
        &mut self,
        event: &SignedNostrEvent,
        timestamp_ms: u64,
    ) -> ProjectBootStateResult<ProjectBootOutcome> {
        let reference = extract_project_boot_reference(event)?;
        let key = (
            reference.project_owner_pubkey.clone(),
            reference.project_d_tag.clone(),
        );
        let already_booted = self.projects.contains_key(&key);
        self.projects.insert(
            key,
            BootedProject {
                project_owner_pubkey: reference.project_owner_pubkey.clone(),
                project_d_tag: reference.project_d_tag.clone(),
                project_reference: reference.project_reference.clone(),
                boot_event_id: event.id.clone(),
                booted_at: timestamp_ms,
            },
        );
        self.updated_at = timestamp_ms;

        Ok(ProjectBootOutcome {
            project_owner_pubkey: reference.project_owner_pubkey,
            project_d_tag: reference.project_d_tag,
            project_reference: reference.project_reference,
            boot_event_id: event.id.clone(),
            already_booted,
            booted_project_count: self.projects.len(),
        })
    }
}

#[derive(Debug, Error)]
pub enum ProjectBootStateError {
    #[error("project boot event missing project a-tag")]
    MissingProjectATag,
    #[error("project boot a-tag `{reference}` is malformed")]
    MalformedProjectATag { reference: String },
    #[error("project boot a-tag `{reference}` references unsupported kind `{kind}`")]
    UnsupportedProjectKind { reference: String, kind: String },
}

pub type ProjectBootStateResult<T> = Result<T, ProjectBootStateError>;

pub fn empty_booted_projects_state() -> BootedProjectsState {
    BootedProjectsState {
        schema_version: BOOTED_PROJECTS_SCHEMA_VERSION,
        updated_at: 0,
        projects: Vec::new(),
    }
}

pub fn extract_project_boot_reference(
    event: &SignedNostrEvent,
) -> ProjectBootStateResult<ProjectBootReference> {
    for tag in &event.tags {
        if tag.first().map(String::as_str) != Some("a") {
            continue;
        }
        let Some(reference) = tag.get(1).map(String::as_str) else {
            continue;
        };
        if !reference.starts_with("31933:") {
            continue;
        }
        return parse_project_reference(reference);
    }

    Err(ProjectBootStateError::MissingProjectATag)
}

pub fn is_project_booted(
    state: &BootedProjectsState,
    project_owner_pubkey: &str,
    project_d_tag: &str,
) -> bool {
    state.projects.iter().any(|project| {
        project.project_owner_pubkey == project_owner_pubkey
            && project.project_d_tag == project_d_tag
    })
}

fn parse_project_reference(reference: &str) -> ProjectBootStateResult<ProjectBootReference> {
    let mut parts = reference.splitn(3, ':');
    let Some(kind) = parts.next() else {
        return Err(ProjectBootStateError::MalformedProjectATag {
            reference: reference.to_string(),
        });
    };
    if kind != KIND_PROJECT.to_string() {
        return Err(ProjectBootStateError::UnsupportedProjectKind {
            reference: reference.to_string(),
            kind: kind.to_string(),
        });
    }
    let Some(owner) = parts.next() else {
        return Err(ProjectBootStateError::MalformedProjectATag {
            reference: reference.to_string(),
        });
    };
    let Some(project_d_tag) = parts.next() else {
        return Err(ProjectBootStateError::MalformedProjectATag {
            reference: reference.to_string(),
        });
    };
    if owner.is_empty() || project_d_tag.is_empty() {
        return Err(ProjectBootStateError::MalformedProjectATag {
            reference: reference.to_string(),
        });
    }
    Ok(ProjectBootReference {
        project_owner_pubkey: owner.to_string(),
        project_d_tag: project_d_tag.to_string(),
        project_reference: reference.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_state_starts_empty() {
        let state = ProjectBootState::new().snapshot();

        assert_eq!(state.schema_version, BOOTED_PROJECTS_SCHEMA_VERSION);
        assert_eq!(state.updated_at, 0);
        assert!(state.projects.is_empty());
    }

    #[test]
    fn boot_event_records_project_reference() {
        let mut state = ProjectBootState::new();
        let event = boot_event(
            "event-one",
            vec![vec!["a", "31933:owner-pubkey:demo-project"]],
        );

        let outcome = state
            .record_boot_event(&event, 1_710_001_000_000)
            .expect("record boot");

        assert_eq!(outcome.project_owner_pubkey, "owner-pubkey");
        assert_eq!(outcome.project_d_tag, "demo-project");
        assert!(!outcome.already_booted);
        let snapshot = state.snapshot();
        assert!(is_project_booted(&snapshot, "owner-pubkey", "demo-project"));
        assert_eq!(snapshot.projects[0].boot_event_id, "event-one");
    }

    #[test]
    fn repeated_boot_updates_existing_project_without_duplicate() {
        let mut state = ProjectBootState::new();
        let first = boot_event(
            "event-one",
            vec![vec!["a", "31933:owner-pubkey:demo-project"]],
        );
        let second = boot_event(
            "event-two",
            vec![vec!["a", "31933:owner-pubkey:demo-project"]],
        );

        state
            .record_boot_event(&first, 1_710_001_000_000)
            .expect("first boot");
        let outcome = state
            .record_boot_event(&second, 1_710_001_030_000)
            .expect("second boot");

        assert!(outcome.already_booted);
        let snapshot = state.snapshot();
        assert_eq!(snapshot.projects.len(), 1);
        assert_eq!(snapshot.projects[0].boot_event_id, "event-two");
        assert_eq!(snapshot.projects[0].booted_at, 1_710_001_030_000);
    }

    #[test]
    fn boot_reference_allows_colons_in_project_identifier() {
        let event = boot_event(
            "event-one",
            vec![vec!["a", "31933:owner-pubkey:project:with:colons"]],
        );

        let reference = extract_project_boot_reference(&event).expect("reference must parse");

        assert_eq!(reference.project_owner_pubkey, "owner-pubkey");
        assert_eq!(reference.project_d_tag, "project:with:colons");
    }

    #[test]
    fn missing_project_reference_is_rejected() {
        let event = boot_event("event-one", vec![vec!["a", "30023:owner:article"]]);

        let error = extract_project_boot_reference(&event).expect_err("must reject");

        assert!(matches!(error, ProjectBootStateError::MissingProjectATag));
    }

    fn boot_event(event_id: &str, tags: Vec<Vec<&str>>) -> SignedNostrEvent {
        SignedNostrEvent {
            id: event_id.to_string(),
            pubkey: "a".repeat(64),
            created_at: 1_710_001_000,
            kind: 24000,
            tags: tags
                .into_iter()
                .map(|tag| tag.into_iter().map(str::to_string).collect())
                .collect(),
            content: String::new(),
            sig: "b".repeat(128),
        }
    }
}
