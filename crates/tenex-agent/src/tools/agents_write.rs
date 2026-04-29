use nostr::{nips::nip19::ToBech32, Keys};
use rig::{completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct AgentsWriteError(String);

#[derive(Debug, Deserialize, Serialize)]
pub struct AgentsWriteArgs {
    pub slug: String,
    pub name: String,
    pub role: String,
    pub instructions: String,
    #[serde(rename = "useCriteria")]
    pub use_criteria: String,
    #[serde(default, rename = "llmConfig")]
    pub llm_config: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct AgentsWriteAgent {
    pub slug: String,
    pub name: String,
    pub pubkey: String,
}

#[derive(Debug, Serialize)]
pub struct AgentsWriteOutput {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<AgentsWriteAgent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Persisted agent record matching the TS `~/.tenex/agents/<pubkey>.json` shape.
///
/// Unknown fields are preserved across read-modify-write so we don't clobber
/// data written by TS code paths (e.g. `category`, `inferredCategory`,
/// `description`, `mcpServers`, `telegram`, `eventId`, etc.). We only normalize
/// the fields this tool owns.
#[derive(Debug, Deserialize, Serialize)]
struct StoredAgent {
    nsec: String,
    slug: String,
    name: String,
    role: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    instructions: String,
    #[serde(
        default,
        rename = "useCriteria",
        skip_serializing_if = "String::is_empty"
    )]
    use_criteria: String,
    #[serde(default = "default_status")]
    status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    default: Option<AgentDefaultConfig>,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

fn default_status() -> String {
    "active".to_string()
}

#[derive(Debug, Default, Deserialize, Serialize)]
struct AgentDefaultConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

pub struct AgentsWriteTool {
    agents_dir: PathBuf,
}

impl AgentsWriteTool {
    pub fn new(agents_dir: PathBuf) -> Self {
        Self { agents_dir }
    }
}

/// Locate an existing stored agent by its `slug` field. Scans all `*.json` files
/// in `agents_dir` and returns the first match.
fn find_agent_by_slug(
    agents_dir: &Path,
    slug: &str,
) -> Result<Option<(PathBuf, StoredAgent)>, AgentsWriteError> {
    let read_dir = match fs::read_dir(agents_dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(AgentsWriteError(format!(
                "Failed to read agents dir {}: {e}",
                agents_dir.display()
            )))
        }
    };

    for entry in read_dir.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(parsed) = serde_json::from_str::<StoredAgent>(&text) else {
            continue;
        };
        if parsed.slug == slug {
            return Ok(Some((path, parsed)));
        }
    }
    Ok(None)
}

/// Write JSON atomically: write to `<path>.tmp` then rename onto `<path>`.
fn write_json_atomic(path: &Path, agent: &StoredAgent) -> Result<(), AgentsWriteError> {
    let parent = path
        .parent()
        .ok_or_else(|| AgentsWriteError(format!("Agent path has no parent: {}", path.display())))?;
    fs::create_dir_all(parent)
        .map_err(|e| AgentsWriteError(format!("Failed to create dir {}: {e}", parent.display())))?;

    let serialized = serde_json::to_vec_pretty(agent)
        .map_err(|e| AgentsWriteError(format!("Failed to serialize agent: {e}")))?;

    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp_path = PathBuf::from(tmp);

    {
        let mut f = fs::File::create(&tmp_path).map_err(|e| {
            AgentsWriteError(format!(
                "Failed to create temp file {}: {e}",
                tmp_path.display()
            ))
        })?;
        f.write_all(&serialized).map_err(|e| {
            AgentsWriteError(format!(
                "Failed to write temp file {}: {e}",
                tmp_path.display()
            ))
        })?;
        f.sync_all().map_err(|e| {
            AgentsWriteError(format!(
                "Failed to fsync temp file {}: {e}",
                tmp_path.display()
            ))
        })?;
    }

    fs::rename(&tmp_path, path).map_err(|e| {
        AgentsWriteError(format!(
            "Failed to rename {} -> {}: {e}",
            tmp_path.display(),
            path.display()
        ))
    })?;
    Ok(())
}

fn apply_llm_config(agent: &mut StoredAgent, llm_config: Option<String>) {
    let Some(model) = llm_config else { return };
    let trimmed = model.trim();
    let default = agent
        .default
        .get_or_insert_with(AgentDefaultConfig::default);
    if trimmed.is_empty() {
        default.model = None;
    } else {
        default.model = Some(trimmed.to_string());
    }
}

