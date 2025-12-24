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

// Mock DelegationXmlFormatter
mock.module("@/conversations/formatters/DelegationXmlFormatter", () => ({
    DelegationXmlFormatter: {
        render: mock((delegation: any) => `<delegation id="${delegation.id}">${delegation.message}</delegation>`),
    },
}));

import {
    buildDelegationMap,
    identifyDelegateToolCallEvents,
    renderDelegationMessage,
} from "../DelegationBuilder";
import type { EventWithContext, DelegationData } from "../types/EventWithContext";

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

function createEventWithContext(
    event: NDKEvent,
    context: Partial<EventWithContext> = {}
): EventWithContext {
    return {
        event,
        timestamp: event.created_at || Date.now() / 1000,
        ...context,
    };
}

describe("DelegationBuilder", () => {
    beforeEach(() => {
        mockProjectCtx = null;
    });

    describe("buildDelegationMap", () => {
        it("should build map from delegation request events", async () => {
            const delegationEvent = createMockEvent({
                id: "delegation-123",
                pubkey: "agent-pubkey",
                content: "Please research this",
                tags: [
                    ["p", "researcher-pubkey"],
                    ["phase", "research"],
                ],
            });

            const events: EventWithContext[] = [
                createEventWithContext(delegationEvent, {
                    isDelegationRequest: true,
                    delegationId: "delegat",
                    delegationContent: "Please research this",
                    delegatedToPubkey: "researcher-pubkey",
                }),
            ];

            const { delegationMap } = await buildDelegationMap(events, "agent-pubkey");

            expect(delegationMap.size).toBe(1);
            const delegation = delegationMap.get("delegation-123");
            expect(delegation).toBeDefined();
            expect(delegation?.message).toBe("Please research this");
            expect(delegation?.phase).toBe("research");
        });

        it("should match responses to delegation requests", async () => {
            const delegationEvent = createMockEvent({
                id: "delegation-123",
                pubkey: "agent-pubkey",
                content: "Do this task",
                tags: [["p", "worker-pubkey"]],
            });

            const responseEvent = createMockEvent({
                id: "response-456",
                pubkey: "worker-pubkey",
                content: "Task completed!",
                tags: [["e", "delegation-123"]],
            });

            mockProjectCtx = {
                getAgentByPubkey: mock((pubkey: string) => {
                    if (pubkey === "worker-pubkey") return { slug: "worker" };
                    return null;
                }),
            };

            const events: EventWithContext[] = [
                createEventWithContext(delegationEvent, {
                    isDelegationRequest: true,
                    delegationId: "delegat",
                    delegationContent: "Do this task",
                    delegatedToPubkey: "worker-pubkey",
                }),
                createEventWithContext(responseEvent, {
                    isDelegationResponse: true,
                    delegationId: "delegat",
                }),
            ];

            const { delegationMap, delegationResponseEventIds } = await buildDelegationMap(
                events,
                "agent-pubkey"
            );

            const delegation = delegationMap.get("delegation-123");
            expect(delegation?.responses).toHaveLength(1);
            expect(delegation?.responses[0].content).toBe("Task completed!");
            expect(delegationResponseEventIds.has("response-456")).toBe(true);
        });

        it("should handle multiple recipients", async () => {
            const delegationEvent1 = createMockEvent({
                id: "delegation-123",
                pubkey: "agent-pubkey",
                content: "Do this task",
                tags: [["p", "worker1-pubkey"]],
            });

            const delegationEvent2 = createMockEvent({
                id: "delegation-123", // Same ID (multi-recipient)
                pubkey: "agent-pubkey",
                content: "Do this task",
                tags: [["p", "worker2-pubkey"]],
            });

            const events: EventWithContext[] = [
                createEventWithContext(delegationEvent1, {
                    isDelegationRequest: true,
                    delegationId: "delegat",
                    delegationContent: "Do this task",
                    delegatedToPubkey: "worker1-pubkey",
                }),
                createEventWithContext(delegationEvent2, {
                    isDelegationRequest: true,
                    delegationId: "delegat",
                    delegationContent: "Do this task",
                    delegatedToPubkey: "worker2-pubkey",
                }),
            ];

            const { delegationMap } = await buildDelegationMap(events, "agent-pubkey");

            const delegation = delegationMap.get("delegation-123");
            expect(delegation?.recipients).toHaveLength(2);
        });

        it("should return empty map when no delegations", async () => {
            const regularEvent = createMockEvent({
                id: "regular-123",
                content: "Just a message",
            });

            const events: EventWithContext[] = [
                createEventWithContext(regularEvent),
            ];

            const { delegationMap, delegationResponseEventIds } = await buildDelegationMap(
                events,
                "agent-pubkey"
            );

            expect(delegationMap.size).toBe(0);
            expect(delegationResponseEventIds.size).toBe(0);
        });
    });

    describe("identifyDelegateToolCallEvents", () => {
        it("should identify events with delegate tool tag", () => {
            const delegateEvent = createMockEvent({
                id: "delegate-123",
                tags: [["tool", "delegate"]],
            });

            const otherEvent = createMockEvent({
                id: "other-123",
                tags: [["tool", "write_file"]],
            });

            const regularEvent = createMockEvent({
                id: "regular-123",
            });

            const events: EventWithContext[] = [
                createEventWithContext(delegateEvent),
                createEventWithContext(otherEvent),
                createEventWithContext(regularEvent),
            ];

            const result = identifyDelegateToolCallEvents(events);

            expect(result.has("delegate-123")).toBe(true);
            expect(result.has("other-123")).toBe(false);
            expect(result.has("regular-123")).toBe(false);
        });

        it("should return empty set when no delegate tool events", () => {
            const events: EventWithContext[] = [
                createEventWithContext(createMockEvent({ id: "event-1" })),
                createEventWithContext(createMockEvent({ id: "event-2" })),
            ];

            const result = identifyDelegateToolCallEvents(events);

            expect(result.size).toBe(0);
        });
    });

    describe("renderDelegationMessage", () => {
        it("should render delegation as system message with XML", () => {
            const delegation: DelegationData = {
                id: "abc123",
                from: "project-manager",
                recipients: ["researcher"],
                message: "Please research this topic",
                requestEventId: "event-123",
                requestEvent: createMockEvent({ id: "event-123" }),
                responses: [],
            };

            const result = renderDelegationMessage(delegation, false);

            expect(result.role).toBe("system");
            expect(result.content).toContain("<delegation");
            expect(result.content).toContain("Please research this topic");
        });

        it("should pass debug flag to formatter", () => {
            const delegation: DelegationData = {
                id: "abc123",
                from: "pm",
                recipients: ["worker"],
                message: "Task",
                requestEventId: "event-123",
                requestEvent: createMockEvent({ id: "event-123" }),
                responses: [],
            };

            // Just verify it doesn't throw with debug = true
            const result = renderDelegationMessage(delegation, true);
            expect(result.role).toBe("system");
        });
    });
});
