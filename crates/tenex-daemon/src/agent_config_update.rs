use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Map, Value};
use thiserror::Error;

use crate::nostr_event::SignedNostrEvent;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigUpdateOutcome {
    pub agent_pubkey: String,
    pub model: String,
    pub tools: Vec<String>,
    pub skills: Vec<String>,
    pub mcp_access: Vec<String>,
    pub file_changed: bool,
}

#[derive(Debug, Error)]
pub enum AgentConfigUpdateError {
    #[error("agent config update event missing `p` tag")]
    MissingAgentPubkey,
    #[error("agent config update event missing `model` tag")]
    MissingModel,
    #[error("agent file {path:?} not found for pubkey {pubkey}")]
    AgentFileNotFound { path: PathBuf, pubkey: String },
    #[error("agent file {path:?} has non-object root")]
    NonObjectRoot { path: PathBuf },
    #[error("agent config update io error: {0}")]
    Io(#[from] io::Error),
    #[error("agent config update json error: {0}")]
    Json(#[from] serde_json::Error),
}

/// Apply a kind 24020 agent-config-update event to the agent's JSON file.
/// Writes `model`, `tools`, `skills`, and `mcpAccess` to the `default` block.
/// Strips any legacy `projectOverrides` field on write (per-project overrides
/// were removed from the protocol).
pub fn apply_agent_config_update(
    agents_dir: impl AsRef<Path>,
    event: &SignedNostrEvent,
) -> Result<AgentConfigUpdateOutcome, AgentConfigUpdateError> {
    let agents_dir = agents_dir.as_ref();
    let agent_pubkey = extract_agent_pubkey(event)?;
    let model = extract_model(event)?;
    let tools = extract_tag_values(event, "tool");
    let skills = extract_tag_values(event, "skill");
    let mcp_access = extract_tag_values(event, "mcp");

    let agent_file = agents_dir.join(format!("{agent_pubkey}.json"));
    let content = match fs::read_to_string(&agent_file) {
        Ok(content) => content,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Err(AgentConfigUpdateError::AgentFileNotFound {
                path: agent_file,
                pubkey: agent_pubkey,
            });
        }
        Err(error) => return Err(error.into()),
    };

    let mut document: Value = serde_json::from_str(&content)?;
    if !matches!(document, Value::Object(_)) {
        return Err(AgentConfigUpdateError::NonObjectRoot { path: agent_file });
    }
    let before = document.clone();
    let Value::Object(ref mut root) = document else {
        unreachable!("document is an object");
    };

    apply_default_update(root, &model, &tools, &skills, &mcp_access);
    // Strip any legacy per-project override block on first write; the concept
    // is gone from the protocol and must not linger in storage.
    root.remove("projectOverrides");

    let changed = document != before;
    if changed {
        write_agent_file_atomically(&agent_file, &document)?;
    }

    Ok(AgentConfigUpdateOutcome {
        agent_pubkey,
        model,
        tools,
        skills,
        mcp_access,
        file_changed: changed,
    })
}

fn extract_agent_pubkey(event: &SignedNostrEvent) -> Result<String, AgentConfigUpdateError> {
    for tag in &event.tags {
        if tag.first().map(String::as_str) != Some("p") {
            continue;
        }
        if let Some(value) = tag.get(1) {
            if !value.is_empty() {
                return Ok(value.clone());
            }
        }
    }
    Err(AgentConfigUpdateError::MissingAgentPubkey)
}

fn extract_model(event: &SignedNostrEvent) -> Result<String, AgentConfigUpdateError> {
    for tag in &event.tags {
        if tag.first().map(String::as_str) != Some("model") {
            continue;
        }
        if let Some(value) = tag.get(1) {
            if !value.is_empty() {
                return Ok(value.clone());
            }
        }
    }
    Err(AgentConfigUpdateError::MissingModel)
}

fn extract_tag_values(event: &SignedNostrEvent, name: &str) -> Vec<String> {
    event
        .tags
        .iter()
        .filter_map(|tag| {
            if tag.first().map(String::as_str) == Some(name) {
                tag.get(1).filter(|v| !v.is_empty()).cloned()
            } else {
                None
            }
        })
        .collect()
}

fn apply_default_update(
    root: &mut Map<String, Value>,
    model: &str,
    tools: &[String],
    skills: &[String],
    mcp_access: &[String],
) {
    let default = ensure_object(root, "default");
    default.insert("model".to_string(), Value::String(model.to_string()));
    write_string_array_field(default, "tools", tools);
    write_string_array_field(default, "skills", skills);
    write_string_array_field(default, "mcpAccess", mcp_access);
    if default.is_empty() {
        root.remove("default");
    }
}

fn ensure_object<'a>(map: &'a mut Map<String, Value>, key: &str) -> &'a mut Map<String, Value> {
    if !matches!(map.get(key), Some(Value::Object(_))) {
        map.insert(key.to_string(), Value::Object(Map::new()));
    }
    match map.get_mut(key) {
        Some(Value::Object(obj)) => obj,
        _ => unreachable!("ensure_object must leave an object at {key}"),
    }
}

