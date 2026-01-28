import { afterAll, beforeEach, describe, expect, it, spyOn, mock } from "bun:test";
import type { ToolExecutionContext } from "@/tools/types";
import type { AgentInstance } from "@/agents/types";

// Mock NDK before importing modules that use it
mock.module("@/nostr", () => ({
    getNDK: () => ({
        fetchEvent: async () => null,
    }),
}));

import { RALRegistry } from "@/services/ral";
import { createDelegateTool } from "@/tools/implementations/delegate";
import { createDelegateFollowupTool } from "@/tools/implementations/delegate_followup";

// Mock the resolution function to return pubkeys for our test agents (slug-only)
import * as agentResolution from "@/services/agents";
const mockResolve = spyOn(agentResolution, "resolveAgentSlug");
mockResolve.mockImplementation((slug: string) => {
    const availableSlugs = ["self-agent", "other-agent"];
    if (slug === "self-agent") {
        return { pubkey: "agent-pubkey-123", availableSlugs };
    }
    if (slug === "other-agent") {
        return { pubkey: "other-pubkey-456", availableSlugs };
    }
    // Only slugs are accepted - pubkeys and other formats should fail
    return { pubkey: null, availableSlugs };
});

describe("Delegation tools - Self-delegation validation", () => {
    const conversationId = "test-conversation-id";
    const projectId = "31933:pubkey:test-project";
    let registry: RALRegistry;

    const createMockContext = (ralNumber: number): ToolExecutionContext => ({
        agent: {
            slug: "self-agent",
            name: "Self Agent",
            pubkey: "agent-pubkey-123",
        } as AgentInstance,
        conversationId,
        triggeringEvent: {
            tags: [],
        } as any,
        agentPublisher: {} as any,
        ralNumber,
        projectBasePath: "/tmp/test",
        workingDirectory: "/tmp/test",
        currentBranch: "main",
        getConversation: () => ({
            getRootEventId: () => conversationId,
            getTodos: () => [],
        }) as any,
    });

    beforeEach(() => {
        // Reset singleton for testing
        // @ts-expect-error - accessing private static for testing
        RALRegistry.instance = undefined;
        registry = RALRegistry.getInstance();
    });

    describe("delegate tool", () => {
        it("should allow self-delegation by slug", async () => {
            const context = {
                ...createMockContext(1), // Provide ralNumber
                agentPublisher: {
                    delegate: async () => "mock-delegation-id",
                } as any,
            };
            const delegateTool = createDelegateTool(context);

            const input = {
                delegations: [
                    { recipient: "self-agent", prompt: "Do something" }
                ],
            };

            // Self-delegation is allowed - now returns normal result (no stop signal)
            const result = await delegateTool.execute(input);
            expect(result).toBeDefined();
            expect(result.success).toBe(true);
            expect(result.delegationConversationIds).toHaveLength(1);
        });

        it("should reject pubkeys (only slugs accepted)", async () => {
            const context = {
                ...createMockContext(1), // Provide ralNumber
                agentPublisher: {
                    delegate: async () => "mock-delegation-id",
                } as any,
            };
            const delegateTool = createDelegateTool(context);

            const input = {
                delegations: [
                    { recipient: "agent-pubkey-123", prompt: "Do something" }
                ],
            };

            // Pubkeys are no longer accepted - should throw with helpful error
            try {
                await delegateTool.execute(input);
                expect(true).toBe(false); // Should not reach here
            } catch (error: any) {
                expect(error.message).toContain("Invalid agent slug");
                expect(error.message).toContain("agent-pubkey-123");
                expect(error.message).toContain("Available agent slugs");
            }
        });

        it("should allow self in multiple recipients", async () => {
            const context = {
                ...createMockContext(1), // Provide ralNumber
                agentPublisher: {
                    delegate: async () => "mock-delegation-id",
                } as any,
            };
            const delegateTool = createDelegateTool(context);

            const input = {
                delegations: [
                    { recipient: "self-agent", prompt: "Task for self" },
                    { recipient: "other-agent", prompt: "Task for other" },
                ],
            };

            // Self-delegation is allowed - now returns normal result (no stop signal)
            const result = await delegateTool.execute(input);
            expect(result).toBeDefined();
            expect(result.success).toBe(true);
            expect(result.delegationConversationIds).toHaveLength(2);
        });
    });

    describe("delegate_followup tool", () => {
        // Note: Self-delegation validation was removed from delegate_followup
        // Self-delegation is now allowed as the delegate tool handles the validation

        it("should error when delegation conversation not found", async () => {
            // Create RAL first, then pass its number to context
            const agentPubkey = "agent-pubkey-123";
            const ralNumber = registry.create(agentPubkey, conversationId, projectId);
            const context = createMockContext(ralNumber);
            const followupTool = createDelegateFollowupTool(context);

            const input = {
                delegation_conversation_id: "non-existent-conv", // Correct parameter name
                message: "Follow-up question",
            };

            try {
                await followupTool.execute(input);
                expect(true).toBe(false); // Should not reach here
            } catch (error: any) {
                // With NDK mocked to return null, should get "Could not fetch" error
                expect(error.message).toContain("Could not fetch delegation conversation");
            }
        });
    });

    // delegate_crossproject tool tests require daemon mocking
    // and are covered in integration tests
});

