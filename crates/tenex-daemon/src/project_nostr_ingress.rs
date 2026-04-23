use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use thiserror::Error;

use crate::nostr_event::SignedNostrEvent;
use crate::project_status_agent_sources::AGENT_INDEX_FILE_NAME;
use crate::project_status_descriptors::{
    PROJECT_DESCRIPTOR_FILE_NAME, PROJECTS_DIR_NAME, project_descriptor_path,
};

const AGENT_INDEX_LOCK_FILE_NAME: &str = "index.lock";

static AGENT_INDEX_WRITE_MUTEX: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProjectNostrIngressOutcome {
    pub project_d_tag: String,
    pub owner_pubkey: String,
    pub is_new_project: bool,
    pub agent_pubkeys: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo_url: Option<String>,
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
    #[error("failed to acquire agent index lock at {path}: {source}")]
    AcquireAgentIndexLock { path: PathBuf, source: io::Error },
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
    let repo_url = optional_tag_value(event, "repo");
    let project_base_path = format!("{}/{}", projects_base.trim_end_matches('/'), d_tag);

    let descriptor_path = project_descriptor_path(tenex_base_dir, d_tag);
    let is_new_project = !descriptor_path.exists();

    let project_dir = tenex_base_dir.join(PROJECTS_DIR_NAME).join(d_tag);
    fs::create_dir_all(&project_dir).map_err(ProjectNostrIngressError::CreateDir)?;

    let mut descriptor = json!({
        "projectOwnerPubkey": owner_pubkey,
        "projectDTag": d_tag,
        "projectBasePath": project_base_path,
        "status": "active"
    });
    if let Some(repo_url) = &repo_url {
        descriptor["repo"] = json!(repo_url);
    }
    fs::write(
        project_dir.join(PROJECT_DESCRIPTOR_FILE_NAME),
        serde_json::to_string_pretty(&descriptor).expect("descriptor serializes"),
    )
    .map_err(ProjectNostrIngressError::WriteDescriptor)?;

    let agents_dir = tenex_base_dir.join("agents");
    fs::create_dir_all(&agents_dir).map_err(ProjectNostrIngressError::CreateDir)?;

    write_agent_index_project_entry(&agents_dir, d_tag, &agent_pubkeys)?;

    Ok(ProjectNostrIngressOutcome {
        project_d_tag: d_tag.to_string(),
        owner_pubkey,
        is_new_project,
        agent_pubkeys,
        repo_url,
    })
}

/// Replaces `byProject[<project_d_tag>]` in `agents/index.json` with the
/// supplied agent pubkey list. Holds an in-process mutex and an `flock`-based
/// cross-process lock for the duration of the read-modify-write so concurrent
/// 31933 ingress paths cannot clobber each other's entries. Writes are atomic
/// (temp-file in the same directory plus rename) so readers never observe a
/// torn JSON document.
fn write_agent_index_project_entry(
    agents_dir: &Path,
    project_d_tag: &str,
    agent_pubkeys: &[String],
) -> Result<(), ProjectNostrIngressError> {
    let _lock = acquire_agent_index_write_lock(agents_dir)?;

    let index_path = agents_dir.join(AGENT_INDEX_FILE_NAME);
    let mut index: RawAgentIndex = match fs::read_to_string(&index_path) {
        Ok(content) => serde_json::from_str(&content)
            .map_err(ProjectNostrIngressError::ParseAgentIndex)?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => RawAgentIndex::default(),
        Err(source) => return Err(ProjectNostrIngressError::ReadAgentIndex(source)),
    };

    index
        .by_project
        .insert(project_d_tag.to_string(), agent_pubkeys.to_vec());

    let serialized =
        serde_json::to_vec_pretty(&index).expect("agent index serializes to JSON bytes");
    atomic_write(&index_path, &serialized).map_err(ProjectNostrIngressError::WriteAgentIndex)?;

    Ok(())
}

