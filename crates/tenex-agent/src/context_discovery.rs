use crate::config::ResolvedModel;
use crate::llm_accounting::{assistant_text, usage_from_rig};
use rig_core::client::CompletionClient;
use rig_core::completion::{Completion, Message};
use rig_core::providers::{anthropic, ollama, openai, openrouter};
use std::cmp::Reverse;
use std::collections::HashMap;
use std::time::Duration;
use tenex_accounting::{record_llm_call, RecordLlmCall, RootKind};
use tenex_rag::store::VectorStore;
use tenex_rag::{RagStore, SearchResult};
use tracing::{info_span, warn, Instrument, Span};

const SCORE_THRESHOLD: f32 = 0.65;
const MAX_RESULTS: usize = 5;
const WORD_COUNT_THRESHOLD: usize = 20;
const LLM_TIMEOUT_SECS: u64 = 5;

/// Identifying context attached to every LLM accounting record produced
/// during a context-discovery pass.
#[derive(Debug, Clone)]
pub struct DiscoveryAccountingCtx {
    pub agent_pubkey: String,
    pub project_id: String,
    pub conversation_id: Option<String>,
}

/// Perform a proactive RAG search with optional LLM query planner and reranker.
///
/// When the query is non-trivial (> 20 words), a fast LLM call generates 2-3
/// focused search queries. The union of results from all queries is deduplicated
/// by document ID and filtered at score ≥ 0.65. If more than 3 results remain,
/// a reranker LLM call reorders them by relevance. The top 5 are returned.
///
/// On any LLM failure the function falls back gracefully — never propagates
/// errors to the caller.
///
/// Telemetry: records phase counts and model attrs onto the **current** span
/// (the caller is expected to enter a `rag.context_discovery` span before
/// calling). Emits child spans `rag.plan`, `rag.search`, `rag.rerank` per
/// phase. The `outcome` attr is the caller's responsibility because the
/// `no_store` outcome is decided before this function is invoked.
pub async fn discover_context<S: VectorStore>(
    query: &str,
    rag_store: &RagStore<S>,
    collections: &[&str],
    resolved: &ResolvedModel,
    accounting: &DiscoveryAccountingCtx,
) -> Vec<SearchResult> {
    let parent = Span::current();
    let word_count = query.split_whitespace().count();
    let use_planner = word_count > WORD_COUNT_THRESHOLD;
    parent.record("query.word_count", word_count as i64);
    parent.record("planner.used", use_planner);

    // Step 1: Determine search queries (planner or raw query as fallback).
    let queries = if use_planner {
        plan_queries(query, resolved, accounting).await
    } else {
        vec![query.to_string()]
    };
    parent.record("queries.count", queries.len() as i64);
    parent.record(
        "queries.list",
        serde_json::to_string(&queries).unwrap_or_default().as_str(),
    );

    // Step 2: Search with each query and deduplicate by document ID.
    let mut by_id: HashMap<String, SearchResult> = HashMap::new();
    let mut raw_count: usize = 0;
    let search_span = info_span!(
        "rag.search",
        queries.count = queries.len() as i64,
        queries.list = serde_json::to_string(&queries).unwrap_or_default().as_str(),
        results.raw = tracing::field::Empty,
        results.deduped = tracing::field::Empty,
        results.ids = tracing::field::Empty,
    );
    async {
        for q in &queries {
            match rag_store.search(q, collections, MAX_RESULTS * 2).await {
                Ok(results) => {
                    raw_count += results.len();
                    for r in results {
                        let existing_score = by_id.get(&r.id).map(|e| e.score).unwrap_or(0.0);
                        if r.score > existing_score {
                            by_id.insert(r.id.clone(), r);
                        }
                    }
                }
                Err(e) => {
                    warn!(
                        error = %e,
                        "rag.search query failed",
                    );
                }
            }
        }
        let s = Span::current();
        s.record("results.raw", raw_count as i64);
        s.record("results.deduped", by_id.len() as i64);
        let ids: Vec<&str> = by_id.keys().map(|k| k.as_str()).collect();
        s.record(
            "results.ids",
            serde_json::to_string(&ids).unwrap_or_default().as_str(),
        );
    }
    .instrument(search_span)
    .await;

    parent.record("raw_count", raw_count as i64);
    parent.record("deduped_count", by_id.len() as i64);

    // Step 3: Filter at threshold and sort by score descending.
    let mut filtered: Vec<SearchResult> = by_id
        .into_values()
        .filter(|r| r.score >= SCORE_THRESHOLD)
        .collect();
    filtered.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    parent.record("filtered_count", filtered.len() as i64);

    // Step 4: Rerank with LLM if more than 3 results, then take top 5.
    let reranker_used = filtered.len() > 3;
    parent.record("reranker.used", reranker_used);
    if reranker_used {
        filtered = rerank_results(query, filtered, resolved, accounting).await;
    }

    filtered.truncate(MAX_RESULTS);

    parent.record("returned_count", filtered.len() as i64);
    if let Some(top) = filtered.first().map(|r| r.score) {
        parent.record("top_score", top as f64);
    }
    let result_summaries: Vec<serde_json::Value> = filtered
        .iter()
        .map(|r| {
            serde_json::json!({
                "id": r.id,
                "score": r.score,
                "collection": r.collection,
                "title": r.title,
            })
        })
        .collect();
    parent.record(
        "results",
        serde_json::to_string(&result_summaries)
            .unwrap_or_default()
            .as_str(),
    );

    filtered
}

