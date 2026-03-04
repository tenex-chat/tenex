import { describe, expect, it, mock } from "bun:test";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { NDKKind } from "@/nostr/kinds";
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
        const triggeringEvent = new NDKEvent();
        triggeringEvent.id = "trigger-id";
        triggeringEvent.pubkey = "trigger-pubkey";
        triggeringEvent.tags = [["branch", "feature/alpha"]];

        const context: EventContext = {
            triggeringEvent,
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
