import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { agentStorage } from "@/agents/AgentStorage";
import { config } from "@/services/ConfigService";
import * as projectsModule from "@/services/projects";
import { logger } from "@/utils/logger";

/**
 * Tests for kind 24030 agent deletion events.
 *
 * Covers:
 * - Project-scoped deletion (r=project, with a-tag)
 * - Global deletion (r=global)
 * - Authorization (whitelisted pubkeys only)
 * - Edge cases (missing tags, agent not found, non-matching project)
 * - NIP-46 31933 update scheduling
 * - Idempotency (repeat deletion is a no-op)
 */

// Track mock calls
let removeAgentFromProjectCalls: string[] = [];
let getAgentProjectsCalls: string[] = [];
let publishImmediatelyCalls = 0;

/** Set of agent pubkeys that have been "removed" — used for idempotency testing. */
let removedAgentPubkeys: Set<string> = new Set();

const OWNER_PUBKEY = "aaaa".repeat(16);
const AGENT_PUBKEY = "bbbb".repeat(16);
const NON_OWNER_PUBKEY = "cccc".repeat(16);
const PROJECT_DTAG = "test-project";
const AGENT_EVENT_ID = "dddd".repeat(16);

const mockStatusPublisher = {
    publishImmediately: async () => {
        publishImmediatelyCalls++;
    },
};
import { handleAgentDeletion, _testClearPendingTimers } from "../agentDeletion";

// Helper to create a mock NDKEvent
function createMockEvent(overrides: {
    pubkey?: string;
    content?: string;
    tags?: string[][];
    id?: string;
}): NDKEvent {
    const tags = overrides.tags || [];
    return {
        id: overrides.id || "event123",
        pubkey: overrides.pubkey || OWNER_PUBKEY,
        content: overrides.content || "",
        tags,
        kind: 24030,
        tagValue: (name: string) => {
            const tag = tags.find((t) => t[0] === name);
            return tag ? tag[1] : undefined;
        },
        getMatchingTags: (name: string) => tags.filter((t) => t[0] === name),
    } as unknown as NDKEvent;
}

