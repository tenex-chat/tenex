# MCP Tool Specifications: Nostr Marketing & Engagement

This document specifies a set of tools to be implemented in the Nostr MCP Server. These tools will provide a marketing agent with the necessary capabilities to engage with the developer community on the Nostr protocol.

## Tool 1: `nostr_conversation_tracker`

### Description

This tool searches for and retrieves conversational threads on Nostr based on specified criteria. It is designed to help an agent monitor discussions, identify community sentiment, and find opportunities for engagement. The tool should be capable of fetching not just root-level notes but also the replies that form a conversation thread.

### Tool Definition

- **Name:** `nostr_conversation_tracker`
- **MCP Namespace:** `nostr` (e.g., `mcp__nostr__nostr_conversation_tracker`)

### Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `query` | `string` | Yes | The search query, including keywords or hashtags (e.g., `"tenex"`, `"#nostrdev"`). |
| `limit` | `number` | No | The maximum number of root-level conversation threads to return. Defaults to 20. |
| `since` | `number` | No | A Unix timestamp to retrieve events published after this time. Useful for continuous monitoring. |
| `until` | `number` | No | A Unix timestamp to retrieve events published before this time. |
| `thread_depth`| `number` | No | The depth of replies to fetch for each thread. `0` = root note only, `1` = root + direct replies, etc. Defaults to 2. |

### Return Value

A JSON object containing an array of `NostrThread` objects.

**`NostrThread` Object Structure:**

```json
{
  "threads": [
    {
      "root_event": {
        "id": "...",
        "pubkey": "...",
        "created_at": 1678886400,
        "kind": 1,
        "tags": [["t", "nostrdev"]],
        "content": "What's the best way to build AI agents on Nostr?",
        "sig": "..."
      },
      "replies": [
        {
          "id": "...",
          "pubkey": "...",
          "created_at": 1678886500,
          "kind": 1,
          "tags": [["e", "root_event_id"], ["p", "root_event_pubkey"]],
          "content": "You should check out TENEX!",
          "sig": "..."
        }
      ]
    }
  ]
}
```

## Tool 2: `nostr_content_publisher`

### Description

This tool publishes long-form content to the Nostr network using the `kind:30023` standard for articles. This allows the agent to create rich, well-formatted content like blog posts, tutorials, and announcements that are native to the Nostr ecosystem.

### Tool Definition

- **Name:** `nostr_content_publisher`
- **MCP Namespace:** `nostr` (e.g., `mcp__nostr__nostr_content_publisher`)

### Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `title` | `string` | Yes | The title of the article. Will be used in the `title` tag. |
| `content` | `string` | Yes | The full body of the article in Markdown format. |
| `summary` | `string` | No | A short summary of the article. Will be used in the `summary` tag. |
| `image` | `string` | No | A URL to a header or thumbnail image. Will be used in the `image` tag. |
| `tags` | `Array<Array<string>>` | No | A list of additional tags, e.g., `[["t", "ai"], ["t", "devrel"]]`. |
| `published_at`| `number` | No | A Unix timestamp for the publication date. Will be used in the `published_at` tag. Defaults to the current time. |

### Return Value

A JSON object containing the identifiers of the published event.

**Return Object Structure:**

```json
{
  "eventId": "...",
  "noteId": "note1..."
}
```

This ensures the calling agent can reference the newly created article immediately.
