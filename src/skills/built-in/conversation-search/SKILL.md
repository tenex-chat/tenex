---
name: conversation-search
description: "Retrieve, list, and search across conversation history with keyword, semantic, hybrid, and full-text modes. Supports conversation tree visualization, time-range filtering, participant filtering, and LLM-powered summarization of individual conversations. Use when reviewing past conversations, searching for specific discussion topics, analyzing agent interactions, or summarizing conversation history."
tools:
  - conversation_get
  - conversation_list
  - conversation_search
---

# Conversation Search

Access and explore TENEX conversation history. Retrieve individual conversations with optional LLM summarization, browse conversation trees with delegation chains, and search across all conversations using multiple search strategies.

## Tools

### `conversation_get`

Retrieves a single conversation by its stored ID, including the full message history as an XML transcript.

- **Parameters:** `conversationId` (required), `untilId` (optional — slice transcript up to a specific message), `prompt` (optional — analyze/summarize via LLM), `includeToolCalls` (optional — include tool-call events in transcript).
- **Use when:** reviewing a specific conversation's contents, summarizing what happened in a conversation, or analyzing agent behavior within a thread.

### `conversation_list`

Lists root conversations for a project as a hierarchical tree, showing delegation chains as nested children sorted by most recent activity.

- **Parameters:** `projectId` (optional — defaults to current project, pass `"ALL"` for all), `limit` (default 50), `fromTime`/`toTime` (Unix timestamp bounds), `with` (filter by agent slug or pubkey).
- **Use when:** browsing recent conversations, finding conversations involving a specific agent, or understanding delegation patterns.

### `conversation_search`

Searches conversations using one of four modes: `keyword` (title substring), `semantic` (embedding similarity), `hybrid` (combined), or `full-text` (message content search).

- **Parameters:** `query` (required), `mode` (default `"keyword"`), `filters` (optional — `agents`, `since`/`after` timestamps), `limit` (default 20), `minScore` (default 0.3 for semantic relevance), `projectId` (optional).
- **Use when:** finding conversations about a specific topic, locating discussions with certain agents, or performing broad content discovery.

## Workflow

1. **Browse recent activity:** Call `conversation_list` to see the latest conversation trees.
2. **Search for topics:** Call `conversation_search` with a query — start with `keyword` mode, switch to `semantic` or `hybrid` for broader discovery.
3. **Inspect a conversation:** Call `conversation_get` with the conversation ID from search results.
4. **Summarize:** Call `conversation_get` with a `prompt` parameter to get an LLM-generated summary of the conversation.
