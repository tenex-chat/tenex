//! Runtime category backfill.
//!
//! Called at agent startup when the on-disk config has no `category`
//! field. Sends the agent's metadata to the resolved LLM, parses the
//! kebab-case category from the response, and persists it via
//! [`AgentStorage::update_category`]. Idempotent on subsequent boots —
//! once `category` is set, the runtime skips this path.

use anyhow::{anyhow, Result};
use rig::client::{CompletionClient, Nothing};
use rig::completion::Prompt;
use rig::providers::{anthropic, ollama, openai, openrouter};
use tenex_agent_registry::{
    build_user_prompt, parse_category, system_prompt, AgentCategory, AgentMetadata, AgentStorage,
};

use crate::config::ResolvedModel;

/// Send `metadata` to the resolved LLM and parse a category from the
/// response. `Ok(None)` means the model returned no canonical literal —
/// not a transport error, just an unparseable answer.
pub async fn classify_via_llm(
    resolved: &ResolvedModel,
    metadata: &AgentMetadata,
) -> Result<Option<AgentCategory>> {
    let preamble = system_prompt();
    let user = build_user_prompt(metadata);

    let response = match resolved.provider.as_str() {
        "openrouter" => {
            let key = resolved
                .api_key
                .as_deref()
                .ok_or_else(|| anyhow!("no OpenRouter API key"))?;
            openrouter::Client::new(key)?
                .agent(&resolved.model)
                .preamble(&preamble)
                .max_tokens(64)
                .build()
                .prompt(user)
                .await
                .map_err(|e| anyhow!("{e:?}"))?
        }
        "openai" => {
            let key = resolved
                .api_key
                .as_deref()
                .ok_or_else(|| anyhow!("no OpenAI API key"))?;
            openai::CompletionsClient::builder()
                .api_key(key)
                .build()?
                .agent(&resolved.model)
                .preamble(&preamble)
                .max_tokens(64)
                .build()
                .prompt(user)
                .await
                .map_err(|e| anyhow!("{e:?}"))?
        }
        "ollama" => {
            let mut builder = ollama::Client::builder().api_key(Nothing);
            if let Some(url) = resolved.base_url.as_deref() {
                builder = builder.base_url(url);
            }
            builder
                .build()?
                .agent(&resolved.model)
                .preamble(&preamble)
                .max_tokens(64)
                .build()
                .prompt(user)
                .await
                .map_err(|e| anyhow!("{e:?}"))?
        }
        _ => {
            let key = resolved
                .api_key
                .as_deref()
                .ok_or_else(|| anyhow!("no Anthropic API key"))?;
            anthropic::Client::new(key)?
                .agent(&resolved.model)
                .preamble(&preamble)
                .max_tokens(64)
                .build()
                .prompt(user)
                .await
                .map_err(|e| anyhow!("{e:?}"))?
        }
    };

    Ok(parse_category(&response))
}

/// Backfill the agent's category and persist it. Returns the resolved
/// category string (kebab-case) on success. Best-effort: errors are
/// returned to the caller so the boot path can log and proceed without
/// a category rather than hard-failing.
pub async fn backfill_and_persist(
    resolved: &ResolvedModel,
    metadata: &AgentMetadata,
    base_dir: &std::path::Path,
    pubkey_hex: &str,
) -> Result<AgentCategory> {
    let category = classify_via_llm(resolved, metadata)
        .await?
        .ok_or_else(|| anyhow!("LLM returned no canonical category"))?;
    let mut storage = AgentStorage::open(base_dir)?;
    storage.update_category(pubkey_hex, category)?;
    Ok(category)
}
