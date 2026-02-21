/**
 * Integration test: Finish chunk routing invariant.
 *
 * Regression guard for commit fa033928.
 *
 * Invariant: `finish` chunks must be emitted as `raw-chunk` directly on LLMService
 * WITHOUT going through ChunkHandler. ChunkHandler triggers `chunk-type-change`
 * which causes AgentExecutor to publish a duplicate kind:1 event.
 *
 * `tool-error` chunks DO go through ChunkHandler because they need error handling.
 *
 * ## Why this is a separate file
 * 
 * `service.test.ts` hangs due to bun ESM resolution issues:
 * 1. `tseep` is CJS-only, which causes bun's ESM resolver to hang
 * 2. Circular import chain: service → context-window-cache → models-dev-cache →
 *    ConfigService → LLMServiceFactory → service
 *
 * This test validates the routing logic without importing LLMService by:
 * - Using a real ChunkHandler to verify it emits `chunk-type-change` and `raw-chunk`
 * - Verifying `finish` chunks would NOT trigger `chunk-type-change` if routed correctly
 * - Testing the routing decision itself as a simple conditional
 *
 * The actual routing code in service.ts (lines ~436-443) is:
 * ```
 * if (part.type === "finish") {
 *     this.emit("raw-chunk", { chunk: part });
 * } else if (part.type === "tool-error") {
 *     this.chunkHandler.handleChunk({ chunk: part });
 * }
 * ```
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";

// ===== Mock CJS-only modules that cause bun ESM hang =====
class MockEventEmitter {
    private _handlers: Map<string, Function[]> = new Map();
    on(event: string, handler: Function) {
        const h = this._handlers.get(event) || [];
        h.push(handler);
        this._handlers.set(event, h);
        return this;
    }
    emit(event: string, ...args: any[]) {
        const h = this._handlers.get(event) || [];
        for (const fn of h) fn(...args);
        return h.length > 0;
    }
    off(event: string, handler: Function) {
        const h = this._handlers.get(event) || [];
        this._handlers.set(event, h.filter(fn => fn !== handler));
        return this;
    }
    removeListener(event: string, handler: Function) { return this.off(event, handler); }
    removeAllListeners(event?: string) {
        if (event) this._handlers.delete(event);
        else this._handlers.clear();
        return this;
    }
    listeners(event: string) { return this._handlers.get(event) || []; }
    listenerCount(event: string) { return (this._handlers.get(event) || []).length; }
}

mock.module("tseep", () => ({ EventEmitter: MockEventEmitter }));

mock.module("@opentelemetry/api", () => ({
    trace: { getActiveSpan: () => null },
    SpanStatusCode: { ERROR: 2, OK: 1 },
    createContextKey: mock((name: string) => Symbol.for(name)),
}));

mock.module("@/utils/logger", () => ({
    logger: {
        info: mock(() => {}),
        error: mock(() => {}),
        warn: mock(() => {}),
        debug: mock(() => {}),
    },
}));

// ===== Import ChunkHandler (lightweight, no circular deps) =====
import { ChunkHandler, type ChunkHandlerState } from "../ChunkHandler";

// ===== Types =====
interface ChunkEvent {
    chunk: { type: string; [key: string]: any };
}

/**
 * Simulates the routing logic from LLMService.stream() fullStream loop.
 *
 * This is the exact same logic as service.ts lines ~436-443:
 * - finish → emit raw-chunk directly (bypass ChunkHandler)
 * - tool-error → go through chunkHandler.handleChunk()
 *
 * The emitter and chunkHandler are the same objects that LLMService uses.
 */
function routeChunk(
    part: { type: string; [key: string]: any },
    emitter: MockEventEmitter,
    chunkHandler: ChunkHandler
): void {
    if (part.type === "finish") {
        // Emit raw-chunk directly to reach StreamPublisher (for HTTP wrapper SSE)
        // WITHOUT going through ChunkHandler which would trigger chunk-type-change
        emitter.emit("raw-chunk", { chunk: part });
    } else if (part.type === "tool-error") {
        chunkHandler.handleChunk({ chunk: part } as any);
    }
}

