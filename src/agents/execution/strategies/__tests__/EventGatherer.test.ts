import { describe, expect, it, mock, beforeEach } from "bun:test";
import { NDKEvent } from "@nostr-dev-kit/ndk";

// Mock logger
mock.module("@/utils/logger", () => ({
    logger: {
        info: mock(() => {}),
        debug: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
    },
}));

// Mock content-utils
mock.module("@/conversations/utils/content-utils", () => ({
    hasReasoningTag: mock((event: NDKEvent) => {
        return event.tags?.some((t) => t[0] === "reasoning");
    }),
}));

// Mock nostr utils
mock.module("@/nostr/utils", () => ({
    getTargetedAgentPubkeys: mock((event: NDKEvent) => {
        return event.getMatchingTags("p").map((t) => t[1]);
    }),
    isEventFromUser: mock((event: NDKEvent) => {
        // Simple heuristic: if pubkey starts with "user", it's a user
        return event.pubkey?.startsWith("user");
    }),
}));

// Mock services
let mockProjectCtx: any = null;
mock.module("@/services/projects", () => ({
    isProjectContextInitialized: mock(() => mockProjectCtx !== null),
    getProjectContext: mock(() => mockProjectCtx),
}));

mock.module("@/services/PubkeyService", () => ({
    getPubkeyService: mock(() => ({
        getName: mock(async (pubkey: string) => `name-${pubkey.substring(0, 8)}`),
    })),
}));

import {
    isDelegatedExecution,
    gatherPreviousSubthreads,
    formatPreviousSubthreadsContext,
    gatherDelegationSubthread,
    gatherRelevantEvents,
} from "../EventGatherer";
import type { ExecutionContext } from "../../types";

// Helper to create mock NDKEvent
function createMockEvent(overrides: Partial<NDKEvent> = {}): NDKEvent {
    const event = new NDKEvent();
    event.id = overrides.id || `event-${Math.random().toString(36).substring(7)}`;
    event.pubkey = overrides.pubkey || "default-pubkey";
    event.content = overrides.content || "";
    event.kind = overrides.kind || 1111;
    event.created_at = overrides.created_at || Math.floor(Date.now() / 1000);
    event.tags = overrides.tags || [];
    return event;
}

