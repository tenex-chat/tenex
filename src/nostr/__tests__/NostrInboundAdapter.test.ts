import { describe, expect, it } from "bun:test";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { NostrInboundAdapter } from "@/nostr/NostrInboundAdapter";

describe("NostrInboundAdapter", () => {
    it("normalizes a project-routed reply into the canonical inbound envelope", () => {
        const event = new NDKEvent();
        event.id = "a".repeat(64);
        event.kind = 1;
        event.pubkey = "b".repeat(64);
        event.content = "hello from nostr";
        event.created_at = 1_773_400_000;
        event.tags = [
            ["p", "c".repeat(64)],
            ["p", "d".repeat(64)],
            ["e", "e".repeat(64)],
            ["a", "31933:owner-pubkey:demo-project"],
        ];

        const adapter = new NostrInboundAdapter();
        const envelope = adapter.toEnvelope(event);

        expect(envelope.transport).toBe("nostr");
        expect(envelope.principal).toEqual({
            id: `nostr:${event.pubkey}`,
            transport: "nostr",
            linkedPubkey: event.pubkey,
        });
        expect(envelope.channel).toEqual({
            id: "nostr:project:31933:owner-pubkey:demo-project",
            transport: "nostr",
            kind: "project",
            projectBinding: "31933:owner-pubkey:demo-project",
        });
        expect(envelope.message).toEqual({
            id: `nostr:${event.id}`,
            transport: "nostr",
            nativeId: event.id,
            replyToId: `nostr:${"e".repeat(64)}`,
        });
        expect(envelope.recipients.map((recipient) => recipient.id)).toEqual([
            `nostr:${"c".repeat(64)}`,
            `nostr:${"d".repeat(64)}`,
        ]);
        expect(envelope.recipients.map((recipient) => recipient.linkedPubkey)).toEqual([
            "c".repeat(64),
            "d".repeat(64),
        ]);
        expect(envelope.content).toBe(event.content);
        expect(envelope.occurredAt).toBe(event.created_at);
        expect(envelope.capabilities).toEqual([
            "fanout-recipient-tags",
            "project-routing-a-tag",
            "threaded-replies",
        ]);
        expect(envelope.metadata).toEqual({
            eventKind: 1,
            eventTagCount: 4,
        });
    });
});
