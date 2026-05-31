---
title: RAG Context Discovery Spans
slug: rag-context-discovery-spans
summary: The `proactive_context_block` function always emits a `rag.context_discovery` span with a caller-owned `outcome` attribute (`no_store | empty_results | returned
tags:
  - capture
volatility: warm
confidence: medium
created: 2026-05-03
updated: 2026-05-03
verified: 2026-05-03
compiled-from: conversation
sources:
  - session:4eda1843-29a0-4cd9-9183-04fa8ef0656b
---

# RAG Context Discovery Spans

## Proactive Context Block Span

The `proactive_context_block` function always emits a `rag.context_discovery` span with a caller-owned `outcome` attribute (`no_store | empty_results | returned`), and pre-populates `score.threshold`, `max_results`, and `collection.count`. [^4eda1-2]


## Discover Context Span

The `discover_context` function records phase counts onto the parent span (`query.word_count`, `planner.used`, `queries.count`, `raw_count`, `deduped_count`, `filtered_count`, `returned_count`, `top_score`, `reranker.used`) and adds three conditional child spans: `rag.plan`, `rag.search`, and `rag.rerank`. [^4eda1-3]

## LLM Child Spans

LLM child spans (`rag.plan`, `rag.rerank`) carry `gen_ai.system`, `gen_ai.request.model`, and `gen_ai.operation.name` per OTel GenAI semconv, and include `fallback.reason = timeout|error|parse_error` on error paths. [^4eda1-4]

## Error and Logging Conventions

Error outputs in context discovery use `tracing::warn!` instead of `eprintln!`, and the two old `tracing::info!` events are dropped in favor of span attributes. [^4eda1-5]
## See Also

