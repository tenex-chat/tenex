import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import * as projectsModule from "@/services/projects";
import { AgentPublisher } from "../AgentPublisher";
import type { AgentInstance } from "@/agents/types";
import type { EventContext } from "../types";
import { createMockInboundEnvelope } from "@/test-utils/mock-factories";
import { logger } from "@/utils/logger";
import * as ndkClientModule from "../ndkClient";
import * as rustPublishOutbox from "../RustPublishOutbox";
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

    it("swallows Rust outbox enqueue failures (best-effort) and does not throw", async () => {
        const enqueueSpy = spyOn(
            rustPublishOutbox,
            "enqueueSignedEventForRustPublish"
        ).mockRejectedValue(new Error("outbox unavailable"));
        const signer = NDKPrivateKeySigner.generate();

        const agent = {
            slug: "test-agent",
            pubkey: (await signer.user()).pubkey,
            sign: mock((event: NDKEvent) => event.sign(signer)),
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
        expect(enqueueSpy).toHaveBeenCalledTimes(1);
        expect(loggerMocks.warn).toHaveBeenCalled();
    });

    it("enqueues signed stream deltas for Rust publishing without direct relay publish", async () => {
        let capturedEvent: NDKEvent | undefined;
        let capturedContext: rustPublishOutbox.RustPublishOutboxContext | undefined;
        const enqueueSpy = spyOn(
            rustPublishOutbox,
            "enqueueSignedEventForRustPublish"
        ).mockImplementation(async (event, context = {}) => {
            capturedEvent = event;
            capturedContext = context;
            return event.rawEvent() as Awaited<ReturnType<typeof rustPublishOutbox.enqueueSignedEventForRustPublish>>;
        });
        const publishSpy = spyOn(NDKEvent.prototype, "publish");
        const signer = NDKPrivateKeySigner.generate();
        const agent = {
            slug: "test-agent",
            pubkey: (await signer.user()).pubkey,
            sign: mock((event: NDKEvent) => event.sign(signer)),
        } as unknown as AgentInstance;
        const publisher = new AgentPublisher(agent);

        const context: EventContext = {
            triggeringEnvelope: createMockInboundEnvelope({
                message: {
                    id: "trigger-id",
                    transport: "nostr",
                    nativeId: "trigger-id",
                },
            }),
            rootEvent: { id: "root-event-id" },
            conversationId: "conversation-id-123",
            model: "anthropic:claude-haiku-4-5",
            ralNumber: 1,
        };

        await publisher.streamTextDelta(
            {
                delta: "hello",
                sequence: 3,
            },
            context
        );

        expect(agent.sign).toHaveBeenCalledTimes(1);
        expect(enqueueSpy).toHaveBeenCalledTimes(1);
        expect(capturedEvent?.rawEvent().sig).toBeString();
        expect(capturedEvent?.tags).toContainEqual(["stream-seq", "3"]);
        expect(capturedContext).toMatchObject({
            correlationId: "agent_stream_delta",
            conversationId: "conversation-id-123",
            waitForRelayOk: false,
        });
        expect(capturedContext?.requestId).toStartWith(
            "agent-stream-delta:conversation-id-123:3:"
        );
        expect(publishSpy).not.toHaveBeenCalled();
    });
});
