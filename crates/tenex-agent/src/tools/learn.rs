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
use tenex_protocol::{Intent, LessonIntent};

#[derive(Debug, Deserialize, Serialize)]
pub struct LearnArgs {
    pub title: String,
    pub lesson: String,
    pub category: Option<String>,
    pub hashtags: Option<Vec<String>>,
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct LearnError(String);

#[derive(Clone)]
pub struct LearnTool {
    state: Arc<EmitState>,
    agent_home: PathBuf,
    resolved: Arc<ResolvedModel>,
}

impl LearnTool {
    pub fn new(state: Arc<EmitState>, agent_home: PathBuf, resolved: Arc<ResolvedModel>) -> Self {
        Self {
            state,
            agent_home,
            resolved,
        }
    }

    async fn call_llm(&self, prompt: String) -> anyhow::Result<String> {
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
                    .build()
                    .completion(prompt.clone(), history.clone())
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
                    .build()
                    .completion(prompt.clone(), history.clone())
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
                    .build()
                    .completion(prompt.clone(), history.clone())
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
                    .build()
                    .completion(prompt.clone(), history.clone())
                    .await
                    .map_err(|e| anyhow::anyhow!("{e:?}"))?
                    .send()
                    .await
                    .map_err(|e| anyhow::anyhow!("{e:?}"))?;
                (assistant_text(&resp.choice), resp.usage)
            }
        };

        record_llm_call(RecordLlmCall {
            root_kind: RootKindOrStr::Other("learn".into()),
            provider: self.resolved.provider.clone(),
            provider_model_id: self.resolved.model.clone(),
            operation: "learn".into(),
            user_message: Some(prompt),
            assistant_response: Some(text.clone()),
            usage: usage_from_rig(&usage),
            ..Default::default()
        })
        .await;

        Ok(text)
    }

    async fn update_index(
        &self,
        title: &str,
        lesson: &str,
        category: Option<&str>,
    ) -> anyhow::Result<()> {
        let index_path = self.agent_home.join("+INDEX.md");
        let current = std::fs::read_to_string(&index_path).unwrap_or_default();

        let category_hint = category
            .map(|c| format!(" (category: {c})"))
            .unwrap_or_default();

        let prompt = format!(
            "You maintain a categorized index of lessons an AI agent has learned. \
Update the index to incorporate the new lesson below. \
Rules: organize by category headings, keep each entry to 1-2 lines, \
remove duplicates or superseded entries, \
keep the TOTAL output under 1200 characters so it fits within the agent's memory window. \
Return ONLY the raw markdown — no explanation, no preamble, no code fences.\n\n\
<current-index>\n{current}\n</current-index>\n\n\
<new-lesson title=\"{title}\"{category_hint}>\n{lesson}\n</new-lesson>"
        );

        let raw = self.call_llm(prompt).await?;

        // Strip common LLM preamble patterns: code fences and leading prose before a heading.
        let content = strip_llm_preamble(raw.trim());

        std::fs::create_dir_all(&self.agent_home)
            .map_err(|e| anyhow::anyhow!("failed to create agent home: {e}"))?;
        std::fs::write(&index_path, content)
            .map_err(|e| anyhow::anyhow!("failed to write +INDEX.md: {e}"))?;

        Ok(())
    }
}

/// Remove markdown code fences and any leading prose before the first `#` heading.
fn strip_llm_preamble(s: &str) -> &str {
    // Unwrap ```markdown ... ``` or ``` ... ``` fences.
    let s = if s.starts_with("```") {
        let after_fence = s.find('\n').map(|i| &s[i + 1..]).unwrap_or(s);
        let without_closing = after_fence
            .rsplit_once("\n```")
            .map(|(body, _)| body)
            .unwrap_or(after_fence);
        without_closing.trim()
    } else {
        s
    };

    // If there's a `#` heading, start from there.
    if let Some(pos) = s
        .find("\n#")
        .or_else(|| if s.starts_with('#') { Some(0) } else { None })
    {
        if pos == 0 {
            s
        } else {
            s[pos + 1..].trim()
        }
    } else {
        s
    }
}

impl Tool for LearnTool {
    const NAME: &'static str = "learn";
    type Error = LearnError;
    type Args = LearnArgs;
    type Output = String;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Persist a lesson learned so it informs future work. Publishes a Nostr lesson event and updates your +INDEX.md knowledge file with a categorized summary of what was learned.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "Short title for the lesson"
                    },
                    "lesson": {
                        "type": "string",
                        "description": "The lesson content — what was learned and why it matters"
                    },
                    "category": {
                        "type": "string",
                        "description": "Category for organizing the lesson (e.g. 'debugging', 'architecture', 'workflow')"
                    },
                    "hashtags": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Optional hashtags without the # prefix"
                    }
                },
                "required": ["title", "lesson"]
            }),
        }
    }

    async fn call(&self, args: LearnArgs) -> Result<String, LearnError> {
        let ral = self.state.meta.lock().unwrap().ral;
        let ctx = self.state.build_ctx(ral);
        let hashtags = args.hashtags.unwrap_or_default();

        let lesson_intent = LessonIntent {
            title: args.title.clone(),
            lesson: args.lesson.clone(),
            category: args.category.clone(),
            hashtags,
            agent_definition_id: None,
        };

        self.state
            .channel
            .send(Intent::Lesson(lesson_intent), &ctx)
            .await
            .map_err(|e| LearnError(format!("failed to emit lesson: {e}")))?;

        self.update_index(&args.title, &args.lesson, args.category.as_deref())
            .await
            .map_err(|e| LearnError(format!("failed to update +INDEX.md: {e}")))?;

        Ok(format!(
            "Lesson '{}' published and +INDEX.md updated.",
            args.title
        ))
    }
}
