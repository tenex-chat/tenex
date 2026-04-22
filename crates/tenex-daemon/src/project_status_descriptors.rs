use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::str::FromStr;

use secp256k1::XOnlyPublicKey;
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const PROJECTS_DIR_NAME: &str = "projects";
pub const PROJECT_DESCRIPTOR_FILE_NAME: &str = "project.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectStatusDescriptorReport {
    pub descriptors: Vec<ProjectStatusDescriptor>,
    pub skipped_files: Vec<ProjectStatusDescriptorSkippedFile>,
}

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
    pub worktrees: Vec<String>,
}

#[derive(Debug, Error)]
pub enum ProjectStatusDescriptorError {
    #[error("failed to read project descriptors directory {path:?}: {source}")]
    ReadDirectory { path: PathBuf, source: io::Error },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawProjectStatusDescriptor {
    #[serde(
        default,
        alias = "ownerPubkey",
        alias = "owner_pubkey",
        alias = "project_owner_pubkey"
    )]
    project_owner_pubkey: Option<String>,
    #[serde(default, alias = "dTag", alias = "d", alias = "project_d_tag")]
    project_d_tag: Option<String>,
    #[serde(
        default,
        alias = "managerPubkey",
        alias = "manager_pubkey",
        alias = "project_manager_pubkey"
    )]
    project_manager_pubkey: Option<String>,
    #[serde(default)]
    worktrees: Vec<String>,
    #[serde(default)]
    status: Option<String>,
}

pub fn projects_dir(base_dir: impl AsRef<Path>) -> PathBuf {
    base_dir.as_ref().join(PROJECTS_DIR_NAME)
}

pub fn project_descriptor_path(base_dir: impl AsRef<Path>, project_d_tag: &str) -> PathBuf {
    projects_dir(base_dir)
        .join(project_d_tag)
        .join(PROJECT_DESCRIPTOR_FILE_NAME)
}

pub fn read_project_status_descriptors(
    base_dir: impl AsRef<Path>,
) -> Result<ProjectStatusDescriptorReport, ProjectStatusDescriptorError> {
    let projects_dir = projects_dir(base_dir);
    let mut skipped_files = Vec::new();
    let mut project_dirs = Vec::new();

    let entries = match fs::read_dir(&projects_dir) {
        Ok(entries) => entries,
        Err(source) if source.kind() == io::ErrorKind::NotFound => {
            return Ok(ProjectStatusDescriptorReport {
                descriptors: Vec::new(),
                skipped_files,
            });
        }
        Err(source) => {
            return Err(ProjectStatusDescriptorError::ReadDirectory {
                path: projects_dir,
                source,
            });
        }
    };

    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(source) => {
                skipped_files.push(ProjectStatusDescriptorSkippedFile {
                    path: projects_dir.clone(),
                    reason: format!("failed to read directory entry: {source}"),
                });
                continue;
            }
        };

        let path = entry.path();
        match entry.file_type() {
            Ok(file_type) if file_type.is_dir() => project_dirs.push(path),
            Ok(_) => continue,
            Err(source) => skipped_files.push(ProjectStatusDescriptorSkippedFile {
                path,
                reason: format!("failed to read file type: {source}"),
            }),
        }
    }

    project_dirs.sort_by(|left, right| {
        left.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .cmp(
                right
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or_default(),
            )
    });

    let mut descriptors = Vec::new();
    for project_dir in project_dirs {
        let Some(project_d_tag) = project_dir.file_name().and_then(|name| name.to_str()) else {
            skipped_files.push(ProjectStatusDescriptorSkippedFile {
                path: project_dir,
                reason: "project directory name is not valid UTF-8".to_string(),
            });
            continue;
        };

        let descriptor_path = project_dir.join(PROJECT_DESCRIPTOR_FILE_NAME);
        let content = match fs::read_to_string(&descriptor_path) {
            Ok(content) => content,
            Err(source) if source.kind() == io::ErrorKind::NotFound => continue,
            Err(source) => {
                skipped_files.push(ProjectStatusDescriptorSkippedFile {
                    path: descriptor_path,
                    reason: format!("failed to read descriptor: {source}"),
                });
                continue;
            }
        };

        match parse_project_status_descriptor(&descriptor_path, project_d_tag, &content) {
            Ok(Some(descriptor)) => descriptors.push(descriptor),
            Ok(None) => continue,
            Err(reason) => skipped_files.push(ProjectStatusDescriptorSkippedFile {
                path: descriptor_path,
                reason,
            }),
        }
    }

    Ok(ProjectStatusDescriptorReport {
        descriptors,
        skipped_files,
    })
}

