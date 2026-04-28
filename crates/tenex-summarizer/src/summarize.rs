//! LLM call. Prompt and schema are lifted verbatim from
//! `src/conversations/services/ConversationSummarizer.ts`.

use anyhow::{anyhow, Context, Result};
use rig::client::{CompletionClient, Nothing};
use rig::providers::{anthropic, ollama, openai, openrouter};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

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

pub async fn summarize(llm: &LlmSelection, transcript: &str) -> Result<Summary> {
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

    match llm.provider.as_str() {
        "anthropic" => {
            let key = llm
                .api_key
                .clone()
                .context("missing ANTHROPIC_API_KEY (env or ~/.tenex/providers.json)")?;
            let client = anthropic::Client::new(&key)?;
            let extractor = client
                .extractor::<Summary>(&llm.model)
                .preamble(&preamble)
                .build();
            extractor
                .extract(user.as_str())
                .await
                .map_err(|e| anyhow!("anthropic extraction failed: {e}"))
        }
        "openrouter" => {
            let key = llm
                .api_key
                .clone()
                .context("missing OPENROUTER_API_KEY")?;
            let client = openrouter::Client::new(&key)?;
            let extractor = client
                .extractor::<Summary>(&llm.model)
                .preamble(&preamble)
                .build();
            extractor
                .extract(user.as_str())
                .await
                .map_err(|e| anyhow!("openrouter extraction failed: {e}"))
        }
        "openai" => {
            let key = llm.api_key.clone().context("missing OPENAI_API_KEY")?;
            let client = openai::CompletionsClient::builder().api_key(&key).build()?;
            let extractor = client
                .extractor::<Summary>(&llm.model)
                .preamble(&preamble)
                .build();
            extractor
                .extract(user.as_str())
                .await
                .map_err(|e| anyhow!("openai extraction failed: {e}"))
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
            extractor
                .extract(user.as_str())
                .await
                .map_err(|e| anyhow!("ollama extraction failed: {e}"))
        }
        other => Err(anyhow!("unsupported LLM provider: {other}")),
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
