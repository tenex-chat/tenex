# Local Streaming Backend Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Unix socket server to stream raw AI SDK chunks to local TUI clients.

**Architecture:** Socket server starts with daemon, LLMService writes chunks through StreamPublisher during generation. Fire-and-forget pattern - drops chunks if no client connected.

**Tech Stack:** Node.js `net` module for Unix sockets, NDJSON format, integrates with existing AI SDK streaming.

---

## Task 1: Create StreamChunk Type

**Files:**
- Modify: `src/llm/types.ts`

**Step 1: Add StreamChunk interface**

Add to `src/llm/types.ts`:

```typescript
/**
 * Chunk sent over local streaming socket
 */
export interface LocalStreamChunk {
    /** Hex pubkey of the agent generating this response */
    agent_pubkey: string;
    /** Root event ID of the conversation (hex) */
    conversation_id: string;
    /** Raw AI SDK chunk - passthrough without transformation */
    data: unknown;
}
```

**Step 2: Commit**

```bash
git add src/llm/types.ts
git commit -m "feat(llm): add LocalStreamChunk type for socket streaming"
```

---

## Task 2: Create StreamPublisher

**Files:**
- Create: `src/llm/StreamPublisher.ts`

**Step 1: Create StreamPublisher class**

Create `src/llm/StreamPublisher.ts`:

```typescript
import type { LocalStreamChunk } from "./types";

/**
 * Interface for stream transports (Unix socket, future Nostr ephemeral)
 */
export interface StreamTransport {
    write(chunk: LocalStreamChunk): void;
    isConnected(): boolean;
}

/**
 * Publishes AI SDK chunks to connected transports
 * Fire-and-forget: silently drops if no transport connected
 */
export class StreamPublisher {
    private transport: StreamTransport | null = null;

    setTransport(transport: StreamTransport | null): void {
        this.transport = transport;
    }

    write(chunk: LocalStreamChunk): void {
        if (this.transport?.isConnected()) {
            this.transport.write(chunk);
        }
    }

    isConnected(): boolean {
        return this.transport?.isConnected() ?? false;
    }
}

/** Singleton instance */
export const streamPublisher = new StreamPublisher();
```

**Step 2: Export from llm/index.ts**

Add to `src/llm/index.ts`:

```typescript
export { StreamPublisher, streamPublisher, type StreamTransport } from "./StreamPublisher";
export type { LocalStreamChunk } from "./types";
```

**Step 3: Commit**

```bash
git add src/llm/StreamPublisher.ts src/llm/index.ts src/llm/types.ts
git commit -m "feat(llm): add StreamPublisher for local streaming"
```

---

## Task 3: Create UnixSocketTransport

**Files:**
- Create: `src/daemon/UnixSocketTransport.ts`

**Step 1: Create UnixSocketTransport**

Create `src/daemon/UnixSocketTransport.ts`:

```typescript
import * as net from "net";
import * as fs from "fs";
import * as path from "path";
import type { StreamTransport } from "@/llm";
import type { LocalStreamChunk } from "@/llm";
import { createLogger } from "@/utils/logger";

const logger = createLogger("UnixSocketTransport");

/**
 * Unix domain socket transport for local streaming
 * Single client connection model
 */
export class UnixSocketTransport implements StreamTransport {
    private server: net.Server | null = null;
    private client: net.Socket | null = null;
    private socketPath: string;

    constructor(socketPath?: string) {
        this.socketPath = socketPath ?? this.defaultSocketPath();
    }

    private defaultSocketPath(): string {
        const runtimeDir = process.env.XDG_RUNTIME_DIR;
        if (runtimeDir) {
            return path.join(runtimeDir, "tenex-stream.sock");
        }
        return "/tmp/tenex-stream.sock";
    }

    async start(): Promise<void> {
        // Clean up stale socket
        this.cleanup();

        return new Promise((resolve, reject) => {
            this.server = net.createServer((socket) => {
                logger.info("Client connected to streaming socket");

                // Only one client at a time
                if (this.client) {
                    logger.warn("Replacing existing client connection");
                    this.client.destroy();
                }

                this.client = socket;

                socket.on("close", () => {
                    logger.info("Client disconnected from streaming socket");
                    if (this.client === socket) {
                        this.client = null;
                    }
                });

                socket.on("error", (err) => {
                    logger.error("Socket client error", { error: err.message });
                    if (this.client === socket) {
                        this.client = null;
                    }
                });
            });

            this.server.on("error", (err) => {
                logger.error("Socket server error", { error: err.message });
                reject(err);
            });

            this.server.listen(this.socketPath, () => {
                logger.info("Streaming socket started", { path: this.socketPath });
                resolve();
            });
        });
    }

    write(chunk: LocalStreamChunk): void {
        if (!this.client) return;

        try {
            const line = JSON.stringify(chunk) + "\n";
            this.client.write(line);
        } catch (err) {
            logger.error("Failed to write chunk", { error: err });
        }
    }

    isConnected(): boolean {
        return this.client !== null && !this.client.destroyed;
    }

    async stop(): Promise<void> {
        if (this.client) {
            this.client.destroy();
            this.client = null;
        }

        return new Promise((resolve) => {
            if (this.server) {
                this.server.close(() => {
                    this.cleanup();
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }

    private cleanup(): void {
        try {
            if (fs.existsSync(this.socketPath)) {
                fs.unlinkSync(this.socketPath);
            }
        } catch {
            // Ignore cleanup errors
        }
    }

    getSocketPath(): string {
        return this.socketPath;
    }
}
```

**Step 2: Commit**

```bash
git add src/daemon/UnixSocketTransport.ts
git commit -m "feat(daemon): add UnixSocketTransport for local streaming"
```

---

## Task 4: Integrate Socket with Daemon

**Files:**
- Modify: `src/daemon/Daemon.ts`

**Step 1: Add imports to Daemon.ts**

Add near top of `src/daemon/Daemon.ts`:

```typescript
import { UnixSocketTransport } from "./UnixSocketTransport";
import { streamPublisher } from "@/llm";
```

**Step 2: Add transport property**

Add to Daemon class properties (around line 30):

```typescript
private streamTransport: UnixSocketTransport | null = null;
```

**Step 3: Start transport in start() method**

In `start()` method, after NDK initialization (around line 100), add:

```typescript
// 6. Start local streaming socket
this.streamTransport = new UnixSocketTransport();
await this.streamTransport.start();
streamPublisher.setTransport(this.streamTransport);
logger.info("Local streaming socket started", { path: this.streamTransport.getSocketPath() });
```

**Step 4: Stop transport in stop() method**

In `stop()` method (find it around line 140), add before other cleanup:

```typescript
// Stop streaming socket
if (this.streamTransport) {
    await this.streamTransport.stop();
    streamPublisher.setTransport(null);
    this.streamTransport = null;
}
```

**Step 5: Commit**

```bash
git add src/daemon/Daemon.ts
git commit -m "feat(daemon): integrate streaming socket lifecycle"
```

---

## Task 5: Hook StreamPublisher into LLMService

**Files:**
- Modify: `src/llm/service.ts`

**Step 1: Add import**

Add near top of `src/llm/service.ts`:

```typescript
import { streamPublisher } from "./StreamPublisher";
import type { LocalStreamChunk } from "./types";
```

**Step 2: Add streaming context to LLMService**

Add properties to LLMService class (around line 110):

```typescript
private streamingAgentPubkey: string | null = null;
private streamingConversationId: string | null = null;
```

**Step 3: Add method to set streaming context**

Add method to LLMService class:

```typescript
/**
 * Set context for local streaming (call before stream())
 */
setStreamingContext(agentPubkey: string, conversationId: string): void {
    this.streamingAgentPubkey = agentPubkey;
    this.streamingConversationId = conversationId;
}

/**
 * Clear streaming context (call after stream completes)
 */
clearStreamingContext(): void {
    this.streamingAgentPubkey = null;
    this.streamingConversationId = null;
}
```

**Step 4: Publish chunks in handleChunk method**

In `handleChunk()` method (around line 536), add at the beginning after chunk validation:

