import { describe, expect, it, mock } from "bun:test";
import { NDKKind } from "@/nostr/kinds";
import { createMockInboundEnvelope } from "@/test-utils/mock-factories";
import { AgentEventEncoder } from "../AgentEventEncoder";
import type { EventContext } from "../types";

mock.module("../ndkClient", () => ({
    getNDK: mock(() => ({})),
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
    logger: {
        debug: mock(),
        info: mock(),
        warn: mock(),
        error: mock(),
    },
}));

describe("AgentEventEncoder.encodeStreamTextDelta", () => {
    it("encodes ephemeral stream-delta events with required tags and no completion routing tags", () => {
        const encoder = new AgentEventEncoder();
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
            metadata: {
                branchName: "feature/alpha",
            },
        });

        const context: EventContext = {
            triggeringEnvelope,
            rootEvent: { id: "root-conv-id" },
            conversationId: "conversation-id",
            model: "anthropic:claude-haiku-4-5",
            ralNumber: 7,
        };

        const event = encoder.encodeStreamTextDelta(
            {
                delta: "hello world",
                sequence: 3,
            },
            context
        );

        expect(event.kind).toBe(NDKKind.TenexStreamTextDelta);
        expect(event.content).toBe("hello world");

        expect(event.tags).toContainEqual(["e", "root-conv-id"]);
        expect(event.tags).toContainEqual(["a", "31933:testpubkey:test-project"]);
        expect(event.tags).toContainEqual(["llm-model", "anthropic:claude-haiku-4-5"]);
        expect(event.tags).toContainEqual(["llm-ral", "7"]);
        expect(event.tags).toContainEqual(["stream-seq", "3"]);
        expect(event.tags).toContainEqual(["branch", "feature/alpha"]);

        expect(event.tags.find((tag) => tag[0] === "p")).toBeUndefined();
        expect(event.tags.find((tag) => tag[0] === "status")).toBeUndefined();
    });
});