fn perform_write(
    agents_dir: &Path,
    args: AgentsWriteArgs,
) -> Result<AgentsWriteOutput, AgentsWriteError> {
    if args.slug.trim().is_empty() {
        return Ok(AgentsWriteOutput {
            success: false,
            agent: None,
            error: Some("Agent slug is required".to_string()),
        });
    }
    if args.name.trim().is_empty() {
        return Ok(AgentsWriteOutput {
            success: false,
            agent: None,
            error: Some("Agent name is required".to_string()),
        });
    }
    if args.role.trim().is_empty() {
        return Ok(AgentsWriteOutput {
            success: false,
            agent: None,
            error: Some("Agent role is required".to_string()),
        });
    }

    if let Some((path, mut existing)) = find_agent_by_slug(agents_dir, &args.slug)? {
        existing.name = args.name.clone();
        existing.role = args.role.clone();
        existing.instructions = args.instructions;
        existing.use_criteria = args.use_criteria;
        apply_llm_config(&mut existing, args.llm_config);

        write_json_atomic(&path, &existing)?;

        let pubkey_hex = path
            .file_stem()
            .and_then(|s| s.to_str())
            .map(|s| s.to_string())
            .ok_or_else(|| {
                AgentsWriteError(format!("Agent file has no valid stem: {}", path.display()))
            })?;

        return Ok(AgentsWriteOutput {
            success: true,
            agent: Some(AgentsWriteAgent {
                slug: args.slug,
                name: args.name,
                pubkey: pubkey_hex,
            }),
            error: None,
        });
    }

    let keys = Keys::generate();
    let pubkey_hex = keys.public_key().to_hex();
    let nsec_bech32 = keys
        .secret_key()
        .to_bech32()
        .map_err(|e| AgentsWriteError(format!("Failed to encode nsec: {e}")))?;

    let mut agent = StoredAgent {
        nsec: nsec_bech32,
        slug: args.slug.clone(),
        name: args.name.clone(),
        role: args.role,
        instructions: args.instructions,
        use_criteria: args.use_criteria,
        status: default_status(),
        default: None,
        extra: Map::new(),
    };
    apply_llm_config(&mut agent, args.llm_config);

    let target = agents_dir.join(format!("{pubkey_hex}.json"));
    write_json_atomic(&target, &agent)?;

    Ok(AgentsWriteOutput {
        success: true,
        agent: Some(AgentsWriteAgent {
            slug: args.slug,
            name: args.name,
            pubkey: pubkey_hex,
        }),
        error: None,
    })
}

