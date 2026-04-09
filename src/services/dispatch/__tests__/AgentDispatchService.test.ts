import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { AgentInstance } from "@/agents/types";
import * as executionContextFactoryModule from "@/agents/execution/ExecutionContextFactory";
import { ConversationStore } from "@/conversations/ConversationStore";
import { metadataDebounceManager } from "@/conversations/services/MetadataDebounceManager";
import { NDKKind } from "@/nostr/kinds";
import { config } from "@/services/ConfigService";
import { llmOpsRegistry } from "@/services/LLMOperationsRegistry";
import { RALRegistry } from "@/services/ral";
import { createMockInboundEnvelope } from "@/test-utils/mock-factories";
import { trace } from "@opentelemetry/api";
import { AgentDispatchService } from "../AgentDispatchService";

describe("AgentDispatchService live message injection", () => {
    const agentPubkey = "agent-pubkey";
    const conversationId = "conversation-id";
    const projectId = "test-project";
    const agent = {
        pubkey: agentPubkey,
        slug: "tester",
        llmConfig: "codex-config",
    } as AgentInstance;

    let registry: RALRegistry;
    let originalGetLLMConfig: typeof config.getLLMConfig;
    let originalGetMessageInjector: typeof llmOpsRegistry.getMessageInjector;

    beforeEach(() => {
        registry = RALRegistry.getInstance();
        registry.clear(agentPubkey, conversationId);

        originalGetLLMConfig = config.getLLMConfig.bind(config);
        originalGetMessageInjector = llmOpsRegistry.getMessageInjector.bind(llmOpsRegistry);

        (config as { getLLMConfig: typeof config.getLLMConfig }).getLLMConfig = mock(() => ({ provider: "codex" } as any));
    });

    afterEach(() => {
        (config as { getLLMConfig: typeof config.getLLMConfig }).getLLMConfig = originalGetLLMConfig;
        (llmOpsRegistry as { getMessageInjector: typeof llmOpsRegistry.getMessageInjector }).getMessageInjector = originalGetMessageInjector;
        registry.clear(agentPubkey, conversationId);
    });

    it("delivers to the live injector and clears only the matching queued message", async () => {
        const ralNumber = registry.create(agentPubkey, conversationId, projectId);
        registry.setStreaming(agentPubkey, conversationId, ralNumber, true);
        registry.queueUserMessage(agentPubkey, conversationId, ralNumber, "keep me", {
            eventId: "event-keep",
        });

        const injectMock = mock((_message: string, callback: (delivered: boolean) => void) => {
            callback(true);
        });
        (llmOpsRegistry as { getMessageInjector: typeof llmOpsRegistry.getMessageInjector }).getMessageInjector = mock(() => ({ inject: injectMock } as any));

        const result = await (AgentDispatchService.getInstance() as any).handleDeliveryInjection({
            activeRal: registry.getRAL(agentPubkey, conversationId, ralNumber),
            agent,
            conversationId,
            message: "tell me RED",
            eventId: "event-red",
            agentSpan: { addEvent: mock(() => {}) },
        });

        expect(result).toEqual({ skipExecution: true });
        expect(injectMock).toHaveBeenCalledTimes(1);

        const state = registry.getRAL(agentPubkey, conversationId, ralNumber);
        expect(state?.queuedInjections.map((injection) => injection.eventId)).toEqual(["event-keep"]);
    });

    it("keeps the queued injection when live delivery fails", async () => {
        const ralNumber = registry.create(agentPubkey, conversationId, projectId);
        registry.setStreaming(agentPubkey, conversationId, ralNumber, true);

        const injectMock = mock((_message: string, callback: (delivered: boolean) => void) => {
            callback(false);
        });
        (llmOpsRegistry as { getMessageInjector: typeof llmOpsRegistry.getMessageInjector }).getMessageInjector = mock(() => ({ inject: injectMock } as any));

        const result = await (AgentDispatchService.getInstance() as any).handleDeliveryInjection({
            activeRal: registry.getRAL(agentPubkey, conversationId, ralNumber),
            agent,
            conversationId,
            message: "tell me RED",
            eventId: "event-red",
            agentSpan: { addEvent: mock(() => {}) },
        });

        expect(result).toEqual({ skipExecution: true });
        expect(injectMock).toHaveBeenCalledTimes(1);

        const state = registry.getRAL(agentPubkey, conversationId, ralNumber);
        expect(state?.queuedInjections.map((injection) => injection.eventId)).toEqual(["event-red"]);
    });
});