fn parse_project_status_descriptor(
    path: &Path,
    directory_d_tag: &str,
    content: &str,
) -> Result<Option<ProjectStatusDescriptor>, String> {
    let raw: RawProjectStatusDescriptor = serde_json::from_str(content)
        .map_err(|source| format!("failed to parse descriptor: {source}"))?;

    if !is_active_descriptor(raw.status.as_deref()) {
        return Ok(None);
    }

    let project_owner_pubkey = required_nonempty(raw.project_owner_pubkey, "projectOwnerPubkey")?;
    validate_xonly_pubkey_hex(&project_owner_pubkey)
        .map_err(|reason| format!("projectOwnerPubkey is not a valid x-only pubkey: {reason}"))?;

    let project_d_tag =
        optional_nonempty(raw.project_d_tag).unwrap_or_else(|| directory_d_tag.to_string());
    if project_d_tag != directory_d_tag {
        return Err(format!(
            "projectDTag {project_d_tag:?} does not match descriptor directory {directory_d_tag:?}"
        ));
    }

    let project_manager_pubkey = optional_nonempty(raw.project_manager_pubkey);
    if let Some(pubkey) = project_manager_pubkey.as_deref() {
        validate_xonly_pubkey_hex(pubkey).map_err(|reason| {
            format!("projectManagerPubkey is not a valid x-only pubkey: {reason}")
        })?;
    }

    let mut worktrees = retain_nonempty(raw.worktrees);
    worktrees.sort();
    worktrees.dedup();

    if path.file_name().and_then(|name| name.to_str()) != Some(PROJECT_DESCRIPTOR_FILE_NAME) {
        return Err(format!(
            "project descriptor must be named {PROJECT_DESCRIPTOR_FILE_NAME}"
        ));
    }

    Ok(Some(ProjectStatusDescriptor {
        project_owner_pubkey,
        project_d_tag,
        project_manager_pubkey,
        worktrees,
    }))
}

fn is_active_descriptor(status: Option<&str>) -> bool {
    match status.map(str::trim).filter(|value| !value.is_empty()) {
        None => true,
        Some("active" | "running") => true,
        Some(_) => false,
    }
}

fn required_nonempty(value: Option<String>, field: &str) -> Result<String, String> {
    optional_nonempty(value).ok_or_else(|| format!("missing {field}"))
}

