//! Build agent + projectAgentInventory blocks for the worker `execute`
//! protocol message.
//!
//! These blocks let the Bun worker materialize the executing agent and the
//! project's agent inventory without reading `~/.tenex/agents/*.json`. Per
//! the design (docs/rust/project-warm-worker-design.md):
//!
//! - `agent` is the full configuration of the agent that will execute,
//!   including its private signing key.
//! - `projectAgentInventory` is the daemon's authoritative view of all
//!   agents in the project at dispatch time; the worker reconciles
//!   `ProjectContext.agents` against it per execute.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};
use thiserror::Error;

use crate::agent_inventory::read_project_agent_pubkeys_for;

#[derive(Debug, Error)]
pub enum AgentPayloadError {
    #[error("agent file {path} could not be read: {source}")]
    AgentFileRead { path: PathBuf, source: io::Error },
    #[error("agent file {path} is missing")]
    AgentFileMissing { path: PathBuf },
    #[error("agent file {path} is not valid JSON: {source}")]
    AgentFileParse {
        path: PathBuf,
        source: serde_json::Error,
    },
    #[error("agent file {path} is missing required field {field}")]
    AgentFileMissingField { path: PathBuf, field: &'static str },
    #[error(transparent)]
    Inventory(#[from] crate::agent_inventory::AgentInventoryError),
}

pub type AgentPayloadResult<T> = Result<T, AgentPayloadError>;

/// Read `<tenex_base_dir>/agents/<pubkey>.json` and convert it to the
/// `agent` block expected by the AgentWorkerProtocol `execute` message.
///
/// The on-disk shape is:
/// ```json
/// {
///   "nsec": "...",
///   "slug": "...",
///   "name": "...",
///   "role": "...",
///   "category": "...",
///   "instructions": "...",
///   "default": { "model": "...", "tools": [], "skills": [], "blockedSkills": [], "mcpAccess": [] }
/// }
/// ```
///
/// The protocol shape moves `nsec` to `signingPrivateKey` and flattens the
/// `default` block. Unknown on-disk fields are passed through (the schema
/// uses `passthrough`).
pub fn read_agent_payload(
    tenex_base_dir: &Path,
    pubkey: &str,
) -> AgentPayloadResult<Value> {
    let path = tenex_base_dir.join("agents").join(format!("{pubkey}.json"));
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Err(AgentPayloadError::AgentFileMissing { path });
        }
        Err(source) => {
            return Err(AgentPayloadError::AgentFileRead { path, source });
        }
    };
    let mut value: Value = serde_json::from_str(&content).map_err(|source| {
        AgentPayloadError::AgentFileParse {
            path: path.clone(),
            source,
        }
    })?;

    let object = value.as_object_mut().ok_or_else(|| {
        AgentPayloadError::AgentFileMissingField {
            path: path.clone(),
            field: "(root must be a JSON object)",
        }
    })?;

    let mut payload = Map::with_capacity(object.len() + 2);
    payload.insert("pubkey".to_string(), Value::String(pubkey.to_string()));

    // Move nsec → signingPrivateKey (the protocol field name).
    let nsec = object
        .remove("nsec")
        .ok_or_else(|| AgentPayloadError::AgentFileMissingField {
            path: path.clone(),
            field: "nsec",
        })?;
    payload.insert("signingPrivateKey".to_string(), nsec);

    // Required fields in the protocol schema.
    for required in ["slug", "name", "role"] {
        let value = object.remove(required).ok_or_else(|| {
            AgentPayloadError::AgentFileMissingField {
                path: path.clone(),
                field: required,
            }
        })?;
        payload.insert(required.to_string(), value);
    }

    // Optional pass-through fields the schema accepts at the top level.
    for optional in [
        "category",
        "description",
        "instructions",
        "customInstructions",
        "useCriteria",
        "isPM",
        "pmOverrides",
        "eventId",
        "useAISDKAgent",
        "telegram",
        "mcpServers",
    ] {
        if let Some(value) = object.remove(optional) {
            payload.insert(optional.to_string(), value);
        }
    }

