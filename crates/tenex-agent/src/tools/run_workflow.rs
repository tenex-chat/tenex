use crate::config::ResolvedModel;
use crate::llm_accounting::{assistant_text, usage_from_rig};
use crate::tools::todo::{apply_todo_write, TodoItem, TodoStatus, TodoWriteArgs, TodoWriteItem};
use crate::workflows;
use rig::completion::{Completion, Message};
use rig::providers::{anthropic, ollama, openai, openrouter};
use rig::{client::CompletionClient, completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tenex_accounting::{record_llm_call, RecordLlmCall, RootKindOrStr};

const TODO_INSTRUCTION: &str = "\
You will be given a workflow specification and a concrete task. Produce a todo checklist that walks through the workflow for that task. \
Return ONLY a JSON array of objects with two fields: `title` (short imperative phrase, required) and `description` (a one or two sentence elaboration, optional). \
Do not return prose, code fences, preambles, or commentary — only the JSON array. \
Cover every step the workflow does not want forgotten, in the order the workflow specifies, specialised to the task.";

#[derive(Debug, Deserialize, Serialize)]
pub struct RunWorkflowArgs {
    pub name: String,
    pub task: String,
    /// Allow replacing an existing todo list. Defaults to false so the agent
    /// is forced to acknowledge — a workflow guarding against mid-task drops
    /// shouldn't itself silently drop in-progress work.
    pub force: Option<bool>,
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct RunWorkflowError(String);

#[derive(Deserialize)]
struct GeneratedTodo {
    title: String,
    #[serde(default)]
    description: Option<String>,
}

#[derive(Clone)]
pub struct RunWorkflowTool {
    agent_home: PathBuf,
    summarization_model: Arc<ResolvedModel>,
    todos: Arc<Mutex<Vec<TodoItem>>>,
    agent_pubkey: String,
    conversation_id: String,
}

impl RunWorkflowTool {
    pub fn new(
        agent_home: PathBuf,
        summarization_model: Arc<ResolvedModel>,
        todos: Arc<Mutex<Vec<TodoItem>>>,
        agent_pubkey: String,
        conversation_id: String,
    ) -> Self {
        Self {
            agent_home,
            summarization_model,
            todos,
            agent_pubkey,
            conversation_id,
        }
    }

    async fn call_llm(&self, system_prompt: &str, user_prompt: String) -> anyhow::Result<String> {
        use rig::client::Nothing;

        let history: Vec<Message> = Vec::new();
        let model = &self.summarization_model;

        let (text, usage) = crate::llm_retry::with_key_retry(model, |key| {
            let system_prompt = system_prompt.to_string();
            let user_prompt = user_prompt.clone();
            let history = history.clone();
            let provider = model.provider.clone();
            let model_id = model.model.clone();
            let base_url = model.base_url.clone();
            async move {
                let (text, usage) = match provider.as_str() {
                    "openrouter" => {
                        let resp = openrouter::Client::new(&key)?
                            .agent(&model_id)
                            .preamble(&system_prompt)
                            .build()
                            .completion(user_prompt, history)
                            .await
                            .map_err(|e| anyhow::anyhow!("{e:?}"))?
                            .send()
                            .await
                            .map_err(|e| anyhow::anyhow!("{e:?}"))?;
                        (assistant_text(&resp.choice), resp.usage)
                    }
                    "openai" => {
                        let resp = openai::CompletionsClient::builder()
                            .api_key(&key)
                            .build()?
                            .agent(&model_id)
                            .preamble(&system_prompt)
                            .build()
                            .completion(user_prompt, history)
                            .await
                            .map_err(|e| anyhow::anyhow!("{e:?}"))?
                            .send()
                            .await
                            .map_err(|e| anyhow::anyhow!("{e:?}"))?;
                        (assistant_text(&resp.choice), resp.usage)
                    }
                    "ollama" => {
                        let mut builder = ollama::Client::builder().api_key(Nothing);
                        if let Some(url) = base_url.as_deref() {
                            builder = builder.base_url(url);
                        }
                        let resp = builder
                            .build()?
                            .agent(&model_id)
                            .preamble(&system_prompt)
                            .build()
                            .completion(user_prompt, history)
                            .await
                            .map_err(|e| anyhow::anyhow!("{e:?}"))?
                            .send()
                            .await
                            .map_err(|e| anyhow::anyhow!("{e:?}"))?;
                        (assistant_text(&resp.choice), resp.usage)
                    }
                    _ => {
                        let resp = anthropic::Client::new(&key)?
                            .agent(&model_id)
                            .preamble(&system_prompt)
                            .build()
                            .completion(user_prompt, history)
                            .await
                            .map_err(|e| anyhow::anyhow!("{e:?}"))?
                            .send()
                            .await
                            .map_err(|e| anyhow::anyhow!("{e:?}"))?;
                        (assistant_text(&resp.choice), resp.usage)
                    }
                };
                Ok((text, usage))
            }
        })
        .await?;

        record_llm_call(RecordLlmCall {
            root_kind: RootKindOrStr::Other("run_workflow".into()),
            provider: model.provider.clone(),
            provider_model_id: model.model.clone(),
            operation: "run_workflow".into(),
            agent_pubkey: Some(self.agent_pubkey.clone()),
            conversation_id: Some(self.conversation_id.clone()),
            user_message: Some(user_prompt),
            assistant_response: Some(text.clone()),
            usage: usage_from_rig(&usage),
            ..Default::default()
        })
        .await;

        Ok(text)
    }
}

/// Strip optional ```json ... ``` or ``` ... ``` fences and surrounding whitespace.
fn strip_json_fences(s: &str) -> &str {
    let trimmed = s.trim();
    if let Some(rest) = trimmed.strip_prefix("```json") {
        return rest
            .trim_start()
            .strip_suffix("```")
            .map(str::trim)
            .unwrap_or(rest.trim());
    }
    if let Some(rest) = trimmed.strip_prefix("```") {
        return rest
            .trim_start()
            .strip_suffix("```")
            .map(str::trim)
            .unwrap_or(rest.trim());
    }
    trimmed
}

impl Tool for RunWorkflowTool {
    const NAME: &'static str = "run_workflow";
    type Error = RunWorkflowError;
    type Args = RunWorkflowArgs;
    type Output = String;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Dispatch a previously authored workflow against a concrete task. \
                Uses the summarizer LLM to expand the workflow's instructions into a todo checklist \
                specialised for the task and REPLACES your current todo list with those items \
                (status pending). Only call this when starting fresh on work that fits the workflow."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Workflow name (must match an existing $AGENT_HOME/workflows/<name>.yaml)."
                    },
                    "task": {
                        "type": "string",
                        "description": "The concrete task this run of the workflow should accomplish."
                    },
                    "force": {
                        "type": "boolean",
                        "description": "Allow replacing an existing todo list (default: false). Required when there are existing items to discard."
                    }
                },
                "required": ["name", "task"]
            }),
        }
    }

    async fn call(&self, args: RunWorkflowArgs) -> Result<String, RunWorkflowError> {
        let workflow = workflows::read_workflow(&self.agent_home, &args.name)
            .map_err(|e| RunWorkflowError(e.to_string()))?;

        let system_prompt = format!("{}\n\n{}", workflow.system_prompt.trim(), TODO_INSTRUCTION);
        let user_prompt = format!("Task: {}", args.task);

        let raw = self
            .call_llm(&system_prompt, user_prompt)
            .await
            .map_err(|e| RunWorkflowError(format!("LLM call failed: {e}")))?;

        let payload = strip_json_fences(&raw);
        let generated: Vec<GeneratedTodo> = serde_json::from_str(payload).map_err(|e| {
            RunWorkflowError(format!(
                "workflow LLM did not return a JSON todo array ({e}); raw output: {raw}"
            ))
        })?;

        if generated.is_empty() {
            return Err(RunWorkflowError(
                "workflow LLM returned an empty todo list".to_string(),
            ));
        }

        let items: Vec<TodoWriteItem> = generated
            .into_iter()
            .map(|g| TodoWriteItem {
                id: None,
                title: g.title,
                description: g.description,
                status: TodoStatus::Pending,
                skip_reason: None,
            })
            .collect();

        let result = apply_todo_write(
            &self.todos,
            TodoWriteArgs {
                todos: items,
                force: args.force,
            },
        )
        .map_err(|e| RunWorkflowError(e.to_string()))?;

        Ok(format!(
            "Workflow '{}' dispatched for task: {}\n\n{}",
            args.name, args.task, result
        ))
    }
}