fn optional_nonempty(value: Option<String>) -> Option<String> {
    value.and_then(|text| {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn retain_nonempty(values: Vec<String>) -> Vec<String> {
    values
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect()
}

fn validate_xonly_pubkey_hex(value: &str) -> Result<(), secp256k1::Error> {
    XOnlyPublicKey::from_str(value)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use secp256k1::{Keypair, Secp256k1, SecretKey};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn missing_projects_directory_returns_empty_report() {
        let base_dir = unique_temp_dir("project-descriptor-missing");

        let report = read_project_status_descriptors(&base_dir)
            .expect("missing projects directory must not fail");

        assert!(report.descriptors.is_empty());
        assert!(report.skipped_files.is_empty());
    }

    #[test]
    fn reads_active_project_descriptors_from_project_metadata_dirs() {
        let base_dir = unique_temp_dir("project-descriptor-read");
        let projects_dir = projects_dir(&base_dir);
        let alpha_dir = projects_dir.join("alpha");
        let beta_dir = projects_dir.join("beta");
        fs::create_dir_all(&alpha_dir).expect("alpha dir must create");
        fs::create_dir_all(&beta_dir).expect("beta dir must create");
        fs::write(projects_dir.join("ignored.json"), "{}").expect("ignored file must write");

        let alpha_owner = pubkey_hex(0x02);
        let alpha_pm = pubkey_hex(0x03);
        let beta_owner = pubkey_hex(0x04);
        fs::write(
            alpha_dir.join(PROJECT_DESCRIPTOR_FILE_NAME),
            format!(
                r#"{{
                    "status": "running",
                    "projectOwnerPubkey": "{alpha_owner}",
                    "projectDTag": "alpha",
                    "projectManagerPubkey": "{alpha_pm}",
                    "worktrees": ["feature/b", "main", "feature/b", ""]
                }}"#
            ),
        )
        .expect("alpha descriptor must write");
        fs::write(
            beta_dir.join(PROJECT_DESCRIPTOR_FILE_NAME),
            format!(
                r#"{{
                    "ownerPubkey": "{beta_owner}",
                    "dTag": "beta",
                    "worktrees": []
                }}"#
            ),
        )
        .expect("beta descriptor must write");

        let report = read_project_status_descriptors(&base_dir).expect("descriptors must read");

        assert!(report.skipped_files.is_empty());
        assert_eq!(
            report.descriptors,
            vec![
                ProjectStatusDescriptor {
                    project_owner_pubkey: alpha_owner,
                    project_d_tag: "alpha".to_string(),
                    project_manager_pubkey: Some(alpha_pm),
                    worktrees: vec!["feature/b".to_string(), "main".to_string()],
                },
                ProjectStatusDescriptor {
                    project_owner_pubkey: beta_owner,
                    project_d_tag: "beta".to_string(),
                    project_manager_pubkey: None,
                    worktrees: Vec::new(),
                },
            ]
        );
    }

    #[test]
    fn skips_inactive_malformed_and_invalid_project_descriptors() {
        let base_dir = unique_temp_dir("project-descriptor-skip");
        let projects_dir = projects_dir(&base_dir);
        let stopped_dir = projects_dir.join("stopped");
        let malformed_dir = projects_dir.join("malformed");
        let invalid_dir = projects_dir.join("invalid");
        let mismatch_dir = projects_dir.join("mismatch");
        fs::create_dir_all(&stopped_dir).expect("stopped dir must create");
        fs::create_dir_all(&malformed_dir).expect("malformed dir must create");
        fs::create_dir_all(&invalid_dir).expect("invalid dir must create");
        fs::create_dir_all(&mismatch_dir).expect("mismatch dir must create");

        fs::write(
            stopped_dir.join(PROJECT_DESCRIPTOR_FILE_NAME),
            format!(
                r#"{{"status":"stopped","projectOwnerPubkey":"{}"}}"#,
                pubkey_hex(0x05)
            ),
        )
        .expect("stopped descriptor must write");
        fs::write(
            malformed_dir.join(PROJECT_DESCRIPTOR_FILE_NAME),
            "{not-json",
        )
        .expect("malformed descriptor must write");
        fs::write(
            invalid_dir.join(PROJECT_DESCRIPTOR_FILE_NAME),
            r#"{"projectOwnerPubkey":"not-a-pubkey"}"#,
        )
        .expect("invalid descriptor must write");
        fs::write(
            mismatch_dir.join(PROJECT_DESCRIPTOR_FILE_NAME),
            format!(
                r#"{{"projectOwnerPubkey":"{}","projectDTag":"other"}}"#,
                pubkey_hex(0x06)
            ),
        )
        .expect("mismatch descriptor must write");

        let report = read_project_status_descriptors(&base_dir).expect("descriptors must read");

        assert!(report.descriptors.is_empty());
        assert_eq!(report.skipped_files.len(), 3);
        assert!(
            report
                .skipped_files
                .iter()
                .any(|skipped| skipped.reason.contains("failed to parse descriptor"))
        );
        assert!(
            report
                .skipped_files
                .iter()
                .any(|skipped| skipped.reason.contains("projectOwnerPubkey"))
        );
        assert!(
            report
                .skipped_files
                .iter()
                .any(|skipped| skipped.reason.contains("does not match"))
        );
    }

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be after UNIX_EPOCH")
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("{prefix}-{unique}-{counter}"))
    }

    fn pubkey_hex(fill_byte: u8) -> String {
        let secret_bytes = [fill_byte; 32];
        let secret = SecretKey::from_byte_array(secret_bytes).expect("valid secret");
        let secp = Secp256k1::new();
        let keypair = Keypair::from_secret_key(&secp, &secret);
        let (xonly, _) = keypair.x_only_public_key();
        hex::encode(xonly.serialize())
    }
}