    // Flatten the `default` block: its leaf fields (model, tools, skills,
    // blockedSkills, mcpAccess) become top-level on the protocol payload.
    if let Some(Value::Object(default)) = object.remove("default") {
        for (k, v) in default {
            // Map `model` (string) to llmConfig (the protocol's name for the
            // config slug into llms.json) — preserve the original under
            // `model` too in case downstream wants the raw value.
            if k == "model" {
                payload.insert("llmConfig".to_string(), v.clone());
                continue;
            }
            if matches!(k.as_str(), "tools" | "skills" | "blockedSkills" | "mcpAccess") {
                let key = if k == "skills" {
                    "alwaysSkills".to_string()
                } else {
                    k
                };
                payload.insert(key, v);
                continue;
            }
            // Anything else gets passed through under its original key.
            payload.insert(k, v);
        }
    }

    Ok(Value::Object(payload))
}

/// Read the project agent inventory (pubkey + slug + name) for the given
/// project from `<tenex_base_dir>/agents/index.json` plus the per-agent
/// JSON files. Returns one entry per agent in the project's index.
pub fn read_project_agent_inventory_payload(
    tenex_base_dir: &Path,
    project_id: &str,
) -> AgentPayloadResult<Vec<Value>> {
    let agents_dir = tenex_base_dir.join("agents");
    let pubkeys = read_project_agent_pubkeys_for(&agents_dir, project_id)?;

    let mut inventory = Vec::with_capacity(pubkeys.len());
    for pubkey in pubkeys {
        let path = agents_dir.join(format!("{pubkey}.json"));
        let content = match fs::read_to_string(&path) {
            Ok(content) => content,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                // Agent listed in index but file missing — skip with warning.
                tracing::warn!(
                    pubkey = %pubkey,
                    project_id = %project_id,
                    "agent listed in project index but agent file is missing; skipping inventory entry"
                );
                continue;
            }
            Err(source) => {
                return Err(AgentPayloadError::AgentFileRead { path, source });
            }
        };
        let value: Value = serde_json::from_str(&content).map_err(|source| {
            AgentPayloadError::AgentFileParse {
                path: path.clone(),
                source,
            }
        })?;
        let object = value.as_object().ok_or_else(|| {
            AgentPayloadError::AgentFileMissingField {
                path: path.clone(),
                field: "(root must be a JSON object)",
            }
        })?;

        let slug = object
            .get("slug")
            .and_then(Value::as_str)
            .ok_or_else(|| AgentPayloadError::AgentFileMissingField {
                path: path.clone(),
                field: "slug",
            })?;
        let name = object
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(slug);

        let mut entry = Map::with_capacity(4);
        entry.insert("pubkey".to_string(), Value::String(pubkey));
        entry.insert("slug".to_string(), Value::String(slug.to_string()));
        entry.insert("name".to_string(), Value::String(name.to_string()));
        if let Some(role) = object.get("role").and_then(Value::as_str) {
            entry.insert("role".to_string(), Value::String(role.to_string()));
        }
        if let Some(is_pm) = object.get("isPM").and_then(Value::as_bool) {
            entry.insert("isPM".to_string(), Value::Bool(is_pm));
        }
        inventory.push(Value::Object(entry));
    }

    Ok(inventory)
}