/// Atomically replaces `path` with `contents` by writing to a sibling temp
/// file, fsyncing it, renaming over the destination, and fsyncing the parent
/// directory. Readers see either the previous file or the new one, never a
/// truncated or partially-written intermediate state.
fn atomic_write(path: &Path, contents: &[u8]) -> io::Result<()> {
    let parent = path
        .parent()
        .expect("agent index path must have a parent directory");
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .expect("agent index path must have a UTF-8 file name");
    let temp_path = parent.join(format!(
        "{file_name}.tmp.{}",
        std::process::id()
    ));

    {
        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&temp_path)?;
        file.write_all(contents)?;
        file.sync_all()?;
    }

    fs::rename(&temp_path, path)?;
    File::open(parent)?.sync_all()?;
    Ok(())
}

struct AgentIndexWriteLock {
    _process_guard: MutexGuard<'static, ()>,
    _lock_file: File,
}

fn acquire_agent_index_write_lock(
    agents_dir: &Path,
) -> Result<AgentIndexWriteLock, ProjectNostrIngressError> {
    let process_guard = AGENT_INDEX_WRITE_MUTEX
        .lock()
        .map_err(|_| ProjectNostrIngressError::AcquireAgentIndexLock {
            path: agents_dir.join(AGENT_INDEX_LOCK_FILE_NAME),
            source: io::Error::other("agent index write mutex poisoned"),
        })?;

    let lock_path = agents_dir.join(AGENT_INDEX_LOCK_FILE_NAME);
    let lock_file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(&lock_path)
        .map_err(|source| ProjectNostrIngressError::AcquireAgentIndexLock {
            path: lock_path.clone(),
            source,
        })?;
    let ret = unsafe { libc::flock(lock_file.as_raw_fd(), libc::LOCK_EX) };
    if ret != 0 {
        return Err(ProjectNostrIngressError::AcquireAgentIndexLock {
            path: lock_path,
            source: io::Error::last_os_error(),
        });
    }

    Ok(AgentIndexWriteLock {
        _process_guard: process_guard,
        _lock_file: lock_file,
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

fn optional_tag_value(event: &SignedNostrEvent, name: &str) -> Option<String> {
    tag_value(event, name)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
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
        assert_eq!(outcome.repo_url, None);

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
    fn stores_repo_tag_in_project_descriptor() {
        let tmp = tempdir().expect("temp dir");
        let base = tmp.path();
        let owner = "a".repeat(64);
        let repo = "https://example.com/project.git";
        let mut event = project_event(&owner, "repo-project", &[]);
        event.tags.push(vec!["repo".to_string(), repo.to_string()]);

        let outcome =
            handle_project_nostr_event(base, &event, "/workspace/projects").expect("handle");

        assert_eq!(outcome.repo_url.as_deref(), Some(repo));
        let descriptor_path = base
            .join("projects")
            .join("repo-project")
            .join("project.json");
        let descriptor: Value =
            serde_json::from_str(&fs::read_to_string(&descriptor_path).unwrap()).unwrap();
        assert_eq!(descriptor["repo"], repo);
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

    #[test]
    fn ingesting_same_project_event_twice_is_idempotent() {
        let tmp = tempdir().expect("temp dir");
        let base = tmp.path();
        let owner = "a".repeat(64);
        let agent1 = "c".repeat(64);
        let agent2 = "d".repeat(64);
        let event = project_event(&owner, "idempotent-project", &[&agent1, &agent2]);

        handle_project_nostr_event(base, &event, "/workspace/projects").expect("first ingest");
        let index_after_first =
            fs::read_to_string(base.join("agents").join("index.json")).expect("first read");

        handle_project_nostr_event(base, &event, "/workspace/projects").expect("second ingest");
        let index_after_second =
            fs::read_to_string(base.join("agents").join("index.json")).expect("second read");

        assert_eq!(
            index_after_first, index_after_second,
            "ingesting the same kind:31933 twice must produce identical agents/index.json bytes"
        );

        let parsed: Value = serde_json::from_str(&index_after_second).expect("index parses");
        let by_project = parsed["byProject"]["idempotent-project"]
            .as_array()
            .expect("byProject entry must be an array");
        assert_eq!(
            by_project.len(),
            2,
            "agent list must not duplicate on repeat ingest"
        );
        assert_eq!(by_project[0], agent1.as_str());
        assert_eq!(by_project[1], agent2.as_str());
    }

    #[test]
    fn newer_project_event_replaces_byproject_entry_including_removals() {
        let tmp = tempdir().expect("temp dir");
        let base = tmp.path();
        let owner = "a".repeat(64);
        let agent1 = "c".repeat(64);
        let agent2 = "d".repeat(64);
        let agent3 = "e".repeat(64);

        handle_project_nostr_event(
            base,
            &project_event(&owner, "replaceable", &[&agent1, &agent2]),
            "/workspace/projects",
        )
        .expect("first ingest");

        // A newer 31933 from the same (owner, d_tag) drops agent2 and adds
        // agent3. The stored byProject[<d_tag>] must reflect the new event
        // exactly, including REMOVING agent2.
        handle_project_nostr_event(
            base,
            &project_event(&owner, "replaceable", &[&agent1, &agent3]),
            "/workspace/projects",
        )
        .expect("replacement ingest");

        let index: Value = serde_json::from_str(
            &fs::read_to_string(base.join("agents").join("index.json")).expect("read index"),
        )
        .expect("index parses");
        let by_project = index["byProject"]["replaceable"]
            .as_array()
            .expect("byProject entry must be an array");

        let pubkeys: Vec<&str> = by_project.iter().map(|value| value.as_str().unwrap()).collect();
        assert_eq!(
            pubkeys,
            vec![agent1.as_str(), agent3.as_str()],
            "newer project event must replace the agent list verbatim"
        );
        assert!(
            !pubkeys.contains(&agent2.as_str()),
            "agents removed from the newer project event must not survive"
        );
    }

    #[test]
    fn concurrent_ingress_for_different_projects_does_not_clobber_each_other() {
        use std::sync::Arc;
        use std::thread;

        let tmp = tempdir().expect("temp dir");
        let base: Arc<PathBuf> = Arc::new(tmp.path().to_path_buf());
        let owner = "a".repeat(64);

        let project_count = 8usize;
        let mut handles = Vec::with_capacity(project_count);
        for project_index in 0..project_count {
            let base = Arc::clone(&base);
            let owner = owner.clone();
            handles.push(thread::spawn(move || {
                let d_tag = format!("project-{project_index:02}");
                let agent_pubkey = make_pubkey_hex(project_index);
                let event = project_event(&owner, &d_tag, &[&agent_pubkey]);
                handle_project_nostr_event(base.as_path(), &event, "/workspace/projects")
                    .expect("concurrent ingest");
            }));
        }
        for handle in handles {
            handle.join().expect("thread join");
        }

        let index: Value = serde_json::from_str(
            &fs::read_to_string(base.as_path().join("agents").join("index.json"))
                .expect("read index"),
        )
        .expect("index parses");

        for project_index in 0..project_count {
            let d_tag = format!("project-{project_index:02}");
            let expected = make_pubkey_hex(project_index);
            let entry = index["byProject"][&d_tag]
                .as_array()
                .unwrap_or_else(|| panic!("byProject must contain {d_tag}"));
            assert_eq!(
                entry.len(),
                1,
                "project {d_tag} must have exactly one agent after concurrent ingest"
            );
            assert_eq!(
                entry[0].as_str().unwrap(),
                expected,
                "project {d_tag} must point to its own agent pubkey"
            );
        }
    }

    fn make_pubkey_hex(seed: usize) -> String {
        // 64-char hex strings are sufficient as opaque identifiers in these
        // tests; index.json stores them verbatim without secp256k1 validation.
        format!("{seed:064x}")
    }
}