describe("AgentDispatchService delegation kill-signal wake-up", () => {
    const agentPubkey = "kill-parent-agent-pubkey";
    const conversationId = "kill-parent-conversation-id";
    const delegationConversationId = "kill-child-conversation-id";
    const recipientPubkey = "kill-child-agent-pubkey";
    const projectId = "test-project";
    const agent = {
        pubkey: agentPubkey,
        slug: "tester",
        llmConfig: "codex-config",
    } as AgentInstance;

    let registry: RALRegistry;
    let service: any;

    beforeEach(() => {
        registry = RALRegistry.getInstance();
        registry.clearAll();
        service = AgentDispatchService.getInstance() as any;
    });

    afterEach(() => {
        registry.clearAll();
        mock.restore();
    });

    it("resumes the immediate parent exactly once when the parent is idle", async () => {
        const ralNumber = registry.create(agentPubkey, conversationId, projectId);
        registry.mergePendingDelegations(agentPubkey, conversationId, ralNumber, [
            {
                type: "standard",
                delegationConversationId,
                recipientPubkey,
                senderPubkey: agentPubkey,
                prompt: "Handle the child task",
                ralNumber,
            },
        ]);
        registry.markParentDelegationKilled(delegationConversationId, "killed by operator");

        spyOn(service, "waitForDelegationDebounce").mockImplementation(async (key: string) => {
            service.delegationDebounceSequence.set(key, 1);
            return 1;
        });
        spyOn(service, "checkAndBlockIfCooldown").mockResolvedValue(false);

        const createExecutionContextSpy = spyOn(
            executionContextFactoryModule,
            "createExecutionContext"
        ).mockImplementation(async () => ({
            conversationId,
            agent,
        }) as any);

        spyOn(metadataDebounceManager, "onAgentStart").mockImplementation(() => undefined);
        spyOn(metadataDebounceManager, "schedulePublish").mockImplementation(() => undefined);

        const parentStore = {
            updateDelegationMarker: mock(() => true),
            save: mock(async () => undefined),
        };
        spyOn(ConversationStore, "get").mockReturnValue(parentStore as any);

        const agentExecutor = {
            execute: mock(async () => undefined),
        } as any;

        const killSignalEnvelope = createMockInboundEnvelope({
            principal: {
                id: `nostr:${agentPubkey}`,
                transport: "nostr",
                linkedPubkey: agentPubkey,
                kind: "agent",
            },
            message: {
                id: "kill-signal-event",
                transport: "nostr",
                nativeId: "kill-signal-event",
            },
            metadata: {
                eventKind: NDKKind.DelegationMarker,
                replyTargets: [delegationConversationId, conversationId],
                delegationConversationId,
                delegationParentConversationId: conversationId,
                delegationMarkerStatus: "aborted",
            },
        });

        await service.handleDelegationResponse(
            killSignalEnvelope,
            { agent, conversationId },
            agentExecutor,
            {
                project: { dTag: projectId },
                agentRegistry: { getBasePath: () => "/tmp/project" },
                mcpManager: undefined,
            },
            trace.getTracer("test").startSpan("parent")
        );

        expect(agentExecutor.execute).toHaveBeenCalledTimes(1);
        expect(createExecutionContextSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                agent,
                conversationId,
                isDelegationCompletion: true,
            })
        );
    });

    it("does not schedule a second execute when the parent is already streaming", async () => {
        const ralNumber = registry.create(agentPubkey, conversationId, projectId);
        registry.setStreaming(agentPubkey, conversationId, ralNumber, true);
        registry.mergePendingDelegations(agentPubkey, conversationId, ralNumber, [
            {
                type: "standard",
                delegationConversationId,
                recipientPubkey,
                senderPubkey: agentPubkey,
                prompt: "Handle the child task",
                ralNumber,
            },
        ]);
        registry.markParentDelegationKilled(delegationConversationId, "killed by operator");

        spyOn(service, "waitForDelegationDebounce").mockImplementation(async (key: string) => {
            service.delegationDebounceSequence.set(key, 1);
            return 1;
        });
        spyOn(service, "checkAndBlockIfCooldown").mockResolvedValue(false);

        const parentStore = {
            updateDelegationMarker: mock(() => true),
            save: mock(async () => undefined),
            addDelegationMarker: mock(() => undefined),
        };
        spyOn(ConversationStore, "get").mockReturnValue(parentStore as any);

        const agentExecutor = {
            execute: mock(async () => undefined),
        } as any;

        const killSignalEnvelope = createMockInboundEnvelope({
            principal: {
                id: `nostr:${agentPubkey}`,
                transport: "nostr",
                linkedPubkey: agentPubkey,
                kind: "agent",
            },
            message: {
                id: "kill-signal-event-streaming",
                transport: "nostr",
                nativeId: "kill-signal-event-streaming",
            },
            metadata: {
                eventKind: NDKKind.DelegationMarker,
                replyTargets: [delegationConversationId, conversationId],
                delegationConversationId,
                delegationParentConversationId: conversationId,
                delegationMarkerStatus: "aborted",
            },
        });

        await service.handleDelegationResponse(
            killSignalEnvelope,
            { agent, conversationId },
            agentExecutor,
            {
                project: { dTag: projectId },
                agentRegistry: { getBasePath: () => "/tmp/project" },
                mcpManager: undefined,
            },
            trace.getTracer("test").startSpan("parent-streaming")
        );

        expect(agentExecutor.execute).not.toHaveBeenCalled();
        expect(parentStore.save).toHaveBeenCalledTimes(2);
        expect(
            registry.getConversationCompletedDelegations(agentPubkey, conversationId, ralNumber)
        ).toHaveLength(0);
    });
});
