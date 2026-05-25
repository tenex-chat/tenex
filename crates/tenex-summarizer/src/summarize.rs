//! LLM call. Prompt and schema are lifted verbatim from
//! `src/conversations/services/ConversationSummarizer.ts`.

use anyhow::{anyhow, Context, Result};
use rig_core::client::{CompletionClient, Nothing};
use rig_core::completion::Usage;
use rig_core::providers::{anthropic, ollama, openai, openrouter};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tenex_accounting::{flush, record_llm_call, LlmUsage, RecordLlmCall, RootKind};

use crate::categories;
use crate::config::LlmSelection;

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
pub struct Summary {
    /// A concise title for the conversation (3-5 words)
    pub title: String,
    /// A 1-sentence, information-dense summary (<=160 chars) of key facts, scope, and blockers
    pub summary: String,
    /// A concise status label (e.g., 'In Progress', 'Blocked', 'Waiting', 'Completed', 'Failed')
    pub status_label: String,
    /// One dense clause consistent with status_label; no duplication or speculation
    pub status_current_activity: String,
    /// 0-3 category tags. Lowercase singular nouns. Prefer canonical list; create new only if necessary; may be empty [].
    pub categories: Vec<String>,
}

/// Caller-supplied context for accounting. None of the fields are
/// required by the LLM call itself.
#[derive(Debug, Clone, Default)]
pub struct SummarizeContext {
    pub conversation_id: Option<String>,
    pub project_id: Option<String>,
}

pub async fn summarize(
    llm: &LlmSelection,
    transcript: &str,
    ctx: SummarizeContext,
) -> Result<Summary> {
    let existing = categories::top(10).unwrap_or_default();
    let category_list_text = if existing.is_empty() {
        "No existing categories yet. Create new ones as needed.".to_string()
    } else {
        format!(
            "Existing categories (prefer these for consistency): {}",
            existing.join(", ")
        )
    };
    let preamble = system_prompt(&category_list_text);
    let user = format!(
        "Please generate a title, summary, and status information for this conversation:\n\n{transcript}"
    );

    let (summary, usage) = match llm.provider.as_str() {
        "anthropic" => {
            let key = llm
                .api_key
                .clone()
                .context("missing Anthropic API key in ~/.tenex/providers.json")?;
            let client = anthropic::Client::new(&key)?;
            let extractor = client
                .extractor::<Summary>(&llm.model)
                .preamble(&preamble)
                .build();
            let resp = extractor
                .extract_with_usage(user.as_str())
                .await
                .map_err(|e| anyhow!("anthropic extraction failed: {e}"))?;
            (resp.data, resp.usage)
        }
        "openrouter" => {
            let key = llm
                .api_key
                .clone()
                .context("missing OpenRouter API key in ~/.tenex/providers.json")?;
            let client = openrouter::Client::new(&key)?;
            let extractor = client
                .extractor::<Summary>(&llm.model)
                .preamble(&preamble)
                .build();
            let resp = extractor
                .extract_with_usage(user.as_str())
                .await
                .map_err(|e| anyhow!("openrouter extraction failed: {e}"))?;
            (resp.data, resp.usage)
        }
        "openai" => {
            let key = llm
                .api_key
                .clone()
                .context("missing OpenAI API key in ~/.tenex/providers.json")?;
            let client = openai::CompletionsClient::builder().api_key(&key).build()?;
            let extractor = client
                .extractor::<Summary>(&llm.model)
                .preamble(&preamble)
                .build();
            let resp = extractor
                .extract_with_usage(user.as_str())
                .await
                .map_err(|e| anyhow!("openai extraction failed: {e}"))?;
            (resp.data, resp.usage)
        }
        "ollama" => {
            let mut builder = ollama::Client::builder().api_key(Nothing);
            if let Some(url) = &llm.base_url {
                builder = builder.base_url(url);
            }
            let client = builder.build()?;
            let extractor = client
                .extractor::<Summary>(&llm.model)
                .preamble(&preamble)
                .build();
            let resp = extractor
                .extract_with_usage(user.as_str())
                .await
                .map_err(|e| anyhow!("ollama extraction failed: {e}"))?;
            (resp.data, resp.usage)
        }
        other => return Err(anyhow!("unsupported LLM provider: {other}")),
    };

    record_llm_call(RecordLlmCall {
        root_kind: RootKind::Summarization.into(),
        provider: llm.provider.clone(),
        provider_model_id: llm.model.clone(),
        operation: "summarize".into(),
        conversation_id: ctx.conversation_id,
        project_id: ctx.project_id,
        user_message: Some(user),
        assistant_response: serde_json::to_string(&summary).ok(),
        usage: usage_from_rig(&usage),
        ..Default::default()
    })
    .await;
    flush().await;

    Ok(summary)
}

