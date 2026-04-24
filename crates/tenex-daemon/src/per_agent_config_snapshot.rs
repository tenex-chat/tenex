use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use thiserror::Error;

use crate::project_status_agent_sources::{
    agent_file_path, read_optional_text_file, ProjectStatusAgentSourceError,
};
use crate::project_status_sources::{read_global_llm_config, ProjectStatusSourceError};

pub const MCP_FILE_NAME: &str = "mcp.json";

/// Per-agent configuration snapshot, built from the agent JSON + global config
/// files. Feeds the per-agent 24011 encoder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentConfigSnapshot {
    pub agent_pubkey: String,
    pub agent_slug: String,
    /// All configured model slugs from llms.json (alphabetical, deduped).
    pub available_models: Vec<String>,
    /// The agent's selected model, if any. `None` means no model is active
    /// (agent has not been configured yet or the configured model is not in
    /// llms.json).
    pub active_model: Option<String>,
    /// Convenience: `active_model` as a `BTreeSet` so the encoder can take
    /// a reference to a set covering the active entries for the `model`
    /// block. Contains 0 or 1 element.
    pub active_model_set: BTreeSet<String>,
    /// Skill IDs visible to this agent (built-in + agent-home + shared).
    pub available_skills: Vec<String>,
    /// Skills that are enabled on this agent, excluding blocked skills.
    pub active_skills: BTreeSet<String>,
    /// MCP server slugs from global mcp.json. Empty if MCP is globally disabled.
    pub available_mcps: Vec<String>,
    /// MCP server slugs the agent has explicit access to.
    pub active_mcps: BTreeSet<String>,
}

#[derive(Debug, Error)]
pub enum AgentConfigSnapshotError {
    #[error("agent file not found for {pubkey}")]
    AgentFileNotFound { pubkey: String },
    #[error("failed to read agent file {path}: {source}")]
    AgentFileRead { path: PathBuf, source: io::Error },
    #[error("failed to parse agent file {path}: {source}")]
    AgentFileParse {
        path: PathBuf,
        source: serde_json::Error,
    },
    #[error("failed to read mcp config: {0}")]
    Mcp(#[from] ProjectStatusAgentSourceError),
    #[error("failed to read global llm config: {0}")]
    Llm(#[from] ProjectStatusSourceError),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawStoredAgent {
    slug: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default, rename = "default")]
    default_config: RawAgentConfig,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawAgentConfig {
    model: Option<String>,
    #[serde(default)]
    skills: Option<Vec<String>>,
    #[serde(default)]
    blocked_skills: Option<Vec<String>>,
    #[serde(default)]
    mcp_access: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct RawMcpConfig {
    #[serde(default)]
    servers: serde_json::Map<String, serde_json::Value>,
    #[serde(default = "default_mcp_enabled")]
    enabled: bool,
}

fn default_mcp_enabled() -> bool {
    true
}

pub fn build_agent_config_snapshot(
    tenex_base_dir: &Path,
    agent_pubkey: &str,
) -> Result<AgentConfigSnapshot, AgentConfigSnapshotError> {
    let agent_path = agent_file_path(tenex_base_dir, agent_pubkey);
    let content = match fs::read_to_string(&agent_path) {
        Ok(content) => content,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Err(AgentConfigSnapshotError::AgentFileNotFound {
                pubkey: agent_pubkey.to_string(),
            });
        }
        Err(source) => {
            return Err(AgentConfigSnapshotError::AgentFileRead {
                path: agent_path,
                source,
            });
        }
    };
    let raw: RawStoredAgent = serde_json::from_str(&content).map_err(|source| {
        AgentConfigSnapshotError::AgentFileParse {
            path: agent_path.clone(),
            source,
        }
    })?;

    let agent_slug = raw
        .slug
        .and_then(nonempty)
        .unwrap_or_else(|| short_pubkey(agent_pubkey).to_string());

    let active_model = raw.default_config.model.and_then(nonempty);
    let active_model_set: BTreeSet<String> = active_model.iter().cloned().collect();
    let active_mcps: BTreeSet<String> = raw
        .default_config
        .mcp_access
        .unwrap_or_default()
        .into_iter()
        .filter_map(nonempty)
        .collect();
    let blocked: BTreeSet<String> = raw
        .default_config
        .blocked_skills
        .unwrap_or_default()
        .into_iter()
        .filter_map(nonempty)
        .collect();
    let active_skills: BTreeSet<String> = raw
        .default_config
        .skills
        .unwrap_or_default()
        .into_iter()
        .filter_map(nonempty)
        .filter(|skill| !blocked.contains(skill))
        .collect();

    let llm = read_global_llm_config(tenex_base_dir)?;
    let available_models = llm.model_keys;

    let available_mcps = list_available_mcp_servers(tenex_base_dir)?;

    let visible_skills = list_agent_visible_skills(tenex_base_dir, agent_pubkey);
    let mut available_skill_set: BTreeSet<String> = visible_skills;
    // Ensure every active skill appears in the available list as well, even
    // if the skill directory is not on disk yet — the agent's config says it
    // is enabled, so surface it.
    for skill in &active_skills {
        available_skill_set.insert(skill.clone());
    }
    let available_skills: Vec<String> = available_skill_set.into_iter().collect();

    Ok(AgentConfigSnapshot {
        agent_pubkey: agent_pubkey.to_string(),
        agent_slug,
        available_models,
        active_model,
        active_model_set,
        available_skills,
        active_skills,
        available_mcps,
        active_mcps,
    })
}

fn list_available_mcp_servers(
    tenex_base_dir: &Path,
) -> Result<Vec<String>, AgentConfigSnapshotError> {
    let path = tenex_base_dir.join(MCP_FILE_NAME);
    let Some(content) = read_optional_text_file(&path)? else {
        return Ok(Vec::new());
    };
    let raw: RawMcpConfig = serde_json::from_str(&content).map_err(|source| {
        AgentConfigSnapshotError::Mcp(ProjectStatusAgentSourceError::Parse {
            path: path.clone(),
            source,
        })
    })?;
    if !raw.enabled {
        return Ok(Vec::new());
    }
    let mut servers: Vec<String> = raw
        .servers
        .into_iter()
        .map(|(key, _)| key)
        .filter(|slug: &String| !slug.is_empty())
        .collect();
    servers.sort();
    servers.dedup();
    Ok(servers)
}

/// Project-independent skill discovery for a single agent. Enumerates:
/// - built-in skills (`<repo>/src/skills/built-in`)
/// - agent home skills (`<tenex_base>/home/<short_pubkey>/skills`)
/// - shared skills (`$HOME/.agents/skills`)
fn list_agent_visible_skills(tenex_base_dir: &Path, agent_pubkey: &str) -> BTreeSet<String> {
    let mut directories = Vec::new();
    directories.push(default_built_in_skills_dir());
    directories.push(
        tenex_base_dir
            .join("home")
            .join(short_pubkey(agent_pubkey))
            .join("skills"),
    );
    if let Some(shared) = default_shared_skills_dir() {
        directories.push(shared);
    }

    let mut visible = BTreeSet::new();
    for directory in directories {
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            if name.is_empty() || visible.contains(&name) {
                continue;
            }
            if !is_skill_directory(&entry) {
                continue;
            }
            if entry.path().join("SKILL.md").is_file() {
                visible.insert(name);
            }
        }
    }
    visible
}

