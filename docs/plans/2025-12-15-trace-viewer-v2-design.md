# Trace Viewer v2 Design

> Status: Not implemented. The current trace viewer still uses a trace-first tree view under `tools/trace-viewer/`. Treat this as a design proposal.

## Problem

The current trace-viewer shows a flat list of traces from Jaeger. It's hard to:
- See which traces belong to the same conversation
- Understand the full timeline of what happened
- Debug "why did the agent do X?"

## Solution

Redesign the trace-viewer with conversation-first navigation:

1. **Conversations list** - Recent conversations, most recent first
2. **Conversation stream** - Chronological timeline of everything that happened
3. **Item detail** - Expand any item to see full payloads

## Entry Points

### Default: Conversations List

```
TENEX Trace Viewer                           [r]efresh [q]uit
─────────────────────────────────────────────────────────────
Recent Conversations (12)

> 2m ago   "help me with the trace viewer..."           8 msgs
  15m ago  "what's the status of PR #42"                3 msgs
  47m ago  "fix the lint errors in src/..."            23 msgs
  1h ago   "delegate: update documentation"             5 msgs

↑↓ select, Enter view, / jump to event ID, q quit
```

Shows:
- Relative timestamp
- First message preview (truncated)
- Message count

### Jump to Event ID

Press `/`, paste an event ID, jump directly to that conversation's stream positioned at that event.

## Conversation Stream View

Chronological stream of everything that happened:

```
Conversation: "help me with the trace viewer..."        8 msgs
Started 2m ago | Agents: router, claude-code, pm
─────────────────────────────────────────────────────────────
14:32:01  ← received    "help me with the trace viewer..."
14:32:01  → routed      to claude-code
14:32:02  🧠 llm        claude-3-5-sonnet (streaming)
14:32:04  🔧 tool       read_file("tools/trace-viewer/src/App.tsx")
14:32:04  🔧 tool       glob("tools/trace-viewer/**/*.ts")
14:32:05  🧠 llm        claude-3-5-sonnet (streaming)
14:32:08  → delegated   to pm "review the proposed changes"
14:32:12  ← delegate    pm responded (247 tokens)
14:32:13  ✉️  replied    "I've analyzed the trace viewer..."

↑↓ navigate, Enter expand, e expand all, / filter, Esc back
```

### Line Format

`timestamp  icon  action  brief-preview`

### Icons

| Icon | Meaning |
|------|---------|
| `←` | Incoming: user message, delegation response |
| `→` | Outgoing: routing decision, delegation, reply |
| `🧠` | LLM call |
| `🔧` | Tool call |
| `❌` | Error (displayed in red) |

### Stream Item Types

1. **Message received** - User or delegation response arrived
2. **Routing decision** - Agent was selected to handle
3. **LLM call** - Model invocation with model name
4. **Tool call** - Tool name with args preview
5. **Delegation** - Sent work to another agent
6. **Reply** - Agent sent response
7. **Error** - Something failed (highlighted red)

## Item Detail View

Press Enter on any item to expand inline:

```
14:32:04  🔧 tool       read_file("tools/trace-viewer/src/App.tsx")
          ├─ duration: 12ms
          ├─ result: 206 lines read
          └─ content: (press Enter to view full payload)

14:32:05  🧠 llm        claude-3-5-sonnet (streaming)
          ├─ duration: 3.2s
          ├─ tokens: 1,247 in / 523 out
          ├─ prompt: (press Enter to view)
          └─ response: (press Enter to view)
```

For tool calls and LLM interactions, full payloads are available by pressing Enter again on the content line.

## Data Sources

### Jaeger Traces (Primary)

- Span hierarchy and relationships
- Timestamps and durations
- `conversation.id` attribute for grouping
- `conversation.message_sequence` for ordering
- `agent.name`, `agent.slug` for agent identification
- `ai.model.id` for LLM calls
- `ai.toolCall.name`, `ai.toolCall.args` for tool calls

### ~/.tenex/agents/ (Enrichment)

JSON files mapping:
- Agent slugs to pubkey hashes
- Event IDs to agent hashes

Used to display friendly agent names instead of pubkey hashes.

### ~/.tenex/tool-messages/ (Payloads)

JSON files containing:
- `eventId` - Links to conversation events
- `agentPubkey` - Which agent made the call
- `timestamp` - When it happened
- `messages` - Full request/response message history

Used for "view full payload" drill-down.

## Merging Strategy

1. Fetch traces from Jaeger for time range
2. Group traces by `conversation.id`
3. Load agent index from `~/.tenex/agents/` for name resolution
4. On detail view, lookup `~/.tenex/tool-messages/` by event ID for full payloads

## Navigation

```
Conversations List  →  Conversation Stream  →  Item Detail (inline)
     [↑↓ Enter]           [↑↓ Enter]              [Esc back]
```

### Keyboard Shortcuts

**Conversations List:**
- `↑↓` - Navigate list
- `Enter` - View conversation
- `/` - Jump to event ID
- `r` - Refresh
- `q` - Quit

**Conversation Stream:**
- `↑↓` - Navigate items
- `Enter` - Expand/collapse item
- `e` - Expand all
- `c` - Collapse all
- `/` - Filter (future)
- `Esc` - Back to list
- `n/p` - Next/previous conversation

**Item Detail:**
- `Enter` - View full payload (for content fields)
- `Esc` - Collapse back to one-line

## Error Display

Errors appear inline with red text:

```
14:32:06  ❌ error      Tool execution failed: ENOENT
          └─ read_file("/nonexistent/path.ts")
```

No separate error summary - errors are visible in context where they occurred.

## Implementation Notes

### Component Structure

```
src/
  cli.tsx              # Entry point, parse args
  components/
    App.tsx            # Main app, manages view state
    ConversationList.tsx    # Recent conversations view
    ConversationStream.tsx  # Chronological stream view
    StreamItem.tsx          # Individual item + detail expansion
  services/
    JaegerClient.ts    # Existing, needs conversation grouping
    TenexLogReader.ts  # New: read ~/.tenex/ files
    DataMerger.ts      # New: combine Jaeger + local data
  types.ts             # Existing, extend with new types
```

### New Types

```typescript
interface Conversation {
  id: string;
  firstMessage: string;
  timestamp: number;
  messageCount: number;
  agents: string[];  // Agent slugs involved
}

interface StreamItem {
  timestamp: number;
  type: 'received' | 'routed' | 'llm' | 'tool' | 'delegated' | 'delegate_response' | 'replied' | 'error';
  agent: string;
  preview: string;
  details?: StreamItemDetails;
  spanId?: string;
  eventId?: string;  // For linking to tool-messages
}

interface StreamItemDetails {
  duration?: number;
  tokens?: { input: number; output: number };
  model?: string;
  toolName?: string;
  toolArgs?: Record<string, any>;
  toolResult?: string;
  error?: string;
  fullPayloadAvailable?: boolean;
}
```

### Jaeger Query Changes

Current: Fetch traces, show flat list
New: Fetch traces, group by `conversation.id`, aggregate into conversations

```typescript
async getConversations(limit: number): Promise<Conversation[]> {
  const traces = await this.getTraces(service, limit * 10);  // Fetch more to group
  return this.groupByConversation(traces);
}

async getConversationStream(conversationId: string): Promise<StreamItem[]> {
  // Fetch all traces with this conversation.id
  // Flatten spans into chronological stream
  // Sort by timestamp
}
```
