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

// Mock the resolution function to return pubkeys for our test agents
import * as agentResolution from "@/services/agents";
const mockResolve = spyOn(agentResolution, "resolveRecipientToPubkey");
mockResolve.mockImplementation((recipient: string) => {
    if (recipient === "self-agent") return "agent-pubkey-123";
    if (recipient === "other-agent") return "other-pubkey-456";
    return recipient.startsWith("agent-pubkey-") ? recipient : null;
});

describe("Delegation tools - Self-delegation validation", () => {
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
        it("should allow self-delegation without phase by slug", async () => {
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

            // Self-delegation without phase is now allowed
            const result = await delegateTool.execute(input);
            expect(result).toBeDefined();
            expect(result.__stopExecution).toBe(true);
        });

        it("should allow self-delegation without phase by pubkey", async () => {
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

            // Self-delegation without phase is now allowed
            const result = await delegateTool.execute(input);
            expect(result).toBeDefined();
            expect(result.__stopExecution).toBe(true);
        });

        it("should allow self in multiple recipients without phase", async () => {
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

            // Self-delegation without phase is now allowed
            const result = await delegateTool.execute(input);
            expect(result).toBeDefined();
            expect(result.__stopExecution).toBe(true);
            expect(result.pendingDelegations).toHaveLength(2);
        });
    });

    describe("delegate_followup tool", () => {
        // Note: Self-delegation validation was removed from delegate_followup
        // Self-delegation is now allowed as the delegate tool handles the validation

        it("should error when delegation conversation not found", async () => {
            // Create RAL first, then pass its number to context
            const agentPubkey = "agent-pubkey-123";
            const ralNumber = registry.create(agentPubkey, conversationId);
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
            const ral1Number = registry.create(agentPubkey, conversationId);
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
            const ral2Number = registry.create(agentPubkey, conversationId);

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
            const result = await delegateTool.execute(input);
            expect(result).toBeDefined();
            expect(result.__stopExecution).toBe(true);
        });

        it("should block delegation when current RAL has pending delegations", async () => {
            const agentPubkey = "agent-pubkey-123";

            // Create a RAL with pending delegations
            const ralNumber = registry.create(agentPubkey, conversationId);
            registry.setPendingDelegations(agentPubkey, conversationId, ralNumber, [
                {
                    delegationConversationId: "pending-delegation-id",
                    recipientPubkey: "some-other-agent",
                    senderPubkey: agentPubkey,
                    prompt: "Pending task",
                    ralNumber,
                },
            ]);

            // Context with this RAL number should block new delegation
            const context = createMockContext(ralNumber);
            const delegateTool = createDelegateTool(context);

            const input = {
                delegations: [
                    { recipient: "other-agent", prompt: "Another task" }
                ],
            };

            try {
                await delegateTool.execute(input);
                expect(true).toBe(false); // Should not reach here
            } catch (error: any) {
                expect(error.message).toContain("Cannot create new delegation while waiting for existing delegation");
                // The error shows truncated pubkey, so just check for the prefix
                expect(error.message).toContain("some-oth");
            }
        });

        // NOTE: Test "should require ralNumber in context" removed - ralNumber is now required by ToolExecutionContext type
    });
});

// Restore mocks
afterAll(() => {
    mockResolve.mockRestore();
});
