use crate::workflows::{self, Workflow};
use rig::{completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::PathBuf;

#[derive(Debug, Deserialize, Serialize)]
pub struct CreateWorkflowArgs {
    pub name: String,
    pub description: String,
    pub system_prompt: String,
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct CreateWorkflowError(String);

#[derive(Clone)]
pub struct CreateWorkflowTool {
    agent_home: PathBuf,
}

impl CreateWorkflowTool {
    pub fn new(agent_home: PathBuf) -> Self {
        Self { agent_home }
    }
}

impl Tool for CreateWorkflowTool {
    const NAME: &'static str = "create_workflow";
    type Error = CreateWorkflowError;
    type Args = CreateWorkflowArgs;
    type Output = String;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Author a named workflow under $AGENT_HOME/workflows/<name>.yaml. \
                The system_prompt should describe — in enough detail that an LLM can specialise it \
                to a specific task — every step you do not want forgotten when this workflow runs, \
                including ordering, gating conditions, and verification. Overwrites an existing \
                workflow with the same name."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Slug used as the file stem. Letters, digits, '_', '-' only."
                    },
                    "description": {
                        "type": "string",
                        "description": "One-line summary shown in the system-prompt fragment listing your workflows."
                    },
                    "system_prompt": {
                        "type": "string",
                        "description": "Detailed instructions an LLM will follow to produce a todo checklist when this workflow is dispatched."
                    }
                },
                "required": ["name", "description", "system_prompt"]
            }),
        }
    }

    async fn call(&self, args: CreateWorkflowArgs) -> Result<String, CreateWorkflowError> {
        let workflow = Workflow {
            name: args.name.clone(),
            description: args.description,
            system_prompt: args.system_prompt,
        };
        let path = workflows::write_workflow(&self.agent_home, &workflow)
            .map_err(|e| CreateWorkflowError(e.to_string()))?;
        Ok(format!(
            "Workflow '{}' written to {}. Dispatch it with run_workflow.",
            args.name,
            path.display()
        ))
    }
}
