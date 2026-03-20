import { describe, expect, it } from "bun:test";
import { RecordingRuntimePublisher, RuntimePublishCollector } from "@/events/runtime/RecordingRuntimePublisher";
import type { RuntimePublishAgent } from "@/events/runtime/RuntimeAgent";
import type { EventContext } from "@/nostr/types";

function createAgent(): RuntimePublishAgent {
    return {
        name: "claude-code",
        slug: "claude-code",
        pubkey: "agent-pubkey-1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd",
        sign: async () => undefined,
    };
}

function createContext(): EventContext {
    return {
        triggeringEnvelope: {
            transport: "nostr",
            principal: {
                id: "nostr:user-pubkey",
                transport: "nostr",
                linkedPubkey: "user-pubkey",
            },
            channel: {
                id: "nostr:conversation:root-event",
                transport: "nostr",
                kind: "conversation",
            },
            message: {
                id: "nostr:root-event",
                transport: "nostr",
                nativeId: "root-event",
            },
            recipients: [],
            content: "trigger",
            occurredAt: Math.floor(Date.now() / 1000),
            capabilities: [],
            metadata: {},
        },
        rootEvent: { id: "root-event" },
        conversationId: "conversation-id",
        model: "test-model",
        ralNumber: 1,
    };
}

describe("RecordingRuntimePublisher", () => {
    it("returns a transport-neutral published message ref", async () => {
        const collector = new RuntimePublishCollector();
        const publisher = new RecordingRuntimePublisher(createAgent(), collector);

        const result = await publisher.conversation({ content: "hello world" }, createContext());

        expect(result.transport).toBe("local");
        expect(result.encodedId).toMatch(/^local:/);
        expect(result.envelope.transport).toBe("local");
        expect(result.envelope.principal).toEqual({
            id: `local:${createAgent().pubkey}`,
            transport: "local",
            linkedPubkey: createAgent().pubkey,
            displayName: "claude-code",
            kind: "agent",
        });
        expect(result.envelope.message.nativeId).toBe(result.id);
        expect(result.envelope.metadata.eventKind).toBe(1);
        expect(collector.list()).toHaveLength(1);
        expect(collector.list()[0]?.eventId).toBeUndefined();
    });
});