describe("EventGatherer", () => {
    beforeEach(() => {
        mockProjectCtx = null;
    });

    describe("isDelegatedExecution", () => {
        it("should return false for self-triggered events", () => {
            const triggeringEvent = createMockEvent({
                pubkey: "agent-pubkey",
            });

            const context = {
                triggeringEvent,
                agent: { pubkey: "agent-pubkey" },
            } as unknown as ExecutionContext;

            const result = isDelegatedExecution(context);

            expect(result).toBe(false);
        });

        it("should return false when agent is not in p-tags", () => {
            const triggeringEvent = createMockEvent({
                pubkey: "other-pubkey",
                tags: [["p", "different-agent"]],
            });

            const context = {
                triggeringEvent,
                agent: { pubkey: "agent-pubkey" },
            } as unknown as ExecutionContext;

            const result = isDelegatedExecution(context);

            expect(result).toBe(false);
        });

        it("should return true when delegated by another agent", () => {
            const triggeringEvent = createMockEvent({
                pubkey: "delegator-agent-pubkey",
                tags: [["p", "agent-pubkey"]],
            });

            mockProjectCtx = {
                getAgentByPubkey: mock((pubkey: string) => {
                    if (pubkey === "delegator-agent-pubkey") {
                        return { slug: "delegator" };
                    }
                    return null;
                }),
            };

            const context = {
                triggeringEvent,
                agent: { pubkey: "agent-pubkey" },
            } as unknown as ExecutionContext;

            const result = isDelegatedExecution(context);

            expect(result).toBe(true);
        });

        it("should return false when sender is a user (not an agent)", () => {
            const triggeringEvent = createMockEvent({
                pubkey: "user-pubkey",
                tags: [["p", "agent-pubkey"]],
            });

            mockProjectCtx = {
                getAgentByPubkey: mock(() => null), // User is not an agent
            };

            const context = {
                triggeringEvent,
                agent: { pubkey: "agent-pubkey" },
            } as unknown as ExecutionContext;

            const result = isDelegatedExecution(context);

            expect(result).toBe(false);
        });
    });

    describe("formatPreviousSubthreadsContext", () => {
        it("should return null for empty subthreads", () => {
            const result = formatPreviousSubthreadsContext([]);

            expect(result).toBeNull();
        });

        it("should format subthreads with prompts and responses", () => {
            const subthreads = [
                {
                    delegationEventId: "event-1",
                    delegatorSlug: "project-manager",
                    delegatorPubkey: "pm-pubkey",
                    prompt: "Please research this topic",
                    response: "I found the following information...",
                    timestamp: 1000,
                },
            ];

            const result = formatPreviousSubthreadsContext(subthreads);

            expect(result).toContain("Previous Tasks in This Conversation");
            expect(result).toContain("Task from project-manager");
            expect(result).toContain("Please research this topic");
            expect(result).toContain("I found the following information");
        });

        it("should truncate long prompts and responses", () => {
            const longText = "A".repeat(600);
            const subthreads = [
                {
                    delegationEventId: "event-1",
                    delegatorSlug: "pm",
                    delegatorPubkey: "pm-pubkey",
                    prompt: longText,
                    response: longText,
                    timestamp: 1000,
                },
            ];

            const result = formatPreviousSubthreadsContext(subthreads);

            expect(result).toContain("...");
            expect(result!.length).toBeLessThan(longText.length * 2);
        });

        it("should handle subthreads without responses", () => {
            const subthreads = [
                {
                    delegationEventId: "event-1",
                    delegatorSlug: "pm",
                    delegatorPubkey: "pm-pubkey",
                    prompt: "Do this task",
                    timestamp: 1000,
                    // No response
                },
            ];

            const result = formatPreviousSubthreadsContext(subthreads);

            expect(result).toContain("Do this task");
            expect(result).not.toContain("Your response:");
        });
    });

    describe("gatherDelegationSubthread", () => {
        it("should only include events in the delegation subthread", async () => {
            const delegationEvent = createMockEvent({
                id: "delegation-1",
                pubkey: "delegator-pubkey",
                content: "Please do this task",
            });

            const responseEvent = createMockEvent({
                id: "response-1",
                pubkey: "agent-pubkey",
                content: "Done!",
                tags: [["e", "delegation-1"]],
            });

            const unrelatedEvent = createMockEvent({
                id: "unrelated-1",
                pubkey: "other-pubkey",
                content: "Something else",
            });

            const allEvents = [delegationEvent, responseEvent, unrelatedEvent];

            const context = {
                triggeringEvent: delegationEvent,
                agent: { pubkey: "agent-pubkey" },
            } as unknown as ExecutionContext;

            const result = await gatherDelegationSubthread(context, allEvents);

            expect(result.length).toBe(2);
            expect(result.map((e) => e.event.id)).toContain("delegation-1");
            expect(result.map((e) => e.event.id)).toContain("response-1");
            expect(result.map((e) => e.event.id)).not.toContain("unrelated-1");
        });

        it("should include transitive replies", async () => {
            const delegationEvent = createMockEvent({
                id: "delegation-1",
                content: "Task",
            });

            const reply1 = createMockEvent({
                id: "reply-1",
                tags: [["e", "delegation-1"]],
            });

            const reply2 = createMockEvent({
                id: "reply-2",
                tags: [["e", "reply-1"]], // Reply to reply
            });

            const allEvents = [delegationEvent, reply1, reply2];

            const context = {
                triggeringEvent: delegationEvent,
                agent: { pubkey: "agent-pubkey" },
            } as unknown as ExecutionContext;

            const result = await gatherDelegationSubthread(context, allEvents);

            expect(result.length).toBe(3);
        });

        it("should filter out reasoning events", async () => {
            const delegationEvent = createMockEvent({
                id: "delegation-1",
            });

            const reasoningEvent = createMockEvent({
                id: "reasoning-1",
                tags: [
                    ["e", "delegation-1"],
                    ["reasoning", "true"],
                ],
            });

            const allEvents = [delegationEvent, reasoningEvent];

            const context = {
                triggeringEvent: delegationEvent,
                agent: { pubkey: "agent-pubkey" },
            } as unknown as ExecutionContext;

            const result = await gatherDelegationSubthread(context, allEvents);

            expect(result.length).toBe(1);
            expect(result[0].event.id).toBe("delegation-1");
        });
    });

    describe("gatherRelevantEvents", () => {
        it("should include events from agent", async () => {
            const agentEvent = createMockEvent({
                id: "agent-event",
                pubkey: "agent-pubkey",
                content: "Agent response",
            });

            const triggeringEvent = createMockEvent({
                id: "trigger",
                pubkey: "user-pubkey",
                tags: [["e", "root"]],
            });

            const rootEvent = createMockEvent({
                id: "root",
                pubkey: "user-pubkey",
            });

            const allEvents = [rootEvent, agentEvent, triggeringEvent];

            const context = {
                triggeringEvent,
                agent: { pubkey: "agent-pubkey" },
            } as unknown as ExecutionContext;

            const result = await gatherRelevantEvents(context, allEvents);

            expect(result.some((e) => e.event.id === "agent-event")).toBe(true);
        });

        it("should include events targeted to agent", async () => {
            const targetedEvent = createMockEvent({
                id: "targeted",
                pubkey: "user-pubkey",
                tags: [["p", "agent-pubkey"]],
            });

            const triggeringEvent = createMockEvent({
                id: "trigger",
                pubkey: "user-pubkey",
                tags: [["p", "agent-pubkey"]],
            });

            const allEvents = [targetedEvent, triggeringEvent];

            const context = {
                triggeringEvent,
                agent: { pubkey: "agent-pubkey" },
            } as unknown as ExecutionContext;

            const result = await gatherRelevantEvents(context, allEvents);

            expect(result.some((e) => e.event.id === "targeted")).toBe(true);
        });

        it("should include events in thread path", async () => {
            const rootEvent = createMockEvent({
                id: "root",
                pubkey: "other-pubkey",
                content: "Root message",
            });

            const parentEvent = createMockEvent({
                id: "parent",
                pubkey: "other-pubkey",
                tags: [["e", "root"]],
            });

            const triggeringEvent = createMockEvent({
                id: "trigger",
                pubkey: "user-pubkey",
                tags: [["e", "parent"]],
            });

            const allEvents = [rootEvent, parentEvent, triggeringEvent];

            const context = {
                triggeringEvent,
                agent: { pubkey: "agent-pubkey" },
            } as unknown as ExecutionContext;

            const result = await gatherRelevantEvents(context, allEvents);

            // Should include all events in the thread path
            expect(result.some((e) => e.event.id === "root")).toBe(true);
            expect(result.some((e) => e.event.id === "parent")).toBe(true);
            expect(result.some((e) => e.event.id === "trigger")).toBe(true);
        });

        it("should filter out reasoning events", async () => {
            const reasoningEvent = createMockEvent({
                id: "reasoning",
                pubkey: "agent-pubkey",
                tags: [["reasoning", "true"]],
            });

            const triggeringEvent = createMockEvent({
                id: "trigger",
                pubkey: "user-pubkey",
            });

            const allEvents = [reasoningEvent, triggeringEvent];

            const context = {
                triggeringEvent,
                agent: { pubkey: "agent-pubkey" },
            } as unknown as ExecutionContext;

            const result = await gatherRelevantEvents(context, allEvents);

            expect(result.some((e) => e.event.id === "reasoning")).toBe(false);
        });

        it("should mark delegation requests from agent", async () => {
            const delegationRequest = createMockEvent({
                id: "delegation",
                pubkey: "agent-pubkey",
                kind: 1111,
                content: "Please do this",
                tags: [
                    ["p", "other-agent"],
                    ["phase", "research"],
                ],
            });

            const triggeringEvent = createMockEvent({
                id: "trigger",
                pubkey: "user-pubkey",
            });

            const allEvents = [delegationRequest, triggeringEvent];

            const context = {
                triggeringEvent,
                agent: { pubkey: "agent-pubkey" },
            } as unknown as ExecutionContext;

            const result = await gatherRelevantEvents(context, allEvents);

            const delegationEvent = result.find((e) => e.event.id === "delegation");
            expect(delegationEvent?.isDelegationRequest).toBe(true);
            expect(delegationEvent?.delegationId).toBeDefined();
        });

        it("should use delegation subthread for delegated executions", async () => {
            const delegationEvent = createMockEvent({
                id: "delegation",
                pubkey: "delegator-pubkey",
            });

            const unrelatedEvent = createMockEvent({
                id: "unrelated",
                pubkey: "other-pubkey",
            });

            const allEvents = [delegationEvent, unrelatedEvent];

            const context = {
                triggeringEvent: delegationEvent,
                agent: { pubkey: "agent-pubkey" },
            } as unknown as ExecutionContext;

            const result = await gatherRelevantEvents(
                context,
                allEvents,
                undefined,
                true // isDelegated = true
            );

            // Should only include delegation subthread events
            expect(result.some((e) => e.event.id === "delegation")).toBe(true);
            expect(result.some((e) => e.event.id === "unrelated")).toBe(false);
        });

        it("should apply external event filter", async () => {
            const event1 = createMockEvent({
                id: "event-1",
                pubkey: "agent-pubkey",
            });

            const event2 = createMockEvent({
                id: "event-2",
                pubkey: "agent-pubkey",
            });

            const triggeringEvent = createMockEvent({
                id: "trigger",
                pubkey: "user-pubkey",
            });

            const allEvents = [event1, event2, triggeringEvent];

            const context = {
                triggeringEvent,
                agent: { pubkey: "agent-pubkey" },
            } as unknown as ExecutionContext;

            // Filter that only allows event-1
            const filter = (event: NDKEvent) => event.id === "event-1" || event.id === "trigger";

            const result = await gatherRelevantEvents(context, allEvents, filter);

            expect(result.some((e) => e.event.id === "event-1")).toBe(true);
            expect(result.some((e) => e.event.id === "event-2")).toBe(false);
        });
    });
});