```typescript
// Publish to local streaming socket
if (this.streamingAgentPubkey && this.streamingConversationId) {
    const localChunk: LocalStreamChunk = {
        agent_pubkey: this.streamingAgentPubkey,
        conversation_id: this.streamingConversationId,
        data: event.chunk,
    };
    streamPublisher.write(localChunk);
}
```

**Step 5: Commit**

```bash
git add src/llm/service.ts
git commit -m "feat(llm): publish chunks to local streaming socket"
```

---

## Task 6: Set Streaming Context from Agent Layer

**Files:**
- Find and modify the agent execution code that calls LLMService

**Step 1: Find the integration point**

Search for where `llmService.stream()` is called and add context setting:

```typescript
// Before calling stream()
llmService.setStreamingContext(agent.pubkey, conversationId);

try {
    const result = await llmService.stream(/* ... */);
    return result;
} finally {
    llmService.clearStreamingContext();
}
```

**Step 2: Commit**

```bash
git add <modified-file>
git commit -m "feat(agents): set streaming context before LLM generation"
```

---

## Task 7: Export from daemon/index.ts

**Files:**
- Modify: `src/daemon/index.ts`

**Step 1: Add export**

Add to `src/daemon/index.ts`:

```typescript
export { UnixSocketTransport } from "./UnixSocketTransport";
```

**Step 2: Commit**

```bash
git add src/daemon/index.ts
git commit -m "feat(daemon): export UnixSocketTransport"
```

---

## Task 8: Add Basic Test

**Files:**
- Create: `src/daemon/__tests__/UnixSocketTransport.test.ts`

**Step 1: Create test file**

Create `src/daemon/__tests__/UnixSocketTransport.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as net from "net";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { UnixSocketTransport } from "../UnixSocketTransport";

describe("UnixSocketTransport", () => {
    let transport: UnixSocketTransport;
    let testSocketPath: string;

    beforeEach(() => {
        testSocketPath = path.join(os.tmpdir(), `test-stream-${Date.now()}.sock`);
        transport = new UnixSocketTransport(testSocketPath);
    });

    afterEach(async () => {
        await transport.stop();
        if (fs.existsSync(testSocketPath)) {
            fs.unlinkSync(testSocketPath);
        }
    });

    test("starts and accepts connections", async () => {
        await transport.start();
        expect(fs.existsSync(testSocketPath)).toBe(true);

        const client = net.createConnection(testSocketPath);
        await new Promise<void>((resolve) => client.on("connect", resolve));

        expect(transport.isConnected()).toBe(true);
        client.destroy();
    });

    test("writes NDJSON chunks to client", async () => {
        await transport.start();

        const client = net.createConnection(testSocketPath);
        await new Promise<void>((resolve) => client.on("connect", resolve));

        const received: string[] = [];
        client.on("data", (data) => {
            received.push(data.toString());
        });

        transport.write({
            agent_pubkey: "abc123",
            conversation_id: "def456",
            data: { type: "text-delta", textDelta: "Hello" },
        });

        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(received.length).toBe(1);
        const parsed = JSON.parse(received[0].trim());
        expect(parsed.agent_pubkey).toBe("abc123");
        expect(parsed.data.textDelta).toBe("Hello");

        client.destroy();
    });

    test("silently drops writes when no client", async () => {
        await transport.start();
        expect(transport.isConnected()).toBe(false);

        // Should not throw
        transport.write({
            agent_pubkey: "abc",
            conversation_id: "def",
            data: {},
        });
    });
});
```

**Step 2: Run tests**

```bash
bun test src/daemon/__tests__/UnixSocketTransport.test.ts
```

**Step 3: Commit**

```bash
git add src/daemon/__tests__/UnixSocketTransport.test.ts
git commit -m "test(daemon): add UnixSocketTransport tests"
```

---

## Verification

After completing all tasks:

1. Start the daemon: `bun run tenex daemon start`
2. Check socket exists: `ls -la /tmp/tenex-stream.sock`
3. Connect with netcat: `nc -U /tmp/tenex-stream.sock`
4. Trigger an agent response and verify NDJSON chunks appear in netcat output
