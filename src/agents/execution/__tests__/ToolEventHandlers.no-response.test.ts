import { beforeEach, describe, expect, it, mock } from "bun:test";
import { RALRegistry } from "@/services/ral";

mock.module("@/services/heuristics", () => ({
    getHeuristicEngine: () => ({
        evaluate: () => [],
    }),
}));

mock.module("@/services/heuristics/ContextBuilder", () => ({
    buildHeuristicContext: () => ({}),
}));

import { setupToolEventHandlers } from "../ToolEventHandlers";

class MockLLMService {
    private handlers = new Map<string, ((...args: unknown[]) => unknown)[]>();

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
}

describe("ToolEventHandlers no_response callback", () => {
    const projectId = "31933:test:tool-events-no-response";
    const conversationId = "conversation-tool-events-no-response";
    const agentPubkey = "e".repeat(64);

    beforeEach(() => {
        // @ts-expect-error Reset singleton for test isolation
        RALRegistry.instance = undefined;
    });

    it("invokes the no_response callback as soon as the tool result is received", () => {
        const registry = RALRegistry.getInstance();
        const ralNumber = registry.create(agentPubkey, conversationId, projectId);
        const llmService = new MockLLMService();
        const onNoResponseRequested = mock(() => undefined);

        setupToolEventHandlers({
            context: {
                agent: {
                    slug: "test-agent",
                    pubkey: agentPubkey,
                    name: "Test Agent",
                },
                conversationId,
                currentBranch: "main",
                conversationStore: {
                    addMessage: mock(() => 0),
                    setEventId: mock(() => undefined),
                    getAllMessages: () => [],
                },
                agentPublisher: {},
            } as any,
            llmService: llmService as any,
            toolTracker: {
                completeExecution: mock(async () => undefined),
            } as any,
            toolsObject: {},
            eventContext: {} as any,
            ralNumber,
            onNoResponseRequested,
        });

        llmService.emit("tool-did-execute", {
            toolName: "no_response",
            toolCallId: "tool-call-1",
            result: { success: true, mode: "silent-complete" },
        });

        expect(onNoResponseRequested).toHaveBeenCalledTimes(1);
    });
});
