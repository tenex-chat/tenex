import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { NDKKind } from "@/nostr/kinds";
import * as projectsModule from "@/services/projects";
import { createMockInboundEnvelope } from "@/test-utils/mock-factories";
import { logger } from "@/utils/logger";
import { AgentEventEncoder } from "../AgentEventEncoder";
import * as ndkClientModule from "../ndkClient";
import type { EventContext } from "../types";

describe("AgentEventEncoder.encodeStreamTextDelta", () => {
    beforeEach(() => {
        spyOn(ndkClientModule, "getNDK").mockReturnValue({} as any);
        spyOn(projectsModule, "getProjectContext").mockReturnValue({
            project: {
                tagReference: () => ["a", "31933:testpubkey:test-project"],
                pubkey: "testpubkey",
            },
            agentRegistry: {
                getAgentByPubkey: () => null,
            },
        } as any);
        spyOn(logger, "debug").mockImplementation(() => {});
        spyOn(logger, "info").mockImplementation(() => {});
        spyOn(logger, "warn").mockImplementation(() => {});
        spyOn(logger, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        mock.restore();
    });

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
