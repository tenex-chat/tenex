import {
    buildDiagnosticEventSnapshot,
    getDiagnosticTagValue,
} from "@/events/runtime/diagnostic-event-snapshot";
import { createMockInboundEnvelope } from "@/test-utils/mock-factories";
import { describe, expect, it } from "bun:test";

describe("diagnostic-event-snapshot", () => {
    it("builds a transport-neutral tag view from an envelope", () => {
        const snapshot = buildDiagnosticEventSnapshot(
            createMockInboundEnvelope({
                principal: {
                    id: "telegram:1234",
                    transport: "telegram",
                    linkedPubkey: undefined,
                    kind: "human",
                },
                message: {
                    id: "telegram:5678",
                    transport: "telegram",
                    nativeId: "5678",
                    replyToId: "nostr:reply-id",
                },
                recipients: [
                    {
                        id: "nostr:agent-pubkey",
                        transport: "nostr",
                        linkedPubkey: "agent-pubkey",
                        kind: "agent",
                    },
                ],
                content: "hello",
            })
        );

        expect(snapshot.id).toBe("5678");
        expect(snapshot.senderId).toBe("telegram:1234");
        expect(snapshot.senderLinkedPubkey).toBeUndefined();
        expect(getDiagnosticTagValue(snapshot, "e")).toBe("reply-id");
        expect(getDiagnosticTagValue(snapshot, "p")).toBe("agent-pubkey");
    });

    it("omits sender linked pubkey when the envelope principal is transport-only", () => {
        const snapshot = buildDiagnosticEventSnapshot(
            createMockInboundEnvelope({
                transport: "telegram",
                principal: {
                    id: "telegram:user:1234",
                    transport: "telegram",
                    linkedPubkey: undefined,
                    kind: "human",
                },
                message: {
                    id: "telegram:tg_n2001_5678",
                    transport: "telegram",
                    nativeId: "tg_n2001_5678",
                },
                channel: {
                    id: "telegram:group:-2001:topic:55",
                    transport: "telegram",
                    kind: "topic",
                    projectBinding: `31933:${"a".repeat(64)}:demo-project`,
                },
            })
        );

        expect(snapshot.senderLinkedPubkey).toBeUndefined();
        expect(snapshot.tags).not.toContainEqual(["senderLinkedPubkey", "undefined"]);
        expect(getDiagnosticTagValue(snapshot, "telegram-chat-id")).toBe("-2001");
        expect(getDiagnosticTagValue(snapshot, "telegram-thread-id")).toBe("55");
        expect(getDiagnosticTagValue(snapshot, "telegram-message-id")).toBe("5678");
    });
});
