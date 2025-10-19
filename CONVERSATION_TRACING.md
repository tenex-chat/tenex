# Conversation-Level Tracing

This document explains how TENEX implements conversation-level tracing using shared attributes for unified timeline visualization in Jaeger.

## Overview

Previously, each message in a conversation created an isolated trace, making it difficult to view the chronological flow of an entire conversation. Now, all messages in a conversation are tagged with a shared `conversation.id` attribute, allowing you to query Jaeger for all traces belonging to the same conversation.

## Architecture

### ConversationSpanManager

Location: `src/telemetry/ConversationSpanManager.ts`

A singleton service that tracks conversation metadata and adds shared attributes to all spans:

```typescript
const conversationSpanManager = getConversationSpanManager();
conversationSpanManager.incrementMessageCount(conversationId, span);
```

**Key Features:**

1. **Automatic Conversation Detection**:
   - For replies: Uses E or A tags to find conversation root
   - For root messages: Uses the event's own ID as conversation ID
   - This ensures all messages (including the first one) get the same conversation.id

2. **Attribute-Based Grouping**: Instead of long-lived parent spans, uses shared attributes:
   - `conversation.id`: The conversation root event ID (same for all messages)
   - `conversation.message_sequence`: Sequential number (1, 2, 3...) for each message
   - `conversation.is_root`: Boolean indicating if this is the first message

3. **Immediate Visibility**: Spans are exported to Jaeger as soon as they complete (no waiting for conversation to end)

4. **Easy Querying**: Search Jaeger for `conversation.id=<id>` to see all messages in chronological order

### Integration Points

**Daemon Event Processing** (`src/daemon/Daemon.ts:handleIncomingEvent`):

```typescript
// Determine conversation ID
let conversationId = AgentEventDecoder.getConversationRoot(event);
if (!conversationId && event.id) {
  conversationId = event.id;
}

// Create span with conversation attributes
const span = tracer.startSpan("tenex.event.process", {
  attributes: {
    "conversation.id": conversationId,
    "conversation.is_root": !AgentEventDecoder.getConversationRoot(event),
    // ... other attributes
  }
});

// Track message sequence
conversationSpanManager.incrementMessageCount(conversationId, span);
```

## Trace Organization

Instead of a hierarchical structure, all traces are independent but share the same `conversation.id`:

```
Trace 1: tenex.event.process (message 1)
  Attributes: conversation.id=abc123, conversation.message_sequence=1
  ├── tenex.agent.execute
  └── tenex.llm.generate

Trace 2: tenex.event.process (message 2)
  Attributes: conversation.id=abc123, conversation.message_sequence=2
  ├── tenex.agent.execute
  └── tenex.llm.generate

Trace 3: tenex.event.process (message 3)
  Attributes: conversation.id=abc123, conversation.message_sequence=3
  ├── tenex.agent.execute
  └── tenex.llm.generate
```

Query Jaeger for `conversation.id=abc123` to see all three traces in one view.

## Attributes

All event processing spans now include:

- `conversation.id`: The conversation root event ID (shared by all messages in conversation)
- `conversation.message_sequence`: Sequential message number (1, 2, 3...)
- `conversation.is_root`: Boolean - `true` if this is the first message, `false` for replies
- `event.id`, `event.kind`, `event.pubkey`, etc.: Standard event attributes

## Lifecycle Management

### Creation
When the first message in a conversation is processed:
1. No E/A tag found → uses event.id as conversation.id
2. Span created with `conversation.is_root=true` and `conversation.message_sequence=1`

### Updates
Each subsequent message in the conversation:
1. Has E tag pointing to root → uses E tag value as conversation.id
2. Span created with `conversation.is_root=false` and incremented sequence number
3. All spans exported immediately after completion

### No Finalization Needed
Since we're not using long-lived parent spans, there's no finalization step. Each span exports independently as soon as it completes.

## Viewing Conversations in Jaeger

### Before (Isolated Traces)
- Each message appeared as a separate trace
- No way to see conversation chronology
- Had to manually correlate messages by conversation ID

