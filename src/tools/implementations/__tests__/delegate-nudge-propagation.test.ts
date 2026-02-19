import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn, mock } from "bun:test";
import type { ToolExecutionContext } from "@/tools/types";
import type { AgentInstance } from "@/agents/types";

// Track delegate calls to verify nudge propagation
const delegateCallArgs: Array<{ nudges?: string[] }> = [];

// Mock NDK before importing modules that use it
mock.module("@/nostr", () => ({
    getNDK: () => ({
        fetchEvent: async () => null,
    }),
}));

import { RALRegistry } from "@/services/ral";
import { createDelegateTool } from "@/tools/implementations/delegate";

// Mock the resolution function to return pubkeys for our test agents
import * as agentResolution from "@/services/agents";
const mockResolve = spyOn(agentResolution, "resolveAgentSlug");
mockResolve.mockImplementation((slug: string) => {
    const availableSlugs = ["self-agent", "other-agent", "third-agent"];
    if (slug === "self-agent") {
        return { pubkey: "agent-pubkey-123", availableSlugs };
    }
    if (slug === "other-agent") {
        return { pubkey: "other-pubkey-456", availableSlugs };
    }
    if (slug === "third-agent") {
        return { pubkey: "third-pubkey-789", availableSlugs };
    }
    return { pubkey: null, availableSlugs };
});