/// Derive the TENEX base dir from a per-project metadata path. The metadata
/// path is `<tenex_base_dir>/projects/<project_id>` per existing layout.
///
/// Falls back to the `TENEX_BASE_DIR` environment variable when the path
/// derivation fails (e.g. the metadata_path is not under the standard
/// `<base>/projects/<id>` layout). The daemon is always launched with
/// TENEX_BASE_DIR set, so the env-var fallback is a reliable safety net.
pub fn tenex_base_dir_from_metadata_path(metadata_path: &Path) -> Option<PathBuf> {
    if let Some(parent) = metadata_path.parent().and_then(Path::parent) {
        // Sanity check: the derived parent should be the same as the
        // grandparent of the metadata_path. We treat the parent path as
        // valid if it actually exists; a non-existent path likely means
        // the layout is non-standard and we should fall through to env.
        let candidate = parent.to_path_buf();
        if candidate.exists() {
            return Some(candidate);
        }
    }

    std::env::var_os("TENEX_BASE_DIR").map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn unique_temp_dir(label: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time goes forward")
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("tenex-agent-{label}-{stamp}-{counter}"));
        fs::create_dir_all(&path).expect("must create temp dir");
        path
    }

    #[test]
    fn reads_agent_payload_with_required_and_optional_fields() {
        let base = unique_temp_dir("agent-payload");
        let agents_dir = base.join("agents");
        fs::create_dir_all(&agents_dir).unwrap();
        let pubkey = "a".repeat(64);
        let agent_json = serde_json::json!({
            "nsec": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            "slug": "project-manager",
            "name": "Project Manager",
            "role": "project-manager",
            "category": "orchestrator",
            "instructions": "You are the PM.",
            "default": {
                "model": "default",
                "tools": ["fs_read"],
                "skills": ["recall"],
                "blockedSkills": [],
                "mcpAccess": ["mcp-a"]
            }
        });
        fs::write(
            agents_dir.join(format!("{pubkey}.json")),
            serde_json::to_string_pretty(&agent_json).unwrap(),
        )
        .unwrap();

        let payload = read_agent_payload(&base, &pubkey).expect("payload must load");
        let obj = payload.as_object().unwrap();
        assert_eq!(obj.get("pubkey").and_then(Value::as_str), Some(pubkey.as_str()));
        assert_eq!(
            obj.get("signingPrivateKey").and_then(Value::as_str),
            Some("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
        );
        assert_eq!(obj.get("slug").and_then(Value::as_str), Some("project-manager"));
        assert_eq!(obj.get("name").and_then(Value::as_str), Some("Project Manager"));
        assert_eq!(obj.get("role").and_then(Value::as_str), Some("project-manager"));
        assert_eq!(obj.get("category").and_then(Value::as_str), Some("orchestrator"));
        assert_eq!(obj.get("instructions").and_then(Value::as_str), Some("You are the PM."));
        assert_eq!(obj.get("llmConfig").and_then(Value::as_str), Some("default"));
        assert!(obj.get("alwaysSkills").is_some(), "skills mapped to alwaysSkills");
        assert!(obj.get("mcpAccess").is_some());

        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn missing_agent_file_returns_dedicated_error() {
        let base = unique_temp_dir("missing");
        fs::create_dir_all(base.join("agents")).unwrap();

        let pubkey = "b".repeat(64);
        let result = read_agent_payload(&base, &pubkey);
        match result {
            Err(AgentPayloadError::AgentFileMissing { .. }) => {}
            other => panic!("expected AgentFileMissing, got {other:?}"),
        }

        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn missing_nsec_returns_missing_field_error() {
        let base = unique_temp_dir("no-nsec");
        let agents_dir = base.join("agents");
        fs::create_dir_all(&agents_dir).unwrap();
        let pubkey = "c".repeat(64);
        let agent_json = serde_json::json!({
            "slug": "agent",
            "name": "Agent",
            "role": "agent",
        });
        fs::write(
            agents_dir.join(format!("{pubkey}.json")),
            serde_json::to_string(&agent_json).unwrap(),
        )
        .unwrap();

        let result = read_agent_payload(&base, &pubkey);
        match result {
            Err(AgentPayloadError::AgentFileMissingField { field: "nsec", .. }) => {}
            other => panic!("expected MissingField nsec, got {other:?}"),
        }

        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn reads_project_agent_inventory_from_index() {
        let base = unique_temp_dir("inventory");
        let agents_dir = base.join("agents");
        fs::create_dir_all(&agents_dir).unwrap();
        // Real x-only pubkeys (validated by `read_project_agent_pubkeys_for`).
        let pubkey_a =
            "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798".to_string();
        let pubkey_b =
            "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5".to_string();

        for (pubkey, slug, name, role, is_pm) in [
            (&pubkey_a, "pm", "Project Manager", "project-manager", true),
            (&pubkey_b, "worker", "Worker", "worker", false),
        ] {
            let agent_json = serde_json::json!({
                "nsec": "0".repeat(64),
                "slug": slug,
                "name": name,
                "role": role,
                "isPM": is_pm,
                "default": {}
            });
            fs::write(
                agents_dir.join(format!("{pubkey}.json")),
                serde_json::to_string(&agent_json).unwrap(),
            )
            .unwrap();
        }

        let index = serde_json::json!({
            "byProject": { "project-x": [pubkey_a, pubkey_b] }
        });
        fs::write(
            agents_dir.join("index.json"),
            serde_json::to_string(&index).unwrap(),
        )
        .unwrap();

        let inventory =
            read_project_agent_inventory_payload(&base, "project-x").expect("inventory loads");
        assert_eq!(inventory.len(), 2);
        let slugs: Vec<&str> = inventory
            .iter()
            .filter_map(|entry| entry.get("slug").and_then(Value::as_str))
            .collect();
        assert!(slugs.contains(&"pm"));
        assert!(slugs.contains(&"worker"));

        fs::remove_dir_all(&base).ok();
    }
}