/// Ask the LLM to produce 2-3 focused search queries as a JSON array.
/// Falls back to `[query]` on any error or timeout.
async fn plan_queries(
    query: &str,
    resolved: &ResolvedModel,
    accounting: &DiscoveryAccountingCtx,
) -> Vec<String> {
    let system = "You generate focused search queries for a vector database. \
        Given a user message, output a JSON array of 2-3 short, specific search queries \
        that would retrieve the most relevant stored knowledge. \
        Return ONLY a JSON array of strings, nothing else. Example: [\"query 1\", \"query 2\"]";
    let user = format!("User message:\n{query}");

    // GenAI semconv attributes (`gen_ai.*`) on phase span — keeps domain name
    // (`rag.plan`) for trace readability while remaining queryable like every
    // other LLM call in the system.
    let plan_span = info_span!(
        "rag.plan",
        gen_ai.system = resolved.provider.as_str(),
        gen_ai.request.model = resolved.model.as_str(),
        gen_ai.operation.name = "chat",
        timeout.secs = LLM_TIMEOUT_SECS as i64,
        queries.generated = tracing::field::Empty,
        fallback.reason = tracing::field::Empty,
    );
    async {
        let result = tokio::time::timeout(
            Duration::from_secs(LLM_TIMEOUT_SECS),
            call_llm(resolved, system, user, "context_discovery.plan", accounting),
        )
        .await;

        match result {
            Ok(Ok(text)) => match parse_query_array(&text) {
                Some(qs) => {
                    Span::current().record(
                        "queries.generated",
                        serde_json::to_string(&qs).unwrap_or_default().as_str(),
                    );
                    qs
                }
                None => {
                    Span::current().record("fallback.reason", "parse_error");
                    warn!(text = %text, "rag.plan: failed to parse query array");
                    vec![query.to_string()]
                }
            },
            Ok(Err(e)) => {
                Span::current().record("fallback.reason", "error");
                warn!(error = %e, "rag.plan: LLM call failed");
                vec![query.to_string()]
            }
            Err(_) => {
                Span::current().record("fallback.reason", "timeout");
                warn!(
                    timeout_secs = LLM_TIMEOUT_SECS,
                    "rag.plan: LLM call timed out"
                );
                vec![query.to_string()]
            }
        }
    }
    .instrument(plan_span)
    .await
}

/// Ask the LLM to score and reorder results by relevance (0-10).
/// Falls back to original order on any error or timeout.
async fn rerank_results(
    query: &str,
    results: Vec<SearchResult>,
    resolved: &ResolvedModel,
    accounting: &DiscoveryAccountingCtx,
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

    let rerank_span = info_span!(
        "rag.rerank",
        gen_ai.system = resolved.provider.as_str(),
        gen_ai.request.model = resolved.model.as_str(),
        gen_ai.operation.name = "chat",
        timeout.secs = LLM_TIMEOUT_SECS as i64,
        documents.count = results.len() as i64,
        fallback.reason = tracing::field::Empty,
    );
    async {
        let result = tokio::time::timeout(
            Duration::from_secs(LLM_TIMEOUT_SECS),
            call_llm(
                resolved,
                system,
                user,
                "context_discovery.rerank",
                accounting,
            ),
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
                    indexed.sort_by_key(|(_, _, score)| Reverse(*score));
                    indexed.into_iter().map(|(_, r, _)| r).collect()
                } else {
                    Span::current().record("fallback.reason", "parse_error");
                    warn!(text = %text, "rag.rerank: failed to parse score array");
                    results
                }
            }
            Ok(Err(e)) => {
                Span::current().record("fallback.reason", "error");
                warn!(error = %e, "rag.rerank: LLM call failed");
                results
            }
            Err(_) => {
                Span::current().record("fallback.reason", "timeout");
                warn!(
                    timeout_secs = LLM_TIMEOUT_SECS,
                    "rag.rerank: LLM call timed out"
                );
                results
            }
        }
    }
    .instrument(rerank_span)
    .await
}

/// Parse a JSON array of strings, stripping markdown fences if present.
fn parse_query_array(text: &str) -> Option<Vec<String>> {
    let cleaned = strip_json_fences(text);
    let value: serde_json::Value = serde_json::from_str(cleaned).ok()?;
    let arr = value.as_array()?;
    let queries: Vec<String> = arr
        .iter()
        .filter_map(|v| v.as_str().map(|s| s.trim().to_string()))
        .filter(|s| !s.is_empty())
        .collect();
    if queries.is_empty() {
        None
    } else {
        Some(queries)
    }
}

/// Parse a JSON array of integers, returning None if count doesn't match expected.
fn parse_score_array(text: &str, expected_len: usize) -> Option<Vec<u32>> {
    let cleaned = strip_json_fences(text);
    let value: serde_json::Value = serde_json::from_str(cleaned).ok()?;
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

/// Make a single completion call using the agent's resolved model and
/// record it via `tenex-accounting`.
async fn call_llm(
    resolved: &ResolvedModel,
    system: &str,
    user: String,
    operation: &str,
    accounting: &DiscoveryAccountingCtx,
) -> anyhow::Result<String> {
    use rig_core::client::Nothing;

    let history: Vec<Message> = Vec::new();

    let (text, usage) = crate::llm_retry::with_key_retry(resolved, |key| {
        let system = system.to_string();
        let user = user.clone();
        let history = history.clone();
        let provider = resolved.provider.clone();
        let model = resolved.model.clone();
        let base_url = resolved.base_url.clone();
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
        root_kind: RootKind::RagQuery.into(),
        provider: resolved.provider.clone(),
        provider_model_id: resolved.model.clone(),
        operation: operation.into(),
        agent_pubkey: Some(accounting.agent_pubkey.clone()),
        project_id: Some(accounting.project_id.clone()),
        conversation_id: accounting.conversation_id.clone(),
        user_message: Some(user),
        assistant_response: Some(text.clone()),
        usage: usage_from_rig(&usage),
        ..Default::default()
    })
    .await;

    Ok(text)
}
