//! LLM-driven compaction summarizer.
//!
//! Implements [`tenex_context::CompactionSummarizer`] using the agent's
//! resolved model to produce a high-signal 8-section summary of the
//! messages being compacted out of the context window.

use crate::config::ResolvedModel;
use async_trait::async_trait;
use rig::client::CompletionClient;
use rig::completion::Prompt;
use rig::providers::{anthropic, ollama, openai, openrouter};
use std::sync::Arc;
use tenex_context::{CompactionSummarizer, Message};

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
fn build_transcript(messages: &[Message]) -> String {
    messages
        .iter()
        .filter_map(|m| match m {
            Message::System { .. } => None,
            Message::User { content } => Some(format!("[user]\n{content}")),
            Message::Assistant { content, tool_calls } => {
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
            Message::ToolResult {
                tool_call_id,
                tool_name,
                content,
                is_error,
            } => Some(format!(
                "[tool_result id={tool_call_id} name={tool_name} error={is_error}]\n{content}"
            )),
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

pub struct LlmCompactionSummarizer {
    resolved: Arc<ResolvedModel>,
}

impl LlmCompactionSummarizer {
    pub fn new(resolved: Arc<ResolvedModel>) -> Self {
        Self { resolved }
    }

    async fn call_llm(&self, user_prompt: String) -> anyhow::Result<String> {
        use rig::client::Nothing;

        let result = match self.resolved.provider.as_str() {
            "openrouter" => {
                let key = self
                    .resolved
                    .api_key
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("no OpenRouter API key"))?;
                let agent = openrouter::Client::new(key)?
                    .agent(&self.resolved.model)
                    .preamble(SYSTEM_PROMPT)
                    .max_tokens(1400)
                    .build();
                agent
                    .prompt(user_prompt)
                    .await
                    .map_err(|e| anyhow::anyhow!("{e:?}"))?
            }
            "openai" => {
                let key = self
                    .resolved
                    .api_key
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("no OpenAI API key"))?;
                let agent = openai::CompletionsClient::builder()
                    .api_key(key)
                    .build()?
                    .agent(&self.resolved.model)
                    .preamble(SYSTEM_PROMPT)
                    .max_tokens(1400)
                    .build();
                agent
                    .prompt(user_prompt)
                    .await
                    .map_err(|e| anyhow::anyhow!("{e:?}"))?
            }
            "ollama" => {
                let mut builder = ollama::Client::builder().api_key(Nothing);
                if let Some(url) = self.resolved.base_url.as_deref() {
                    builder = builder.base_url(url);
                }
                let agent = builder
                    .build()?
                    .agent(&self.resolved.model)
                    .preamble(SYSTEM_PROMPT)
                    .max_tokens(1400)
                    .build();
                agent
                    .prompt(user_prompt)
                    .await
                    .map_err(|e| anyhow::anyhow!("{e:?}"))?
            }
            _ => {
                let key = self
                    .resolved
                    .api_key
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("no Anthropic API key"))?;
                let agent = anthropic::Client::new(key)?
                    .agent(&self.resolved.model)
                    .preamble(SYSTEM_PROMPT)
                    .max_tokens(1400)
                    .build();
                agent
                    .prompt(user_prompt)
                    .await
                    .map_err(|e| anyhow::anyhow!("{e:?}"))?
            }
        };

        Ok(result)
    }
}

#[async_trait]
impl CompactionSummarizer for LlmCompactionSummarizer {
    async fn summarize(&self, messages: &[Message]) -> anyhow::Result<String> {
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
