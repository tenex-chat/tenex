import { afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { ExecutionContext } from "@/agents/execution/types";
import type { AgentInstance } from "@/agents/types";
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

    const createMockContext = (ralNumber?: number): ExecutionContext => ({
        agent: {
            slug: "self-agent",
            name: "Self Agent",
            pubkey: "agent-pubkey-123",
        } as AgentInstance,
        conversationId,
        conversationCoordinator: {} as any,
        triggeringEvent: {} as any,
        agentPublisher: {} as any,
        phase: undefined,
        ralNumber,
        projectBasePath: "/tmp/test",
        workingDirectory: "/tmp/test",
        currentBranch: "main",
        getConversation: () => undefined,
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
                ...createMockContext(),
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
                ...createMockContext(),
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
                ...createMockContext(),
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
        it("should reject self-delegation when delegation points to self", async () => {
            const context = createMockContext();
            const followupTool = createDelegateFollowupTool(context);

            // Set up a delegation in the RAL that points to self
            const ralNumber = registry.create(context.agent.pubkey, conversationId);
            registry.saveState(context.agent.pubkey, conversationId, ralNumber, [], [
                {
                    eventId: "self-delegation-event",
                    recipientPubkey: "agent-pubkey-123", // Same as self
                    prompt: "Original task",
                },
            ]);

            const input = {
                delegation_event_id: "self-delegation-event",
                message: "Follow-up question",
            };

            try {
                await followupTool.execute(input);
                expect(true).toBe(false); // Should not reach here
            } catch (error: any) {
                expect(error.message).toContain("Self-delegation is not permitted");
            }
        });

        it("should error when delegation event ID not found", async () => {
            const context = createMockContext();
            const followupTool = createDelegateFollowupTool(context);

            // Don't set up any delegations
            registry.create(context.agent.pubkey, conversationId);

            const input = {
                delegation_event_id: "non-existent-event",
                message: "Follow-up question",
            };

            try {
                await followupTool.execute(input);
                expect(true).toBe(false); // Should not reach here
            } catch (error: any) {
                expect(error.message).toContain("No delegation found with event ID");
            }
        });
    });

    // delegate_crossproject tool tests require daemon mocking
    // and are covered in integration tests
});

describe("Delegation tools - RAL isolation", () => {
    const conversationId = "test-conversation-id";
    let registry: RALRegistry;

    const createMockContext = (ralNumber?: number): ExecutionContext => ({
        agent: {
            slug: "self-agent",
            name: "Self Agent",
            pubkey: "agent-pubkey-123",
        } as AgentInstance,
        conversationId,
        conversationCoordinator: {} as any,
        triggeringEvent: {} as any,
        agentPublisher: {
            delegate: async () => "mock-delegation-id",
        } as any,
        phase: undefined,
        ralNumber,
        projectBasePath: "/tmp/test",
        workingDirectory: "/tmp/test",
        currentBranch: "main",
        getConversation: () => undefined,
    });

    beforeEach(() => {
        // Reset singleton for testing
        // @ts-expect-error - accessing private static for testing
        RALRegistry.instance = undefined;
        registry = RALRegistry.getInstance();
    });

    describe("delegate tool", () => {
        it("should allow delegation when previous RAL has pending delegations but current RAL does not", async () => {
            // Create RAL 1 with pending delegations (simulating previous execution)
            const ral1Number = registry.create("agent-pubkey-123", conversationId);
            registry.setPendingDelegations("agent-pubkey-123", conversationId, ral1Number, [
                {
                    delegationConversationId: "old-delegation-id",
                    recipientPubkey: "some-other-agent",
                    recipientSlug: "other-agent",
                },
            ]);

            // Create RAL 2 (current execution) with NO pending delegations
            const ral2Number = registry.create("agent-pubkey-123", conversationId);

            // Verify RAL 1 still has pending delegations
            const ral1 = registry.getRAL("agent-pubkey-123", conversationId, ral1Number);
            expect(ral1?.pendingDelegations.length).toBe(1);

            // Verify RAL 2 has no pending delegations
            const ral2 = registry.getRAL("agent-pubkey-123", conversationId, ral2Number);
            expect(ral2?.pendingDelegations.length).toBe(0);

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
            // Create a RAL with pending delegations
            const ralNumber = registry.create("agent-pubkey-123", conversationId);
            registry.setPendingDelegations("agent-pubkey-123", conversationId, ralNumber, [
                {
                    delegationConversationId: "pending-delegation-id",
                    recipientPubkey: "some-other-agent",
                    recipientSlug: "other-agent",
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
                expect(error.message).toContain("other-agent");
            }
        });

        it("should allow delegation when context has no ralNumber (backwards compatibility)", async () => {
            // Create RAL with pending delegations
            const ralNumber = registry.create("agent-pubkey-123", conversationId);
            registry.setPendingDelegations("agent-pubkey-123", conversationId, ralNumber, [
                {
                    delegationConversationId: "pending-delegation-id",
                    recipientPubkey: "some-other-agent",
                    recipientSlug: "other-agent",
                },
            ]);

            // Context WITHOUT ralNumber (undefined) should skip the check
            const context = createMockContext(undefined);
            const delegateTool = createDelegateTool(context);

            const input = {
                delegations: [
                    { recipient: "other-agent", prompt: "Task" }
                ],
            };

            // Should succeed because ralNumber is undefined, so check is skipped
            const result = await delegateTool.execute(input);
            expect(result).toBeDefined();
            expect(result.__stopExecution).toBe(true);
        });
    });
});

// Restore mocks
afterAll(() => {
    mockResolve.mockRestore();
});
