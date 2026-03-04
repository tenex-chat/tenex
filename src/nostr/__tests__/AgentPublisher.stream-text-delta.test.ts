import { describe, expect, it, mock, spyOn } from "bun:test";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { AgentPublisher } from "../AgentPublisher";
import type { AgentInstance } from "@/agents/types";
import type { EventContext } from "../types";

const loggerMocks = {
    debug: mock(),
    info: mock(),
    warn: mock(),
    error: mock(),
};

mock.module("../ndkClient", () => ({
    getNDK: mock(() => ({})),
}));

mock.module("../trace-context", () => ({
    injectTraceContext: mock(),
}));

mock.module("@/services/projects", () => ({
    getProjectContext: mock(() => ({
        project: {
            tagReference: () => ["a", "31933:testpubkey:test-project"],
            pubkey: "testpubkey",
        },
        agentRegistry: {
            getAgentByPubkey: () => null,
        },
    })),
}));

mock.module("@/utils/logger", () => ({
    logger: loggerMocks,
}));

describe("AgentPublisher.streamTextDelta", () => {
    it("swallows publish failures (best-effort) and does not throw", async () => {
        const publishSpy = spyOn(NDKEvent.prototype, "publish").mockRejectedValue(
            new Error("relay rejected")
        );

        const agent = {
            slug: "test-agent",
            pubkey: "abcdef1234567890",
            sign: mock(() => Promise.resolve()),
        } as unknown as AgentInstance;
        const publisher = new AgentPublisher(agent);

        const triggeringEvent = new NDKEvent();
        triggeringEvent.id = "trigger-id";
        triggeringEvent.pubkey = "trigger-pubkey";
        triggeringEvent.tags = [];

        const context: EventContext = {
            triggeringEvent,
            rootEvent: { id: "root-event-id" },
            conversationId: "conversation-id-123",
            model: "anthropic:claude-haiku-4-5",
            ralNumber: 1,
        };

        await expect(
            publisher.streamTextDelta(
                {
                    delta: "hello",
                    sequence: 1,
                },
                context
            )
        ).resolves.toBeUndefined();

        expect(agent.sign).toHaveBeenCalledTimes(1);
        expect(publishSpy).toHaveBeenCalledTimes(1);
        expect(loggerMocks.warn).toHaveBeenCalled();
    });
});
