//! Persistent cache of the last-published per-agent config snapshot hash.
//!
//! Kind 34011 is an addressable event: the relay stores exactly one event
//! per (backend_pubkey, 34011, d-tag) tuple. We only need to publish when
//! the effective config for an agent actually changes (model / skills /
//! mcp / owner set). This module records, per agent, the content hash of
//! the last snapshot we published. Callers check against the cache and
//! skip the publish when the hash matches.
//!
//! Cache file lives at `<daemon_dir>/agent-config-publish-cache.json` and
//! survives daemon restarts. A restart followed by an unchanged agent
//! directory therefore produces zero publish traffic — the cache entry
//! tells us the relay already has a current event.
//!
//! When the cache is out of sync with reality (file corrupted, daemon
//! dir wiped, manual agent JSON edit while daemon was down), we simply
//! miss → publish a fresh event. The relay replaces its stored copy with
//! our identical-but-signed-now event and the cache catches up.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::per_agent_config_snapshot::AgentConfigSnapshot;

pub const AGENT_CONFIG_PUBLISH_CACHE_FILE_NAME: &str = "agent-config-publish-cache.json";
const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigPublishCache {
    pub schema_version: u32,
    #[serde(default)]
    pub agents: BTreeMap<String, AgentConfigPublishCacheEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigPublishCacheEntry {
    pub last_hash: String,
    pub last_published_at: u64,
}

impl AgentConfigPublishCache {
    pub fn empty() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            agents: BTreeMap::new(),
        }
    }

    /// Returns `true` when a snapshot with this content hash has already
    /// been published for this agent and therefore doesn't need to be
    /// republished.
    pub fn is_fresh(&self, agent_pubkey: &str, snapshot_hash: &str) -> bool {
        self.agents
            .get(agent_pubkey)
            .is_some_and(|entry| entry.last_hash == snapshot_hash)
    }

    pub fn record_published(
        &mut self,
        agent_pubkey: impl Into<String>,
        snapshot_hash: impl Into<String>,
        published_at: u64,
    ) {
        self.agents.insert(
            agent_pubkey.into(),
            AgentConfigPublishCacheEntry {
                last_hash: snapshot_hash.into(),
                last_published_at: published_at,
            },
        );
    }

    pub fn forget_agent(&mut self, agent_pubkey: &str) {
        self.agents.remove(agent_pubkey);
    }
}

#[derive(Debug, Error)]
pub enum AgentConfigPublishCacheError {
    #[error("failed to read agent config publish cache {path:?}: {source}")]
    Read { path: PathBuf, source: io::Error },
    #[error("failed to parse agent config publish cache {path:?}: {source}")]
    Parse {
        path: PathBuf,
        source: serde_json::Error,
    },
    #[error("failed to write agent config publish cache {path:?}: {source}")]
    Write { path: PathBuf, source: io::Error },
    #[error("failed to serialize agent config publish cache: {0}")]
    Serialize(#[from] serde_json::Error),
}

pub fn cache_path(daemon_dir: &Path) -> PathBuf {
    daemon_dir.join(AGENT_CONFIG_PUBLISH_CACHE_FILE_NAME)
}

pub fn read_cache(
    daemon_dir: &Path,
) -> Result<AgentConfigPublishCache, AgentConfigPublishCacheError> {
    let path = cache_path(daemon_dir);
    match fs::read_to_string(&path) {
        Ok(content) => {
            serde_json::from_str(&content).map_err(|source| AgentConfigPublishCacheError::Parse {
                path: path.clone(),
                source,
            })
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(AgentConfigPublishCache::empty()),
        Err(source) => Err(AgentConfigPublishCacheError::Read { path, source }),
    }
}

pub fn write_cache(
    daemon_dir: &Path,
    cache: &AgentConfigPublishCache,
) -> Result<(), AgentConfigPublishCacheError> {
    let path = cache_path(daemon_dir);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|source| AgentConfigPublishCacheError::Write {
            path: path.clone(),
            source,
        })?;
    }
    let tmp = path.with_extension(format!("json.tmp.{}", std::process::id()));
    let body = serde_json::to_vec_pretty(cache)?;
    fs::write(&tmp, body).map_err(|source| AgentConfigPublishCacheError::Write {
        path: tmp.clone(),
        source,
    })?;
    fs::rename(&tmp, &path).map_err(|source| AgentConfigPublishCacheError::Write { path, source })
}

