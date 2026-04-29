use indexmap::IndexMap;
use rig::{completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tenex_agent_storage::{AgentDoc, AgentStorage};

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

pub struct AgentsWriteTool {
    base_dir: PathBuf,
}

impl AgentsWriteTool {
    pub fn new(base_dir: PathBuf) -> Self {
        Self { base_dir }
    }
}

fn storage_error(action: &str, error: anyhow::Error) -> AgentsWriteError {
    AgentsWriteError(format!("Failed to {action}: {error}"))
}

fn apply_llm_config(agent: &mut AgentDoc, llm_config: Option<String>) {
    let Some(model) = llm_config else { return };
    let trimmed = model.trim();
    let default = agent
        .raw_mut()
        .entry("default".to_string())
        .or_insert_with(|| Value::Object(serde_json::Map::new()));

    if !default.is_object() {
        *default = Value::Object(serde_json::Map::new());
    }
    let Some(default) = default.as_object_mut() else {
        return;
    };

    if trimmed.is_empty() {
        default.shift_remove("model");
    } else {
        default.insert("model".to_string(), Value::String(trimmed.to_string()));
    }
}

fn build_agent(args: &AgentsWriteArgs) -> Result<AgentDoc, AgentsWriteError> {
    let nsec = tenex_agent_storage::generate_nsec_bech32()
        .map_err(|e| AgentsWriteError(format!("Failed to generate nsec: {e}")))?;
    let mut raw = IndexMap::<String, Value>::new();
    raw.insert("nsec".to_string(), Value::String(nsec));
    raw.insert("slug".to_string(), Value::String(args.slug.clone()));
    raw.insert("name".to_string(), Value::String(args.name.clone()));
    raw.insert("role".to_string(), Value::String(args.role.clone()));
    raw.insert(
        "instructions".to_string(),
        Value::String(args.instructions.clone()),
    );
    raw.insert(
        "useCriteria".to_string(),
        Value::String(args.use_criteria.clone()),
    );
    raw.insert("status".to_string(), Value::String("active".to_string()));
    Ok(AgentDoc::from_raw(raw))
}

fn perform_write(
    base_dir: &Path,
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

    let mut storage =
        AgentStorage::open(base_dir).map_err(|e| storage_error("open agent storage", e))?;
    let existing = storage
        .get_all_stored_agents()
        .map_err(|e| storage_error("list agents", e))?
        .into_iter()
        .find(|(_, agent)| agent.slug() == Some(args.slug.as_str()));

    let mut agent_doc = if let Some((_, mut existing)) = existing {
        existing
            .raw_mut()
            .insert("name".to_string(), Value::String(args.name.clone()));
        existing
            .raw_mut()
            .insert("role".to_string(), Value::String(args.role.clone()));
        existing.raw_mut().insert(
            "instructions".to_string(),
            Value::String(args.instructions.clone()),
        );
        existing.raw_mut().insert(
            "useCriteria".to_string(),
            Value::String(args.use_criteria.clone()),
        );
        existing
    } else {
        build_agent(&args)?
    };

    apply_llm_config(&mut agent_doc, args.llm_config);
    let pubkey = storage
        .save_agent(&agent_doc)
        .map_err(|e| storage_error("save agent", e))?;

    Ok(AgentsWriteOutput {
        success: true,
        agent: Some(AgentsWriteAgent {
            slug: args.slug,
            name: args.name,
            pubkey,
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
        perform_write(&self.base_dir, args)
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

        let path = dir.join("agents").join(format!("{}.json", agent.pubkey));
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
        let path = dir.join("agents").join(format!("{pubkey}.json"));
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

        let entries: Vec<_> = std::fs::read_dir(dir.join("agents"))
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("json"))
            .filter(|e| e.file_name().to_str() != Some("index.json"))
            .collect();
        assert_eq!(entries.len(), 1, "update must not create a second file");
    }

    #[test]
    fn update_preserves_unknown_fields() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_path_buf();
        let first = perform_write(&dir, args("gamma", "Gamma", None)).unwrap();
        let pubkey = first.agent.unwrap().pubkey;
        let path = dir.join("agents").join(format!("{pubkey}.json"));

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
        let dir = tmp.path().join("nested");
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
