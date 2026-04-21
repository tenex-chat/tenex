# Conversation Indexing

TENEX automatically indexes conversations for semantic search using RAG (Retrieval-Augmented Generation).

## How It Works

- **Automatic Background Indexing**: Runs every 5 minutes when the daemon is active
- **Smart Change Detection**: Only re-indexes conversations when content changes
- **Full Transcript Indexing**: Embeds complete conversation history (not just metadata)
- **Project Isolation**: Properly scopes search results to project boundaries

## CLI Commands

### Check Indexing Status

```bash
tenex doctor conversations status
```

Displays:
- Total indexed conversations
- RAG collection stats
- Indexing job status
- Embedding provider info
- Number of tracked conversations

**Example Output:**
```
Checking conversation indexing status...

RAG Collection:
  Collection: conversation_embeddings
  Total indexed: 42
  Has content: yes
  Embedding provider: OpenAI text-embedding-3-small

Indexing Job:
  Running: yes
  Batch in progress: no
  Interval: 5 minutes

Indexing State:
  Tracked conversations: 42

✓ Conversation indexing is active
```

### Force Full Re-index

```bash
tenex doctor conversations reindex
```

This will:
1. Clear all indexing state
2. Re-index all conversations across all projects
3. Re-embed conversations even if they haven't changed

**With Confirmation Skip:**
```bash
tenex doctor conversations reindex --confirm
```

Use this when:
- You've changed embedding providers
- You've updated the embedding model
- Conversations aren't appearing in search results
- You suspect indexing corruption

## Automatic Indexing

The `ConversationIndexingJob` runs automatically in the background when the daemon is active:

- **Frequency**: Every 5 minutes
- **Detection**: Uses content versioning + metadata hashing
- **Efficiency**: Only indexes new/changed conversations
- **State Tracking**: Durable per-conversation state in catalog

### What Triggers Re-indexing?

A conversation is re-indexed when:
1. **Content version changes** (e.g., v1 → v2 format upgrade)
2. **Metadata changes**: title, summary, lastUserMessage, or lastActivity
3. **Never indexed before**

### What Doesn't Trigger Re-indexing?

- Unchanged conversations (skip redundant work)
- Conversations marked as "no content" (empty conversations)

## Search Tools

Once indexed, conversations are searchable via:

1. **`conversation_search` tool** (agents)
   - Keyword mode (fast title matching)
   - Semantic mode (natural language)
   - Hybrid mode (both)
   - Full-text mode (deep message search)

2. **`rag_search` tool** (agents)
   - Unified search across all RAG collections
   - Includes conversations + lessons + custom collections
   - Optional LLM-based extraction

## Architecture

```
ConversationIndexingJob (5min cron)
  ↓
IndexingStateManager (tracks what needs indexing)
  ↓
ConversationEmbeddingService (builds documents)
  ↓
RAGService (stores in vector DB)
  ↓
Vector Store (SQLite-vec/Qdrant)
```

### Key Files

- `src/conversations/search/embeddings/ConversationIndexingJob.ts` - Background indexer
- `src/conversations/search/embeddings/ConversationEmbeddingService.ts` - Document builder
- `src/conversations/search/embeddings/IndexingStateManager.ts` - State tracker
- `src/tools/implementations/conversation_search.ts` - Search tool
- `src/tools/implementations/rag_search.ts` - Unified RAG search

## Troubleshooting

### No conversations showing in search

1. Check indexing status:
   ```bash
   tenex doctor conversations status
   ```

2. If `Total indexed: 0`, run reindex:
   ```bash
   tenex doctor conversations reindex
   ```

3. Verify daemon is running:
   ```bash
   tenex daemon-status
   ```

### Search results are stale

The indexing job runs every 5 minutes. Recent conversations will be indexed automatically.

To force immediate indexing:
```bash
tenex doctor conversations reindex --confirm
```

### Embedding provider errors

Check your LLM provider configuration:
```bash
tenex config providers
```

Ensure you have:
- Valid API keys
- Correct embedding model configured
- Network connectivity to provider

### Memory issues during indexing

Indexing embeds full conversation transcripts. For large histories:
- Indexing happens sequentially to limit memory usage
- Each batch is 20 conversations (configurable in code)
- Progress is saved incrementally (failures don't lose progress)

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
