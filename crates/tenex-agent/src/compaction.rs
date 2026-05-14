//! LLM-driven compaction summarizer.
//!
//! Implements [`tenex_context::CompactionSummarizer`] using the agent's
//! resolved model to produce a high-signal 8-section summary of the
//! messages being compacted out of the context window.

use crate::config::ResolvedModel;
use crate::llm_accounting::{assistant_text, usage_from_rig};
use async_trait::async_trait;
use rig::client::CompletionClient;
use rig::completion::{Completion, Message};
use rig::providers::{anthropic, ollama, openai, openrouter};
use std::sync::Arc;
use tenex_accounting::{record_llm_call, RecordLlmCall, RootKindOrStr};
use tenex_context::{CompactionSummarizer, Message as CtxMessage};

const SYSTEM_PROMPT: &str = "\
Compress prior TENEX execution context into a high-signal continuation summary for future work. \
Return plain text with exactly these sections and headings: \
Task, Completed, Important Findings, Failures And Dead Ends, \
Tool Use And Side Effects, Open Issues, Next Steps, Persistent Facts. \
Preserve the current user goal, constraints, decisions, exact file paths, commands, URLs, \
identifiers, tool names, relevant tool-call IDs, side effects, failures, retries, dead ends, \
plans, unfinished work, and facts needed to continue safely. \
Keep concrete artifacts over vague gist. \
Mention what changed, what was tried, what did not work, and what remains. \
Do not invent progress, verification, or results. \
Do not hide unresolved risk. \
Do not claim tests passed unless the transcript proves it. \
Summarize only from the provided transcript.";

/// Build a plain-text transcript of the messages to be summarized.
fn build_transcript(messages: &[CtxMessage]) -> String {
    messages
        .iter()
        .filter_map(|m| match m {
            CtxMessage::System { .. } => None,
            CtxMessage::User { content } => Some(format!("[user]\n{content}")),
            CtxMessage::Assistant {
                content,
                tool_calls,
                ..
            } => {
                let mut parts = vec![format!("[assistant]\n{content}")];
                for tc in tool_calls {
                    parts.push(format!(
                        "[tool_call id={} name={}]\n{}",
                        tc.id,
                        tc.name,
                        serde_json::to_string(&tc.arguments).unwrap_or_default()
                    ));
                }
                Some(parts.join("\n"))
            }
            CtxMessage::ToolResult {
                tool_call_id,
                tool_name,
                content,
                is_error,
                ..
            } => Some(format!(
                "[tool_result id={tool_call_id} name={tool_name} error={is_error}]\n{content}"
            )),
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

pub struct LlmCompactionSummarizer {
    resolved: Arc<ResolvedModel>,
    agent_pubkey: String,
    conversation_id: String,
    project_id: Option<String>,
}

impl LlmCompactionSummarizer {
    pub fn new(
        resolved: Arc<ResolvedModel>,
        agent_pubkey: String,
        conversation_id: String,
        project_id: Option<String>,
    ) -> Self {
        Self {
            resolved,
            agent_pubkey,
            conversation_id,
            project_id,
        }
    }

    async fn call_llm(&self, user_prompt: String) -> anyhow::Result<String> {
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
                    .preamble(SYSTEM_PROMPT)
                    .max_tokens(1400)
                    .build()
                    .completion(user_prompt.clone(), history.clone())
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
                    .preamble(SYSTEM_PROMPT)
                    .max_tokens(1400)
                    .build()
                    .completion(user_prompt.clone(), history.clone())
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
                    .preamble(SYSTEM_PROMPT)
                    .max_tokens(1400)
                    .build()
                    .completion(user_prompt.clone(), history.clone())
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
                    .preamble(SYSTEM_PROMPT)
                    .max_tokens(1400)
                    .build()
                    .completion(user_prompt.clone(), history.clone())
                    .await
                    .map_err(|e| anyhow::anyhow!("{e:?}"))?
                    .send()
                    .await
                    .map_err(|e| anyhow::anyhow!("{e:?}"))?;
                (assistant_text(&resp.choice), resp.usage)
            }
        };

        record_llm_call(RecordLlmCall {
            root_kind: RootKindOrStr::Other("compaction".into()),
            provider: self.resolved.provider.clone(),
            provider_model_id: self.resolved.model.clone(),
            operation: "compaction".into(),
            agent_pubkey: Some(self.agent_pubkey.clone()),
            conversation_id: Some(self.conversation_id.clone()),
            project_id: self.project_id.clone(),
            user_message: Some(user_prompt),
            assistant_response: Some(text.clone()),
            usage: usage_from_rig(&usage),
            ..Default::default()
        })
        .await;

        Ok(text)
    }
}

#[async_trait]
impl CompactionSummarizer for LlmCompactionSummarizer {
    async fn summarize(&self, messages: &[CtxMessage]) -> anyhow::Result<String> {
        let transcript = build_transcript(messages);
        if transcript.trim().is_empty() {
            anyhow::bail!("no transcript content to summarize");
        }

        let user_prompt = format!(
            "Summarize this TENEX execution transcript so work can continue safely after \
context compaction. Capture goals, important completed work, findings, failed attempts, \
tool use, side effects, open issues, next steps, and persistent facts.\n\n\
Transcript to compact:\n{transcript}"
        );

        self.call_llm(user_prompt).await
    }
}
