use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::str::FromStr;

use secp256k1::XOnlyPublicKey;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::backend_events::project_status::ProjectStatusAgent;

pub const AGENT_INDEX_FILE_NAME: &str = "index.json";

/// Agents belonging to a project, plus any filesystem entries we had to skip.
/// 24010 only needs pubkey + slug per agent; that's what this produces.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectStatusAgentSourceReport {
    pub agents: Vec<ProjectStatusAgent>,
    pub skipped_files: Vec<ProjectStatusAgentSourceSkippedFile>,
}

impl ProjectStatusAgentSourceReport {
    pub fn empty() -> Self {
        Self {
            agents: Vec::new(),
            skipped_files: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProjectStatusAgentSourceSkippedFile {
    pub path: PathBuf,
    pub reason: String,
}

#[derive(Debug, Error)]
pub enum ProjectStatusAgentSourceError {
    #[error("failed to read project-status agent source file {path}: {source}")]
    Read { path: PathBuf, source: io::Error },
    #[error("failed to parse project-status agent source file {path}: {source}")]
    Parse {
        path: PathBuf,
        source: serde_json::Error,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawAgentIndex {
    #[serde(default)]
    by_project: BTreeMap<String, Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawStoredAgentHeader {
    slug: Option<String>,
    #[serde(default)]
    status: Option<String>,
}

pub fn read_project_status_agent_sources(
    tenex_base_dir: impl AsRef<Path>,
    project_d_tag: &str,
) -> Result<ProjectStatusAgentSourceReport, ProjectStatusAgentSourceError> {
    let tenex_base_dir = tenex_base_dir.as_ref();
    let agent_index_path = agent_index_path(tenex_base_dir);
    let Some(agent_index_content) = read_optional_text_file(&agent_index_path)? else {
        return Ok(ProjectStatusAgentSourceReport::empty());
    };
    let agent_index: RawAgentIndex =
        serde_json::from_str(&agent_index_content).map_err(|source| {
            ProjectStatusAgentSourceError::Parse {
                path: agent_index_path.clone(),
                source,
            }
        })?;
    let project_pubkeys = agent_index
        .by_project
        .get(project_d_tag)
        .cloned()
        .unwrap_or_default();
    if project_pubkeys.is_empty() {
        return Ok(ProjectStatusAgentSourceReport::empty());
    }

    let mut skipped_files = Vec::new();
    let mut agents = Vec::new();
    let mut seen = BTreeSet::new();
    for pubkey in &project_pubkeys {
        if !seen.insert(pubkey.clone()) {
            continue;
        }
        if XOnlyPublicKey::from_str(pubkey).is_err() {
            skipped_files.push(ProjectStatusAgentSourceSkippedFile {
                path: agent_file_path(tenex_base_dir, pubkey),
                reason: format!("project agent pubkey is invalid: {pubkey:?}"),
            });
            continue;
        }
        let path = agent_file_path(tenex_base_dir, pubkey);
        match read_agent_header(&path) {
            Ok(Some(slug)) => agents.push(ProjectStatusAgent {
                pubkey: pubkey.clone(),
                slug,
            }),
            Ok(None) => {}
            Err(reason) => skipped_files.push(ProjectStatusAgentSourceSkippedFile { path, reason }),
        }
    }
    agents.sort_by(|left, right| {
        left.slug
            .cmp(&right.slug)
            .then_with(|| left.pubkey.cmp(&right.pubkey))
    });

    Ok(ProjectStatusAgentSourceReport {
        agents,
        skipped_files,
    })
}

fn read_agent_header(path: &Path) -> Result<Option<String>, String> {
    let content = fs::read_to_string(path)
        .map_err(|source| format!("failed to read agent file: {source}"))?;
    let raw: RawStoredAgentHeader = serde_json::from_str(&content)
        .map_err(|source| format!("failed to parse agent file: {source}"))?;

    if raw.status.as_deref() == Some("inactive") {
        return Ok(None);
    }
    if let Some(status) = raw.status.as_deref()
        && status != "active"
    {
        return Err(format!("unsupported agent status {status:?}"));
    }

    let slug = raw
        .slug
        .and_then(nonempty)
        .ok_or_else(|| "missing or empty slug".to_string())?;
    Ok(Some(slug))
}

pub fn agent_index_path(tenex_base_dir: &Path) -> PathBuf {
    agents_dir(tenex_base_dir).join(AGENT_INDEX_FILE_NAME)
}

pub fn agent_file_path(tenex_base_dir: &Path, pubkey: &str) -> PathBuf {
    agents_dir(tenex_base_dir).join(format!("{pubkey}.json"))
}

pub fn agents_dir(tenex_base_dir: &Path) -> PathBuf {
    tenex_base_dir.join("agents")
}

pub fn read_optional_text_file(
    path: &Path,
) -> Result<Option<String>, ProjectStatusAgentSourceError> {
    match fs::read_to_string(path) {
        Ok(content) => Ok(Some(content)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(source) => Err(ProjectStatusAgentSourceError::Read {
            path: path.to_path_buf(),
            source,
        }),
    }
}

fn nonempty(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use secp256k1::{Keypair, Secp256k1, SecretKey};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be after UNIX_EPOCH")
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("{prefix}-{unique}-{counter}"));
        fs::create_dir_all(&dir).expect("unique temp dir must create");
        dir
    }

    fn pubkey_hex(fill_byte: u8) -> String {
        let secret = SecretKey::from_byte_array([fill_byte; 32]).expect("valid secret");
        let secp = Secp256k1::new();
        let keypair = Keypair::from_secret_key(&secp, &secret);
        let (xonly, _) = keypair.x_only_public_key();
        hex::encode(xonly.serialize())
    }

    fn write_agent(base_dir: &Path, pubkey: &str, slug: &str, status: &str) {
        let agents_dir = base_dir.join("agents");
        fs::create_dir_all(&agents_dir).expect("agents dir must create");
        fs::write(
            agents_dir.join(format!("{pubkey}.json")),
            serde_json::to_vec_pretty(&serde_json::json!({
                "slug": slug,
                "status": status,
            }))
            .expect("agent json must serialize"),
        )
        .expect("agent file must write");
    }

    fn write_index(base_dir: &Path, project: &str, pubkeys: &[&str]) {
        let agents_dir = base_dir.join("agents");
        fs::create_dir_all(&agents_dir).expect("agents dir must create");
        fs::write(
            agents_dir.join(AGENT_INDEX_FILE_NAME),
            serde_json::to_vec_pretty(&serde_json::json!({
                "byProject": { project: pubkeys }
            }))
            .expect("index must serialize"),
        )
        .expect("index must write");
    }

    #[test]
    fn empty_when_index_missing() {
        let base = unique_temp_dir("agent-sources-missing");
        let report = read_project_status_agent_sources(&base, "demo").expect("must read");
        assert!(report.agents.is_empty());
        assert!(report.skipped_files.is_empty());
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn lists_active_agents_sorted_by_slug_then_pubkey() {
        let base = unique_temp_dir("agent-sources-sort");
        let a = pubkey_hex(0x02);
        let b = pubkey_hex(0x03);
        write_agent(&base, &a, "zeta", "active");
        write_agent(&base, &b, "alpha", "active");
        write_index(&base, "demo", &[&a, &b]);

        let report = read_project_status_agent_sources(&base, "demo").expect("must read");
        let slugs: Vec<_> = report.agents.iter().map(|a| a.slug.as_str()).collect();
        assert_eq!(slugs, vec!["alpha", "zeta"]);
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn skips_inactive_agents_silently() {
        let base = unique_temp_dir("agent-sources-inactive");
        let a = pubkey_hex(0x02);
        write_agent(&base, &a, "alpha", "inactive");
        write_index(&base, "demo", &[&a]);

        let report = read_project_status_agent_sources(&base, "demo").expect("must read");
        assert!(report.agents.is_empty());
        assert!(report.skipped_files.is_empty());
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn skips_invalid_pubkeys_with_reason() {
        let base = unique_temp_dir("agent-sources-invalid");
        write_index(&base, "demo", &["not-a-pubkey"]);
        let report = read_project_status_agent_sources(&base, "demo").expect("must read");
        assert!(report.agents.is_empty());
        assert_eq!(report.skipped_files.len(), 1);
        assert!(
            report.skipped_files[0]
                .reason
                .contains("project agent pubkey is invalid")
        );
        fs::remove_dir_all(&base).ok();
    }
}
