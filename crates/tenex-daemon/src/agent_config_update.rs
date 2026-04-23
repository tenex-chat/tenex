use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Map, Value};
use thiserror::Error;

use crate::nostr_classification::KIND_PROJECT;
use crate::nostr_event::SignedNostrEvent;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigUpdateOutcome {
    pub agent_pubkey: String,
    pub scope: AgentConfigUpdateScope,
    pub model: String,
    pub tools: Vec<String>,
    pub file_changed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AgentConfigUpdateScope {
    Global,
    Project {
        project_owner_pubkey: String,
        project_d_tag: String,
    },
}

#[derive(Debug, Error)]
pub enum AgentConfigUpdateError {
    #[error("agent config update event missing `p` tag")]
    MissingAgentPubkey,
    #[error("agent config update event missing `model` tag")]
    MissingModel,
    #[error("agent config update `a` tag `{reference}` is malformed")]
    MalformedProjectATag { reference: String },
    #[error("agent file {path:?} not found for pubkey {pubkey}")]
    AgentFileNotFound { path: PathBuf, pubkey: String },
    #[error("agent file {path:?} has non-object root")]
    NonObjectRoot { path: PathBuf },
    #[error("agent config update io error: {0}")]
    Io(#[from] io::Error),
    #[error("agent config update json error: {0}")]
    Json(#[from] serde_json::Error),
}

pub fn apply_agent_config_update(
    agents_dir: impl AsRef<Path>,
    event: &SignedNostrEvent,
) -> Result<AgentConfigUpdateOutcome, AgentConfigUpdateError> {
    let agents_dir = agents_dir.as_ref();
    let agent_pubkey = extract_agent_pubkey(event)?;
    let model = extract_model(event)?;
    let tools = extract_tools(event);
    let scope = extract_scope(event)?;

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

    match &scope {
        AgentConfigUpdateScope::Global => {
            apply_global_update(root, &model, &tools);
        }
        AgentConfigUpdateScope::Project { project_d_tag, .. } => {
            apply_project_update(root, project_d_tag, &model, &tools);
        }
    }

    let changed = document != before;
    if changed {
        write_agent_file_atomically(&agent_file, &document)?;
    }

    Ok(AgentConfigUpdateOutcome {
        agent_pubkey,
        scope,
        model,
        tools,
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

fn extract_tools(event: &SignedNostrEvent) -> Vec<String> {
    event
        .tags
        .iter()
        .filter_map(|tag| {
            if tag.first().map(String::as_str) == Some("tool") {
                tag.get(1).cloned()
            } else {
                None
            }
        })
        .collect()
}

fn extract_scope(
    event: &SignedNostrEvent,
) -> Result<AgentConfigUpdateScope, AgentConfigUpdateError> {
    for tag in &event.tags {
        if tag.first().map(String::as_str) != Some("a") {
            continue;
        }
        let Some(reference) = tag.get(1) else {
            continue;
        };
        if !reference.starts_with("31933:") {
            continue;
        }
        let (owner, d_tag) = parse_project_reference(reference)?;
        return Ok(AgentConfigUpdateScope::Project {
            project_owner_pubkey: owner,
            project_d_tag: d_tag,
        });
    }
    Ok(AgentConfigUpdateScope::Global)
}

fn parse_project_reference(reference: &str) -> Result<(String, String), AgentConfigUpdateError> {
    let mut parts = reference.splitn(3, ':');
    let malformed = || AgentConfigUpdateError::MalformedProjectATag {
        reference: reference.to_string(),
    };
    let kind = parts.next().ok_or_else(malformed)?;
    if kind != KIND_PROJECT.to_string() {
        return Err(malformed());
    }
    let owner = parts.next().ok_or_else(malformed)?;
    let d_tag = parts.next().ok_or_else(malformed)?;
    if owner.is_empty() || d_tag.is_empty() {
        return Err(malformed());
    }
    Ok((owner.to_string(), d_tag.to_string()))
}

fn apply_global_update(root: &mut Map<String, Value>, model: &str, tools: &[String]) {
    let default = ensure_object(root, "default");
    default.insert("model".to_string(), Value::String(model.to_string()));
    write_tools_field(default, tools);
    if default.is_empty() {
        root.remove("default");
    }
}

fn apply_project_update(
    root: &mut Map<String, Value>,
    project_d_tag: &str,
    model: &str,
    tools: &[String],
) {
    let default_model = root
        .get("default")
        .and_then(Value::as_object)
        .and_then(|default| default.get("model"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let default_tools = root
        .get("default")
        .and_then(Value::as_object)
        .and_then(|default| default.get("tools"))
        .and_then(Value::as_array)
        .map(|tools| {
            tools
                .iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let project_overrides = ensure_object(root, "projectOverrides");
    let override_entry = ensure_object(project_overrides, project_d_tag);

    if default_model.as_deref() == Some(model) {
        override_entry.remove("model");
    } else {
        override_entry.insert("model".to_string(), Value::String(model.to_string()));
    }

    if tools == default_tools.as_slice() {
        override_entry.remove("tools");
    } else {
        write_tools_field(override_entry, tools);
    }

    if override_entry.is_empty() {
        project_overrides.remove(project_d_tag);
    }
    if project_overrides.is_empty() {
        root.remove("projectOverrides");
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

fn write_tools_field(map: &mut Map<String, Value>, tools: &[String]) {
    if tools.is_empty() {
        map.remove("tools");
    } else {
        map.insert(
            "tools".to_string(),
            Value::Array(tools.iter().map(|t| Value::String(t.clone())).collect()),
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
    fn global_update_sets_default_model_and_tools() {
        let dir = tempdir().expect("tempdir");
        let agents_dir = dir.path();
        let agent_file = agents_dir.join(format!("{AGENT_PUBKEY}.json"));
        write_agent(
            &agent_file,
            json!({
                "slug": "alpha",
                "status": "active",
                "nsec": "nsec1xxx",
                "default": {
                    "model": "anthropic:claude-sonnet-4-5",
                },
            }),
        );

        let event = signed_event(vec![
            vec!["p", AGENT_PUBKEY],
            vec!["model", "anthropic:claude-opus-4-7"],
            vec!["tool", "web_search"],
            vec!["tool", "bash"],
        ]);

        let outcome = apply_agent_config_update(agents_dir, &event).expect("apply");
        assert_eq!(outcome.agent_pubkey, AGENT_PUBKEY);
        assert_eq!(outcome.scope, AgentConfigUpdateScope::Global);
        assert_eq!(outcome.model, "anthropic:claude-opus-4-7");
        assert_eq!(
            outcome.tools,
            vec!["web_search".to_string(), "bash".to_string()]
        );
        assert!(outcome.file_changed);

        let stored = read_agent(&agent_file);
        assert_eq!(stored["default"]["model"], "anthropic:claude-opus-4-7");
        assert_eq!(stored["default"]["tools"], json!(["web_search", "bash"]));
        assert_eq!(stored["slug"], "alpha");
        assert_eq!(stored["status"], "active");
        assert_eq!(stored["nsec"], "nsec1xxx");
    }

    #[test]
    fn global_update_creates_default_block_when_missing() {
        let dir = tempdir().expect("tempdir");
        let agents_dir = dir.path();
        let agent_file = agents_dir.join(format!("{AGENT_PUBKEY}.json"));
        write_agent(
            &agent_file,
            json!({
                "slug": "alpha",
                "status": "active",
            }),
        );

        let event = signed_event(vec![
            vec!["p", AGENT_PUBKEY],
            vec!["model", "anthropic:claude-opus-4-7"],
        ]);

        let outcome = apply_agent_config_update(agents_dir, &event).expect("apply");
        assert!(outcome.file_changed);

        let stored = read_agent(&agent_file);
        assert_eq!(stored["default"]["model"], "anthropic:claude-opus-4-7");
        assert!(stored["default"].get("tools").is_none());
    }

    #[test]
    fn global_update_with_empty_tools_clears_tools_field() {
        let dir = tempdir().expect("tempdir");
        let agents_dir = dir.path();
        let agent_file = agents_dir.join(format!("{AGENT_PUBKEY}.json"));
        write_agent(
            &agent_file,
            json!({
                "slug": "alpha",
                "default": {
                    "model": "anthropic:claude-sonnet-4-5",
                    "tools": ["web_search"],
                },
            }),
        );

        let event = signed_event(vec![
            vec!["p", AGENT_PUBKEY],
            vec!["model", "anthropic:claude-sonnet-4-5"],
        ]);

        apply_agent_config_update(agents_dir, &event).expect("apply");

        let stored = read_agent(&agent_file);
        assert!(stored["default"].get("tools").is_none());
    }

    #[test]
    fn project_scoped_update_writes_to_project_overrides() {
        let dir = tempdir().expect("tempdir");
        let agents_dir = dir.path();
        let agent_file = agents_dir.join(format!("{AGENT_PUBKEY}.json"));
        write_agent(
            &agent_file,
            json!({
                "slug": "alpha",
                "default": {
                    "model": "anthropic:claude-sonnet-4-5",
                    "tools": ["web_search"],
                },
            }),
        );

        let event = signed_event(vec![
            vec!["a", "31933:owner-pubkey:demo-project"],
            vec!["p", AGENT_PUBKEY],
            vec!["model", "anthropic:claude-opus-4-7"],
            vec!["tool", "bash"],
        ]);

        let outcome = apply_agent_config_update(agents_dir, &event).expect("apply");
        assert_eq!(
            outcome.scope,
            AgentConfigUpdateScope::Project {
                project_owner_pubkey: "owner-pubkey".to_string(),
                project_d_tag: "demo-project".to_string(),
            }
        );

        let stored = read_agent(&agent_file);
        assert_eq!(
            stored["projectOverrides"]["demo-project"]["model"],
            "anthropic:claude-opus-4-7"
        );
        assert_eq!(
            stored["projectOverrides"]["demo-project"]["tools"],
            json!(["bash"])
        );
        // defaults preserved untouched
        assert_eq!(stored["default"]["model"], "anthropic:claude-sonnet-4-5");
        assert_eq!(stored["default"]["tools"], json!(["web_search"]));
    }

    #[test]
    fn project_scoped_update_dedups_against_defaults() {
        let dir = tempdir().expect("tempdir");
        let agents_dir = dir.path();
        let agent_file = agents_dir.join(format!("{AGENT_PUBKEY}.json"));
        write_agent(
            &agent_file,
            json!({
                "slug": "alpha",
                "default": {
                    "model": "anthropic:claude-sonnet-4-5",
                    "tools": ["web_search"],
                },
                "projectOverrides": {
                    "demo-project": {
                        "model": "openai:gpt-5",
                        "tools": ["bash"],
                    }
                }
            }),
        );

        let event = signed_event(vec![
            vec!["a", "31933:owner-pubkey:demo-project"],
            vec!["p", AGENT_PUBKEY],
            vec!["model", "anthropic:claude-sonnet-4-5"],
            vec!["tool", "web_search"],
        ]);

        apply_agent_config_update(agents_dir, &event).expect("apply");

        let stored = read_agent(&agent_file);
        assert!(stored.get("projectOverrides").is_none());
        assert_eq!(stored["default"]["model"], "anthropic:claude-sonnet-4-5");
    }

    #[test]
    fn project_scoped_update_keeps_unrelated_project_overrides() {
        let dir = tempdir().expect("tempdir");
        let agents_dir = dir.path();
        let agent_file = agents_dir.join(format!("{AGENT_PUBKEY}.json"));
        write_agent(
            &agent_file,
            json!({
                "slug": "alpha",
                "default": {
                    "model": "anthropic:claude-sonnet-4-5",
                },
                "projectOverrides": {
                    "other-project": {
                        "model": "openai:gpt-5",
                    }
                }
            }),
        );

        let event = signed_event(vec![
            vec!["a", "31933:owner-pubkey:demo-project"],
            vec!["p", AGENT_PUBKEY],
            vec!["model", "anthropic:claude-opus-4-7"],
        ]);

        apply_agent_config_update(agents_dir, &event).expect("apply");

        let stored = read_agent(&agent_file);
        assert_eq!(
            stored["projectOverrides"]["other-project"]["model"],
            "openai:gpt-5"
        );
        assert_eq!(
            stored["projectOverrides"]["demo-project"]["model"],
            "anthropic:claude-opus-4-7"
        );
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
                "pmOverrides": {"demo-project": true},
                "telegram": {"botToken": "abc"},
                "default": {"model": "anthropic:claude-sonnet-4-5"},
            }),
        );

        let event = signed_event(vec![
            vec!["p", AGENT_PUBKEY],
            vec!["model", "anthropic:claude-opus-4-7"],
        ]);

        apply_agent_config_update(agents_dir, &event).expect("apply");

        let stored = read_agent(&agent_file);
        assert_eq!(stored["slug"], "alpha");
        assert_eq!(stored["status"], "active");
        assert_eq!(stored["nsec"], "nsec1xxx");
        assert_eq!(stored["name"], "Alpha");
        assert_eq!(stored["isPM"], true);
        assert_eq!(stored["pmOverrides"]["demo-project"], true);
        assert_eq!(stored["telegram"]["botToken"], "abc");
    }

    #[test]
    fn missing_p_tag_errors() {
        let dir = tempdir().expect("tempdir");
        let event = signed_event(vec![vec!["model", "anthropic:claude-opus-4-7"]]);
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
        let event = signed_event(vec![
            vec!["p", AGENT_PUBKEY],
            vec!["model", "anthropic:claude-opus-4-7"],
        ]);
        let error = apply_agent_config_update(dir.path(), &event).expect_err("must error");
        match error {
            AgentConfigUpdateError::AgentFileNotFound { pubkey, .. } => {
                assert_eq!(pubkey, AGENT_PUBKEY);
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn malformed_project_a_tag_errors() {
        let dir = tempdir().expect("tempdir");
        let agents_dir = dir.path();
        let agent_file = agents_dir.join(format!("{AGENT_PUBKEY}.json"));
        write_agent(&agent_file, json!({"slug": "alpha"}));
        let event = signed_event(vec![
            vec!["a", "31933:"],
            vec!["p", AGENT_PUBKEY],
            vec!["model", "anthropic:claude-opus-4-7"],
        ]);
        let error = apply_agent_config_update(agents_dir, &event).expect_err("must error");
        assert!(matches!(
            error,
            AgentConfigUpdateError::MalformedProjectATag { .. }
        ));
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
                "default": {"model": "anthropic:claude-sonnet-4-5"},
            }),
        );

        let event = signed_event(vec![
            vec!["p", AGENT_PUBKEY],
            vec!["model", "anthropic:claude-sonnet-4-5"],
        ]);

        let outcome = apply_agent_config_update(agents_dir, &event).expect("apply");
        assert!(!outcome.file_changed);
    }
}