describe("Delegation tools - RAL isolation", () => {
    const conversationId = "test-conversation-id";
    let registry: RALRegistry;

    const createMockContext = (ralNumber: number): ToolExecutionContext => ({
        agent: {
            slug: "self-agent",
            name: "Self Agent",
            pubkey: "agent-pubkey-123",
        } as AgentInstance,
        conversationId,
        triggeringEvent: {
            tags: [],
        } as any,
        agentPublisher: {
            delegate: async () => "mock-delegation-id",
        } as any,
        ralNumber,
        projectBasePath: "/tmp/test",
        workingDirectory: "/tmp/test",
        currentBranch: "main",
        getConversation: () => ({
            getRootEventId: () => conversationId,
            getTodos: () => [],
        }) as any,
    });

    beforeEach(() => {
        // Reset singleton for testing
        // @ts-expect-error - accessing private static for testing
        RALRegistry.instance = undefined;
        registry = RALRegistry.getInstance();
    });

    describe("delegate tool", () => {
        it("should allow delegation when previous RAL has pending delegations but current RAL does not", async () => {
            const agentPubkey = "agent-pubkey-123";

            // Create RAL 1 with pending delegations (simulating previous execution)
            const ral1Number = registry.create(agentPubkey, conversationId, projectId);
            registry.setPendingDelegations(agentPubkey, conversationId, ral1Number, [
                {
                    delegationConversationId: "old-delegation-id",
                    recipientPubkey: "some-other-agent",
                    senderPubkey: agentPubkey,
                    prompt: "Old task",
                    ralNumber: ral1Number,
                },
            ]);

            // Create RAL 2 (current execution) with NO pending delegations
            const ral2Number = registry.create(agentPubkey, conversationId, projectId);

            // Verify RAL 1 still has pending delegations (using conversation-level API)
            const ral1Pending = registry.getConversationPendingDelegations(agentPubkey, conversationId, ral1Number);
            expect(ral1Pending.length).toBe(1);

            // Verify RAL 2 has no pending delegations
            const ral2Pending = registry.getConversationPendingDelegations(agentPubkey, conversationId, ral2Number);
            expect(ral2Pending.length).toBe(0);

            // Context with RAL 2 number should allow new delegation
            const context = createMockContext(ral2Number);
            const delegateTool = createDelegateTool(context);

            const input = {
                delegations: [
                    { recipient: "other-agent", prompt: "New task" }
                ],
            };

            // This should NOT throw an error - the bug was that it would check RAL 1
            // (because getState() returns highest RAL) and block the delegation
            // Now returns normal result (no stop signal) - agent continues without blocking
            const result = await delegateTool.execute(input);
            expect(result).toBeDefined();
            expect(result.success).toBe(true);
            expect(result.delegationConversationIds).toHaveLength(1);
        });

        it("should allow delegation even when current RAL has pending delegations", async () => {
            const agentPubkey = "agent-pubkey-123";

            // Create a RAL with pending delegations
            const ralNumber = registry.create(agentPubkey, conversationId, projectId);
            registry.setPendingDelegations(agentPubkey, conversationId, ralNumber, [
                {
                    delegationConversationId: "pending-delegation-id",
                    recipientPubkey: "some-other-agent",
                    senderPubkey: agentPubkey,
                    prompt: "Pending task",
                    ralNumber,
                },
            ]);

            // Context with this RAL number should still allow new delegation
            const context = createMockContext(ralNumber);
            const delegateTool = createDelegateTool(context);

            const input = {
                delegations: [
                    { recipient: "other-agent", prompt: "Another task" }
                ],
            };

            // Should succeed - multiple pending delegations are now allowed
            // Now returns normal result (no stop signal) - agent continues without blocking
            const result = await delegateTool.execute(input);
            expect(result).toBeDefined();
            expect(result.success).toBe(true);
            expect(result.delegationConversationIds).toHaveLength(1);
        });

        // NOTE: Test "should require ralNumber in context" removed - ralNumber is now required by ToolExecutionContext type
    });
});

