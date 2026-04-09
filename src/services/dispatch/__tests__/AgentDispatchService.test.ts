import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { AgentInstance } from "@/agents/types";
import { config } from "@/services/ConfigService";
import { llmOpsRegistry } from "@/services/LLMOperationsRegistry";
import { RALRegistry } from "@/services/ral";
import { AgentDispatchService } from "../AgentDispatchService";
import type { AgentExecutor } from "@/agents/execution/AgentExecutor";
import type { InboundEnvelope } from "@/events/runtime/InboundEnvelope";
import { NDKKind } from "@/nostr/kinds";

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

describe("AgentDispatchService.dispatchKillWakeup", () => {
    const delegationConversationId = "delegation-conv-kill-abc123";
    const abortReason = "parent killed child delegation";
    const completedAt = 1700000000;

    let service: AgentDispatchService;
    let savedExecutor: AgentExecutor | null;
    let originalDispatch: AgentDispatchService["dispatch"];

    beforeEach(() => {
        service = AgentDispatchService.getInstance();
        // Save and clear the stored executor so tests start from a known state
        savedExecutor = (service as any).agentExecutor as AgentExecutor | null;
        (service as any).agentExecutor = null;
        // Save dispatch so we can restore after tests that replace it
        originalDispatch = service.dispatch.bind(service);
    });

    afterEach(() => {
        // Restore executor and dispatch
        (service as any).agentExecutor = savedExecutor;
        service.dispatch = originalDispatch;
    });

    it("is a no-op when no AgentExecutor has been registered", async () => {
        // agentExecutor is null — set explicitly
        (service as any).agentExecutor = null;

        const dispatchMock = mock(async (_envelope: InboundEnvelope) => {});
        service.dispatch = dispatchMock;

        await service.dispatchKillWakeup({ delegationConversationId, abortReason, completedAt });

        // dispatch must never be called when executor is absent
        expect(dispatchMock).not.toHaveBeenCalled();
    });

    it("builds a kill-signal envelope and calls dispatch when executor is registered", async () => {
        const mockExecutor = {} as AgentExecutor;
        service.setAgentExecutor(mockExecutor);

        const capturedEnvelopes: InboundEnvelope[] = [];
        service.dispatch = mock(async (envelope: InboundEnvelope) => {
            capturedEnvelopes.push(envelope);
        });

        await service.dispatchKillWakeup({ delegationConversationId, abortReason, completedAt });

        expect(capturedEnvelopes).toHaveLength(1);
        const envelope = capturedEnvelopes[0];

        // The envelope must be a local transport kill-signal
        expect(envelope.transport).toBe("local");
        expect(envelope.metadata.isKillSignal).toBe(true);
        expect(envelope.metadata.killSignalDelegationConversationId).toBe(delegationConversationId);
        expect(envelope.metadata.eventKind).toBe(NDKKind.TenexKillSignal);

        // Content describes the abort reason
        expect(envelope.content).toContain(abortReason);

        // Timestamp matches completedAt
        expect(envelope.occurredAt).toBe(completedAt);

        // No recipients: this is a control-plane-only signal
        expect(envelope.recipients).toHaveLength(0);
    });
});
