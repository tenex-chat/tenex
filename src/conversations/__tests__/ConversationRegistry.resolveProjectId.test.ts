/**
 * Tests for ConversationRegistry.resolveProjectId resolution chain
 *
 * Verifies the priority chain:
 *   1. Explicit projectId parameter
 *   2. Envelope projectBinding
 *   3. Single-project shortcut (unambiguous when only one project)
 *
 * Also tests that multiple initialize() calls accumulate entries.
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { conversationRegistry } from "../ConversationRegistry";
import type { InboundEnvelope } from "@/events/runtime/InboundEnvelope";
import { logger } from "@/utils/logger";

describe("ConversationRegistry.resolveProjectId", () => {
    const TEST_DIR = "/tmp/tenex-test-resolve-project-id";
    const PROJECT_A = "project-alpha";
    const PROJECT_B = "project-beta";

    function createEnvelope(projectId: string): InboundEnvelope {
        return {
            transport: "nostr",
            principal: {
                id: "nostr:user-pubkey",
                transport: "nostr",
                linkedPubkey: "user-pubkey",
                kind: "human",
            },
            channel: {
                id: `nostr:project:31933:test-owner:${projectId}`,
                transport: "nostr",
                kind: "conversation",
                projectBinding: `31933:test-owner:${projectId}`,
            },
            message: {
                id: `nostr:${projectId}:message`,
                transport: "nostr",
                nativeId: `${projectId}-message`,
            },
            recipients: [],
            content: "test",
            occurredAt: Date.now(),
            capabilities: [],
            metadata: {},
        };
    }

    beforeEach(() => {
        conversationRegistry.reset();
    });

    afterEach(() => {
        conversationRegistry.reset();
        mock.restore();
    });

    describe("Tier 1: Explicit projectId parameter", () => {
        it("should return the explicit projectId when provided", () => {
            conversationRegistry.initialize(`${TEST_DIR}/${PROJECT_A}`, []);

            const result = conversationRegistry.resolveProjectId("explicit-project");
            expect(result).toBe("explicit-project");
        });

        it("should prefer explicit projectId over envelope projectBinding", () => {
            const envelope = createEnvelope(PROJECT_A);

            const result = conversationRegistry.resolveProjectId("explicit-override", envelope);

            expect(result).toBe("explicit-override");
        });
    });

    describe("Tier 2: Envelope projectBinding", () => {
        it("should resolve from envelope projectBinding when no explicit param given", () => {
            conversationRegistry.initialize(`${TEST_DIR}/${PROJECT_A}`, []);

            const result = conversationRegistry.resolveProjectId(undefined, createEnvelope(PROJECT_A));

            expect(result).toBe(PROJECT_A);
        });

        it("should fall through when envelope projectBinding has unknown project dTag", () => {
            conversationRegistry.initialize(`${TEST_DIR}/${PROJECT_A}`, []);

            const result = conversationRegistry.resolveProjectId(
                undefined,
                createEnvelope("unknown-project")
            );

            // Should fall through to single-project shortcut
            expect(result).toBe(PROJECT_A);
        });

        it("should fall through when envelope lacks projectBinding", () => {
            conversationRegistry.initialize(`${TEST_DIR}/${PROJECT_A}`, []);

            const envelope = createEnvelope(PROJECT_A);
            envelope.channel.projectBinding = undefined;
            const result = conversationRegistry.resolveProjectId(undefined, envelope);

            // Should fall through to single-project shortcut
            expect(result).toBe(PROJECT_A);
        });
    });

    describe("Tier 3: Single-project shortcut", () => {
        it("should return the sole project when only one is initialized", () => {
            conversationRegistry.initialize(`${TEST_DIR}/${PROJECT_A}`, []);

            // Without an explicit or envelope-scoped binding, the single initialized
            // project remains unambiguous.
            const result = conversationRegistry.resolveProjectId();
            expect(result).toBe(PROJECT_A);
        });

        it("should return null when multiple projects are initialized without project binding", () => {
            conversationRegistry.initialize(`${TEST_DIR}/${PROJECT_A}`, []);
            conversationRegistry.initialize(`${TEST_DIR}/${PROJECT_B}`, []);

            // Without an explicit or envelope-scoped binding, multi-project mode
            // has no safe implicit resolution.
            const result = conversationRegistry.resolveProjectId();
            expect(result).toBeNull();
        });

        it("should not log any warnings in multi-project mode", () => {
            const warnSpy = spyOn(logger, "warn");
            warnSpy.mockClear();

            conversationRegistry.initialize(`${TEST_DIR}/${PROJECT_A}`, []);
            conversationRegistry.initialize(`${TEST_DIR}/${PROJECT_B}`, []);

            conversationRegistry.resolveProjectId();

            // No legacy fallback warning should be emitted
            const fallbackCalls = warnSpy.mock.calls.filter(
                (call) =>
                    typeof call[0] === "string" && call[0].includes("legacy projectId fallback")
            );
            expect(fallbackCalls).toHaveLength(0);
        });

        it("should return null when no project has been initialized", () => {
            const result = conversationRegistry.resolveProjectId();
            expect(result).toBeNull();
        });
    });

    describe("Multiple initialize() calls accumulate entries", () => {
        it("should accumulate project configs across multiple initialize() calls", () => {
            const agentsA = ["pubkey-a1", "pubkey-a2"];
            const agentsB = ["pubkey-b1"];

            conversationRegistry.initialize(`${TEST_DIR}/${PROJECT_A}`, agentsA);
            conversationRegistry.initialize(`${TEST_DIR}/${PROJECT_B}`, agentsB);

            const resolvedA = conversationRegistry.resolveProjectId(
                undefined,
                createEnvelope(PROJECT_A)
            );
            expect(resolvedA).toBe(PROJECT_A);

            const resolvedB = conversationRegistry.resolveProjectId(
                undefined,
                createEnvelope(PROJECT_B)
            );
            expect(resolvedB).toBe(PROJECT_B);
        });

        it("should fall back to the union of all agent pubkeys when no project can be resolved", () => {
            const agentsA = ["pubkey-a1", "pubkey-a2"];
            const agentsB = ["pubkey-b1"];

            conversationRegistry.initialize(`${TEST_DIR}/${PROJECT_A}`, agentsA);
            conversationRegistry.initialize(`${TEST_DIR}/${PROJECT_B}`, agentsB);

            expect(conversationRegistry.agentPubkeys).toEqual(
                new Set(["pubkey-a1", "pubkey-a2", "pubkey-b1"])
            );
        });

        it("should merge all agent pubkeys into allAgentPubkeys union", () => {
            const agentsA = ["pubkey-a1", "pubkey-a2"];
            const agentsB = ["pubkey-b1", "pubkey-a1"]; // pubkey-a1 overlaps

            conversationRegistry.initialize(`${TEST_DIR}/${PROJECT_A}`, agentsA);
            conversationRegistry.initialize(`${TEST_DIR}/${PROJECT_B}`, agentsB);

            // isAgentPubkey checks the union across all projects
            expect(conversationRegistry.isAgentPubkey("pubkey-a1")).toBe(true);
            expect(conversationRegistry.isAgentPubkey("pubkey-a2")).toBe(true);
            expect(conversationRegistry.isAgentPubkey("pubkey-b1")).toBe(true);
            expect(conversationRegistry.isAgentPubkey("pubkey-unknown")).toBe(false);
        });

        it("should not overwrite first project config when second is initialized", () => {
            const agentsA = ["pubkey-a1"];
            conversationRegistry.initialize(`${TEST_DIR}/${PROJECT_A}`, agentsA);

            // Verify project A is registered
            expect(conversationRegistry.isAgentPubkey("pubkey-a1")).toBe(true);

            const agentsB = ["pubkey-b1"];
            conversationRegistry.initialize(`${TEST_DIR}/${PROJECT_B}`, agentsB);

            // Project A's agents should still be accessible
            expect(conversationRegistry.isAgentPubkey("pubkey-a1")).toBe(true);
            expect(conversationRegistry.isAgentPubkey("pubkey-b1")).toBe(true);
        });

        it("should return null without project binding when multiple projects are initialized", () => {
            conversationRegistry.initialize(`${TEST_DIR}/${PROJECT_A}`, []);
            conversationRegistry.initialize(`${TEST_DIR}/${PROJECT_B}`, []);

            // Without an explicit or envelope-scoped binding, multi-project mode
            // has no safe implicit resolution.
            const result = conversationRegistry.resolveProjectId();
            expect(result).toBeNull();
        });
    });
});
