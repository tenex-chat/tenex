use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::nostr_classification::KIND_PROJECT;
use crate::nostr_event::SignedNostrEvent;

pub const BOOTED_PROJECTS_FILE_NAME: &str = "booted-projects.json";
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

#[derive(Debug, Error)]
pub enum ProjectBootStateError {
    #[error("project boot event missing project a-tag")]
    MissingProjectATag,
    #[error("project boot a-tag `{reference}` is malformed")]
    MalformedProjectATag { reference: String },
    #[error("project boot a-tag `{reference}` references unsupported kind `{kind}`")]
    UnsupportedProjectKind { reference: String, kind: String },
    #[error("project boot state io error: {0}")]
    Io(#[from] io::Error),
    #[error("project boot state json error: {0}")]
    Json(#[from] serde_json::Error),
}

pub type ProjectBootStateResult<T> = Result<T, ProjectBootStateError>;

pub fn booted_projects_state_path(daemon_dir: impl AsRef<Path>) -> PathBuf {
    daemon_dir.as_ref().join(BOOTED_PROJECTS_FILE_NAME)
}

pub fn read_booted_projects_state(
    daemon_dir: impl AsRef<Path>,
) -> ProjectBootStateResult<BootedProjectsState> {
    let path = booted_projects_state_path(daemon_dir);
    match fs::read_to_string(path) {
        Ok(content) => normalize_state(serde_json::from_str(&content)?),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(BootedProjectsState {
            schema_version: BOOTED_PROJECTS_SCHEMA_VERSION,
            updated_at: 0,
            projects: Vec::new(),
        }),
        Err(error) => Err(error.into()),
    }
}

pub fn record_project_boot_event(
    daemon_dir: impl AsRef<Path>,
    event: &SignedNostrEvent,
    timestamp_ms: u64,
) -> ProjectBootStateResult<ProjectBootOutcome> {
    let daemon_dir = daemon_dir.as_ref();
    let reference = extract_project_boot_reference(event)?;
    let mut state = read_booted_projects_state(daemon_dir)?;
    let mut by_project = state
        .projects
        .into_iter()
        .map(|project| {
            (
                (
                    project.project_owner_pubkey.clone(),
                    project.project_d_tag.clone(),
                ),
                project,
            )
        })
        .collect::<BTreeMap<_, _>>();
    let key = (
        reference.project_owner_pubkey.clone(),
        reference.project_d_tag.clone(),
    );
    let already_booted = by_project.contains_key(&key);
    by_project.insert(
        key,
        BootedProject {
            project_owner_pubkey: reference.project_owner_pubkey.clone(),
            project_d_tag: reference.project_d_tag.clone(),
            project_reference: reference.project_reference.clone(),
            boot_event_id: event.id.clone(),
            booted_at: timestamp_ms,
        },
    );
    state = BootedProjectsState {
        schema_version: BOOTED_PROJECTS_SCHEMA_VERSION,
        updated_at: timestamp_ms,
        projects: by_project.into_values().collect(),
    };
    write_booted_projects_state(daemon_dir, &state)?;

    Ok(ProjectBootOutcome {
        project_owner_pubkey: reference.project_owner_pubkey,
        project_d_tag: reference.project_d_tag,
        project_reference: reference.project_reference,
        boot_event_id: event.id.clone(),
        already_booted,
        booted_project_count: state.projects.len(),
    })
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

fn normalize_state(state: BootedProjectsState) -> ProjectBootStateResult<BootedProjectsState> {
    let mut by_project = BTreeMap::new();
    for project in state.projects {
        by_project.insert(
            (
                project.project_owner_pubkey.clone(),
                project.project_d_tag.clone(),
            ),
            project,
        );
    }
    Ok(BootedProjectsState {
        schema_version: BOOTED_PROJECTS_SCHEMA_VERSION,
        updated_at: state.updated_at,
        projects: by_project.into_values().collect(),
    })
}

fn write_booted_projects_state(
    daemon_dir: &Path,
    state: &BootedProjectsState,
) -> ProjectBootStateResult<()> {
    fs::create_dir_all(daemon_dir)?;
    let path = booted_projects_state_path(daemon_dir);
    let tmp_path = path.with_extension(format!("json.tmp.{}", std::process::id()));
    fs::write(&tmp_path, serde_json::to_string_pretty(state)?)?;
    fs::rename(tmp_path, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn missing_state_reads_as_empty() {
        let tmp = tempdir().expect("temp dir");

        let state = read_booted_projects_state(tmp.path()).expect("state must read");

        assert_eq!(state.schema_version, BOOTED_PROJECTS_SCHEMA_VERSION);
        assert_eq!(state.updated_at, 0);
        assert!(state.projects.is_empty());
    }

    #[test]
    fn boot_event_records_project_reference() {
        let tmp = tempdir().expect("temp dir");
        let event = boot_event(
            "event-one",
            vec![vec!["a", "31933:owner-pubkey:demo-project"]],
        );

        let outcome =
            record_project_boot_event(tmp.path(), &event, 1_710_001_000_000).expect("record boot");

        assert_eq!(outcome.project_owner_pubkey, "owner-pubkey");
        assert_eq!(outcome.project_d_tag, "demo-project");
        assert!(!outcome.already_booted);
        let state = read_booted_projects_state(tmp.path()).expect("state must read");
        assert!(is_project_booted(&state, "owner-pubkey", "demo-project"));
        assert_eq!(state.projects[0].boot_event_id, "event-one");
    }

    #[test]
    fn repeated_boot_updates_existing_project_without_duplicate() {
        let tmp = tempdir().expect("temp dir");
        let first = boot_event(
            "event-one",
            vec![vec!["a", "31933:owner-pubkey:demo-project"]],
        );
        let second = boot_event(
            "event-two",
            vec![vec!["a", "31933:owner-pubkey:demo-project"]],
        );

        record_project_boot_event(tmp.path(), &first, 1_710_001_000_000).expect("first boot");
        let outcome =
            record_project_boot_event(tmp.path(), &second, 1_710_001_030_000).expect("second boot");

        assert!(outcome.already_booted);
        let state = read_booted_projects_state(tmp.path()).expect("state must read");
        assert_eq!(state.projects.len(), 1);
        assert_eq!(state.projects[0].boot_event_id, "event-two");
        assert_eq!(state.projects[0].booted_at, 1_710_001_030_000);
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
