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

class MockLLMService {
    provider = "openrouter";
    model = "test-model";
    private handlers = new Map<string, ((...args: unknown[]) => unknown)[]>();

    constructor(private readonly completionMode: "throw" | "return" = "throw") {}

    on(event: string, handler: (...args: unknown[]) => unknown): void {
        const existing = this.handlers.get(event) ?? [];
        existing.push(handler);
        this.handlers.set(event, existing);
    }

    emit(event: string, payload: unknown): void {
        for (const handler of this.handlers.get(event) ?? []) {
            void handler(payload);
        }
    }

    removeAllListeners(): void {
        this.handlers.clear();
    }

    updateUsageFromSteps(): void {}

    createLanguageModelFromRegistry(): never {
        throw new Error("Not implemented in test");
    }

    async stream(
        _messages: unknown[],
        _tools: Record<string, unknown>,
        options?: { abortSignal?: AbortSignal; onStopCheck?: () => Promise<boolean> }
    ): Promise<void> {
        this.emit("tool-did-execute", {
            toolName: "no_response",
            toolCallId: "tool-call-1",
            result: { success: true, mode: "silent-complete" },
        });
        expect(await options?.onStopCheck?.()).toBe(true);
        expect(options?.abortSignal?.aborted).toBe(true);
        if (this.completionMode === "throw") {
            throw new Error("aborted after no_response");
        }
    }
}

describe("StreamExecutionHandler no_response short-circuit", () => {
    const projectId = "31933:test:stream-no-response";
    const conversationId = "conversation-stream-no-response";
    const agentPubkey = "c".repeat(64);

    beforeEach(() => {
        // @ts-expect-error Reset singleton for test isolation
        RALRegistry.instance = undefined;
    });

    function createHandler(completionMode: "throw" | "return" = "throw") {
        const registry = RALRegistry.getInstance();
        const ralNumber = registry.create(agentPubkey, conversationId, projectId);
        const llmService = new MockLLMService(completionMode);
        const errorPublisher = mock(async () => undefined);

        const triggeringEnvelope = createMockInboundEnvelope({
            principal: {
                id: "nostr:user-1",
                transport: "nostr",
                linkedPubkey: "d".repeat(64),
                kind: "human",
            },
            content: "Don't reply",
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
                    error: errorPublisher,
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
                messages: [{ role: "user", content: "Don't reply" }],
            },
            nudgeContent: "",
            nudges: [],
            nudgeToolPermissions: {},
            skillContent: "",
            skills: [],
            abortSignal: new AbortController().signal,
        });

        return { handler, errorPublisher };
    }

    it("returns a blank completion instead of publishing an error when no_response aborts the stream", async () => {
        const { handler, errorPublisher } = createHandler("throw");

        const result = await handler.execute();

        expect(result.kind).toBe("complete");
        if (result.kind === "complete") {
            expect(result.event.message).toBe("");
            expect(result.aborted).toBeUndefined();
        }
        expect(errorPublisher).not.toHaveBeenCalled();
    });

    it("returns a blank completion when the stream exits cleanly without complete or stream-error after no_response", async () => {
        const { handler, errorPublisher } = createHandler("return");

        const result = await handler.execute();

        expect(result.kind).toBe("complete");
        if (result.kind === "complete") {
            expect(result.event.message).toBe("");
            expect(result.aborted).toBeUndefined();
        }
        expect(errorPublisher).not.toHaveBeenCalled();
    });
});
