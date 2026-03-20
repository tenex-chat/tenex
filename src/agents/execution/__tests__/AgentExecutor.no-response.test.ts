import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";

const mockCheckPostCompletion = mock(async () => ({
    shouldReEngage: false,
    injectedMessage: false,
}));

mock.module("../PostCompletionChecker", () => ({
    checkPostCompletion: mockCheckPostCompletion,
}));

import type { FullRuntimeContext } from "../types";
import { AgentExecutor } from "../AgentExecutor";
import { ToolExecutionTracker } from "../ToolExecutionTracker";
import { createMockInboundEnvelope } from "@/test-utils/mock-factories";
import { RALRegistry } from "@/services/ral";

describe("AgentExecutor no_response handling", () => {
    const projectId = "31933:test:no-response-executor";
    const conversationId = "conversation-no-response-executor";
    const agentPubkey = "b".repeat(64);

    let registry: RALRegistry;

    beforeEach(() => {
        // @ts-expect-error Reset singleton for test isolation
        RALRegistry.instance = undefined;
        registry = RALRegistry.getInstance();
        mockCheckPostCompletion.mockReset();
        mockCheckPostCompletion.mockResolvedValue({
            shouldReEngage: false,
            injectedMessage: false,
        });
    });

    afterEach(() => {
        mock.restore();
    });

    function createConversationStoreMock() {
        return {
            id: conversationId,
            metadata: {},
            getRootEventId: () => conversationId,
            getAllMessages: () => [],
            completeRal: mock(() => undefined),
            save: mock(async () => undefined),
        } as any;
    }

    function createContext(
        overrides?: Partial<FullRuntimeContext> & {
            triggeringEnvelope?: FullRuntimeContext["triggeringEnvelope"];
            agent?: Partial<FullRuntimeContext["agent"]>;
        }
    ): { context: FullRuntimeContext; conversationStore: ReturnType<typeof createConversationStoreMock>; ralNumber: number } {
        const conversationStore = createConversationStoreMock();
        const ralNumber = registry.create(agentPubkey, conversationId, projectId);

        const agent = {
            slug: "test-agent",
            pubkey: agentPubkey,
            name: "Test Agent",
            llmConfig: "default",
            ...(overrides?.agent ?? {}),
        } as any;

        const context: FullRuntimeContext = {
            agent,
            conversationId,
            projectBasePath: "/mock/project",
            workingDirectory: "/mock/project",
            currentBranch: "main",
            triggeringEnvelope:
                overrides?.triggeringEnvelope ??
                createMockInboundEnvelope({
                    principal: {
                        id: "nostr:user-1",
                        transport: "nostr",
                        linkedPubkey: "c".repeat(64),
                        kind: "human",
                    },
                    content: "Don't respond to this",
                }),
            agentPublisher: {} as any,
            ralNumber,
            conversationStore,
            getConversation: () => conversationStore,
            ...overrides,
        };

        return { context, conversationStore, ralNumber };
    }

    it("skips supervision and publishing when silent completion was requested and the final text is blank", async () => {
        const publisher = {
            complete: mock(async () => undefined),
            conversation: mock(async () => undefined),
        } as any;
        const { context, conversationStore, ralNumber } = createContext({ agentPublisher: publisher });

        registry.requestSilentCompletion(agentPubkey, conversationId, ralNumber);

        const executor = Object.create(AgentExecutor.prototype) as AgentExecutor;
        spyOn(executor as any, "executeStreaming").mockResolvedValue({
            kind: "complete",
            event: {
                message: "   ",
                steps: [],
                usage: {},
            },
            messageCompiler: {} as any,
            accumulatedRuntime: 0,
        });

        const result = await (executor as any).executeOnce(
            context,
            new ToolExecutionTracker(),
            publisher,
            ralNumber
        );

        expect(result).toBeUndefined();
        expect(mockCheckPostCompletion).not.toHaveBeenCalled();
        expect(publisher.complete).not.toHaveBeenCalled();
        expect(publisher.conversation).not.toHaveBeenCalled();
        expect(conversationStore.completeRal).toHaveBeenCalledWith(agentPubkey, ralNumber);
        expect(conversationStore.save).toHaveBeenCalledTimes(1);
        expect(registry.getRAL(agentPubkey, conversationId, ralNumber)).toBeUndefined();
    });

    it("ignores the silent request when the model produces visible text and publishes normally", async () => {
        const publisher = {
            complete: mock(async () => undefined),
            conversation: mock(async () => undefined),
        } as any;
        const { context, ralNumber } = createContext({ agentPublisher: publisher });

        registry.requestSilentCompletion(agentPubkey, conversationId, ralNumber);

        const executor = Object.create(AgentExecutor.prototype) as AgentExecutor;
        spyOn(executor as any, "executeStreaming").mockResolvedValue({
            kind: "complete",
            event: {
                message: "Visible reply",
                steps: [],
                usage: {},
            },
            messageCompiler: {} as any,
            accumulatedRuntime: 0,
        });

        await (executor as any).executeOnce(
            context,
            new ToolExecutionTracker(),
            publisher,
            ralNumber
        );

        expect(mockCheckPostCompletion).toHaveBeenCalledTimes(1);
        expect(publisher.complete).toHaveBeenCalledTimes(1);
        expect(publisher.conversation).not.toHaveBeenCalled();
        expect(registry.isSilentCompletionRequested(agentPubkey, conversationId, ralNumber)).toBe(false);
    });

});
