import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import * as projectsModule from "@/services/projects";
import { AgentPublisher } from "../AgentPublisher";
import type { AgentInstance } from "@/agents/types";
import type { EventContext } from "../types";
import { createMockInboundEnvelope } from "@/test-utils/mock-factories";
import { logger } from "@/utils/logger";
import * as ndkClientModule from "../ndkClient";
import * as traceContextModule from "../trace-context";

const loggerMocks = {
    debug: mock(),
    info: mock(),
    warn: mock(),
    error: mock(),
};

describe("AgentPublisher.streamTextDelta", () => {
    beforeEach(() => {
        spyOn(ndkClientModule, "getNDK").mockReturnValue({} as any);
        spyOn(traceContextModule, "injectTraceContext").mockImplementation(() => {});
        spyOn(projectsModule, "getProjectContext").mockReturnValue({
            project: {
                tagReference: () => ["a", "31933:testpubkey:test-project"],
                pubkey: "testpubkey",
            },
            agentRegistry: {
                getAgentByPubkey: () => null,
            },
        } as any);
        spyOn(logger, "debug").mockImplementation(loggerMocks.debug);
        spyOn(logger, "info").mockImplementation(loggerMocks.info);
        spyOn(logger, "warn").mockImplementation(loggerMocks.warn);
        spyOn(logger, "error").mockImplementation(loggerMocks.error);
    });

    afterEach(() => {
        mock.restore();
    });

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

        const triggeringEnvelope = createMockInboundEnvelope({
            principal: {
                id: "trigger-pubkey",
                transport: "nostr",
                linkedPubkey: "trigger-pubkey",
                kind: "human",
            },
            message: {
                id: "trigger-id",
                transport: "nostr",
                nativeId: "trigger-id",
            },
        });

        const context: EventContext = {
            triggeringEnvelope,
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