describe("Delegation tools - RALRegistry state verification", () => {
    const conversationId = "test-conversation-id";
    let registry: RALRegistry;

    const createMockContext = (ralNumber: number): ToolExecutionContext => ({
        agent: {
            slug: "self-agent",
            name: "Self Agent",
            pubkey: "agent-pubkey-123",
        } as AgentInstance,
        conversationId,
        triggeringEvent: {
            tags: [],
        } as any,
        agentPublisher: {
            delegate: async () => "mock-delegation-id-" + Math.random().toString(36).substring(7),
        } as any,
        ralNumber,
        projectBasePath: "/tmp/test",
        workingDirectory: "/tmp/test",
        currentBranch: "main",
        getConversation: () => ({
            getRootEventId: () => conversationId,
            getTodos: () => [],
        }) as any,
    });

    beforeEach(() => {
        // Reset singleton for testing
        // @ts-expect-error - accessing private static for testing
        RALRegistry.instance = undefined;
        registry = RALRegistry.getInstance();
    });

    describe("delegate tool", () => {
        it("should register pending delegation in RALRegistry after successful delegation", async () => {
            const agentPubkey = "agent-pubkey-123";
            const ralNumber = registry.create(agentPubkey, conversationId, projectId);
            const context = createMockContext(ralNumber);
            const delegateTool = createDelegateTool(context);

            const input = {
                delegations: [
                    { recipient: "other-agent", prompt: "Test task" }
                ],
            };

            // Execute the delegation
            const result = await delegateTool.execute(input);
            expect(result.success).toBe(true);

            // Verify RALRegistry state
            const pendingDelegations = registry.getConversationPendingDelegations(
                agentPubkey,
                conversationId,
                ralNumber
            );
            expect(pendingDelegations).toHaveLength(1);
            expect(pendingDelegations[0].recipientPubkey).toBe("other-pubkey-456");
            expect(pendingDelegations[0].prompt).toBe("Test task");
            expect(pendingDelegations[0].ralNumber).toBe(ralNumber);
        });

        it("should register multiple pending delegations correctly", async () => {
            const agentPubkey = "agent-pubkey-123";
            const ralNumber = registry.create(agentPubkey, conversationId, projectId);
            const context = createMockContext(ralNumber);
            const delegateTool = createDelegateTool(context);

            const input = {
                delegations: [
                    { recipient: "other-agent", prompt: "Task 1" },
                    { recipient: "other-agent", prompt: "Task 2" },
                ],
            };

            const result = await delegateTool.execute(input);
            expect(result.success).toBe(true);
            expect(result.delegationConversationIds).toHaveLength(2);

            // Verify RALRegistry has both delegations
            const pendingDelegations = registry.getConversationPendingDelegations(
                agentPubkey,
                conversationId,
                ralNumber
            );
            expect(pendingDelegations).toHaveLength(2);
        });

        it("should atomically merge delegations from concurrent calls without losing any", async () => {
            const agentPubkey = "agent-pubkey-123";
            const ralNumber = registry.create(agentPubkey, conversationId, projectId);

            // Pre-seed with existing delegation (simulating concurrent call)
            registry.mergePendingDelegations(agentPubkey, conversationId, ralNumber, [
                {
                    delegationConversationId: "pre-existing-delegation",
                    recipientPubkey: "pre-existing-recipient",
                    senderPubkey: agentPubkey,
                    prompt: "Pre-existing task",
                    ralNumber,
                },
            ]);

            // Now execute another delegation
            const context = createMockContext(ralNumber);
            const delegateTool = createDelegateTool(context);

            const input = {
                delegations: [
                    { recipient: "other-agent", prompt: "New task" }
                ],
            };

            const result = await delegateTool.execute(input);
            expect(result.success).toBe(true);

            // Verify both delegations exist (atomic merge didn't drop the pre-existing one)
            const pendingDelegations = registry.getConversationPendingDelegations(
                agentPubkey,
                conversationId,
                ralNumber
            );
            expect(pendingDelegations).toHaveLength(2);

            const preExisting = pendingDelegations.find(d => d.delegationConversationId === "pre-existing-delegation");
            expect(preExisting).toBeDefined();
            expect(preExisting?.prompt).toBe("Pre-existing task");
        });

        it("should merge fields into existing delegations with the same delegationConversationId", async () => {
            const agentPubkey = "agent-pubkey-123";
            const ralNumber = registry.create(agentPubkey, conversationId, projectId);

            // Add a delegation manually
            const { insertedCount: firstInserted } = registry.mergePendingDelegations(agentPubkey, conversationId, ralNumber, [
                {
                    delegationConversationId: "fixed-delegation-id",
                    recipientPubkey: "other-pubkey-456",
                    senderPubkey: agentPubkey,
                    prompt: "Original task",
                    ralNumber,
                },
            ]);
            expect(firstInserted).toBe(1);

            // Try to add the same delegation again with different metadata
            // This simulates a followup re-registering the delegation with new fields (e.g., followupEventId)
            const { insertedCount, mergedCount } = registry.mergePendingDelegations(agentPubkey, conversationId, ralNumber, [
                {
                    type: "followup" as const,
                    delegationConversationId: "fixed-delegation-id",
                    recipientPubkey: "other-pubkey-456",
                    senderPubkey: agentPubkey,
                    prompt: "Updated prompt for followup",
                    followupEventId: "followup-event-xyz",
                    ralNumber,
                },
            ]);

            // Should still only have one delegation, but merged
            expect(insertedCount).toBe(0);
            expect(mergedCount).toBe(1);

            const pendingDelegations = registry.getConversationPendingDelegations(
                agentPubkey,
                conversationId,
                ralNumber
            );
            expect(pendingDelegations).toHaveLength(1);
            // Merged entry should have the updated fields
            expect(pendingDelegations[0].prompt).toBe("Updated prompt for followup");
            expect(pendingDelegations[0].type).toBe("followup");
            expect(pendingDelegations[0].followupEventId).toBe("followup-event-xyz");
        });
    });
});

// Restore mocks
afterAll(() => {
    mockResolve.mockRestore();
});
