import { beforeEach, describe, expect, it, mock } from "bun:test";
import { createMockInboundEnvelope } from "@/test-utils/mock-factories";
import { RALRegistry } from "@/services/ral";

mock.module("@/services/heuristics", () => ({
    getHeuristicEngine: () => ({
        evaluate: () => [],
    }),
}));

mock.module("@/services/heuristics/ContextBuilder", () => ({
    buildHeuristicContext: () => ({}),
}));

import { StreamExecutionHandler } from "../StreamExecutionHandler";

interface Scripted {
    chunkTypeChange?: { from: string; to: string };
    toolWillExecute?: { toolName: string; toolCallId: string };
    content?: string;
    complete?: { message: string; finishReason: string };
}

class ScriptedLLMService {
    provider = "openrouter";
    model = "test-model";
    private handlers = new Map<string, ((...args: unknown[]) => unknown)[]>();

    constructor(private readonly script: Scripted[]) {}

    on(event: string, handler: (...args: unknown[]) => unknown): void {
        const existing = this.handlers.get(event) ?? [];
        existing.push(handler);
        this.handlers.set(event, existing);
    }

    private async emit(event: string, payload: unknown): Promise<void> {
        for (const handler of this.handlers.get(event) ?? []) {
            await handler(payload);
        }
    }

    removeAllListeners(): void {
        this.handlers.clear();
    }

    updateUsageFromSteps(): void {}

    createLanguageModelFromRegistry(): never {
        throw new Error("Not implemented in test");
    }

    async stream(): Promise<void> {
        for (const step of this.script) {
            if (step.content !== undefined) {
                await this.emit("content", { delta: step.content });
            }
            if (step.chunkTypeChange) {
                await this.emit("chunk-type-change", step.chunkTypeChange);
            }
            if (step.toolWillExecute) {
                await this.emit("tool-will-execute", step.toolWillExecute);
            }
            if (step.complete) {
                await this.emit("complete", step.complete);
            }
        }
    }
}

interface PublishedConversation {
    content: string;
}

describe("StreamExecutionHandler todo_write deferral", () => {
    const projectId = "31933:test:stream-todo-defer";
    const conversationId = "conversation-stream-todo-defer";
    const agentPubkey = "c".repeat(64);

    beforeEach(() => {
        // @ts-expect-error Reset singleton for test isolation
        RALRegistry.instance = undefined;
    });

    function createHandler(script: Scripted[]) {
        const registry = RALRegistry.getInstance();
        const ralNumber = registry.create(agentPubkey, conversationId, projectId);
        const llmService = new ScriptedLLMService(script);
        const publishedConversations: PublishedConversation[] = [];
        const conversationPublisher = mock(async (intent: { content: string }) => {
            publishedConversations.push({ content: intent.content });
            return { id: `conv-${publishedConversations.length}` };
        });

        const triggeringEnvelope = createMockInboundEnvelope({
            principal: {
                id: "nostr:user-1",
                transport: "nostr",
                linkedPubkey: "d".repeat(64),
                kind: "human",
            },
            content: "Do the work",
        });

        const handler = new StreamExecutionHandler({
            context: {
                agent: {
                    slug: "test-agent",
                    pubkey: agentPubkey,
                    name: "Test Agent",
                },
                conversationId,
                projectBasePath: "/mock/project",
                workingDirectory: "/mock/project",
                currentBranch: "main",
                triggeringEnvelope,
                conversationStore: {
                    metadata: {},
                    getMetaModelVariantOverride: () => undefined,
                    addMessage: mock(() => 0),
                    setEventId: mock(() => undefined),
                    getAllMessages: () => [],
                },
                getConversation: () => undefined,
                agentPublisher: {
                    conversation: conversationPublisher,
                    error: mock(async () => undefined),
                    streamTextDelta: mock(async () => undefined),
                },
            } as any,
            toolTracker: {
                completeExecution: mock(async () => undefined),
            } as any,
            ralNumber,
            toolsObject: {},
            llmService: llmService as any,
            messageCompiler: {} as any,
            request: {
                messages: [{ role: "user", content: "Do the work" }],
            },
            abortSignal: new AbortController().signal,
        });

        return { handler, publishedConversations };
    }

    it("folds pre-todo_write text into the completion message when todo_write is the only tool", async () => {
        const { handler, publishedConversations } = createHandler([
            { content: "Substantive summary of the work." },
            { chunkTypeChange: { from: "text-delta", to: "tool-call" } },
            { toolWillExecute: { toolName: "todo_write", toolCallId: "tc-1" } },
            { complete: { message: "Done! ✅", finishReason: "stop" } },
        ]);

        const result = await handler.execute();

        expect(result.kind).toBe("complete");
        if (result.kind === "complete") {
            expect(result.event.message).toBe("Substantive summary of the work.\n\nDone! ✅");
        }
        expect(publishedConversations).toHaveLength(0);
    });

    it("uses only deferred text when trailing message is empty", async () => {
        const { handler, publishedConversations } = createHandler([
            { content: "Substantive summary." },
            { chunkTypeChange: { from: "text-delta", to: "tool-call" } },
            { toolWillExecute: { toolName: "todo_write", toolCallId: "tc-1" } },
            { complete: { message: "", finishReason: "stop" } },
        ]);

        const result = await handler.execute();

        expect(result.kind).toBe("complete");
        if (result.kind === "complete") {
            expect(result.event.message).toBe("Substantive summary.");
        }
        expect(publishedConversations).toHaveLength(0);
    });

    it("publishes pre-tool text as conversation() when the first tool is not todo_write", async () => {
        const { handler, publishedConversations } = createHandler([
            { content: "Planning the next step." },
            { chunkTypeChange: { from: "text-delta", to: "tool-call" } },
            { toolWillExecute: { toolName: "read_file", toolCallId: "tc-1" } },
            { complete: { message: "Final answer.", finishReason: "stop" } },
        ]);

        const result = await handler.execute();

        expect(result.kind).toBe("complete");
        if (result.kind === "complete") {
            expect(result.event.message).toBe("Final answer.");
        }
        expect(publishedConversations).toHaveLength(1);
        expect(publishedConversations[0]?.content).toBe("Planning the next step.");
    });

    it("flushes deferred todo_write text when a second tool is called", async () => {
        const { handler, publishedConversations } = createHandler([
            { content: "First segment." },
            { chunkTypeChange: { from: "text-delta", to: "tool-call" } },
            { toolWillExecute: { toolName: "todo_write", toolCallId: "tc-1" } },
            { content: "Second segment." },
            { chunkTypeChange: { from: "text-delta", to: "tool-call" } },
            { toolWillExecute: { toolName: "read_file", toolCallId: "tc-2" } },
            { complete: { message: "Final.", finishReason: "stop" } },
        ]);

        const result = await handler.execute();

        expect(result.kind).toBe("complete");
        if (result.kind === "complete") {
            expect(result.event.message).toBe("Final.");
        }
        expect(publishedConversations).toHaveLength(2);
        expect(publishedConversations[0]?.content).toBe("First segment.");
        expect(publishedConversations[1]?.content).toBe("Second segment.");
    });

    it("leaves completion untouched when there are no tool calls", async () => {
        const { handler, publishedConversations } = createHandler([
            { content: "Single shot answer." },
            { complete: { message: "Single shot answer.", finishReason: "stop" } },
        ]);

        const result = await handler.execute();

        expect(result.kind).toBe("complete");
        if (result.kind === "complete") {
            expect(result.event.message).toBe("Single shot answer.");
        }
        expect(publishedConversations).toHaveLength(0);
    });
});
