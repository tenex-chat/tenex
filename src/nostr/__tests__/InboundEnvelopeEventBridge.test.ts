import { describe, expect, it } from "bun:test";
import type { InboundEnvelope } from "@/events/runtime/InboundEnvelope";
import { InboundEnvelopeEventBridge } from "@/nostr/InboundEnvelopeEventBridge";

describe("InboundEnvelopeEventBridge", () => {
    it("uses linked pubkeys when present", () => {
        const bridge = new InboundEnvelopeEventBridge();
        const envelope: InboundEnvelope = {
            transport: "local",
            principal: {
                id: "telegram:user:42",
                transport: "local",
                linkedPubkey: "1".repeat(64),
                displayName: "Alice Telegram",
                kind: "human",
            },
            channel: {
                id: "telegram:dm:42",
                transport: "local",
                kind: "project",
                projectBinding: `31933:${"2".repeat(64)}:transport-smoke-project`,
            },
            message: {
                id: "local:message-1",
                transport: "local",
                nativeId: "message-1",
                replyToId: "local:message-0",
            },
            recipients: [
                {
                    id: "telegram:agent:1",
                    transport: "local",
                    linkedPubkey: "3".repeat(64),
                    kind: "agent",
                },
            ],
            content: "hello bridge",
            occurredAt: 123,
            capabilities: ["local-test-gateway"],
            metadata: {
                eventKind: 1,
                eventTagCount: 3,
            },
        };

        const event = bridge.toEvent(envelope);

        expect(event.id).toBe("message-1");
        expect(event.pubkey).toBe("1".repeat(64));
        expect(event.created_at).toBe(123);
        expect(event.tags).toEqual([
            ["transport", "local"],
            ["principal", "telegram:user:42"],
            ["channel", "telegram:dm:42"],
            ["a", `31933:${"2".repeat(64)}:transport-smoke-project`],
            ["e", "message-0"],
            ["p", "3".repeat(64)],
        ]);
    });

    it("synthesizes a deterministic pubkey for transport-only principals", () => {
        const bridge = new InboundEnvelopeEventBridge();
        const envelope: InboundEnvelope = {
            transport: "local",
            principal: {
                id: "telegram:user:99",
                transport: "local",
                displayName: "Unlinked User",
                kind: "human",
            },
            channel: {
                id: "telegram:group:55",
                transport: "local",
                kind: "group",
            },
            message: {
                id: "local:message-2",
                transport: "local",
                nativeId: "message-2",
            },
            recipients: [],
            content: "hello unlinked",
            occurredAt: 456,
            capabilities: [],
            metadata: {},
        };

        const event = bridge.toEvent(envelope);

        expect(event.pubkey).toMatch(/^[0-9a-f]{64}$/);
        expect(event.pubkey).toBe(bridge.toEvent(envelope).pubkey);
        expect(event.tags).toEqual([
            ["transport", "local"],
            ["principal", "telegram:user:99"],
            ["channel", "telegram:group:55"],
        ]);
    });

    it("preserves Telegram routing tags needed for outbound delivery", () => {
        const bridge = new InboundEnvelopeEventBridge();
        const envelope: InboundEnvelope = {
            transport: "telegram",
            principal: {
                id: "telegram:user:42",
                transport: "telegram",
                kind: "human",
            },
            channel: {
                id: "telegram:group:-2001:topic:55",
                transport: "telegram",
                kind: "topic",
                projectBinding: `31933:${"2".repeat(64)}:transport-smoke-project`,
            },
            message: {
                id: "telegram:tg_n2001_99",
                transport: "telegram",
                nativeId: "tg_n2001_99",
            },
            recipients: [
                {
                    id: `nostr:${"3".repeat(64)}`,
                    transport: "nostr",
                    linkedPubkey: "3".repeat(64),
                    kind: "agent",
                },
            ],
            content: "hello telegram bridge",
            occurredAt: 123,
            capabilities: ["telegram-bot"],
            metadata: {
                eventKind: 1,
                eventTagCount: 4,
            },
        };

        const event = bridge.toEvent(envelope);

        expect(event.tags).toContainEqual(["telegram-chat-id", "-2001"]);
        expect(event.tags).toContainEqual(["telegram-message-id", "99"]);
        expect(event.tags).toContainEqual(["telegram-thread-id", "55"]);
    });
});