fn write_string_array_field(map: &mut Map<String, Value>, key: &str, values: &[String]) {
    if values.is_empty() {
        map.remove(key);
    } else {
        map.insert(
            key.to_string(),
            Value::Array(values.iter().map(|v| Value::String(v.clone())).collect()),
        );
    }
}

fn write_agent_file_atomically(path: &Path, value: &Value) -> Result<(), AgentConfigUpdateError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp_path = path.with_extension(format!("json.tmp.{}", std::process::id()));
    let serialized = serde_json::to_string_pretty(value)?;
    fs::write(&tmp_path, serialized)?;
    fs::rename(tmp_path, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    fn signed_event(tags: Vec<Vec<&str>>) -> SignedNostrEvent {
        SignedNostrEvent {
            id: "event-id".to_string(),
            pubkey: "owner".to_string(),
            created_at: 1_710_000_000,
            kind: 24020,
            tags: tags
                .into_iter()
                .map(|tag| tag.into_iter().map(str::to_string).collect())
                .collect(),
            content: String::new(),
            sig: "0".repeat(128),
        }
    }

    fn write_agent(path: &Path, contents: Value) {
        fs::write(path, serde_json::to_string_pretty(&contents).expect("json")).expect("write");
    }

    fn read_agent(path: &Path) -> Value {
        serde_json::from_str(&fs::read_to_string(path).expect("read")).expect("parse")
    }

    const AGENT_PUBKEY: &str = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

    #[test]
    fn writes_model_tools_skills_and_mcp_to_default_block() {
        let dir = tempdir().expect("tempdir");
        let agents_dir = dir.path();
        let agent_file = agents_dir.join(format!("{AGENT_PUBKEY}.json"));
        write_agent(
            &agent_file,
            json!({
                "slug": "alpha",
                "status": "active",
                "default": {"model": "anthropic:claude-sonnet-4-5"},
            }),
        );

        let event = signed_event(vec![
            vec!["p", AGENT_PUBKEY],
            vec!["model", "opus"],
            vec!["tool", "web_search"],
            vec!["skill", "read-access"],
            vec!["skill", "shell"],
            vec!["mcp", "github"],
        ]);

        let outcome = apply_agent_config_update(agents_dir, &event).expect("apply");
        assert_eq!(outcome.agent_pubkey, AGENT_PUBKEY);
        assert_eq!(outcome.model, "opus");
        assert_eq!(outcome.tools, vec!["web_search".to_string()]);
        assert_eq!(
            outcome.skills,
            vec!["read-access".to_string(), "shell".to_string()]
        );
        assert_eq!(outcome.mcp_access, vec!["github".to_string()]);
        assert!(outcome.file_changed);

        let stored = read_agent(&agent_file);
        assert_eq!(stored["default"]["model"], "opus");
        assert_eq!(stored["default"]["tools"], json!(["web_search"]));
        assert_eq!(stored["default"]["skills"], json!(["read-access", "shell"]));
        assert_eq!(stored["default"]["mcpAccess"], json!(["github"]));
    }

    #[test]
    fn strips_legacy_project_overrides_on_write() {
        let dir = tempdir().expect("tempdir");
        let agents_dir = dir.path();
        let agent_file = agents_dir.join(format!("{AGENT_PUBKEY}.json"));
        write_agent(
            &agent_file,
            json!({
                "slug": "alpha",
                "default": {"model": "opus"},
                "projectOverrides": {
                    "demo-project": {"model": "sonnet", "skills": ["legacy"]}
                }
            }),
        );

        let event = signed_event(vec![vec!["p", AGENT_PUBKEY], vec!["model", "haiku"]]);

        let outcome = apply_agent_config_update(agents_dir, &event).expect("apply");
        assert!(outcome.file_changed);

        let stored = read_agent(&agent_file);
        assert_eq!(stored["default"]["model"], "haiku");
        assert!(
            stored.get("projectOverrides").is_none(),
            "projectOverrides must be stripped on write"
        );
    }

    #[test]
    fn empty_tag_values_clear_the_corresponding_field() {
        let dir = tempdir().expect("tempdir");
        let agents_dir = dir.path();
        let agent_file = agents_dir.join(format!("{AGENT_PUBKEY}.json"));
        write_agent(
            &agent_file,
            json!({
                "slug": "alpha",
                "default": {
                    "model": "opus",
                    "tools": ["web_search"],
                    "skills": ["old"],
                    "mcpAccess": ["github"]
                }
            }),
        );

        let event = signed_event(vec![vec!["p", AGENT_PUBKEY], vec!["model", "opus"]]);
        apply_agent_config_update(agents_dir, &event).expect("apply");

        let stored = read_agent(&agent_file);
        assert!(stored["default"].get("tools").is_none());
        assert!(stored["default"].get("skills").is_none());
        assert!(stored["default"].get("mcpAccess").is_none());
    }

    #[test]
    fn no_op_update_does_not_rewrite_file() {
        let dir = tempdir().expect("tempdir");
        let agents_dir = dir.path();
        let agent_file = agents_dir.join(format!("{AGENT_PUBKEY}.json"));
        write_agent(
            &agent_file,
            json!({
                "slug": "alpha",
                "default": {"model": "opus"}
            }),
        );

        let event = signed_event(vec![vec!["p", AGENT_PUBKEY], vec!["model", "opus"]]);
        let outcome = apply_agent_config_update(agents_dir, &event).expect("apply");
        assert!(!outcome.file_changed);
    }

    #[test]
    fn empty_single_element_tool_tag_is_ignored() {
        let dir = tempdir().expect("tempdir");
        let agents_dir = dir.path();
        let agent_file = agents_dir.join(format!("{AGENT_PUBKEY}.json"));
        write_agent(
            &agent_file,
            json!({"slug": "alpha", "default": {"model": "opus"}}),
        );
        // The TUI sometimes sends a placeholder ["tool"] with no value. That
        // must not register as "add empty tool".
        let event = signed_event(vec![
            vec!["p", AGENT_PUBKEY],
            vec!["model", "opus"],
            vec!["tool"],
        ]);
        let outcome = apply_agent_config_update(agents_dir, &event).expect("apply");
        assert!(outcome.tools.is_empty());
        assert!(!outcome.file_changed);
    }

    #[test]
    fn preserves_unrelated_fields() {
        let dir = tempdir().expect("tempdir");
        let agents_dir = dir.path();
        let agent_file = agents_dir.join(format!("{AGENT_PUBKEY}.json"));
        write_agent(
            &agent_file,
            json!({
                "slug": "alpha",
                "status": "active",
                "nsec": "nsec1xxx",
                "name": "Alpha",
                "isPM": true,
                "telegram": {"botToken": "abc"},
                "default": {"model": "sonnet"}
            }),
        );

        let event = signed_event(vec![vec!["p", AGENT_PUBKEY], vec!["model", "opus"]]);
        apply_agent_config_update(agents_dir, &event).expect("apply");

        let stored = read_agent(&agent_file);
        assert_eq!(stored["slug"], "alpha");
        assert_eq!(stored["status"], "active");
        assert_eq!(stored["nsec"], "nsec1xxx");
        assert_eq!(stored["name"], "Alpha");
        assert_eq!(stored["isPM"], true);
        assert_eq!(stored["telegram"]["botToken"], "abc");
    }

    #[test]
    fn missing_p_tag_errors() {
        let dir = tempdir().expect("tempdir");
        let event = signed_event(vec![vec!["model", "opus"]]);
        let error = apply_agent_config_update(dir.path(), &event).expect_err("must error");
        assert!(matches!(error, AgentConfigUpdateError::MissingAgentPubkey));
    }

    #[test]
    fn missing_model_tag_errors() {
        let dir = tempdir().expect("tempdir");
        let event = signed_event(vec![vec!["p", AGENT_PUBKEY]]);
        let error = apply_agent_config_update(dir.path(), &event).expect_err("must error");
        assert!(matches!(error, AgentConfigUpdateError::MissingModel));
    }

    #[test]
    fn missing_agent_file_errors() {
        let dir = tempdir().expect("tempdir");
        let event = signed_event(vec![vec!["p", AGENT_PUBKEY], vec!["model", "opus"]]);
        let error = apply_agent_config_update(dir.path(), &event).expect_err("must error");
        match error {
            AgentConfigUpdateError::AgentFileNotFound { pubkey, .. } => {
                assert_eq!(pubkey, AGENT_PUBKEY);
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }
}
