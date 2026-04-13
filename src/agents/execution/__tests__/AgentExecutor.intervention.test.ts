import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { ConversationStore } from "@/conversations/ConversationStore";
import { InterventionService } from "@/services/intervention";
import { RALRegistry } from "@/services/ral";

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

describe("AgentExecutor intervention seam", () => {
    const projectDTag = "test-executor-intervention";
    const projectId = projectDTag;
    const conversationId = "conversation-executor-intervention";
    const agentPubkey = "b".repeat(64);
    const rootUserPubkey = "c".repeat(64);

    let registry: RALRegistry;
    let mockInterventionService: {
        isEnabled: ReturnType<typeof mock>;
        setProject: ReturnType<typeof mock>;
        onAgentCompletion: ReturnType<typeof mock>;
    };

    beforeEach(() => {
        // @ts-expect-error test singleton reset
        RALRegistry.instance = undefined;
        registry = RALRegistry.getInstance();
        mock.restore();

        mockCheckPostCompletion.mockReset();
        mockCheckPostCompletion.mockResolvedValue({
            shouldReEngage: false,
            injectedMessage: false,
        });

        mockInterventionService = {
            isEnabled: mock(() => true),
            setProject: mock(() => Promise.resolve()),
            onAgentCompletion: mock(() => undefined),
        };
        spyOn(InterventionService, "getInstance").mockReturnValue(
            mockInterventionService as unknown as InterventionService
        );
        spyOn(ConversationStore, "addEnvelope").mockResolvedValue(undefined as never);
    });

    afterEach(() => {
        mock.restore();
    });

    function createConversationStoreMock() {
        return {
            id: conversationId,
            metadata: {},
            getRootEventId: () => conversationId,
            getRootAuthorPubkey: () => rootUserPubkey,
            getAllMessages: () => [],
            completeRal: mock(() => undefined),
            save: mock(async () => undefined),
            markAgentPromptHistoryCacheAnchored: mock(() => false),
        } as any;
    }

    function createContext(
        overrides?: Partial<FullRuntimeContext> & {
            triggeringEnvelope?: FullRuntimeContext["triggeringEnvelope"];
            agent?: Partial<FullRuntimeContext["agent"]>;
        }
    ) {
        const conversationStore = createConversationStoreMock();
        const ralNumber = registry.create(agentPubkey, conversationId, projectId);

        const context: FullRuntimeContext = {
            agent: {
                slug: "test-agent",
                pubkey: agentPubkey,
                name: "Test Agent",
                llmConfig: "default",
                ...(overrides?.agent ?? {}),
            } as any,
            conversationId,
            projectBasePath: "/mock/project",
            workingDirectory: "/mock/project",
            currentBranch: "main",
            projectContext: {
                project: {
                    tagValue: (name: string) => (name === "d" ? projectDTag : undefined),
                },
            } as any,
            triggeringEnvelope:
                overrides?.triggeringEnvelope ??
                createMockInboundEnvelope({
                    principal: {
                        id: "nostr:user-1",
                        transport: "nostr",
                        linkedPubkey: rootUserPubkey,
                        kind: "human",
                    },
                    content: "Please finish this",
                }),
            agentPublisher: {} as any,
            ralNumber,
            conversationStore,
            getConversation: () => conversationStore,
            ...overrides,
        };

        return { context, conversationStore, ralNumber };
    }

    function createPublishedMessageRef(recipientPubkey: string) {
        return {
            id: "event-id-123",
            transport: "nostr" as const,
            envelope: {
                transport: "nostr" as const,
                principal: {
                    id: `nostr:${agentPubkey}`,
                    transport: "nostr" as const,
                    linkedPubkey: agentPubkey,
                    kind: "agent" as const,
                },
                channel: {
                    id: `nostr:conversation:${conversationId}`,
                    transport: "nostr" as const,
                    kind: "conversation" as const,
                },
                message: {
                    id: "nostr:event-id-123",
                    transport: "nostr" as const,
                    nativeId: "event-id-123",
                    replyToId: `nostr:${conversationId}`,
                },
                recipients: [{
                    id: `nostr:${recipientPubkey}`,
                    transport: "nostr" as const,
                    linkedPubkey: recipientPubkey,
                    kind: "human" as const,
                }],
                content: "Final answer",
                occurredAt: 1_700_000_000,
                capabilities: [],
                metadata: {},
            },
        };
    }

    it("starts intervention from the final complete() publish path", async () => {
        const publisher = {
            complete: mock(async () => createPublishedMessageRef(rootUserPubkey)),
            conversation: mock(async () => createPublishedMessageRef(rootUserPubkey)),
        } as any;
        const { context, ralNumber } = createContext({ agentPublisher: publisher });

        const executor = Object.create(AgentExecutor.prototype) as AgentExecutor;
        spyOn(executor as any, "executeStreaming").mockResolvedValue({
            kind: "complete",
            event: {
                message: "Final answer",
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

        expect(publisher.complete).toHaveBeenCalledTimes(1);
        expect(publisher.conversation).not.toHaveBeenCalled();
        expect(mockInterventionService.setProject).toHaveBeenCalledWith(projectId);
        expect(mockInterventionService.onAgentCompletion).toHaveBeenCalledWith(
            conversationId,
            1_700_000_000_000,
            agentPubkey,
            rootUserPubkey,
            projectId
        );
    });

    it("does not start intervention for intermediate conversation() publishes", async () => {
        const publisher = {
            complete: mock(async () => createPublishedMessageRef(rootUserPubkey)),
            conversation: mock(async () => createPublishedMessageRef(rootUserPubkey)),
        } as any;
        const { context, ralNumber } = createContext({
            agentPublisher: publisher,
            hasPendingDelegations: true,
        });

        spyOn(registry, "hasOutstandingWork").mockReturnValue({
            hasWork: true,
            details: {
                queuedInjections: 0,
                pendingDelegations: 1,
                completedDelegations: 0,
            },
        } as any);

        const executor = Object.create(AgentExecutor.prototype) as AgentExecutor;
        spyOn(executor as any, "executeStreaming").mockResolvedValue({
            kind: "complete",
            event: {
                message: "Still working through delegation results",
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

        expect(publisher.complete).not.toHaveBeenCalled();
        expect(publisher.conversation).toHaveBeenCalledTimes(1);
        expect(mockInterventionService.setProject).not.toHaveBeenCalled();
        expect(mockInterventionService.onAgentCompletion).not.toHaveBeenCalled();
    });

    it("does not start intervention for completions addressed to a delegator instead of the root user", async () => {
        const delegatorPubkey = "d".repeat(64);
        const publisher = {
            complete: mock(async () => createPublishedMessageRef(delegatorPubkey)),
            conversation: mock(async () => createPublishedMessageRef(delegatorPubkey)),
        } as any;
        const { context, ralNumber } = createContext({ agentPublisher: publisher });

        const executor = Object.create(AgentExecutor.prototype) as AgentExecutor;
        spyOn(executor as any, "executeStreaming").mockResolvedValue({
            kind: "complete",
            event: {
                message: "Delegation result",
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

        expect(publisher.complete).toHaveBeenCalledTimes(1);
        expect(mockInterventionService.setProject).not.toHaveBeenCalled();
        expect(mockInterventionService.onAgentCompletion).not.toHaveBeenCalled();
    });
});
