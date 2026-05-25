mod xml;

#[cfg(test)]
mod tests;

use crate::config::ResolvedModel;
use crate::emit::EmitState;
use crate::llm_accounting::{assistant_text, usage_from_rig};
use rig_core::completion::{Completion, Message};
use rig_core::providers::{anthropic, ollama, openai, openrouter};
use rig_core::{client::CompletionClient, completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::PathBuf;
use std::sync::Arc;
use tenex_accounting::{record_llm_call, RecordLlmCall, RootKindOrStr};
use tenex_conversations::{
    paths::CONVERSATION_DB_FILENAME, ConversationListFilter, ConversationStore, MessageQuery,
};
use tenex_protocol::intent::{Intent, ToolUseIntent};

#[derive(Debug, Deserialize, Serialize)]
pub struct ConversationGetArgs {
    #[serde(alias = "conversationId")]
    pub conversation_id: String,
    pub description: String,
    #[serde(alias = "untilId")]
    pub until_id: Option<String>,
    pub limit: Option<usize>,
    pub prompt: Option<String>,
    #[serde(default, alias = "includeToolCalls")]
    pub include_tool_calls: bool,
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct ConversationGetError(String);

#[derive(Clone)]
pub struct ConversationGetTool {
    state: Arc<EmitState>,
    db_path: PathBuf,
    base_dir: PathBuf,
    resolved: Arc<ResolvedModel>,
}

impl ConversationGetTool {
    pub fn new(
        state: Arc<EmitState>,
        db_path: PathBuf,
        base_dir: PathBuf,
        resolved: Arc<ResolvedModel>,
    ) -> Self {
        Self {
            state,
            db_path,
            base_dir,
            resolved,
        }
    }

    fn find_store(
        &self,
        raw_id: &str,
    ) -> Result<(ConversationStore, String), ConversationGetError> {
        let open_current = || {
            ConversationStore::open(&self.db_path).map_err(|e| {
                ConversationGetError(format!("failed to open conversation store: {e}"))
            })
        };

        let current = open_current()?;
        let resolved_id = resolve_conversation_id(&current, raw_id)?;

        let in_current = current.get_conversation(&resolved_id).ok().flatten().is_some()
            || !current
                .list_messages(
                    &resolved_id,
                    MessageQuery {
                        limit: Some(1),
                        ..Default::default()
                    },
                )
                .unwrap_or_default()
                .is_empty();
        if in_current {
            return Ok((current, resolved_id));
        }
        drop(current);

        let projects_dir = self.base_dir.join("projects");
        if let Ok(entries) = std::fs::read_dir(&projects_dir) {
            for entry in entries.flatten() {
                let db_path = entry.path().join(CONVERSATION_DB_FILENAME);
                if db_path == self.db_path {
                    continue;
                }
                if let Ok(store) = ConversationStore::open(&db_path) {
                    if let Ok(id) = resolve_conversation_id(&store, raw_id) {
                        let found = store.get_conversation(&id).ok().flatten().is_some()
                            || !store
                                .list_messages(
                                    &id,
                                    MessageQuery {
                                        limit: Some(1),
                                        ..Default::default()
                                    },
                                )
                                .unwrap_or_default()
                                .is_empty();
                        if found {
                            return Ok((store, id));
                        }
                    }
                }
            }
        }

        Ok((open_current()?, resolved_id))
    }

    async fn call_llm(
        &self,
        system: &str,
        user: String,
        conversation_id: &str,
    ) -> anyhow::Result<String> {
        use rig_core::client::Nothing;

        let history: Vec<Message> = Vec::new();

        let (text, usage) = crate::llm_retry::with_key_retry(&self.resolved, |key| {
            let system = system.to_string();
            let user = user.clone();
            let history = history.clone();
            let provider = self.resolved.provider.clone();
            let model = self.resolved.model.clone();
            let base_url = self.resolved.base_url.clone();
            async move {
                let (text, usage) = match provider.as_str() {
                    "openrouter" => {
                        let resp = openrouter::Client::new(&key)?
                            .agent(&model)
                            .preamble(&system)
                            .build()
                            .completion(user, history)
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
                            .agent(&model)
                            .preamble(&system)
                            .build()
                            .completion(user, history)
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
                            .agent(&model)
                            .preamble(&system)
                            .build()
                            .completion(user, history)
                            .await
                            .map_err(|e| anyhow::anyhow!("{e:?}"))?
                            .send()
                            .await
                            .map_err(|e| anyhow::anyhow!("{e:?}"))?;
                        (assistant_text(&resp.choice), resp.usage)
                    }
                    _ => {
                        let resp = anthropic::Client::new(&key)?
                            .agent(&model)
                            .preamble(&system)
                            .build()
                            .completion(user, history)
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
            root_kind: RootKindOrStr::Other("conversation_analysis".into()),
            provider: self.resolved.provider.clone(),
            provider_model_id: self.resolved.model.clone(),
            operation: "conversation_analysis".into(),
            conversation_id: Some(conversation_id.to_string()),
            user_message: Some(user),
            assistant_response: Some(text.clone()),
            usage: usage_from_rig(&usage),
            ..Default::default()
        })
        .await;

        Ok(text)
    }
}

fn is_full_hex_id(input: &str) -> bool {
    input.len() == 64 && input.chars().all(|c| c.is_ascii_hexdigit())
}

fn is_conversation_prefix(input: &str) -> bool {
    (8..64).contains(&input.len()) && input.chars().all(|c| c.is_ascii_hexdigit())
}

fn resolve_conversation_id(
    store: &ConversationStore,
    raw_id: &str,
) -> Result<String, ConversationGetError> {
    let trimmed = raw_id.trim();
    let normalized = trimmed.to_ascii_lowercase();

    if is_full_hex_id(&normalized) {
        return Ok(normalized);
    }

    if !is_conversation_prefix(&normalized) {
        return Ok(trimmed.to_string());
    }

    let mut matches: Vec<String> = store
        .list_recent(ConversationListFilter {
            limit: None,
            ..Default::default()
        })
        .map_err(|e| ConversationGetError(format!("failed to list conversations: {e}")))?
        .into_iter()
        .filter_map(|conversation| {
            if conversation
                .id
                .to_ascii_lowercase()
                .starts_with(&normalized)
            {
                Some(conversation.id)
            } else {
                None
            }
        })
        .collect();

    match matches.len() {
        0 => Ok(normalized),
        1 => Ok(matches.remove(0)),
        count => Err(ConversationGetError(format!(
            "conversation prefix {trimmed} is ambiguous ({count} matches); provide the full 64-character ID"
        ))),
    }
}

impl Tool for ConversationGetTool {
    const NAME: &'static str = "conversation_get";
    type Error = ConversationGetError;
    type Args = ConversationGetArgs;
    type Output = String;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Retrieve a conversation by stored ID. Returns an XML transcript. XML includes root t0, per-entry relative time=\"+seconds\", author/recipient attribution, short event IDs, and optional tool-call entries.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "conversation_id": {
                        "type": "string",
                        "description": "Stored conversation ID. Full 64-character hex IDs and unique 8+ character hex prefixes are accepted."
                    },
                    "description": {
                        "type": "string",
                        "description": "One-line reason why you are retrieving this conversation"
                    },
                    "until_id": {
                        "type": "string",
                        "description": "Optional stored message/event/tool-call ID. Returns the transcript up to and including this entry; unique 8+ character prefixes are accepted."
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Optional maximum number of messages to return (earliest first)."
                    },
                    "prompt": {
                        "type": "string",
                        "description": "Optional prompt to analyze the retrieved conversation with an LLM."
                    },
                    "include_tool_calls": {
                        "type": "boolean",
                        "description": "Whether to include tool-call entries in the XML transcript. Tool result payloads are omitted. The camelCase alias includeToolCalls is also accepted.",
                        "default": false
                    },
                    "includeToolCalls": {
                        "type": "boolean",
                        "description": "Alias for include_tool_calls.",
                        "default": false
                    }
                },
                "required": ["conversation_id", "description"]
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<String, Self::Error> {
        let ral = self.state.meta.lock().unwrap().ral;
        let mut ctx = self.state.build_ctx(ral);
        ctx.llm_runtime_ms = self.state.take_runtime_delta();
        let args_json = serde_json::to_string(&args).unwrap_or_default();
        self.state
            .channel
            .send(
                Intent::ToolUse(ToolUseIntent {
                    tool_name: Self::NAME.to_string(),
                    content: String::new(),
                    args_json: Some(args_json),
                    referenced_messages: vec![],
                    usage: None,
                    extra_tags: vec![],
                }),
                &ctx,
            )
            .await
            .map_err(|e| ConversationGetError(format!("failed to emit tool-use event: {e}")))?;

        let (store, conversation_id) = self.find_store(&args.conversation_id)?;
        let conversation = store
            .get_conversation(&conversation_id)
            .map_err(|e| ConversationGetError(format!("failed to read conversation: {e}")))?;

        let mut messages = store
            .list_messages(
                &conversation_id,
                MessageQuery {
                    limit: args.limit.map(|n| n as i64),
                    ..Default::default()
                },
            )
            .map_err(|e| ConversationGetError(format!("failed to list messages: {e}")))?;
        let mut tool_messages = store
            .list_tool_messages(&conversation_id)
            .map_err(|e| ConversationGetError(format!("failed to list tool messages: {e}")))?;

        if conversation.is_none() && messages.is_empty() && tool_messages.is_empty() {
            return Ok(xml::render_missing_conversation_xml(&conversation_id));
        }

        if let Some(until_id) = args.until_id.as_deref() {
            xml::truncate_until(&mut messages, &mut tool_messages, until_id);
        }

        let messages_xml = xml::render_conversation_xml(
            &conversation_id,
            &messages,
            &tool_messages,
            args.include_tool_calls,
        );

        if let Some(prompt) = args.prompt {
            let system = "You analyze TENEX conversation transcripts. Base your answer only on the provided conversation data, preserve identifiers exactly, and include verbatim quotes when they support the answer.";
            let user = format!(
                "Please analyze the following conversation based on this prompt: \"{prompt}\"\n\nCONVERSATION XML:\n{messages_xml}"
            );
            return self
                .call_llm(system, user, &conversation_id)
                .await
                .map_err(|e| ConversationGetError(format!("LLM call failed: {e}")));
        }

        Ok(messages_xml)
    }
}