describe("Delegate Tool - Nudge Propagation", () => {
    const conversationId = "test-conversation-id";
    const projectId = "31933:pubkey:test-project";
    let registry: RALRegistry;

    const defaultTodo = {
        id: "test-todo",
        title: "Test Todo",
        description: "Test",
        status: "pending" as const,
        createdAt: Date.now(),
        updatedAt: Date.now()
    };

    /**
     * Create a mock context with optional nudge tags on the triggering event
     */
    const createMockContext = (ralNumber: number, nudgeTags: string[][] = []): ToolExecutionContext => ({
        agent: {
            slug: "self-agent",
            name: "Self Agent",
            pubkey: "agent-pubkey-123",
        } as AgentInstance,
        conversationId,
        triggeringEvent: {
            tags: nudgeTags,
        } as any,
        agentPublisher: {
            delegate: async (config: any) => {
                // Track the delegate call to verify nudge propagation
                delegateCallArgs.push({ nudges: config.nudges });
                return "mock-delegation-id-" + Math.random().toString(36).substring(7);
            },
            delegationMarker: async () => ({ id: "marker-id" }),
        } as any,
        ralNumber,
        projectBasePath: "/tmp/test",
        workingDirectory: "/tmp/test",
        currentBranch: "main",
        getConversation: () => ({
            getRootEventId: () => conversationId,
            getTodos: () => [defaultTodo],
            addDelegationMarker: () => {},
            save: async () => {},
        }) as any,
    });

    beforeEach(() => {
        // Reset singleton and call tracking
        // @ts-expect-error - accessing private static for testing
        RALRegistry.instance = undefined;
        registry = RALRegistry.getInstance();
        delegateCallArgs.length = 0;
    });

    afterEach(() => {
        delegateCallArgs.length = 0;
    });

    describe("nudge inheritance", () => {
        it("should inherit nudges from triggering event and pass to delegated agent", async () => {
            const inheritedNudge1 = "inherited-nudge-event-id-1";
            const inheritedNudge2 = "inherited-nudge-event-id-2";

            const nudgeTags = [
                ["nudge", inheritedNudge1],
                ["nudge", inheritedNudge2],
            ];

            const agentPubkey = "agent-pubkey-123";
            const ralNumber = registry.create(agentPubkey, conversationId, projectId);
            const context = createMockContext(ralNumber, nudgeTags);
            const delegateTool = createDelegateTool(context);

            const input = {
                delegations: [
                    { recipient: "other-agent", prompt: "Do something" }
                ],
            };

            const result = await delegateTool.execute(input);
            expect(result.success).toBe(true);

            // Verify delegate was called with inherited nudges
            expect(delegateCallArgs.length).toBe(1);
            expect(delegateCallArgs[0].nudges).toContain(inheritedNudge1);
            expect(delegateCallArgs[0].nudges).toContain(inheritedNudge2);
        });

        it("should combine inherited nudges with explicit nudges", async () => {
            const inheritedNudge = "inherited-nudge-id";
            const explicitNudge = "explicit-nudge-id";

            const nudgeTags = [["nudge", inheritedNudge]];

            const agentPubkey = "agent-pubkey-123";
            const ralNumber = registry.create(agentPubkey, conversationId, projectId);
            const context = createMockContext(ralNumber, nudgeTags);
            const delegateTool = createDelegateTool(context);

            const input = {
                delegations: [
                    {
                        recipient: "other-agent",
                        prompt: "Do something",
                        nudges: [explicitNudge],
                    }
                ],
            };

            const result = await delegateTool.execute(input);
            expect(result.success).toBe(true);

            // Verify delegate was called with BOTH inherited and explicit nudges
            expect(delegateCallArgs.length).toBe(1);
            expect(delegateCallArgs[0].nudges).toContain(inheritedNudge);
            expect(delegateCallArgs[0].nudges).toContain(explicitNudge);
            expect(delegateCallArgs[0].nudges?.length).toBe(2);
        });

        it("should deduplicate nudges when explicit nudge is same as inherited", async () => {
            const sameNudgeId = "same-nudge-id";

            const nudgeTags = [["nudge", sameNudgeId]];

            const agentPubkey = "agent-pubkey-123";
            const ralNumber = registry.create(agentPubkey, conversationId, projectId);
            const context = createMockContext(ralNumber, nudgeTags);
            const delegateTool = createDelegateTool(context);

            const input = {
                delegations: [
                    {
                        recipient: "other-agent",
                        prompt: "Do something",
                        nudges: [sameNudgeId], // Same as inherited
                    }
                ],
            };

            const result = await delegateTool.execute(input);
            expect(result.success).toBe(true);

            // Verify nudge appears only ONCE (deduplication)
            expect(delegateCallArgs.length).toBe(1);
            expect(delegateCallArgs[0].nudges?.length).toBe(1);
            expect(delegateCallArgs[0].nudges).toContain(sameNudgeId);
        });

        it("should handle no nudges gracefully", async () => {
            const agentPubkey = "agent-pubkey-123";
            const ralNumber = registry.create(agentPubkey, conversationId, projectId);
            const context = createMockContext(ralNumber, []); // No nudge tags
            const delegateTool = createDelegateTool(context);

            const input = {
                delegations: [
                    { recipient: "other-agent", prompt: "Do something" }
                ],
            };

            const result = await delegateTool.execute(input);
            expect(result.success).toBe(true);

            // Verify delegate was called without nudges (undefined or empty)
            expect(delegateCallArgs.length).toBe(1);
            const nudges = delegateCallArgs[0].nudges;
            expect(nudges === undefined || nudges.length === 0).toBe(true);
        });
    });

    describe("multiple delegations", () => {
        it("should propagate nudges to all delegated agents", async () => {
            const inheritedNudge = "inherited-nudge-for-all";
            const nudgeTags = [["nudge", inheritedNudge]];

            const agentPubkey = "agent-pubkey-123";
            const ralNumber = registry.create(agentPubkey, conversationId, projectId);
            const context = createMockContext(ralNumber, nudgeTags);
            const delegateTool = createDelegateTool(context);

            const input = {
                delegations: [
                    { recipient: "other-agent", prompt: "Task 1" },
                    { recipient: "third-agent", prompt: "Task 2" },
                ],
            };

            const result = await delegateTool.execute(input);
            expect(result.success).toBe(true);
            expect(result.delegationConversationIds).toHaveLength(2);

            // Verify BOTH delegations received the inherited nudge
            expect(delegateCallArgs.length).toBe(2);
            expect(delegateCallArgs[0].nudges).toContain(inheritedNudge);
            expect(delegateCallArgs[1].nudges).toContain(inheritedNudge);
        });

        it("should allow different explicit nudges per delegation while still inheriting", async () => {
            const inheritedNudge = "inherited-nudge";
            const explicitNudge1 = "explicit-nudge-1";
            const explicitNudge2 = "explicit-nudge-2";

            const nudgeTags = [["nudge", inheritedNudge]];

            const agentPubkey = "agent-pubkey-123";
            const ralNumber = registry.create(agentPubkey, conversationId, projectId);
            const context = createMockContext(ralNumber, nudgeTags);
            const delegateTool = createDelegateTool(context);

            const input = {
                delegations: [
                    { recipient: "other-agent", prompt: "Task 1", nudges: [explicitNudge1] },
                    { recipient: "third-agent", prompt: "Task 2", nudges: [explicitNudge2] },
                ],
            };

            const result = await delegateTool.execute(input);
            expect(result.success).toBe(true);

            // First delegation: inherited + explicit1
            expect(delegateCallArgs[0].nudges).toContain(inheritedNudge);
            expect(delegateCallArgs[0].nudges).toContain(explicitNudge1);
            expect(delegateCallArgs[0].nudges).not.toContain(explicitNudge2);

            // Second delegation: inherited + explicit2
            expect(delegateCallArgs[1].nudges).toContain(inheritedNudge);
            expect(delegateCallArgs[1].nudges).toContain(explicitNudge2);
            expect(delegateCallArgs[1].nudges).not.toContain(explicitNudge1);
        });
    });

    describe("explicit nudges array deduplication", () => {
        it("should deduplicate duplicate explicit nudges", async () => {
            const nudgeId = "duplicate-nudge";

            const agentPubkey = "agent-pubkey-123";
            const ralNumber = registry.create(agentPubkey, conversationId, projectId);
            const context = createMockContext(ralNumber, []);
            const delegateTool = createDelegateTool(context);

            const input = {
                delegations: [
                    {
                        recipient: "other-agent",
                        prompt: "Task",
                        nudges: [nudgeId, nudgeId, nudgeId], // Duplicates
                    }
                ],
            };

            const result = await delegateTool.execute(input);
            expect(result.success).toBe(true);

            // Verify only one nudge (deduplicated)
            expect(delegateCallArgs.length).toBe(1);
            expect(delegateCallArgs[0].nudges?.length).toBe(1);
            expect(delegateCallArgs[0].nudges).toContain(nudgeId);
        });
    });
});

afterAll(() => {
    mockResolve.mockRestore();
});