/// Deterministic content hash of the parts of an agent snapshot that
/// affect the 34011 event body. Excludes timestamps — equivalent configs
/// at two different times produce the same hash.
pub fn snapshot_hash(snapshot: &AgentConfigSnapshot, owner_pubkeys: &[String]) -> String {
    #[derive(Serialize)]
    struct Hashable<'a> {
        agent_pubkey: &'a str,
        agent_slug: &'a str,
        owner_pubkeys: &'a [String],
        available_models: &'a [String],
        active_model: Option<&'a str>,
        available_skills: &'a [String],
        active_skills: Vec<&'a str>,
        available_mcps: &'a [String],
        active_mcps: Vec<&'a str>,
    }
    let hashable = Hashable {
        agent_pubkey: &snapshot.agent_pubkey,
        agent_slug: &snapshot.agent_slug,
        owner_pubkeys,
        available_models: &snapshot.available_models,
        active_model: snapshot.active_model.as_deref(),
        available_skills: &snapshot.available_skills,
        active_skills: snapshot.active_skills.iter().map(String::as_str).collect(),
        available_mcps: &snapshot.available_mcps,
        active_mcps: snapshot.active_mcps.iter().map(String::as_str).collect(),
    };
    let canonical = serde_json::to_vec(&hashable).expect("hashable snapshot must serialize");
    let mut hasher = Sha256::new();
    hasher.update(&canonical);
    hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    use tempfile::tempdir;

    fn snapshot_for(
        pubkey: &str,
        slug: &str,
        models: &[&str],
        active_model: Option<&str>,
    ) -> AgentConfigSnapshot {
        let active_model = active_model.map(str::to_string);
        let active_model_set: BTreeSet<String> = active_model.iter().cloned().collect();
        AgentConfigSnapshot {
            agent_pubkey: pubkey.to_string(),
            agent_slug: slug.to_string(),
            available_models: models.iter().map(|s| s.to_string()).collect(),
            active_model,
            active_model_set,
            available_skills: Vec::new(),
            active_skills: BTreeSet::new(),
            available_mcps: Vec::new(),
            active_mcps: BTreeSet::new(),
        }
    }

    #[test]
    fn empty_cache_is_not_fresh_for_any_agent() {
        let cache = AgentConfigPublishCache::empty();
        assert!(!cache.is_fresh("any", "hash"));
    }

    #[test]
    fn record_and_check_publish_decision() {
        let mut cache = AgentConfigPublishCache::empty();
        let snapshot = snapshot_for("pub1", "alpha", &["opus", "sonnet"], Some("opus"));
        let owners = vec!["owner1".to_string()];
        let h = snapshot_hash(&snapshot, &owners);
        assert!(!cache.is_fresh(&snapshot.agent_pubkey, &h));
        cache.record_published(&snapshot.agent_pubkey, &h, 1);
        assert!(cache.is_fresh(&snapshot.agent_pubkey, &h));
        assert!(!cache.is_fresh(&snapshot.agent_pubkey, "different"));
    }

    #[test]
    fn hash_changes_on_active_model_switch() {
        let owners = vec!["owner1".to_string()];
        let a = snapshot_for("pub1", "alpha", &["opus", "sonnet"], Some("opus"));
        let b = snapshot_for("pub1", "alpha", &["opus", "sonnet"], Some("sonnet"));
        assert_ne!(snapshot_hash(&a, &owners), snapshot_hash(&b, &owners));
    }

    #[test]
    fn hash_is_stable_for_identical_inputs() {
        let owners = vec!["owner1".to_string()];
        let a = snapshot_for("pub1", "alpha", &["opus"], Some("opus"));
        let b = snapshot_for("pub1", "alpha", &["opus"], Some("opus"));
        assert_eq!(snapshot_hash(&a, &owners), snapshot_hash(&b, &owners));
    }

    #[test]
    fn read_cache_returns_empty_when_file_missing() {
        let dir = tempdir().expect("tempdir");
        let cache = read_cache(dir.path()).expect("read");
        assert!(cache.agents.is_empty());
    }

    #[test]
    fn write_then_read_round_trips() {
        let dir = tempdir().expect("tempdir");
        let mut cache = AgentConfigPublishCache::empty();
        cache.record_published("pub1", "hash1", 1_000);
        cache.record_published("pub2", "hash2", 2_000);
        write_cache(dir.path(), &cache).expect("write");
        let loaded = read_cache(dir.path()).expect("read");
        assert_eq!(loaded.agents.len(), 2);
        assert_eq!(loaded.agents["pub1"].last_hash, "hash1");
        assert_eq!(loaded.agents["pub1"].last_published_at, 1_000);
    }
}
