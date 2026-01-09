# Local LLM Streaming via Unix Socket

## Overview

Enable real-time LLM token streaming between backend and TUI when running on the same machine. Uses Unix domain socket for local transport, with design supporting future Nostr ephemeral events transport.

## Problem

Publishing individual Nostr events per token is impractical. When backend and TUI are co-located, we can stream chunks directly via Unix socket for immediate display, while still using Nostr events as the authoritative source for complete messages.

## Chunk Format

Minimal wrapper around raw AI SDK chunks:

```json
{"agent_pubkey": "<hex>", "conversation_id": "<hex>", "data": <raw AI SDK chunk>}
```

- **agent_pubkey**: Hex pubkey of the agent generating the response
- **conversation_id**: Root event ID of the conversation
- **data**: Passthrough of AI SDK chunk (text-delta, reasoning, tool-call, finish, etc.)

NDJSON format - one JSON object per line.

## Backend Architecture

### Files

```
daemon/
└── stream-socket.ts       # Unix socket server lifecycle

llm/
└── stream-publisher.ts    # Hooks into AI SDK stream, writes to socket
```

### Socket Lifecycle

- Socket path: `/tmp/tenex-stream.sock` (or `$XDG_RUNTIME_DIR/tenex-stream.sock`)
- Created at daemon startup
- Cleaned up on shutdown
- Single client connection model

### Stream Publishing

```typescript
interface StreamTransport {
  write(chunk: StreamChunk): void;
  isConnected(): boolean;
}

class UnixSocketTransport implements StreamTransport { ... }
```

Integration point - wherever AI SDK stream is consumed:

```typescript
for await (const chunk of aiStream) {
  // Existing logic...

  streamPublisher.write({
    agent_pubkey: agent.pubkey,
    conversation_id: conversation.id,
    data: chunk
  });
}
```

Fire-and-forget: silently drops if no client connected.

## TUI Architecture

### Files

```
src/streaming/
├── mod.rs
├── socket_client.rs    # Unix socket connection management
├── chunk_buffer.rs     # Per-conversation chunk accumulation
└── types.rs            # StreamChunk type definitions
```

### Chunk Source Trait

```rust
trait ChunkSource {
    async fn next_chunk(&mut self) -> Option<StreamChunk>;
}

struct UnixSocketSource { ... }
```

### Connection Management

- Connect on startup, auto-reconnect on disconnect
- Parse NDJSON lines
- Route chunks to conversations via channel

### Chunk Buffering

- Accumulate text deltas per conversation_id
- Display with "streaming" visual indicator
- Discard buffer when authoritative Nostr event arrives
- Timeout if stream stops without Nostr event

### Rendering Rules

- Streaming text: visual indicator (cursor/styling)
- On Nostr event arrival: finalize display, remove indicator
- Nostr event always wins (source of truth)

## Future: Nostr Ephemeral Events

The transport abstraction supports adding `NostrEphemeralTransport` (backend) and `NostrEphemeralSource` (TUI) without changing core buffering/rendering logic.

## Non-Goals

- Multi-user support
- Multi-client broadcast
- Cross-machine streaming (use Nostr for that)
