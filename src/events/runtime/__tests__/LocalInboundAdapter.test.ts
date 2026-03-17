import { describe, expect, it } from "bun:test";
import { LocalInboundAdapter } from "@/events/runtime/LocalInboundAdapter";

describe("LocalInboundAdapter", () => {
    it("normalizes a linked local principal into a canonical inbound envelope", () => {
        const adapter = new LocalInboundAdapter();

        const envelope = adapter.toEnvelope({
            principal: {
                id: "telegram:user:42",
                linkedPubkey: "b".repeat(64),
                displayName: "Alice Telegram",
                kind: "human",
            },
            channel: {
                id: "telegram:dm:42",
                kind: "project",
                projectBinding: `31933:${"f".repeat(64)}:transport-smoke-project`,
            },
            message: {
                id: "telegram-message-1",
            },
            recipients: [
                {
                    id: "nostr:agent-pubkey",
                    linkedPubkey: "a".repeat(64),
                    kind: "agent",
                },
            ],
            content: "hello from local transport",
            occurredAt: 123,
        });

        expect(envelope.transport).toBe("local");
        expect(envelope.principal).toEqual({
            id: "telegram:user:42",
            transport: "local",
            linkedPubkey: "b".repeat(64),
            displayName: "Alice Telegram",
            username: undefined,
            kind: "human",
        });
        expect(envelope.channel).toEqual({
            id: "telegram:dm:42",
            transport: "local",
            kind: "project",
            projectBinding: `31933:${"f".repeat(64)}:transport-smoke-project`,
        });
        expect(envelope.message).toEqual({
            id: "local:telegram-message-1",
            transport: "local",
            nativeId: "telegram-message-1",
            replyToId: undefined,
        });
        expect(envelope.recipients).toEqual([
            {
                id: "nostr:agent-pubkey",
                transport: "local",
                linkedPubkey: "a".repeat(64),
                displayName: undefined,
                username: undefined,
                kind: "agent",
            },
        ]);
        expect(envelope.metadata.eventKind).toBe(1);
        expect(envelope.metadata.eventTagCount).toBe(2);
    });
});