impl Tool for AgentsWriteTool {
    const NAME: &'static str = "agents_write";
    type Error = AgentsWriteError;
    type Args = AgentsWriteArgs;
    type Output = AgentsWriteOutput;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Write or update agent configuration. Creates or updates backend-local \
                agent identities stored at ~/.tenex/agents/<pubkey>.json. When an agent with the \
                given slug already exists, its name/role/instructions/useCriteria/llmConfig are \
                updated and its nsec/pubkey are preserved. When no such slug exists, a new nsec \
                is generated, the pubkey is derived, and a new file is written. Newly created \
                agents are installed in the backend, but they are not assigned to the current \
                project until the user publishes a 31933 event that p-tags the agent pubkey."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "slug": {
                        "type": "string",
                        "description": "The slug identifier for the agent"
                    },
                    "name": {
                        "type": "string",
                        "description": "Display name of the agent"
                    },
                    "role": {
                        "type": "string",
                        "description": "Primary role/function of the agent"
                    },
                    "instructions": {
                        "type": "string",
                        "description": "System instructions that guide agent behavior"
                    },
                    "useCriteria": {
                        "type": "string",
                        "description": "Criteria for when this agent should be selected"
                    },
                    "llmConfig": {
                        "type": ["string", "null"],
                        "description": "LLM configuration identifier (e.g. 'anthropic:claude-sonnet-4'). Pass null to leave unset."
                    }
                },
                "required": ["slug", "name", "role", "instructions", "useCriteria"]
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        perform_write(&self.agents_dir, args)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn args(slug: &str, name: &str, llm: Option<&str>) -> AgentsWriteArgs {
        AgentsWriteArgs {
            slug: slug.to_string(),
            name: name.to_string(),
            role: "worker".to_string(),
            instructions: "do the thing".to_string(),
            use_criteria: "when asked".to_string(),
            llm_config: llm.map(|s| s.to_string()),
        }
    }

    #[test]
    fn create_writes_pubkey_named_file_with_expected_fields() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_path_buf();

        let out = perform_write(
            &dir,
            args("alpha", "Alpha", Some("anthropic:claude-sonnet-4")),
        )
        .unwrap();
        assert!(out.success);
        let agent = out.agent.expect("agent returned");
        assert_eq!(agent.slug, "alpha");
        assert_eq!(agent.name, "Alpha");
        assert_eq!(agent.pubkey.len(), 64);

        let path = dir.join(format!("{}.json", agent.pubkey));
        let raw = std::fs::read_to_string(&path).unwrap();
        let v: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["slug"], "alpha");
        assert_eq!(v["name"], "Alpha");
        assert_eq!(v["role"], "worker");
        assert_eq!(v["instructions"], "do the thing");
        assert_eq!(v["useCriteria"], "when asked");
        assert_eq!(v["status"], "active");
        assert_eq!(v["default"]["model"], "anthropic:claude-sonnet-4");
        assert!(v["nsec"].as_str().unwrap().starts_with("nsec1"));
    }

    #[test]
    fn update_preserves_nsec_and_pubkey_filename() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_path_buf();

        let first = perform_write(&dir, args("beta", "Beta", None)).unwrap();
        let pubkey = first.agent.unwrap().pubkey;
        let path = dir.join(format!("{pubkey}.json"));
        let original_nsec = {
            let raw = std::fs::read_to_string(&path).unwrap();
            let v: Value = serde_json::from_str(&raw).unwrap();
            v["nsec"].as_str().unwrap().to_string()
        };

        let mut updated = args("beta", "Beta v2", Some("openai:gpt-4o"));
        updated.role = "reviewer".to_string();
        updated.instructions = "review carefully".to_string();
        updated.use_criteria = "for code review".to_string();
        let out = perform_write(&dir, updated).unwrap();
        assert!(out.success);
        let agent = out.agent.unwrap();
        assert_eq!(
            agent.pubkey, pubkey,
            "pubkey must be preserved across update"
        );

        let raw = std::fs::read_to_string(&path).unwrap();
        let v: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["nsec"], original_nsec);
        assert_eq!(v["name"], "Beta v2");
        assert_eq!(v["role"], "reviewer");
        assert_eq!(v["instructions"], "review carefully");
        assert_eq!(v["useCriteria"], "for code review");
        assert_eq!(v["default"]["model"], "openai:gpt-4o");

        let entries: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("json"))
            .collect();
        assert_eq!(entries.len(), 1, "update must not create a second file");
    }

    #[test]
    fn update_preserves_unknown_fields() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_path_buf();
        let first = perform_write(&dir, args("gamma", "Gamma", None)).unwrap();
        let pubkey = first.agent.unwrap().pubkey;
        let path = dir.join(format!("{pubkey}.json"));

        let raw = std::fs::read_to_string(&path).unwrap();
        let mut v: Value = serde_json::from_str(&raw).unwrap();
        v.as_object_mut()
            .unwrap()
            .insert("category".to_string(), Value::String("worker".to_string()));
        v.as_object_mut()
            .unwrap()
            .insert("eventId".to_string(), Value::String("abc123".to_string()));
        std::fs::write(&path, serde_json::to_vec_pretty(&v).unwrap()).unwrap();

        perform_write(&dir, args("gamma", "Gamma 2", None)).unwrap();

        let raw = std::fs::read_to_string(&path).unwrap();
        let v: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["category"], "worker");
        assert_eq!(v["eventId"], "abc123");
        assert_eq!(v["name"], "Gamma 2");
    }

    #[test]
    fn missing_dir_creates_on_first_write() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("nested").join("agents");
        assert!(!dir.exists());
        let out = perform_write(&dir, args("delta", "Delta", None)).unwrap();
        assert!(out.success);
        assert!(dir.exists());
    }

    #[test]
    fn empty_slug_returns_error_payload() {
        let tmp = tempfile::tempdir().unwrap();
        let out = perform_write(tmp.path(), args("", "X", None)).unwrap();
        assert!(!out.success);
        assert!(out.agent.is_none());
        assert!(out.error.unwrap().contains("slug"));
    }
}