### After (Attribute-Based Grouping)
1. Open Jaeger UI: http://localhost:16686
2. Search for service: `tenex-daemon`
3. Click "Tags" and add filter: `conversation.id=<your_conversation_id>`
4. All traces for that conversation appear in chronological order
5. Click on each trace to see detailed processing spans

## Example Queries

To find all traces in a specific conversation:
```
Service: tenex-daemon
Tags: conversation.id=6eb683015959e4c313480d52e7aceb6fecdc4d2c8c1841000bd3324796ff0051
```

To find only root messages (first message in conversations):
```
Service: tenex-daemon
Tags: conversation.is_root=true
```

To find all messages in a conversation sorted by sequence:
```
Service: tenex-daemon
Tags: conversation.id=<your_id>
Sort by: conversation.message_sequence (ascending)
```

## Configuration

### Cleanup Intervals

Modify these constants in `ConversationSpanManager.ts`:

```typescript
private readonly MAX_CONVERSATION_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
private readonly CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
```

### Disable Conversation Tracing

To disable conversation-level spans, simply remove the conversation span parent assignment in `Daemon.ts`:

```typescript
// Comment out these lines:
// const conversationSpanManager = getConversationSpanManager();
// const conversationSpan = conversationSpanManager.getOrCreateConversationSpan(event);
// if (conversationSpan) {
//   parentContext = trace.setSpan(parentContext, conversationSpan);
// }
```

## Testing

To test conversation-level tracing:

1. Start Jaeger:
   ```bash
   docker run -d --name jaeger \
     -p 16686:16686 \
     -p 4318:4318 \
     jaegertracing/all-in-one:latest
   ```

2. Start TENEX daemon:
   ```bash
   bun run ./src/tenex.ts daemon
   ```

3. Send messages to start a conversation:
   - **First message**: Send a message to an agent (this becomes the conversation root)
   - **Agent reply**: The agent responds (will have E tag pointing to your message)
   - **Follow-up**: Send another message in the same thread

4. Open Jaeger UI (http://localhost:16686) and search for:
   - Service: `tenex-daemon`
   - Operation: `tenex.conversation`

5. Verify all messages in the conversation appear nested under the same parent span

**Important**: The conversation span is created when the FIRST message is processed. All subsequent messages with E tags pointing to that root will be nested under the same span.

## Benefits

1. **Unified Timeline**: See entire conversation flow in one trace view
2. **Message Chronology**: Clear ordering of messages by timestamp
3. **Performance Analysis**: Identify bottlenecks across entire conversation
4. **Debugging**: Easier to trace issues through multi-message interactions
5. **Memory Efficient**: Automatic cleanup prevents unbounded span accumulation

## Memory Management

The ConversationSpanManager maintains in-memory state for active conversations:
- Average memory per conversation: ~1-2 KB (span object + metadata)
- With 1000 active conversations: ~1-2 MB
- Automatic cleanup ensures memory doesn't grow unbounded
- Spans are properly exported before finalization (no data loss)

## Troubleshooting

### Conversation spans not appearing in Jaeger

1. Check that events have conversation root tags (E or A tags)
2. Verify OTEL exporter is configured: `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/v1/traces`
3. Check daemon logs for "Created new conversation span" messages
4. Ensure Jaeger is running and accessible

### Messages not nested under conversation span

1. Check `conversation.has_parent_span` attribute on message spans
2. Verify `AgentEventDecoder.getConversationRoot(event)` returns valid ID
3. Check for errors in ConversationSpanManager logs

### Stale conversation spans not cleaned up

1. Verify cleanup interval is running (check logs for "Cleaned up stale conversations")
2. Check `MAX_CONVERSATION_AGE_MS` configuration
3. Ensure daemon is not being restarted frequently (cleanup runs hourly)

## Future Enhancements

Potential improvements for conversation tracing:

1. **Conversation Metadata**: Add participant count, agent involvement, etc.
2. **Session Grouping**: Group related conversations by session/day
3. **Custom Attributes**: Allow projects to add custom conversation tags
4. **Metrics**: Export conversation duration, message rate, etc. to monitoring
5. **Visualization**: Custom UI for conversation timeline analysis
