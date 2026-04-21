import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { ConversationStore } from "@/conversations/ConversationStore";
import type { InboundEnvelope } from "@/events/runtime/InboundEnvelope";
import { RALRegistry } from "@/services/ral";
import type { McpSubscription } from "@/services/mcp/McpSubscriptionService";
import { AgentExecutor } from "@/agents/execution/AgentExecutor";
import * as executionContextFactoryModule from "@/agents/execution/ExecutionContextFactory";
import * as projectsModule from "@/services/projects";

mock.module("@/utils/logger", () => ({
    logger: {
        info: mock(),
        warn: mock(),
        warning: mock(),
        error: mock(),
        debug: mock(),
        success: mock(),
        isLevelEnabled: () => false,
        initDaemonLogging: async () => undefined,
        writeToWarnLog: () => undefined,
    },
}));

import { deliverMcpNotification } from "../McpNotificationDelivery";

describe("McpNotificationDelivery", () => {
    const TEST_DIR = "/tmp/tenex-mcp-notification-delivery-test";
    const agentPubkey = "a".repeat(64);
    const subscription: McpSubscription = {
        id: "sub-1",
        agentPubkey,
        agentSlug: "telegram-agent",
        serverName: "docs",
        resourceUri: "resource://notes",
        conversationId: "conv-mcp-1",
        rootEventId: "root-event-1",
        projectId: `31933:${"b".repeat(64)}:demo-project`,
        description: "Test subscription",
        status: "ACTIVE" as const,
        notificationsReceived: 0,
        createdAt: 1,
        updatedAt: 1,
    };
    const agent = {
        pubkey: agentPubkey,
        slug: "telegram-agent",
    };

    const executeMock = mock(async () => {});
    const createExecutionContextMock = mock(async (params: unknown) => params);
    const getAgentByPubkeyMock = mock(() => agent);

    beforeEach(async () => {
        await mkdir(TEST_DIR, { recursive: true });
        ConversationStore.initialize(TEST_DIR);

        spyOn(AgentExecutor.prototype, "execute").mockImplementation(executeMock);
        spyOn(executionContextFactoryModule, "createExecutionContext").mockImplementation(
            createExecutionContextMock
        );
        spyOn(projectsModule, "getProjectContext").mockReturnValue({
            getAgentByPubkey: getAgentByPubkeyMock,
            agentRegistry: {
                getBasePath: () => "/tmp/tenex-mcp-project",
            },
            mcpManager: undefined,
        } as any);

        getAgentByPubkeyMock.mockReset();
        getAgentByPubkeyMock.mockReturnValue(agent);
        createExecutionContextMock.mockReset();
        createExecutionContextMock.mockImplementation(async (params: unknown) => params);
        executeMock.mockReset();
        // @ts-expect-error test-only singleton reset
        RALRegistry.instance = undefined;
    });

    afterEach(async () => {
        ConversationStore.reset();
        await rm(TEST_DIR, { recursive: true, force: true });
    });

    it("queues active-stream notifications with sender metadata intact", async () => {
        const registry = RALRegistry.getInstance();
        const ralNumber = registry.create(agentPubkey, subscription.conversationId, subscription.projectId);
        registry.setStreaming(agentPubkey, subscription.conversationId, ralNumber, true);

        await deliverMcpNotification(subscription, "A new resource version is available.");

        const injections = registry.getAndConsumeInjections(
            agentPubkey,
            subscription.conversationId,
            ralNumber
        );
        expect(injections).toHaveLength(1);
        expect(injections[0].senderPrincipal).toEqual({
            id: "mcp:subscription:sub-1",
            transport: "mcp",
            displayName: "docs",
            kind: "system",
        });
        expect(injections[0].targetedPrincipals).toEqual([
            {
                id: `nostr:${agentPubkey}`,
                transport: "nostr",
                linkedPubkey: agentPubkey,
                displayName: "telegram-agent",
                kind: "agent",
            },
        ]);
        expect(injections[0].eventId).toMatch(/^mcp-notification:sub-1:\d+$/);
        expect(ConversationStore.getOrLoad(subscription.conversationId).getAllMessages()).toHaveLength(0);
        expect(createExecutionContextMock).not.toHaveBeenCalled();
        expect(executeMock).not.toHaveBeenCalled();
    });

    it("stores direct notifications as transport-only user messages and executes the agent", async () => {
        const store = ConversationStore.getOrLoad(subscription.conversationId);

        await deliverMcpNotification(subscription, "A new resource version is available.");

        const messages = store.getAllMessages();
        expect(messages).toHaveLength(1);
        expect(messages[0].pubkey).toBe("");
        expect(messages[0].role).toBe("user");
        expect(messages[0].senderPrincipal).toEqual({
            id: "mcp:subscription:sub-1",
            transport: "mcp",
            displayName: "docs",
            kind: "system",
        });
        expect(messages[0].targetedPrincipals).toEqual([
            {
                id: `nostr:${agentPubkey}`,
                transport: "nostr",
                linkedPubkey: agentPubkey,
                displayName: "telegram-agent",
                kind: "agent",
            },
        ]);
        expect(messages[0].eventId).toMatch(/^mcp-notification:sub-1:\d+$/);

        expect(createExecutionContextMock).toHaveBeenCalledTimes(1);
        const executionParams = createExecutionContextMock.mock.calls[0]?.[0] as {
            triggeringEnvelope: {
                principal: InboundEnvelope["principal"];
                message: { nativeId: string };
            };
        };
        expect(executionParams.triggeringEnvelope.principal).toEqual({
            id: "mcp:subscription:sub-1",
            transport: "mcp",
            displayName: "docs",
            kind: "system",
        });
        expect(executionParams.triggeringEnvelope.message.nativeId).toBe(messages[0].eventId);
        expect(executeMock).toHaveBeenCalledTimes(1);
    });
});
