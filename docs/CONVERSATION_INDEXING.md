# Conversation Indexing

TENEX can index conversations for semantic search using RAG (Retrieval-Augmented Generation).

## Current Status

**The background indexing job is not wired into the daemon.** `ConversationIndexingJob` exists in `src/conversations/search/embeddings/ConversationIndexingJob.ts` but is never started automatically. Conversations are only indexed on-demand via the CLI or when an agent explicitly triggers embedding.

## Search Tools

Agents can search indexed conversations via:

1. **`conversation_search` tool**
   - Keyword mode (fast title matching)
   - Semantic mode (natural language)
   - Hybrid mode (both)
   - Full-text mode (deep message search)

2. **`rag_search` tool**
   - Unified search across all RAG collections
   - Includes conversations + lessons + custom collections
   - Optional LLM-based extraction

These tools return empty or stale results if conversations have not been indexed.

## CLI Commands

### Force Full Re-index

```bash
tenex doctor conversations reindex
```

This will:
1. Clear all indexing state
2. Re-index all conversations across all projects
3. Re-embed conversations even if they haven't changed

```bash
tenex doctor conversations reindex --confirm
```

Use `--confirm` to skip the interactive prompt.

## Configuration

Embedding settings are configured via:
```bash
tenex config embed
```

Supported providers:
- OpenAI (text-embedding-3-small, text-embedding-3-large)
- Anthropic (Voyage AI models)
- OpenRouter (various models)
- Local providers (via MCP)

Vector store configuration is read from the `vectorStore` field in `embed.json`:
- `provider`: `sqlite-vec` (default) or `qdrant`
- `url`: Qdrant server URL (if using Qdrant)

## Key Files

- `src/conversations/search/embeddings/ConversationIndexingJob.ts` — batch indexer (not yet started automatically)
- `src/conversations/search/embeddings/ConversationEmbeddingService.ts` — document builder
- `src/conversations/search/embeddings/IndexingStateManager.ts` — state tracker
- `src/tools/implementations/conversation_search.ts` — search tool
- `src/tools/implementations/rag_search.ts` — unified RAG search
