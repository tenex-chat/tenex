use crate::config::ResolvedModel;
use rig::providers::{anthropic, ollama, openai, openrouter};
use rig::{client::CompletionClient, completion::Prompt};
use std::collections::HashMap;
use std::time::Duration;
use tenex_rag::{RagStore, SearchResult};
use tenex_rag::store::VectorStore;

const SCORE_THRESHOLD: f32 = 0.65;
const MAX_RESULTS: usize = 5;
const WORD_COUNT_THRESHOLD: usize = 20;
const LLM_TIMEOUT_SECS: u64 = 5;

/// Perform a proactive RAG search with optional LLM query planner and reranker.
///
/// When the query is non-trivial (> 20 words), a fast LLM call generates 2-3
/// focused search queries. The union of results from all queries is deduplicated
/// by document ID and filtered at score ≥ 0.65. If more than 3 results remain,
/// a reranker LLM call reorders them by relevance. The top 5 are returned.
///
/// On any LLM failure the function falls back gracefully — never propagates
/// errors to the caller.
pub async fn discover_context<S: VectorStore>(
    query: &str,
    rag_store: &RagStore<S>,
    collections: &[&str],
    resolved: &ResolvedModel,
) -> Vec<SearchResult> {
    let word_count = query.split_whitespace().count();
    let use_planner = word_count > WORD_COUNT_THRESHOLD;

    // Step 1: Determine search queries (planner or raw query as fallback).
    let queries = if use_planner {
        plan_queries(query, resolved).await
    } else {
        vec![query.to_string()]
    };

    // Step 2: Search with each query and deduplicate by document ID.
    let mut by_id: HashMap<String, SearchResult> = HashMap::new();
    for q in &queries {
        match rag_store.search(q, collections, MAX_RESULTS * 2).await {
            Ok(results) => {
                for r in results {
                    let existing_score = by_id.get(&r.id).map(|e| e.score).unwrap_or(0.0);
                    if r.score > existing_score {
                        by_id.insert(r.id.clone(), r);
                    }
                }
            }
            Err(e) => eprintln!("[tenex-agent] Context discovery search failed: {e}"),
        }
    }

    // Step 3: Filter at threshold and sort by score descending.
    let mut filtered: Vec<SearchResult> = by_id
        .into_values()
        .filter(|r| r.score >= SCORE_THRESHOLD)
        .collect();
    filtered.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));

    // Step 4: Rerank with LLM if more than 3 results, then take top 5.
    if filtered.len() > 3 {
        filtered = rerank_results(query, filtered, resolved).await;
    }

    filtered.truncate(MAX_RESULTS);
    filtered
}

/// Ask the LLM to produce 2-3 focused search queries as a JSON array.
/// Falls back to `[query]` on any error or timeout.
async fn plan_queries(query: &str, resolved: &ResolvedModel) -> Vec<String> {
    let system = "You generate focused search queries for a vector database. \
        Given a user message, output a JSON array of 2-3 short, specific search queries \
        that would retrieve the most relevant stored knowledge. \
        Return ONLY a JSON array of strings, nothing else. Example: [\"query 1\", \"query 2\"]";
    let user = format!("User message:\n{query}");

    let result = tokio::time::timeout(
        Duration::from_secs(LLM_TIMEOUT_SECS),
        call_llm(resolved, system, user),
    )
    .await;

    match result {
        Ok(Ok(text)) => parse_query_array(&text).unwrap_or_else(|| vec![query.to_string()]),
        Ok(Err(e)) => {
            eprintln!("[tenex-agent] Context discovery planner failed: {e}");
            vec![query.to_string()]
        }
        Err(_) => {
            eprintln!("[tenex-agent] Context discovery planner timed out");
            vec![query.to_string()]
        }
    }
}

