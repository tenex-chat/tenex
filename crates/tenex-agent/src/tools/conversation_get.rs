mod xml;

#[cfg(test)]
mod tests;

use crate::config::ResolvedModel;
use crate::emit::EmitState;
use crate::llm_accounting::{assistant_text, usage_from_rig};
use rig::completion::{Completion, Message};
use rig::providers::{anthropic, ollama, openai, openrouter};
use rig::{client::CompletionClient, completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::PathBuf;
use std::sync::Arc;
use tenex_accounting::{record_llm_call, RecordLlmCall, RootKindOrStr};
use tenex_conversations::{ConversationListFilter, ConversationStore, MessageQuery};
use tenex_protocol::intent::{Intent, ToolUseIntent};

#[derive(Debug, Deserialize, Serialize)]
pub struct ConversationGetArgs {
    #[serde(alias = "conversationId")]
    pub conversation_id: String,
    pub description: String,
    pub limit: Option<i64>,
    #[serde(alias = "untilId")]
    pub until_id: Option<String>,
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
    resolved: Arc<ResolvedModel>,
}

impl ConversationGetTool {
    pub fn new(state: Arc<EmitState>, db_path: PathBuf, resolved: Arc<ResolvedModel>) -> Self {
        Self {
            state,
            db_path,
            resolved,
        }
    }

    async fn call_llm(
        &self,
        system: &str,
        user: String,
        conversation_id: &str,
    ) -> anyhow::Result<String> {
        use rig::client::Nothing;

        let history: Vec<Message> = Vec::new();

        let (text, usage) = match self.resolved.provider.as_str() {
            "openrouter" => {
                let key = self
                    .resolved
                    .api_key
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("no OpenRouter API key"))?;
                let resp = openrouter::Client::new(key)?
                    .agent(&self.resolved.model)
                    .preamble(system)
                    .build()
                    .completion(user.clone(), history.clone())
                    .await
                    .map_err(|e| anyhow::anyhow!("{e:?}"))?
                    .send()
                    .await
                    .map_err(|e| anyhow::anyhow!("{e:?}"))?;
                (assistant_text(&resp.choice), resp.usage)
            }
            "openai" => {
                let key = self
                    .resolved
                    .api_key
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("no OpenAI API key"))?;
                let resp = openai::CompletionsClient::builder()
                    .api_key(key)
                    .build()?
                    .agent(&self.resolved.model)
                    .preamble(system)
                    .build()
                    .completion(user.clone(), history.clone())
                    .await
                    .map_err(|e| anyhow::anyhow!("{e:?}"))?
                    .send()
                    .await
                    .map_err(|e| anyhow::anyhow!("{e:?}"))?;
                (assistant_text(&resp.choice), resp.usage)
            }
            "ollama" => {
                let mut builder = ollama::Client::builder().api_key(Nothing);
                if let Some(url) = self.resolved.base_url.as_deref() {
                    builder = builder.base_url(url);
                }
                let resp = builder
                    .build()?
                    .agent(&self.resolved.model)
                    .preamble(system)
                    .build()
                    .completion(user.clone(), history.clone())
                    .await
                    .map_err(|e| anyhow::anyhow!("{e:?}"))?
                    .send()
                    .await
                    .map_err(|e| anyhow::anyhow!("{e:?}"))?;
                (assistant_text(&resp.choice), resp.usage)
            }
            _ => {
                let key = self
                    .resolved
                    .api_key
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("no Anthropic API key"))?;
                let resp = anthropic::Client::new(key)?
                    .agent(&self.resolved.model)
                    .preamble(system)
                    .build()
                    .completion(user.clone(), history.clone())
                    .await
                    .map_err(|e| anyhow::anyhow!("{e:?}"))?
                    .send()
                    .await
                    .map_err(|e| anyhow::anyhow!("{e:?}"))?;
                (assistant_text(&resp.choice), resp.usage)
            }
        };

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
                    "limit": {
                        "type": "integer",
                        "description": "Maximum number of text/delegation messages to return after slicing."
                    },
                    "until_id": {
                        "type": "string",
                        "description": "Optional stored message/event/tool-call ID. Returns the transcript up to and including this entry; unique 8+ character prefixes are accepted."
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
        let ctx = self.state.build_ctx(ral);
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

        let store = ConversationStore::open(&self.db_path)
            .map_err(|e| ConversationGetError(format!("failed to open conversation store: {e}")))?;
        let conversation_id = resolve_conversation_id(&store, &args.conversation_id)?;
        let conversation = store
            .get_conversation(&conversation_id)
            .map_err(|e| ConversationGetError(format!("failed to read conversation: {e}")))?;

        let mut messages = store
            .list_messages(&conversation_id, MessageQuery::default())
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
        if let Some(limit) = args.limit.and_then(|value| usize::try_from(value).ok()) {
            xml::truncate_message_limit(&mut messages, &mut tool_messages, limit);
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
