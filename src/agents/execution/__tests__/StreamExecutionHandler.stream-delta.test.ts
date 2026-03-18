import { describe, expect, it, mock } from "bun:test";
import type { EventContext } from "@/nostr/types";
import { createMockInboundEnvelope } from "@/test-utils/mock-factories";
import { StreamExecutionHandler } from "../StreamExecutionHandler";

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function createHandler(streamTextDeltaMock: ReturnType<typeof mock>): StreamExecutionHandler {
    const triggeringEnvelope = createMockInboundEnvelope({
        principal: {
            id: "trigger-pubkey",
            transport: "nostr",
            linkedPubkey: "trigger-pubkey",
            kind: "human",
        },
        message: {
            id: "trigger-event-id",
            transport: "nostr",
            nativeId: "trigger-event-id",
        },
    });

    const handler = new StreamExecutionHandler({
        context: {
            agent: {
                pubkey: "agent-pubkey",
                slug: "agent",
                name: "Agent",
            },
            agentPublisher: {
                streamTextDelta: streamTextDeltaMock,
            },
            conversationId: "conversation-id",
            conversationStore: {
                getMetaModelVariantOverride: () => undefined,
            },
            triggeringEnvelope,
        } as any,
        toolTracker: {} as any,
        ralNumber: 42,
        toolsObject: {},
        sessionManager: {} as any,
        llmService: {} as any,
        messageCompiler: {} as any,
        request: {
            messages: [],
        },
        nudgeContent: "",
        skillContent: "",
        skills: [],
        abortSignal: new AbortController().signal,
    });

    const eventContext: EventContext = {
        triggeringEnvelope,
        rootEvent: { id: "root-event-id" },
        conversationId: "conversation-id",
        model: "anthropic:claude-haiku-4-5",
        ralNumber: 42,
    };
    (handler as any).streamTextDeltaEventContext = eventContext;

    return handler;
}

describe("StreamExecutionHandler stream text delta throttling", () => {
    it("coalesces text deltas into one publish per throttle window", async () => {
        const streamTextDeltaMock = mock(() => Promise.resolve());
        const handler = createHandler(streamTextDeltaMock);

        (handler as any).enqueueStreamTextDelta("hello");
        (handler as any).enqueueStreamTextDelta(" world");

        await sleep(250);
        expect(streamTextDeltaMock).not.toHaveBeenCalled();

        await sleep(900);
        expect(streamTextDeltaMock).toHaveBeenCalledTimes(1);

        const [intent] = streamTextDeltaMock.mock.calls[0] as [{ delta: string; sequence: number }];
        expect(intent.delta).toBe("hello world");
        expect(intent.sequence).toBe(1);
    });

    it("force flush publishes immediately and keeps strict sequence order", async () => {
        const streamTextDeltaMock = mock(() => Promise.resolve());
        const handler = createHandler(streamTextDeltaMock);

        (handler as any).enqueueStreamTextDelta("hello");
        await (handler as any).flushStreamTextDeltas({
            force: true,
            reason: "test-force-1",
        });

        (handler as any).enqueueStreamTextDelta(" world");
        await (handler as any).flushStreamTextDeltas({
            force: true,
            reason: "test-force-2",
        });

        expect(streamTextDeltaMock).toHaveBeenCalledTimes(2);

        const [firstIntent] = streamTextDeltaMock.mock.calls[0] as [{ delta: string; sequence: number }];
        const [secondIntent] = streamTextDeltaMock.mock.calls[1] as [{ delta: string; sequence: number }];

        expect(firstIntent).toEqual({
            delta: "hello",
            sequence: 1,
        });
        expect(secondIntent).toEqual({
            delta: " world",
            sequence: 2,
        });
    });
});