/// Ask the LLM to score and reorder results by relevance (0-10).
/// Falls back to original order on any error or timeout.
async fn rerank_results(
    query: &str,
    results: Vec<SearchResult>,
    resolved: &ResolvedModel,
) -> Vec<SearchResult> {
    let system = "You are a relevance judge. Given a user query and retrieved documents, \
        score each document 0-10 for relevance to the query. \
        Return ONLY a JSON array of integers (scores) in the same order as the documents. \
        Example: [8, 3, 9, 5]";

    let docs_text = results
        .iter()
        .enumerate()
        .map(|(i, r)| {
            let snippet: String = r.content.chars().take(200).collect();
            let ellipsis = if r.content.len() > 200 { "…" } else { "" };
            format!("[{}] {}{}", i + 1, snippet, ellipsis)
        })
        .collect::<Vec<_>>()
        .join("\n\n");

    let user = format!("Query: {query}\n\nDocuments:\n{docs_text}");

    let result = tokio::time::timeout(
        Duration::from_secs(LLM_TIMEOUT_SECS),
        call_llm(resolved, system, user),
    )
    .await;

    match result {
        Ok(Ok(text)) => {
            if let Some(scores) = parse_score_array(&text, results.len()) {
                let mut indexed: Vec<(usize, SearchResult, u32)> = results
                    .into_iter()
                    .enumerate()
                    .map(|(i, r)| (i, r, scores[i]))
                    .collect();
                indexed.sort_by(|a, b| b.2.cmp(&a.2));
                indexed.into_iter().map(|(_, r, _)| r).collect()
            } else {
                results
            }
        }
        Ok(Err(e)) => {
            eprintln!("[tenex-agent] Context discovery reranker failed: {e}");
            results
        }
        Err(_) => {
            eprintln!("[tenex-agent] Context discovery reranker timed out");
            results
        }
    }
}

/// Parse a JSON array of strings, stripping markdown fences if present.
fn parse_query_array(text: &str) -> Option<Vec<String>> {
    let cleaned = strip_json_fences(text);
    let value: serde_json::Value = serde_json::from_str(&cleaned).ok()?;
    let arr = value.as_array()?;
    let queries: Vec<String> = arr
        .iter()
        .filter_map(|v| v.as_str().map(|s| s.trim().to_string()))
        .filter(|s| !s.is_empty())
        .collect();
    if queries.is_empty() { None } else { Some(queries) }
}

/// Parse a JSON array of integers, returning None if count doesn't match expected.
fn parse_score_array(text: &str, expected_len: usize) -> Option<Vec<u32>> {
    let cleaned = strip_json_fences(text);
    let value: serde_json::Value = serde_json::from_str(&cleaned).ok()?;
    let arr = value.as_array()?;
    if arr.len() != expected_len {
        return None;
    }
    arr.iter()
        .map(|v| v.as_u64().map(|n| n.min(10) as u32))
        .collect()
}

/// Strip leading/trailing markdown code fences from LLM output.
fn strip_json_fences(text: &str) -> &str {
    let trimmed = text.trim();
    let stripped = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```"))
        .map(|s| s.trim_start());
    if let Some(s) = stripped {
        s.strip_suffix("```").map(|s| s.trim_end()).unwrap_or(s)
    } else {
        trimmed
    }
}

/// Make a single completion call using the agent's resolved model.
async fn call_llm(resolved: &ResolvedModel, system: &str, user: String) -> anyhow::Result<String> {
    use rig::client::Nothing;

    let result = match resolved.provider.as_str() {
        "openrouter" => {
            let key = resolved
                .api_key
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("no OpenRouter API key"))?;
            let agent = openrouter::Client::new(key)?
                .agent(&resolved.model)
                .preamble(system)
                .build();
            agent.prompt(user).await.map_err(|e| anyhow::anyhow!("{e:?}"))?
        }
        "openai" => {
            let key = resolved
                .api_key
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("no OpenAI API key"))?;
            let agent = openai::CompletionsClient::builder()
                .api_key(key)
                .build()?
                .agent(&resolved.model)
                .preamble(system)
                .build();
            agent.prompt(user).await.map_err(|e| anyhow::anyhow!("{e:?}"))?
        }
        "ollama" => {
            let mut builder = ollama::Client::builder().api_key(Nothing);
            if let Some(url) = resolved.base_url.as_deref() {
                builder = builder.base_url(url);
            }
            let agent = builder.build()?.agent(&resolved.model).preamble(system).build();
            agent.prompt(user).await.map_err(|e| anyhow::anyhow!("{e:?}"))?
        }
        _ => {
            let key = resolved
                .api_key
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("no Anthropic API key"))?;
            let agent = anthropic::Client::new(key)?
                .agent(&resolved.model)
                .preamble(system)
                .build();
            agent.prompt(user).await.map_err(|e| anyhow::anyhow!("{e:?}"))?
        }
    };

    Ok(result)
}