fn usage_from_rig(u: &Usage) -> LlmUsage {
    LlmUsage {
        input_tokens: u.input_tokens,
        output_tokens: u.output_tokens,
        cached_input_tokens: u.cached_input_tokens,
        cache_creation_input_tokens: u.cache_creation_input_tokens,
        reasoning_tokens: 0,
        total_tokens: Some(u.total_tokens),
    }
}

fn system_prompt(category_list_text: &str) -> String {
    format!(
        r#"You generate high-signal titles, summaries, status metadata, and category tags for technical conversations.

                CRITICAL: Base output ONLY on what is explicitly stated in the conversation. Do NOT:
                - Hallucinate success when errors, failures, or problems are mentioned
                - Assume tasks were completed if the conversation shows they failed or are still in progress
                - Invent outcomes not clearly stated in the transcript

                DENSITY RULES (ENFORCE)
                - Summary max 160 characters (hard limit).
                - No narrative glue: avoid “ensuring”, “including”, “key features”, “focused on”, “review of”, “in order to”, “now complete”, “ready for testing” (unless explicitly stated).
                - No redundancy: summary and status_current_activity must not restate the same fact in different words.

                TITLE
                - 3–5 words (hard limit), concrete nouns/verbs, no filler.
                - Prefer outcome/topic phrasing.

                SUMMARY (1 sentence only)
                - Changelog style: state facts only (outcome/state, scope, blockers).
                - For In Progress / Blocked / Waiting: include what is missing or unknown (“Details not provided”).
                - Do not describe process.

                STATUS
                - status_label: one of "Researching", "In Progress", "Blocked", "Waiting", "Completed", "Failed", "Planning".
                - status_current_activity: one dense clause, consistent with status_label.
                - Do not duplicate the summary.

                CATEGORIES (CANONICAL-FIRST, SEMANTIC)
                You are given a list of previously used categories below. This list is a CANONICAL SUGGESTION SET, not an allowlist.
                You must actively judge each candidate (including items from the list) using the rules below.

                Previously used categories:
                {category_list_text}

                Selection rules:
                - Prefer an existing category from the list *only if* it is a good semantic fit.
                - A valid category must:
                - Name a stable system concept (component, data model, protocol, UI artifact, subsystem)
                - Remain meaningful months later without task context
                - Have high discriminative value (would not apply to most unrelated conversations)
                - Do NOT select a category just because it exists in the list.

                Creation rules (to avoid fragmentation):
                - Create a new category ONLY if no existing category fits well.
                - If creating a new category:
                - Use a simple, canonical noun form
                - Avoid re-ordering words that would create near-duplicates
                - Prefer the most general stable concept (e.g., “agent” over “agent-runtime” unless runtime is explicitly the core topic)

                Rejection rule:
                - If all plausible categories (including those from the list) are low-signal or process-oriented, output [].

                Before emitting categories, silently verify for each:
                - It maps to an explicit noun phrase in the transcript
                - It passes the “6-months later” test
                - It would not create a near-duplicate of an existing category"#
    )
}
