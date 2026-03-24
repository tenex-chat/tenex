import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { AgentInstance } from "@/agents/types";
import { config } from "@/services/ConfigService";
import { llmOpsRegistry } from "@/services/LLMOperationsRegistry";
import { RALRegistry } from "@/services/ral";
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

        expect(result).toBe(true);
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

        expect(result).toBe(true);
        expect(injectMock).toHaveBeenCalledTimes(1);

        const state = registry.getRAL(agentPubkey, conversationId, ralNumber);
        expect(state?.queuedInjections.map((injection) => injection.eventId)).toEqual(["event-red"]);
    });
});