fn is_skill_directory(entry: &fs::DirEntry) -> bool {
    match entry.file_type() {
        Ok(file_type) if file_type.is_dir() => true,
        Ok(file_type) if file_type.is_symlink() => fs::metadata(entry.path())
            .map(|metadata| metadata.is_dir())
            .unwrap_or(false),
        _ => false,
    }
}

fn default_built_in_skills_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("src")
        .join("skills")
        .join("built-in")
}

fn default_shared_skills_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join(".agents").join("skills"))
}

fn short_pubkey(pubkey: &str) -> &str {
    &pubkey[..pubkey.len().min(8)]
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
        fs::create_dir_all(&dir).expect("temp dir must create");
        dir
    }

    const AGENT_PUBKEY: &str =
        "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

    fn write_agent(base: &Path, pubkey: &str, body: serde_json::Value) {
        let dir = base.join("agents");
        fs::create_dir_all(&dir).expect("agents dir");
        fs::write(
            dir.join(format!("{pubkey}.json")),
            serde_json::to_vec_pretty(&body).expect("serialize agent"),
        )
        .expect("write agent");
    }

    #[test]
    fn active_model_and_skills_are_extracted_from_default_block() {
        let base = unique_temp_dir("per-agent-active");
        write_agent(
            &base,
            AGENT_PUBKEY,
            serde_json::json!({
                "slug": "worker",
                "status": "active",
                "default": {
                    "model": "opus",
                    "skills": ["read-access", "shell", "blocked-one"],
                    "blockedSkills": ["blocked-one"],
                    "mcpAccess": ["github"]
                }
            }),
        );
        fs::write(
            base.join("llms.json"),
            r#"{"configurations":{"opus":{},"sonnet":{}},"default":"sonnet"}"#,
        )
        .expect("write llms");
        fs::write(
            base.join("mcp.json"),
            r#"{"enabled":true,"servers":{"github":{},"jira":{}}}"#,
        )
        .expect("write mcp");

        let snapshot =
            build_agent_config_snapshot(&base, AGENT_PUBKEY).expect("snapshot must build");
        assert_eq!(snapshot.agent_pubkey, AGENT_PUBKEY);
        assert_eq!(snapshot.agent_slug, "worker");
        assert_eq!(snapshot.active_model.as_deref(), Some("opus"));
        assert_eq!(
            snapshot.available_models,
            vec!["opus".to_string(), "sonnet".to_string()]
        );
        assert_eq!(
            snapshot.active_skills,
            BTreeSet::from(["read-access".to_string(), "shell".to_string()])
        );
        // Active skills are included in available even though no dir was
        // created for them.
        assert!(snapshot.available_skills.contains(&"read-access".to_string()));
        assert!(snapshot.available_skills.contains(&"shell".to_string()));
        assert_eq!(
            snapshot.active_mcps,
            BTreeSet::from(["github".to_string()])
        );
        assert_eq!(
            snapshot.available_mcps,
            vec!["github".to_string(), "jira".to_string()]
        );
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn disabled_mcp_returns_empty_available_list() {
        let base = unique_temp_dir("per-agent-mcp-disabled");
        write_agent(
            &base,
            AGENT_PUBKEY,
            serde_json::json!({
                "slug": "worker",
                "default": {"model": "opus"}
            }),
        );
        fs::write(
            base.join("mcp.json"),
            r#"{"enabled":false,"servers":{"github":{}}}"#,
        )
        .expect("write mcp");

        let snapshot =
            build_agent_config_snapshot(&base, AGENT_PUBKEY).expect("snapshot must build");
        assert!(snapshot.available_mcps.is_empty());
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn missing_agent_file_errors() {
        let base = unique_temp_dir("per-agent-missing");
        let result = build_agent_config_snapshot(&base, AGENT_PUBKEY);
        assert!(matches!(
            result,
            Err(AgentConfigSnapshotError::AgentFileNotFound { .. })
        ));
        fs::remove_dir_all(&base).ok();
    }
}
