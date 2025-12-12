# LLM Chunk Telemetry

## Overview

TENEX supports detailed telemetry tracking of LLM streaming chunks through OpenTelemetry. This feature enables deep observability into how LLMs generate responses in real-time, allowing you to trace individual chunks through the entire conversation flow.

## Configuration

Add the `telemetry.chunks` section to your `~/.tenex/config.json`:

```json
{
  "telemetry": {
    "chunks": {
      "enabled": true,
      "publishToNostr": false
    }
  }
}
```

### Options

#### `telemetry.chunks.enabled`
- **Type**: `boolean`
- **Default**: `false`
- **Description**: Enable publishing telemetry data for each LLM chunk received during streaming

When enabled, TENEX will create OpenTelemetry spans for each chunk received from the LLM. This provides detailed tracing of:
- Text deltas
- Reasoning deltas
- Tool calls
- Tool results
- Chunk type changes

#### `telemetry.chunks.publishToNostr`
- **Type**: `boolean`
- **Default**: `false`
- **Description**: Publish chunk telemetry as Nostr events

**Note**: This feature is planned for future implementation. Currently, chunk telemetry is only published to OpenTelemetry collectors.

## Hierarchical Tracing Structure

Chunk telemetry is organized hierarchically to enable complete tracing through conversations:

### Level 1: Conversation Root
- **Span Name**: `tenex.event.process`
- **Attributes**:
  - `conversation.id`: The root conversation ID
  - `conversation.is_root`: Boolean indicating if this is the root event
  - `conversation.message_sequence`: Sequential message number

### Level 2: Agent Execution
- **Span Name**: `tenex.agent.execute`
- **Attributes**:
  - `agent.name`: The agent's name
  - `agent.slug`: The agent's slug identifier
  - `conversation.phase`: Current execution phase (e.g., "PLANNING", "EXECUTION")

### Level 3: LLM Stream
- **Span Name**: `ai.streamText.{model}` or `ai.generateText.{model}`
- **Attributes**:
  - `ai.model.id`: The LLM model identifier
  - `llm.provider`: Provider name (e.g., "anthropic", "openai")
  - `llm.temperature`: Temperature setting
  - `llm.max_tokens`: Max tokens setting

### Level 4: Individual Chunks
- **Span Name**: `ai.chunk.{type}`
- **Attributes**:
  - `chunk.type`: Type of chunk (text-delta, reasoning-delta, tool-call, etc.)
  - `chunk.delta`: The actual chunk content
  - `chunk.sequence`: Sequential number within the stream
  - `chunk.timestamp`: Timestamp when chunk was received

## Tracing Across Agent Turns

Chunks are linked across multiple agent turns within a single RAL (Request-Agent Loop) execution through:

1. **Conversation ID**: All spans share the same `conversation.id` attribute
2. **Trace Context Propagation**: W3C trace context is propagated through Nostr events via `trace_context` tags
3. **Parent-Child Relationships**: Each chunk span is a child of its stream span, which is a child of the agent execution span

## Querying Chunk Telemetry

### In Jaeger UI

1. **Find all chunks in a conversation**:
   ```
   conversation.id="<conversation-event-id>"
   ```

2. **Find all chunks of a specific type**:
   ```
   chunk.type="text-delta" conversation.id="<conversation-event-id>"
   ```

3. **Find all tool calls in a conversation**:
   ```
   chunk.type="tool-call" conversation.id="<conversation-event-id>"
   ```

4. **Trace a complete agent execution**:
   ```
   agent.slug="<agent-slug>" conversation.id="<conversation-event-id>"
   ```

### Using the Trace Viewer Tool

TENEX includes a web-based trace viewer tool at `tools/trace-viewer/`:

```bash
cd tools/trace-viewer
npm install
npm run dev
```

This provides a custom UI for visualizing chunk-level telemetry with:
- Timeline view of all chunks in a stream
- Hierarchical tree view of agent executions
- Filtering by chunk type, agent, or conversation
- Real-time updates as new chunks arrive

## Performance Considerations

### When to Enable Chunk Telemetry

**Enable for**:
- Development and debugging
- Performance profiling of LLM responses
- Understanding agent decision-making patterns
- Troubleshooting streaming issues

**Disable for**:
- Production deployments with high message volume
- Privacy-sensitive deployments
- Resource-constrained environments

### Impact

Enabling chunk telemetry has minimal performance impact:
- **CPU**: ~1-2% additional overhead per chunk
- **Memory**: ~100 bytes per chunk span
- **Network**: Depends on OpenTelemetry collector configuration (batched by default)

## Example Use Cases

### 1. Debugging Slow Responses

Enable chunk telemetry to identify where delays occur in LLM streaming:

```json
{
  "telemetry": {
    "chunks": {
      "enabled": true
    }
  }
}
```

Then query Jaeger for spans with long durations:
```
duration > 1s chunk.type="text-delta"
```

### 2. Analyzing Tool Call Patterns

Track which tools are called and in what order:

```
chunk.type="tool-call" | count by ai.toolCall.name
```

### 3. Monitoring Reasoning Quality

Compare the length and frequency of reasoning deltas:

```
chunk.type="reasoning-delta" | stats avg(length(chunk.delta))
```

## OpenTelemetry Setup

Chunk telemetry requires an OpenTelemetry collector. See the [OpenTelemetry documentation](https://opentelemetry.io/docs/collector/) for setup instructions.

TENEX exports traces to:
- **Default URL**: `http://localhost:4318/v1/traces`
- **Override**: Set `OTEL_EXPORTER_OTLP_ENDPOINT` environment variable

### Quick Start with Jaeger

```bash
docker run -d --name jaeger \
  -e COLLECTOR_OTLP_ENABLED=true \
  -p 16686:16686 \
  -p 4318:4318 \
  jaegertracing/all-in-one:latest
```

Then access Jaeger UI at: http://localhost:16686

## Future Enhancements

- **Nostr Publishing**: Publish chunk telemetry as Nostr events for decentralized tracing
- **Chunk Aggregation**: Automatic aggregation of chunk statistics per stream
- **Real-time Dashboards**: Pre-built Grafana dashboards for chunk metrics
- **Anomaly Detection**: AI-powered detection of unusual chunk patterns