// ===== Tests =====
describe("Finish chunk routing (regression guard)", () => {
    let emitter: MockEventEmitter;
    let chunkHandler: ChunkHandler;
    let state: ChunkHandlerState;

    beforeEach(() => {
        emitter = new MockEventEmitter();
        state = {
            previousChunkType: undefined,
            cachedContentForComplete: "",
            getCurrentStepUsage: () => undefined,
            getModelContextWindow: () => undefined,
        };
        chunkHandler = new ChunkHandler(emitter as any, state);
    });

    test("finish chunk emits raw-chunk event (via direct emit)", () => {
        const rawChunkEvents: ChunkEvent[] = [];
        emitter.on("raw-chunk", (event: any) => rawChunkEvents.push(event));

        const finishChunk = { type: "finish", finishReason: "stop" };
        routeChunk(finishChunk, emitter, chunkHandler);

        const finishRawChunks = rawChunkEvents.filter(e => e.chunk.type === "finish");
        expect(finishRawChunks).toHaveLength(1);
        expect(finishRawChunks[0].chunk.finishReason).toBe("stop");
    });

    test("finish chunk does NOT go through ChunkHandler.handleChunk", () => {
        // Spy on handleChunk
        const handleChunkCalls: ChunkEvent[] = [];
        const originalHandleChunk = chunkHandler.handleChunk.bind(chunkHandler);
        chunkHandler.handleChunk = ((event: any) => {
            handleChunkCalls.push(event);
            return originalHandleChunk(event);
        }) as any;

        const finishChunk = { type: "finish", finishReason: "stop" };
        routeChunk(finishChunk, emitter, chunkHandler);

        const finishCalls = handleChunkCalls.filter(e => e.chunk.type === "finish");
        expect(finishCalls).toHaveLength(0);
    });

    test("tool-error chunk goes through ChunkHandler.handleChunk", () => {
        const handleChunkCalls: ChunkEvent[] = [];
        const originalHandleChunk = chunkHandler.handleChunk.bind(chunkHandler);
        chunkHandler.handleChunk = ((event: any) => {
            handleChunkCalls.push(event);
            return originalHandleChunk(event);
        }) as any;

        const toolErrorChunk = {
            type: "tool-error",
            toolCallId: "call-err-1",
            toolName: "failing-tool",
            error: new Error("tool failed"),
        };
        routeChunk(toolErrorChunk, emitter, chunkHandler);

        const toolErrorCalls = handleChunkCalls.filter(e => e.chunk.type === "tool-error");
        expect(toolErrorCalls).toHaveLength(1);
        expect(toolErrorCalls[0].chunk.toolName).toBe("failing-tool");
        expect(toolErrorCalls[0].chunk.toolCallId).toBe("call-err-1");
    });

    test("finish chunk does NOT trigger chunk-type-change event", () => {
        const chunkTypeChanges: any[] = [];
        emitter.on("chunk-type-change", (event: any) => chunkTypeChanges.push(event));

        // First, send a text-delta through ChunkHandler to set previousChunkType
        chunkHandler.handleChunk({ chunk: { type: "text-delta", text: "hello" } } as any);

        // Now route a finish chunk — should bypass ChunkHandler
        const finishChunk = { type: "finish", finishReason: "stop" };
        routeChunk(finishChunk, emitter, chunkHandler);

        // If finish had gone through ChunkHandler, it would emit chunk-type-change
        // from "text-delta" to "finish". This is the exact bug from the regression.
        const finishTransitions = chunkTypeChanges.filter(e => e.to === "finish");
        expect(finishTransitions).toHaveLength(0);
    });

    test("if finish went through ChunkHandler, it WOULD trigger chunk-type-change (proving bypass is needed)", () => {
        // This test proves WHY the bypass is necessary:
        // If we send finish directly through ChunkHandler, it triggers chunk-type-change
        const chunkTypeChanges: any[] = [];
        emitter.on("chunk-type-change", (event: any) => chunkTypeChanges.push(event));

        // Set up state: text-delta was the previous chunk type
        chunkHandler.handleChunk({ chunk: { type: "text-delta", text: "hello" } } as any);

        // Send finish THROUGH ChunkHandler (the wrong way — this is the regression)
        chunkHandler.handleChunk({ chunk: { type: "finish", finishReason: "stop" } } as any);

        // This WOULD emit chunk-type-change from text-delta to finish
        // which causes AgentExecutor to publish a duplicate kind:1 event
        const finishTransitions = chunkTypeChanges.filter(e => e.to === "finish");
        expect(finishTransitions).toHaveLength(1);
        expect(finishTransitions[0].from).toBe("text-delta");
    });

    test("combined: finish emits raw-chunk only, tool-error goes to ChunkHandler only", () => {
        const rawChunkEvents: ChunkEvent[] = [];
        emitter.on("raw-chunk", (event: any) => rawChunkEvents.push(event));

        const handleChunkCalls: ChunkEvent[] = [];
        const originalHandleChunk = chunkHandler.handleChunk.bind(chunkHandler);
        chunkHandler.handleChunk = ((event: any) => {
            handleChunkCalls.push(event);
            return originalHandleChunk(event);
        }) as any;

        // Route tool-error (should go through ChunkHandler)
        routeChunk(
            { type: "tool-error", toolCallId: "call-err-2", toolName: "broken-tool", error: new Error("boom") },
            emitter,
            chunkHandler
        );

        // Route finish (should bypass ChunkHandler, emit raw-chunk directly)
        routeChunk(
            { type: "finish", finishReason: "stop" },
            emitter,
            chunkHandler
        );

        // Verify finish routing: raw-chunk YES (from routeChunk), ChunkHandler NO
        const finishRawChunks = rawChunkEvents.filter(e => e.chunk.type === "finish");
        const finishHandlerCalls = handleChunkCalls.filter(e => e.chunk.type === "finish");
        expect(finishRawChunks).toHaveLength(1);
        expect(finishHandlerCalls).toHaveLength(0);

        // Verify tool-error routing: ChunkHandler YES
        // (ChunkHandler also emits raw-chunk internally for tool-error, that's expected)
        const toolErrorHandlerCalls = handleChunkCalls.filter(e => e.chunk.type === "tool-error");
        expect(toolErrorHandlerCalls).toHaveLength(1);
        expect(toolErrorHandlerCalls[0].chunk.toolName).toBe("broken-tool");
    });

    test("standard chunks through onChunk go through ChunkHandler normally", () => {
        // Verify that the onChunk callback path still works for standard chunks
        const contentEvents: any[] = [];
        emitter.on("content", (event: any) => contentEvents.push(event));

        chunkHandler.handleChunk({ chunk: { type: "text-delta", text: "hello" } } as any);
        chunkHandler.handleChunk({ chunk: { type: "text-delta", text: " world" } } as any);

        expect(contentEvents).toHaveLength(2);
        expect(contentEvents[0].delta).toBe("hello");
        expect(contentEvents[1].delta).toBe(" world");
    });
});
