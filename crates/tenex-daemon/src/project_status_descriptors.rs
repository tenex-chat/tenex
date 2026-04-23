use std::path::PathBuf;

use serde::Serialize;
use thiserror::Error;

/// Projection of the daemon's in-memory kind 31933 event index into the shape
/// every downstream subsystem (maintenance loop, scheduled tasks, inbound
/// routing, project-status republishes) consumes. Built by
/// [`crate::project_event_index::ProjectEventIndex::descriptors_report`]; the
/// daemon has no on-disk project descriptor file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectStatusDescriptorReport {
    pub descriptors: Vec<ProjectStatusDescriptor>,
    pub skipped_files: Vec<ProjectStatusDescriptorSkippedFile>,
}

/// Preserved as part of the report shape for diagnostics consumers that
/// previously surfaced descriptor parse failures. The index projection never
/// populates it (malformed events are dropped at ingestion), so this is
/// always empty today.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectStatusDescriptorSkippedFile {
    pub path: PathBuf,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectStatusDescriptor {
    pub project_owner_pubkey: String,
    pub project_d_tag: String,
    pub project_manager_pubkey: Option<String>,
    pub project_base_path: Option<String>,
}

#[derive(Debug, Error)]
pub enum ProjectStatusDescriptorError {}
