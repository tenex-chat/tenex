import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { AgentExecutor } from "../AgentExecutor";
import { ToolExecutionTracker } from "../ToolExecutionTracker";
import { AgentPublisher } from "@/nostr/AgentPublisher";
import { createMockInboundEnvelope } from "@/test-utils/mock-factories";
import { RALRegistry } from "@/services/ral";
import { TelegramRuntimePublisher } from "@/services/telegram/TelegramRuntimePublisherService";

describe("AgentExecutor no_response Telegram runtime", () => {
    const projectId = "31933:test:no-response-executor";
    const conversationId = "conversation-no-response-executor";
    const agentPubkey = "b".repeat(64);

    let registry: RALRegistry;

    beforeEach(() => {
        // @ts-expect-error Reset singleton for test isolation
        RALRegistry.instance = undefined;
        registry = RALRegistry.getInstance();
    });

    it("does not send Telegram replies when explicit silent completion is honored", async () => {
        const sendReply = mock(async () => undefined);
        const publisher = new TelegramRuntimePublisher(
            {
                slug: "telegram-agent",
                pubkey: agentPubkey,
                llmConfig: "default",
                telegram: {
                    botToken: "token",
                },
            } as any,
            {
                canHandle: () => true,
                sendReply,
            } as any
        );

        const ralNumber = registry.create(agentPubkey, conversationId, projectId);
        const conversationStore = {
            id: conversationId,
            metadata: {},
            getRootEventId: () => conversationId,
            getAllMessages: () => [],
            completeRal: mock(() => undefined),
            save: mock(async () => undefined),
        } as any;
        const context = {
            agent: {
                slug: "telegram-agent",
                pubkey: agentPubkey,
                name: "Telegram Agent",
                llmConfig: "default",
                telegram: {
                    botToken: "token",
                },
            },
            conversationId,
            projectBasePath: "/mock/project",
            workingDirectory: "/mock/project",
            currentBranch: "main",
            triggeringEnvelope: createMockInboundEnvelope({
                transport: "telegram",
                principal: {
                    id: "telegram:user:42",
                    transport: "telegram",
                    linkedPubkey: "d".repeat(64),
                    kind: "human",
                },
                channel: {
                    id: "telegram:chat:42",
                    transport: "telegram",
                    kind: "dm",
                },
                message: {
                    id: "telegram:message:101",
                    transport: "telegram",
                    nativeId: "telegram:chat:42:message:101",
                },
            }),
            agentPublisher: publisher,
            ralNumber,
            conversationStore,
            getConversation: () => conversationStore,
        } as any;

        expect(registry.requestSilentCompletion(agentPubkey, conversationId, ralNumber)).toBe(true);
        spyOn(AgentPublisher.prototype, "complete").mockResolvedValue(undefined);
        spyOn(AgentPublisher.prototype, "conversation").mockResolvedValue({} as any);

        const executor = Object.create(AgentExecutor.prototype) as AgentExecutor;
        spyOn(executor as any, "executeStreaming").mockResolvedValue({
            kind: "complete",
            event: {
                message: "",
                steps: [],
                usage: {},
            },
            messageCompiler: {} as any,
            accumulatedRuntime: 0,
        });

        const result = await (executor as any).executeOnce(
            context,
            new ToolExecutionTracker(),
            publisher as any,
            ralNumber
        );

        expect(result).toBeUndefined();
        expect(sendReply).not.toHaveBeenCalled();
        expect(AgentPublisher.prototype.complete).not.toHaveBeenCalled();
        expect(AgentPublisher.prototype.conversation).not.toHaveBeenCalled();
        expect(conversationStore.completeRal).toHaveBeenCalledWith(agentPubkey, ralNumber);
        expect(conversationStore.save).toHaveBeenCalledTimes(1);
        expect(registry.getRAL(agentPubkey, conversationId, ralNumber)).toBeUndefined();
    });
});
