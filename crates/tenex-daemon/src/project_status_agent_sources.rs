use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::str::FromStr;

use secp256k1::XOnlyPublicKey;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::backend_events::project_status::{
    ProjectStatusAgent, ProjectStatusMcpServer, ProjectStatusModel, ProjectStatusSkill,
    ProjectStatusTool,
};

pub const AGENT_INDEX_FILE_NAME: &str = "index.json";
pub const MCP_FILE_NAME: &str = "mcp.json";

const CORE_AGENT_TOOLS: &[&str] = &[
    "lesson_learn",
    "todo_write",
    "kill",
    "skill_list",
    "skills_set",
    "self_delegate",
];
const DELEGATE_TOOLS: &[&str] = &[
    "ask",
    "delegate",
    "delegate_crossproject",
    "delegate_followup",
];
const CONTEXT_INJECTED_TOOLS: &[&str] = &[
    "change_model",
    "send_message",
    "no_response",
    "home_fs_read",
    "home_fs_write",
    "home_fs_edit",
    "home_fs_glob",
    "home_fs_grep",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectStatusAgentSourceReport {
    pub agents: Vec<ProjectStatusAgent>,
    pub models: Vec<ProjectStatusModel>,
    pub tools: Vec<ProjectStatusTool>,
    pub skills: Vec<ProjectStatusSkill>,
    pub mcp_servers: Vec<ProjectStatusMcpServer>,
    pub skipped_files: Vec<ProjectStatusAgentSourceSkippedFile>,
}

impl ProjectStatusAgentSourceReport {
    pub fn empty() -> Self {
        Self {
            agents: Vec::new(),
            models: Vec::new(),
            tools: Vec::new(),
            skills: Vec::new(),
            mcp_servers: Vec::new(),
            skipped_files: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProjectStatusAgentSourceSkippedFile {
    pub path: PathBuf,
    pub reason: String,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct ProjectStatusAgentSourceOptions<'a> {
    pub project_base_path: Option<&'a Path>,
    pub built_in_skills_dir: Option<&'a Path>,
    pub shared_skills_dir: Option<&'a Path>,
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
struct RawStoredAgent {
    slug: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default, rename = "default")]
    default_config: RawAgentConfig,
    #[serde(default)]
    project_overrides: BTreeMap<String, RawAgentConfig>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawAgentConfig {
    model: Option<String>,
    #[serde(default)]
    tools: Option<Vec<String>>,
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
    servers: BTreeMap<String, Value>,
    #[serde(default = "default_mcp_enabled")]
    enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ResolvedProjectAgent {
    pubkey: String,
    slug: String,
    model: Option<String>,
    tools: Vec<String>,
    skills: Vec<String>,
    mcp_access: Vec<String>,
}

pub fn read_project_status_agent_sources(
    tenex_base_dir: impl AsRef<Path>,
    project_d_tag: &str,
) -> Result<ProjectStatusAgentSourceReport, ProjectStatusAgentSourceError> {
    read_project_status_agent_sources_with_options(
        tenex_base_dir,
        project_d_tag,
        ProjectStatusAgentSourceOptions::default(),
    )
}

pub fn read_project_status_agent_sources_with_options(
    tenex_base_dir: impl AsRef<Path>,
    project_d_tag: &str,
    options: ProjectStatusAgentSourceOptions<'_>,
) -> Result<ProjectStatusAgentSourceReport, ProjectStatusAgentSourceError> {
    let tenex_base_dir = tenex_base_dir.as_ref();
    let agent_index_path = agent_index_path(tenex_base_dir);
    let project_pubkeys =
        if let Some(agent_index_content) = read_optional_text_file(&agent_index_path)? {
            let agent_index: RawAgentIndex =
                serde_json::from_str(&agent_index_content).map_err(|source| {
                    ProjectStatusAgentSourceError::Parse {
                        path: agent_index_path.clone(),
                        source,
                    }
                })?;
            agent_index
                .by_project
                .get(project_d_tag)
                .cloned()
                .unwrap_or_default()
        } else {
            Vec::new()
        };

    if project_pubkeys.is_empty() && options.project_base_path.is_none() {
        return Ok(ProjectStatusAgentSourceReport::empty());
    }

    let configured_mcp_servers = read_configured_mcp_server_slugs(tenex_base_dir, project_d_tag)?;
    let mut skipped_files = Vec::new();
    let mut resolved_agents = Vec::new();
    let mut seen_pubkeys = BTreeSet::new();

    for pubkey in &project_pubkeys {
        if !seen_pubkeys.insert(pubkey.clone()) {
            continue;
        }
        if XOnlyPublicKey::from_str(pubkey).is_err() {
            skipped_files.push(ProjectStatusAgentSourceSkippedFile {
                path: agents_dir(tenex_base_dir).join(format!("{pubkey}.json")),
                reason: format!("project agent pubkey is invalid: {pubkey:?}"),
            });
            continue;
        }

        let path = agent_file_path(tenex_base_dir, pubkey);
        match read_resolved_project_agent(&path, pubkey, project_d_tag) {
            Ok(Some(agent)) => resolved_agents.push(agent),
            Ok(None) => {}
            Err(reason) => skipped_files.push(ProjectStatusAgentSourceSkippedFile { path, reason }),
        }
    }

    resolved_agents.sort_by(|left, right| {
        left.slug
            .cmp(&right.slug)
            .then_with(|| left.pubkey.cmp(&right.pubkey))
    });

    let mut model_agents: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut tool_agents: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let skill_agents = build_skill_agent_map(
        tenex_base_dir,
        options,
        &resolved_agents,
        &mut skipped_files,
    );
    let mut mcp_agents: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();

    for agent in &resolved_agents {
        if let Some(model) = agent.model.as_deref().and_then(nonempty_ref) {
            model_agents
                .entry(model.to_string())
                .or_default()
                .insert(agent.slug.clone());
        }
        for tool in &agent.tools {
            if is_configurable_tool(tool) {
                tool_agents
                    .entry(tool.clone())
                    .or_default()
                    .insert(agent.slug.clone());
            }
        }
        for server in &agent.mcp_access {
            if configured_mcp_servers.contains(server) {
                mcp_agents
                    .entry(server.clone())
                    .or_default()
                    .insert(agent.slug.clone());
            }
        }
    }

    Ok(ProjectStatusAgentSourceReport {
        agents: resolved_agents
            .iter()
            .map(|agent| ProjectStatusAgent {
                pubkey: agent.pubkey.clone(),
                slug: agent.slug.clone(),
            })
            .collect(),
        models: model_agents
            .into_iter()
            .map(|(slug, agents)| ProjectStatusModel {
                slug,
                agents: agents.into_iter().collect(),
            })
            .collect(),
        tools: tool_agents
            .into_iter()
            .map(|(name, agents)| ProjectStatusTool {
                name,
                agents: agents.into_iter().collect(),
            })
            .collect(),
        skills: skill_agents
            .into_iter()
            .map(|(id, agents)| ProjectStatusSkill {
                id,
                agents: agents.into_iter().collect(),
            })
            .collect(),
        mcp_servers: mcp_agents
            .into_iter()
            .map(|(slug, agents)| ProjectStatusMcpServer {
                slug,
                agents: agents.into_iter().collect(),
            })
            .collect(),
        skipped_files,
    })
}

fn build_skill_agent_map(
    tenex_base_dir: &Path,
    options: ProjectStatusAgentSourceOptions<'_>,
    resolved_agents: &[ResolvedProjectAgent],
    skipped_files: &mut Vec<ProjectStatusAgentSourceSkippedFile>,
) -> BTreeMap<String, BTreeSet<String>> {
    let mut skill_agents: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();

    let Some(project_base_path) = options.project_base_path else {
        for agent in resolved_agents {
            for skill in &agent.skills {
                skill_agents
                    .entry(skill.clone())
                    .or_default()
                    .insert(agent.slug.clone());
            }
        }
        return skill_agents;
    };

    for skill in list_visible_skill_ids(
        project_visible_skill_directories(project_base_path, options),
        skipped_files,
    ) {
        skill_agents.entry(skill).or_default();
    }

    for agent in resolved_agents {
        let visible_agent_skills = list_visible_skill_ids(
            agent_visible_skill_directories(tenex_base_dir, project_base_path, agent, options),
            skipped_files,
        );
        for skill in &agent.skills {
            if visible_agent_skills.contains(skill) {
                skill_agents
                    .entry(skill.clone())
                    .or_default()
                    .insert(agent.slug.clone());
            }
        }
    }

    skill_agents
}

fn project_visible_skill_directories(
    project_base_path: &Path,
    options: ProjectStatusAgentSourceOptions<'_>,
) -> Vec<PathBuf> {
    let mut directories = Vec::new();
    directories.push(built_in_skills_dir(options));
    directories.push(project_base_path.join(".agents").join("skills"));
    if let Some(shared) = shared_skills_dir(options) {
        directories.push(shared);
    }
    directories
}

fn agent_visible_skill_directories(
    tenex_base_dir: &Path,
    project_base_path: &Path,
    agent: &ResolvedProjectAgent,
    options: ProjectStatusAgentSourceOptions<'_>,
) -> Vec<PathBuf> {
    let short_pubkey = short_pubkey(&agent.pubkey);
    let mut directories = Vec::new();
    directories.push(built_in_skills_dir(options));
    directories.push(
        tenex_base_dir
            .join("home")
            .join(short_pubkey)
            .join("skills"),
    );
    directories.push(
        project_base_path
            .join(".agents")
            .join(short_pubkey)
            .join("skills"),
    );
    directories.push(project_base_path.join(".agents").join("skills"));
    if let Some(shared) = shared_skills_dir(options) {
        directories.push(shared);
    }
    directories
}

fn list_visible_skill_ids(
    directories: Vec<PathBuf>,
    skipped_files: &mut Vec<ProjectStatusAgentSourceSkippedFile>,
) -> BTreeSet<String> {
    let mut visible = BTreeSet::new();

    for directory in directories {
        let mut entries = match fs::read_dir(&directory) {
            Ok(entries) => entries.filter_map(Result::ok).collect::<Vec<_>>(),
            Err(source) if source.kind() == io::ErrorKind::NotFound => continue,
            Err(source) => {
                skipped_files.push(ProjectStatusAgentSourceSkippedFile {
                    path: directory,
                    reason: format!("failed to read skill directory: {source}"),
                });
                continue;
            }
        };

        entries.sort_by(|left, right| left.file_name().cmp(&right.file_name()));

        for entry in entries {
            let path = entry.path();
            let Some(skill_id) = entry
                .file_name()
                .to_str()
                .and_then(nonempty_ref)
                .map(str::to_string)
            else {
                skipped_files.push(ProjectStatusAgentSourceSkippedFile {
                    path,
                    reason: "skill directory name is not valid UTF-8 or is empty".to_string(),
                });
                continue;
            };

            if visible.contains(&skill_id) {
                continue;
            }
            if !is_skill_directory(&entry) {
                continue;
            }
            if path.join("SKILL.md").is_file() {
                visible.insert(skill_id);
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

fn built_in_skills_dir(options: ProjectStatusAgentSourceOptions<'_>) -> PathBuf {
    options
        .built_in_skills_dir
        .map(Path::to_path_buf)
        .unwrap_or_else(default_built_in_skills_dir)
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

fn shared_skills_dir(options: ProjectStatusAgentSourceOptions<'_>) -> Option<PathBuf> {
    options
        .shared_skills_dir
        .map(Path::to_path_buf)
        .or_else(default_shared_skills_dir)
}

fn default_shared_skills_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join(".agents").join("skills"))
}

fn short_pubkey(pubkey: &str) -> &str {
    &pubkey[..pubkey.len().min(8)]
}

fn agent_index_path(tenex_base_dir: &Path) -> PathBuf {
    agents_dir(tenex_base_dir).join(AGENT_INDEX_FILE_NAME)
}

fn agent_file_path(tenex_base_dir: &Path, pubkey: &str) -> PathBuf {
    agents_dir(tenex_base_dir).join(format!("{pubkey}.json"))
}

fn agents_dir(tenex_base_dir: &Path) -> PathBuf {
    tenex_base_dir.join("agents")
}

fn project_metadata_dir(tenex_base_dir: &Path, project_d_tag: &str) -> PathBuf {
    tenex_base_dir.join("projects").join(project_d_tag)
}

fn mcp_path(base_dir: &Path) -> PathBuf {
    base_dir.join(MCP_FILE_NAME)
}

fn read_resolved_project_agent(
    path: &Path,
    pubkey: &str,
    project_d_tag: &str,
) -> Result<Option<ResolvedProjectAgent>, String> {
    let content = fs::read_to_string(path)
        .map_err(|source| format!("failed to read agent file: {source}"))?;
    let raw: RawStoredAgent = serde_json::from_str(&content)
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
    let project_config = raw.project_overrides.get(project_d_tag);
    let model = resolve_model(&raw.default_config, project_config);
    let tools = resolve_tools(&raw.default_config, project_config);
    let blocked_skills = resolve_blocked_skills(&raw.default_config, project_config);
    let skills = resolve_skills(&raw.default_config, project_config, &blocked_skills);
    let mcp_access = resolve_mcp_access(&raw.default_config, project_config);

    Ok(Some(ResolvedProjectAgent {
        pubkey: pubkey.to_string(),
        slug,
        model,
        tools,
        skills,
        mcp_access,
    }))
}

fn resolve_model(
    default_config: &RawAgentConfig,
    project_config: Option<&RawAgentConfig>,
) -> Option<String> {
    optional_nonempty(project_config.and_then(|config| config.model.clone()))
        .or_else(|| optional_nonempty(default_config.model.clone()))
}

fn resolve_tools(
    default_config: &RawAgentConfig,
    project_config: Option<&RawAgentConfig>,
) -> Vec<String> {
    let default_tools = retain_nonempty(default_config.tools.clone().unwrap_or_default());
    let Some(project_tools) = project_config.and_then(|config| config.tools.clone()) else {
        return sorted_deduped(default_tools);
    };
    if project_tools.is_empty() {
        return sorted_deduped(default_tools);
    }

    let mut result = default_tools
        .into_iter()
        .filter(|tool| {
            !project_tools
                .iter()
                .any(|entry| entry.strip_prefix('-') == Some(tool.as_str()))
        })
        .collect::<Vec<_>>();

    for tool in project_tools {
        if let Some(addition) = tool.strip_prefix('+').and_then(nonempty_ref)
            && !result.iter().any(|existing| existing == addition)
        {
            result.push(addition.to_string());
        }
    }

    sorted_deduped(result)
}

fn resolve_skills(
    default_config: &RawAgentConfig,
    project_config: Option<&RawAgentConfig>,
    blocked_skills: &[String],
) -> Vec<String> {
    let skills = project_config
        .and_then(|config| config.skills.clone())
        .unwrap_or_else(|| default_config.skills.clone().unwrap_or_default());
    let blocked = blocked_skills.iter().collect::<BTreeSet<_>>();
    sorted_deduped(
        retain_nonempty(skills)
            .into_iter()
            .filter(|skill| !blocked.contains(skill))
            .collect(),
    )
}

fn resolve_blocked_skills(
    default_config: &RawAgentConfig,
    project_config: Option<&RawAgentConfig>,
) -> Vec<String> {
    sorted_deduped(
        [
            default_config.blocked_skills.clone().unwrap_or_default(),
            project_config
                .and_then(|config| config.blocked_skills.clone())
                .unwrap_or_default(),
        ]
        .concat(),
    )
}

fn resolve_mcp_access(
    default_config: &RawAgentConfig,
    project_config: Option<&RawAgentConfig>,
) -> Vec<String> {
    sorted_deduped(retain_nonempty(
        project_config
            .and_then(|config| config.mcp_access.clone())
            .unwrap_or_else(|| default_config.mcp_access.clone().unwrap_or_default()),
    ))
}

fn read_configured_mcp_server_slugs(
    tenex_base_dir: &Path,
    project_d_tag: &str,
) -> Result<BTreeSet<String>, ProjectStatusAgentSourceError> {
    let global_mcp = read_optional_mcp_config(&mcp_path(tenex_base_dir))?;
    let project_mcp = read_optional_mcp_config(&mcp_path(&project_metadata_dir(
        tenex_base_dir,
        project_d_tag,
    )))?;

    let enabled = project_mcp
        .as_ref()
        .map(|config| config.enabled)
        .or_else(|| global_mcp.as_ref().map(|config| config.enabled))
        .unwrap_or(true);

    if !enabled {
        return Ok(BTreeSet::new());
    }

    let mut servers = BTreeSet::new();
    if let Some(global) = global_mcp {
        servers.extend(
            global
                .servers
                .into_keys()
                .filter(|server| !server.is_empty()),
        );
    }
    if let Some(project) = project_mcp {
        servers.extend(
            project
                .servers
                .into_keys()
                .filter(|server| !server.is_empty()),
        );
    }
    Ok(servers)
}

fn read_optional_mcp_config(
    path: &Path,
) -> Result<Option<RawMcpConfig>, ProjectStatusAgentSourceError> {
    let Some(content) = read_optional_text_file(path)? else {
        return Ok(None);
    };
    serde_json::from_str(&content).map(Some).map_err(|source| {
        ProjectStatusAgentSourceError::Parse {
            path: path.to_path_buf(),
            source,
        }
    })
}

fn read_optional_text_file(path: &Path) -> Result<Option<String>, ProjectStatusAgentSourceError> {
    match fs::read_to_string(path) {
        Ok(content) => Ok(Some(content)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(source) => Err(ProjectStatusAgentSourceError::Read {
            path: path.to_path_buf(),
            source,
        }),
    }
}

fn is_configurable_tool(tool: &str) -> bool {
    !tool.is_empty()
        && !tool.starts_with("mcp__")
        && !CORE_AGENT_TOOLS.contains(&tool)
        && !DELEGATE_TOOLS.contains(&tool)
        && !CONTEXT_INJECTED_TOOLS.contains(&tool)
}

fn optional_nonempty(value: Option<String>) -> Option<String> {
    value.and_then(nonempty)
}

fn nonempty(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn nonempty_ref(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

fn retain_nonempty(values: Vec<String>) -> Vec<String> {
    values.into_iter().filter_map(nonempty).collect()
}

fn sorted_deduped(mut values: Vec<String>) -> Vec<String> {
    values.sort();
    values.dedup();
    values
}

fn default_mcp_enabled() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use secp256k1::{Keypair, Secp256k1, SecretKey};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn reads_project_agent_status_details_from_agent_storage() {
        let base_dir = unique_temp_dir("project-status-agent-sources");
        let worker = pubkey_hex(0x02);
        let reviewer = pubkey_hex(0x03);
        let unrelated = pubkey_hex(0x04);
        fs::create_dir_all(base_dir.join("agents")).expect("agents dir must create");
        fs::create_dir_all(base_dir.join("projects/demo-project"))
            .expect("project dir must create");
        fs::write(
            agent_index_path(&base_dir),
            format!(
                r#"{{
                    "byProject": {{
                        "demo-project": ["{worker}", "{reviewer}", "{worker}"],
                        "other-project": ["{unrelated}"]
                    }}
                }}"#
            ),
        )
        .expect("agent index must write");
        fs::write(
            agent_file_path(&base_dir, &worker),
            r#"{
                "slug": "worker",
                "status": "active",
                "default": {
                    "model": "alpha",
                    "tools": ["shell", "ask", "todo_write", "mcp__github__search"],
                    "skills": ["skill-a", "skill-blocked"],
                    "blockedSkills": ["skill-blocked"],
                    "mcpAccess": ["github"]
                },
                "projectOverrides": {
                    "demo-project": {
                        "model": "beta",
                        "tools": ["-shell", "+fs_read"],
                        "skills": ["skill-b", "skill-c"],
                        "blockedSkills": ["skill-c"],
                        "mcpAccess": ["linear", "missing-server"]
                    }
                }
            }"#,
        )
        .expect("worker file must write");
        fs::write(
            agent_file_path(&base_dir, &reviewer),
            r#"{
                "slug": "reviewer",
                "default": {
                    "model": "alpha",
                    "tools": ["shell"],
                    "skills": ["skill-a"],
                    "mcpAccess": ["github"]
                }
            }"#,
        )
        .expect("reviewer file must write");
        fs::write(
            mcp_path(&base_dir),
            r#"{"enabled": true, "servers": {"github": {"command": "npx", "args": []}}}"#,
        )
        .expect("global mcp must write");
        fs::write(
            mcp_path(&project_metadata_dir(&base_dir, "demo-project")),
            r#"{"enabled": true, "servers": {"linear": {"command": "npx", "args": []}}}"#,
        )
        .expect("project mcp must write");

        let report =
            read_project_status_agent_sources(&base_dir, "demo-project").expect("report must read");

        assert_eq!(
            report.agents,
            vec![
                ProjectStatusAgent {
                    pubkey: reviewer,
                    slug: "reviewer".to_string(),
                },
                ProjectStatusAgent {
                    pubkey: worker,
                    slug: "worker".to_string(),
                },
            ]
        );
        assert_eq!(
            report.models,
            vec![
                ProjectStatusModel {
                    slug: "alpha".to_string(),
                    agents: vec!["reviewer".to_string()],
                },
                ProjectStatusModel {
                    slug: "beta".to_string(),
                    agents: vec!["worker".to_string()],
                },
            ]
        );
        assert_eq!(
            report.tools,
            vec![
                ProjectStatusTool {
                    name: "fs_read".to_string(),
                    agents: vec!["worker".to_string()],
                },
                ProjectStatusTool {
                    name: "shell".to_string(),
                    agents: vec!["reviewer".to_string()],
                },
            ]
        );
        assert_eq!(
            report.skills,
            vec![
                ProjectStatusSkill {
                    id: "skill-a".to_string(),
                    agents: vec!["reviewer".to_string()],
                },
                ProjectStatusSkill {
                    id: "skill-b".to_string(),
                    agents: vec!["worker".to_string()],
                },
            ]
        );
        assert_eq!(
            report.mcp_servers,
            vec![
                ProjectStatusMcpServer {
                    slug: "github".to_string(),
                    agents: vec!["reviewer".to_string()],
                },
                ProjectStatusMcpServer {
                    slug: "linear".to_string(),
                    agents: vec!["worker".to_string()],
                },
            ]
        );
        assert!(report.skipped_files.is_empty());

        fs::remove_dir_all(base_dir).expect("cleanup must succeed");
    }

    #[test]
    fn reads_skill_catalog_from_typescript_visible_skill_roots() {
        let base_dir = unique_temp_dir("project-status-agent-sources-skill-catalog");
        let project_base_path = unique_temp_dir("project-status-agent-sources-project-path");
        let built_in_skills_dir = unique_temp_dir("project-status-agent-sources-built-ins");
        let shared_skills_dir = unique_temp_dir("project-status-agent-sources-shared");
        let worker = pubkey_hex(0x05);
        let reviewer = pubkey_hex(0x06);

        fs::create_dir_all(base_dir.join("agents")).expect("agents dir must create");
        fs::write(
            agent_index_path(&base_dir),
            format!(r#"{{ "byProject": {{ "demo-project": ["{worker}", "{reviewer}"] }} }}"#),
        )
        .expect("agent index must write");
        fs::write(
            agent_file_path(&base_dir, &worker),
            r#"{
                "slug": "worker",
                "default": {
                    "skills": [
                        "agent-home-skill",
                        "built-in-skill",
                        "missing-skill",
                        "project-skill",
                        "shared-skill"
                    ]
                }
            }"#,
        )
        .expect("worker file must write");
        fs::write(
            agent_file_path(&base_dir, &reviewer),
            r#"{
                "slug": "reviewer",
                "default": {
                    "skills": ["agent-project-skill", "project-skill"]
                }
            }"#,
        )
        .expect("reviewer file must write");

        write_skill(&built_in_skills_dir, "built-in-skill");
        write_skill(
            &base_dir
                .join("home")
                .join(short_pubkey(&worker))
                .join("skills"),
            "agent-home-skill",
        );
        write_skill(
            &project_base_path
                .join(".agents")
                .join(short_pubkey(&reviewer))
                .join("skills"),
            "agent-project-skill",
        );
        write_skill(
            &project_base_path.join(".agents").join("skills"),
            "project-skill",
        );
        write_skill(
            &project_base_path.join(".agents").join("skills"),
            "project-unassigned",
        );
        write_skill(&shared_skills_dir, "shared-skill");

        let report = read_project_status_agent_sources_with_options(
            &base_dir,
            "demo-project",
            ProjectStatusAgentSourceOptions {
                project_base_path: Some(&project_base_path),
                built_in_skills_dir: Some(&built_in_skills_dir),
                shared_skills_dir: Some(&shared_skills_dir),
            },
        )
        .expect("report must read");

        assert_eq!(
            report.skills,
            vec![
                ProjectStatusSkill {
                    id: "agent-home-skill".to_string(),
                    agents: vec!["worker".to_string()],
                },
                ProjectStatusSkill {
                    id: "agent-project-skill".to_string(),
                    agents: vec!["reviewer".to_string()],
                },
                ProjectStatusSkill {
                    id: "built-in-skill".to_string(),
                    agents: vec!["worker".to_string()],
                },
                ProjectStatusSkill {
                    id: "project-skill".to_string(),
                    agents: vec!["reviewer".to_string(), "worker".to_string()],
                },
                ProjectStatusSkill {
                    id: "project-unassigned".to_string(),
                    agents: Vec::new(),
                },
                ProjectStatusSkill {
                    id: "shared-skill".to_string(),
                    agents: vec!["worker".to_string()],
                },
            ]
        );
        assert!(
            report
                .skills
                .iter()
                .all(|skill| skill.id != "missing-skill"),
            "configured skills that are not visible to the agent are not advertised"
        );

        let _ = fs::remove_dir_all(base_dir);
        let _ = fs::remove_dir_all(project_base_path);
        let _ = fs::remove_dir_all(built_in_skills_dir);
        let _ = fs::remove_dir_all(shared_skills_dir);
    }

    #[test]
    fn missing_agent_index_returns_empty_report() {
        let base_dir = unique_temp_dir("project-status-agent-sources-missing");

        let report =
            read_project_status_agent_sources(&base_dir, "demo-project").expect("report must read");

        assert_eq!(report, ProjectStatusAgentSourceReport::empty());
        let _ = fs::remove_dir_all(base_dir);
    }

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be after UNIX_EPOCH")
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("{prefix}-{unique}-{counter}"))
    }

    fn write_skill(root: &Path, skill_id: &str) {
        let skill_dir = root.join(skill_id);
        fs::create_dir_all(&skill_dir).expect("skill dir must create");
        fs::write(skill_dir.join("SKILL.md"), "# Test Skill\n").expect("skill file must write");
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