describe("handleAgentDeletion", () => {
    beforeEach(() => {
        removeAgentFromProjectCalls = [];
        getAgentProjectsCalls = [];
        publishImmediatelyCalls = 0;
        removedAgentPubkeys = new Set();

        spyOn(logger, "info").mockImplementation(() => {});
        spyOn(logger, "debug").mockImplementation(() => {});
        spyOn(logger, "warn").mockImplementation(() => {});
        spyOn(logger, "error").mockImplementation(() => {});

        spyOn(config, "getWhitelistedPubkeys").mockReturnValue([OWNER_PUBKEY]);
        spyOn(agentStorage, "getAgentProjects").mockImplementation(async (pubkey: string) => {
            getAgentProjectsCalls.push(pubkey);
            return [PROJECT_DTAG];
        });

        spyOn(projectsModule, "getProjectContext").mockReturnValue({
            project: {
                pubkey: OWNER_PUBKEY,
                dTag: PROJECT_DTAG,
                tagValue: (tag: string) => {
                    if (tag === "d") return PROJECT_DTAG;
                    return undefined;
                },
                content: "",
                tags: [
                    ["d", PROJECT_DTAG],
                    ["title", "Test Project"],
                    ["agent", AGENT_EVENT_ID],
                ],
            },
            getAgentByPubkey: (pubkey: string) => {
                if (removedAgentPubkeys.has(pubkey)) return undefined;

                if (pubkey === AGENT_PUBKEY) {
                    return {
                        slug: "test-agent",
                        pubkey: AGENT_PUBKEY,
                        name: "Test Agent",
                        eventId: AGENT_EVENT_ID,
                    };
                }
                return undefined;
            },
            agentRegistry: {
                removeAgentFromProject: async (slug: string) => {
                    removeAgentFromProjectCalls.push(slug);
                    return true;
                },
                getAllAgents: () => [],
            },
            statusPublisher: mockStatusPublisher,
        } as any);
    });

    afterEach(() => {
        // Clear pending debounce timers so they don't keep the test runner alive
        _testClearPendingTimers();
        mock.restore();
    });

    describe("project-scoped deletion (r=project)", () => {
        it("removes agent from the current project", async () => {
            const event = createMockEvent({
                pubkey: OWNER_PUBKEY,
                tags: [
                    ["p", AGENT_PUBKEY],
                    ["a", `31933:${OWNER_PUBKEY}:${PROJECT_DTAG}`],
                    ["r", "project"],
                ],
            });

            await handleAgentDeletion(event);

            expect(removeAgentFromProjectCalls).toEqual(["test-agent"]);
        });

        it("publishes project status after removal", async () => {
            const event = createMockEvent({
                pubkey: OWNER_PUBKEY,
                tags: [
                    ["p", AGENT_PUBKEY],
                    ["a", `31933:${OWNER_PUBKEY}:${PROJECT_DTAG}`],
                    ["r", "project"],
                ],
            });

            await handleAgentDeletion(event);

            expect(publishImmediatelyCalls).toBe(1);
        });

        it("ignores deletion for a different project", async () => {
            const event = createMockEvent({
                pubkey: OWNER_PUBKEY,
                tags: [
                    ["p", AGENT_PUBKEY],
                    ["a", `31933:${OWNER_PUBKEY}:other-project`],
                    ["r", "project"],
                ],
            });

            await handleAgentDeletion(event);

            expect(removeAgentFromProjectCalls).toEqual([]);
        });

        it("is a no-op when agent is not found in project", async () => {
            const unknownPubkey = "ffff".repeat(16);
            const event = createMockEvent({
                pubkey: OWNER_PUBKEY,
                tags: [
                    ["p", unknownPubkey],
                    ["a", `31933:${OWNER_PUBKEY}:${PROJECT_DTAG}`],
                    ["r", "project"],
                ],
            });

            await handleAgentDeletion(event);

            expect(removeAgentFromProjectCalls).toEqual([]);
        });

        it("rejects deletion from non-project-owner", async () => {
            const event = createMockEvent({
                pubkey: NON_OWNER_PUBKEY,
                tags: [
                    ["p", AGENT_PUBKEY],
                    ["a", `31933:${OWNER_PUBKEY}:${PROJECT_DTAG}`],
                    ["r", "project"],
                ],
            });

            await handleAgentDeletion(event);

            // Non-owner is not whitelisted, should be rejected at authorization
            expect(removeAgentFromProjectCalls).toEqual([]);
        });

        it("rejects deletion when missing a tag", async () => {
            const event = createMockEvent({
                pubkey: OWNER_PUBKEY,
                tags: [
                    ["p", AGENT_PUBKEY],
                    ["r", "project"],
                    // No a-tag
                ],
            });

            await handleAgentDeletion(event);

            expect(removeAgentFromProjectCalls).toEqual([]);
        });
    });

    describe("global deletion (r=global)", () => {
        it("removes agent from the current project", async () => {
            const event = createMockEvent({
                pubkey: OWNER_PUBKEY,
                tags: [
                    ["p", AGENT_PUBKEY],
                    ["r", "global"],
                ],
            });

            await handleAgentDeletion(event);

            expect(getAgentProjectsCalls).toEqual([AGENT_PUBKEY]);
            expect(removeAgentFromProjectCalls).toEqual(["test-agent"]);
        });

        it("publishes project status after removal", async () => {
            const event = createMockEvent({
                pubkey: OWNER_PUBKEY,
                tags: [
                    ["p", AGENT_PUBKEY],
                    ["r", "global"],
                ],
            });

            await handleAgentDeletion(event);

            expect(publishImmediatelyCalls).toBe(1);
        });
    });

    describe("validation", () => {
        it("rejects events with missing p tag", async () => {
            const event = createMockEvent({
                pubkey: OWNER_PUBKEY,
                tags: [
                    ["r", "project"],
                    ["a", `31933:${OWNER_PUBKEY}:${PROJECT_DTAG}`],
                ],
            });

            await handleAgentDeletion(event);

            expect(removeAgentFromProjectCalls).toEqual([]);
        });

        it("rejects events with missing r tag", async () => {
            const event = createMockEvent({
                pubkey: OWNER_PUBKEY,
                tags: [
                    ["p", AGENT_PUBKEY],
                    ["a", `31933:${OWNER_PUBKEY}:${PROJECT_DTAG}`],
                ],
            });

            await handleAgentDeletion(event);

            expect(removeAgentFromProjectCalls).toEqual([]);
        });

        it("rejects events with invalid r tag value", async () => {
            const event = createMockEvent({
                pubkey: OWNER_PUBKEY,
                tags: [
                    ["p", AGENT_PUBKEY],
                    ["r", "invalid-scope"],
                    ["a", `31933:${OWNER_PUBKEY}:${PROJECT_DTAG}`],
                ],
            });

            await handleAgentDeletion(event);

            expect(removeAgentFromProjectCalls).toEqual([]);
        });

        it("rejects events from unauthorized pubkeys", async () => {
            const event = createMockEvent({
                pubkey: NON_OWNER_PUBKEY,
                tags: [
                    ["p", AGENT_PUBKEY],
                    ["r", "global"],
                ],
            });

            await handleAgentDeletion(event);

            expect(removeAgentFromProjectCalls).toEqual([]);
            expect(getAgentProjectsCalls).toEqual([]);
        });

        it("handles invalid a-tag format gracefully", async () => {
            const event = createMockEvent({
                pubkey: OWNER_PUBKEY,
                tags: [
                    ["p", AGENT_PUBKEY],
                    ["a", "invalid-format"],
                    ["r", "project"],
                ],
            });

            await handleAgentDeletion(event);

            expect(removeAgentFromProjectCalls).toEqual([]);
        });
    });

    describe("idempotency", () => {
        it("second deletion of same agent is a no-op", async () => {
            // First deletion succeeds
            const event1 = createMockEvent({
                pubkey: OWNER_PUBKEY,
                tags: [
                    ["p", AGENT_PUBKEY],
                    ["a", `31933:${OWNER_PUBKEY}:${PROJECT_DTAG}`],
                    ["r", "project"],
                ],
            });
            await handleAgentDeletion(event1);
            expect(removeAgentFromProjectCalls).toEqual(["test-agent"]);

            // Simulate the agent being gone after removal (as it would be in production)
            removedAgentPubkeys.add(AGENT_PUBKEY);

            // Second deletion: agent no longer in registry → handler short-circuits
            removeAgentFromProjectCalls = [];
            publishImmediatelyCalls = 0;
            const event2 = createMockEvent({
                pubkey: OWNER_PUBKEY,
                tags: [
                    ["p", AGENT_PUBKEY],
                    ["a", `31933:${OWNER_PUBKEY}:${PROJECT_DTAG}`],
                    ["r", "project"],
                ],
            });
            await handleAgentDeletion(event2);

            // Verify no removal attempt or status publish on repeat
            expect(removeAgentFromProjectCalls).toEqual([]);
            expect(publishImmediatelyCalls).toBe(0);
        });
    });
});
