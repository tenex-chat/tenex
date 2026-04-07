import { afterEach, beforeEach, describe, expect, it, spyOn, mock, type Mock } from "bun:test";
import type { ToolExecutionContext } from "@/tools/types";
import type { AgentRegistry } from "@/agents/AgentRegistry";
import type { AgentInstance } from "@/agents/types";
import type { ProjectContext } from "@/services/projects";
import * as nostrModule from "@/nostr";
import { shortenConversationId } from "@/utils/conversation-id";

import { RALRegistry } from "@/services/ral";
import { createDelegateTool } from "@/tools/implementations/delegate";
import { createDelegateFollowupTool } from "@/tools/implementations/delegate_followup";
import { ConversationStore } from "@/conversations/ConversationStore";
import { projectContextStore } from "@/services/projects";
import { createMockInboundEnvelope } from "@/test-utils/mock-factories";

const createTriggeringEnvelope = () => createMockInboundEnvelope();
const mockFetchEvent = mock(() => Promise.resolve(null));

function createTestAgent(slug: string, pubkey: string): AgentInstance {
    return {
        slug,
        pubkey,
        name: slug,
        role: "developer",
        llmConfig: "default",
        tools: [],
        signer: {} as any,
    } as AgentInstance;
}

const createMockProjectContext = (): ProjectContext => {
    const agents = new Map<string, AgentInstance>([
        ["self-agent", createTestAgent("self-agent", "agent-pubkey-123")],
        ["other-agent", createTestAgent("other-agent", "other-pubkey-456")],
        ["third-agent", createTestAgent("third-agent", "third-pubkey-789")],
    ]);

    const agentsByPubkey = new Map<string, AgentInstance>();
    for (const agent of agents.values()) {
        agentsByPubkey.set(agent.pubkey, agent);
    }

    return {
        agents,
        agentRegistry: {
            getAllAgentsMap: () => agents,
        } as unknown as AgentRegistry,
        getAgentByPubkey: (pubkey: string) => agentsByPubkey.get(pubkey),
    } as unknown as ProjectContext;
};

const runWithProjectContext = <T>(fn: () => Promise<T>): Promise<T> =>
    projectContextStore.run(createMockProjectContext(), fn);

beforeEach(() => {
    mockFetchEvent.mockReset();
    mockFetchEvent.mockResolvedValue(null);
    spyOn(nostrModule, "getNDK").mockReturnValue({
        fetchEvent: mockFetchEvent,
    } as any);
});

afterEach(() => {
    mock.restore();
});

describe("Delegation tools - Self-delegation validation", () => {
    const conversationId = "test-conversation-id";
    const projectId = "31933:pubkey:test-project";
    let registry: RALRegistry;

    // Default todo item to satisfy delegation requirement
    const defaultTodo = { id: "test-todo", title: "Test Todo", description: "Test", status: "pending" as const, createdAt: Date.now(), updatedAt: Date.now() };

    const createMockContext = (ralNumber: number, hasTodos = true): ToolExecutionContext => ({
        agent: {
            slug: "self-agent",
            name: "Self Agent",
            pubkey: "agent-pubkey-123",
        } as AgentInstance,
        conversationId,
        triggeringEnvelope: createTriggeringEnvelope(),
        agentPublisher: {} as any,
        ralNumber,
        projectBasePath: "/tmp/test",
        workingDirectory: "/tmp/test",
        currentBranch: "main",
        getConversation: () => ({
            getRootEventId: () => conversationId,
            getTodos: () => hasTodos ? [defaultTodo] : [],
        }) as any,
    });

    /**
     * Creates a context with getConversation() returning null,
     * simulating MCP-only mode where no conversation context is available.
     */
    const createMockContextWithNoConversation = (ralNumber: number): ToolExecutionContext => ({
        agent: {
            slug: "self-agent",
            name: "Self Agent",
            pubkey: "agent-pubkey-123",
        } as AgentInstance,
        conversationId,
        triggeringEnvelope: createTriggeringEnvelope(),
        agentPublisher: {} as any,
        ralNumber,
        projectBasePath: "/tmp/test",
        workingDirectory: "/tmp/test",
        currentBranch: "main",
        getConversation: () => null,
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
                recipient: "self-agent",
                prompt: "Do something",
            };

            // Self-delegation is allowed - now returns normal result (no stop signal)
            const result = await runWithProjectContext(() => delegateTool.execute(input));
            expect(result).toBeDefined();
            expect(result.success).toBe(true);
            expect(result.delegationConversationId).toBeDefined();
        });

        it("should reject pubkeys (only slugs accepted)", async () => {
            const context = {
                ...createMockContext(1, true), // Provide ralNumber, with todos
                agentPublisher: {
                    delegate: async () => "mock-delegation-id",
                } as any,
            };
            const delegateTool = createDelegateTool(context);

            const input = {
                recipient: "agent-pubkey-123",
                prompt: "Do something",
            };

            // Pubkeys are no longer accepted - should throw with helpful error
            try {
                await runWithProjectContext(() => delegateTool.execute(input));
                expect(true).toBe(false); // Should not reach here
            } catch (error: any) {
                expect(error.message).toContain("Invalid agent slug");
                expect(error.message).toContain("agent-pubkey-123");
                expect(error.message).toContain("Available agent slugs");
            }
        });

        it("should succeed but include reminder when no todos exist", async () => {
            const context = {
                ...createMockContext(1, false), // No todos
                agentPublisher: {
                    delegate: async () => "mock-delegation-id",
                } as any,
            };
            const delegateTool = createDelegateTool(context);

            const input = {
                recipient: "self-agent",
                prompt: "Do something",
            };

            const result = await runWithProjectContext(() => delegateTool.execute(input));
            expect(result.success).toBe(true);
            expect(result.delegationConversationId).toBeDefined();
            expect(result.message).toContain("delegation-todo-nudge");
            expect(result.message).toContain("todo_write()");
        });

        it("should not include reminder when no conversation context (MCP-only mode)", async () => {
            const agentPubkey = "agent-pubkey-123";
            const ralNumber = registry.create(agentPubkey, conversationId, projectId);

            // Context with getConversation() returning null - simulates MCP-only mode
            const context = {
                ...createMockContextWithNoConversation(ralNumber),
                agentPublisher: {
                    delegate: async () => "mock-delegation-id",
                } as any,
            };
            const delegateTool = createDelegateTool(context);

            const input = {
                recipient: "other-agent",
                prompt: "Task to delegate",
            };

            const result = await runWithProjectContext(() => delegateTool.execute(input));
            expect(result).toBeDefined();
            expect(result.success).toBe(true);
            expect(result.delegationConversationId).toBeDefined();
            // No reminder since there's no conversation context to check
            expect(result.message).not.toContain("delegation-todo-nudge");
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
                // Invalid ID format is rejected before lookup
                expect(error.message).toContain("Invalid delegation conversation event ID");
            }
        });
    });

    // delegate_crossproject tool tests require daemon mocking
    // and are covered in integration tests
});

describe("Delegation tools - RAL isolation", () => {
    const conversationId = "test-conversation-id";
    const projectId = "31933:pubkey:test-project";
    let registry: RALRegistry;

    // Default todo item to satisfy delegation requirement
    const defaultTodo = { id: "test-todo", title: "Test Todo", description: "Test", status: "pending" as const, createdAt: Date.now(), updatedAt: Date.now() };

    const createMockContext = (ralNumber: number, hasTodos = true): ToolExecutionContext => ({
        agent: {
            slug: "self-agent",
            name: "Self Agent",
            pubkey: "agent-pubkey-123",
        } as AgentInstance,
        conversationId,
        triggeringEnvelope: createTriggeringEnvelope(),
        agentPublisher: {
            delegate: async () => "mock-delegation-id",
        } as any,
        ralNumber,
        projectBasePath: "/tmp/test",
        workingDirectory: "/tmp/test",
        currentBranch: "main",
        getConversation: () => ({
            getRootEventId: () => conversationId,
            getTodos: () => hasTodos ? [defaultTodo] : [],
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
                recipient: "other-agent",
                prompt: "New task",
            };

            // This should NOT throw an error - the bug was that it would check RAL 1
            // (because getState() returns highest RAL) and block the delegation
            // Now returns normal result (no stop signal) - agent continues without blocking
            const result = await runWithProjectContext(() => delegateTool.execute(input));
            expect(result).toBeDefined();
            expect(result.success).toBe(true);
            expect(result.delegationConversationId).toBeDefined();
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
                recipient: "other-agent",
                prompt: "Another task",
            };

            // Should succeed - multiple pending delegations are now allowed
            // Now returns normal result (no stop signal) - agent continues without blocking
            const result = await runWithProjectContext(() => delegateTool.execute(input));
            expect(result).toBeDefined();
            expect(result.success).toBe(true);
            expect(result.delegationConversationId).toBeDefined();
        });

        // NOTE: Test "should require ralNumber in context" removed - ralNumber is now required by ToolExecutionContext type
    });
});

describe("Delegation tools - RALRegistry state verification", () => {
    const conversationId = "test-conversation-id";
    const projectId = "31933:pubkey:test-project";
    let registry: RALRegistry;

    // Default todo item to satisfy delegation requirement
    const defaultTodo = { id: "test-todo", title: "Test Todo", description: "Test", status: "pending" as const, createdAt: Date.now(), updatedAt: Date.now() };

    const createMockContext = (ralNumber: number, hasTodos = true): ToolExecutionContext => ({
        agent: {
            slug: "self-agent",
            name: "Self Agent",
            pubkey: "agent-pubkey-123",
        } as AgentInstance,
        conversationId,
        triggeringEnvelope: createTriggeringEnvelope(),
        agentPublisher: {
            delegate: async () => `mock-delegation-id-${Math.random().toString(36).substring(7)}`,
        } as any,
        ralNumber,
        projectBasePath: "/tmp/test",
        workingDirectory: "/tmp/test",
        currentBranch: "main",
        getConversation: () => ({
            getRootEventId: () => conversationId,
            getTodos: () => hasTodos ? [defaultTodo] : [],
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
                recipient: "other-agent",
                prompt: "Test task",
            };

            // Execute the delegation
            const result = await runWithProjectContext(() => delegateTool.execute(input));
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
                recipient: "other-agent",
                prompt: "New task",
            };

            const result = await runWithProjectContext(() => delegateTool.execute(input));
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

describe("Delegation tools - Circular delegation soft warning", () => {
    const conversationId = "test-conversation-id";
    const projectId = "31933:pubkey:test-project";
    let registry: RALRegistry;
    let conversationStoreSpy: Mock<typeof ConversationStore.get>;

    // Default todo item to satisfy delegation requirement
    const defaultTodo = { id: "test-todo", title: "Test Todo", description: "Test", status: "pending" as const, createdAt: Date.now(), updatedAt: Date.now() };

    const createMockContextWithChain = (ralNumber: number, delegationChain: any[] = [], hasTodos = true): ToolExecutionContext => {
        // Mock the ConversationStore.get to return our chain
        const mockConversation = {
            getRootEventId: () => conversationId,
            getTodos: () => hasTodos ? [defaultTodo] : [],
            getAllMessages: () => [],
            metadata: {
                delegationChain,
            },
        };

        return {
            agent: {
                slug: "self-agent",
                name: "Self Agent",
                pubkey: "agent-pubkey-123",
            } as AgentInstance,
            conversationId,
            triggeringEnvelope: createTriggeringEnvelope(),
            agentPublisher: {
                delegate: async () => `mock-delegation-id-${Math.random().toString(36).substring(7)}`,
                delegationMarker: async () => ({ id: "mock-marker-id" }),
            } as any,
            ralNumber,
            projectBasePath: "/tmp/test",
            workingDirectory: "/tmp/test",
            currentBranch: "main",
            getConversation: () => mockConversation as any,
        };
    };

    beforeEach(() => {
        // Reset singleton for testing
        // @ts-expect-error - accessing private static for testing
        RALRegistry.instance = undefined;
        registry = RALRegistry.getInstance();

        // Mock ConversationStore.get - default to no chain
        conversationStoreSpy = spyOn(ConversationStore, "get").mockImplementation(() => {
            return undefined;
        });
    });

    afterEach(() => {
        // Restore ConversationStore spy after each test
        conversationStoreSpy.mockRestore();
    });

    it("should throw error when circular delegation is detected without force flag", async () => {
        const agentPubkey = "agent-pubkey-123";
        const ralNumber = registry.create(agentPubkey, conversationId, projectId);

        // Create a delegation chain that includes other-agent
        const delegationChain = [
            { pubkey: "user-pubkey", displayName: "User" },
            { pubkey: "other-pubkey-456", displayName: "other-agent" },
            { pubkey: agentPubkey, displayName: "self-agent" },
        ];

        const context = createMockContextWithChain(ralNumber, delegationChain);

        // Update the spy mock for this specific test
        conversationStoreSpy.mockReturnValue({
            metadata: { delegationChain },
            addDelegationMarker: () => {},
            save: async () => {},
            getAllMessages: () => [],
        } as any);

        const delegateTool = createDelegateTool(context);

        const input = {
            recipient: "other-agent",
            prompt: "This would create a cycle",
        };

        // Should throw an error
        try {
            await runWithProjectContext(() => delegateTool.execute(input));
            expect(true).toBe(false); // Should not reach here
        } catch (error: any) {
            expect(error.message).toContain("already in the delegation chain");
            expect(error.message).toContain("force: true");
            expect(error.circularDelegationWarning).toBeDefined();
        }
    });

    it("should proceed with circular delegation when force flag is true", async () => {
        const agentPubkey = "agent-pubkey-123";
        const ralNumber = registry.create(agentPubkey, conversationId, projectId);

        // Create a delegation chain that includes other-agent
        const delegationChain = [
            { pubkey: "user-pubkey", displayName: "User" },
            { pubkey: "other-pubkey-456", displayName: "other-agent" },
            { pubkey: agentPubkey, displayName: "self-agent" },
        ];

        const context = createMockContextWithChain(ralNumber, delegationChain);

        // Update the spy mock for this specific test
        conversationStoreSpy.mockReturnValue({
            metadata: { delegationChain },
            addDelegationMarker: () => {},
            save: async () => {},
            getAllMessages: () => [],
        } as any);

        const delegateTool = createDelegateTool(context);

        const input = {
            recipient: "other-agent",
            prompt: "Force through the cycle",
            force: true,
        };

        const result = await runWithProjectContext(() => delegateTool.execute(input));

        // Should succeed with force flag
        expect(result.success).toBe(true);
        expect(result.delegationConversationId).toBeDefined();
    });

    it("should allow normal delegation when no circular dependency exists", async () => {
        const agentPubkey = "agent-pubkey-123";
        const ralNumber = registry.create(agentPubkey, conversationId, projectId);

        // Create a delegation chain that does NOT include other-agent
        const delegationChain = [
            { pubkey: "user-pubkey", displayName: "User" },
            { pubkey: agentPubkey, displayName: "self-agent" },
        ];

        const context = createMockContextWithChain(ralNumber, delegationChain);

        // Update the spy mock for this specific test
        conversationStoreSpy.mockReturnValue({
            metadata: { delegationChain },
            addDelegationMarker: () => {},
            save: async () => {},
            getAllMessages: () => [],
        } as any);

        const delegateTool = createDelegateTool(context);

        const input = {
            recipient: "other-agent",
            prompt: "Normal delegation",
        };

        const result = await runWithProjectContext(() => delegateTool.execute(input));

        // Should succeed normally
        expect(result.success).toBe(true);
        expect(result.delegationConversationId).toBeDefined();
        expect(result.circularDelegationWarning).toBeUndefined();
    });

});

describe("delegate_followup - ID handling", () => {
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
        triggeringEnvelope: createTriggeringEnvelope(),
        agentPublisher: {
            delegateFollowup: async () => "mock-followup-event-id",
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

    it("should canonicalize full 64-char hex followup event ID to canonical delegation ID", async () => {
        const agentPubkey = "agent-pubkey-123";
        const ralNumber = registry.create(agentPubkey, conversationId, projectId);

        // Register a followup delegation with known IDs (must be exactly 64 hex chars)
        const canonicalId = "1111111111111111111111111111111111111111111111111111111111111111";
        const followupId = "2222222222222222222222222222222222222222222222222222222222222222";

        registry.mergePendingDelegations(agentPubkey, conversationId, ralNumber, [{
            type: "followup",
            delegationConversationId: canonicalId,
            followupEventId: followupId,
            recipientPubkey: "recipient-agent-pubkey",
            senderPubkey: agentPubkey,
            prompt: "Original prompt",
            ralNumber,
        }]);

        const context = createMockContext(ralNumber);
        const followupTool = createDelegateFollowupTool(context);

        // User provides full followup event ID (not the canonical delegation ID)
        const input = {
            delegation_conversation_id: followupId, // Full 64-char hex followup ID
            message: "Follow-up question",
        };

        // This should canonicalize the followup ID to the canonical delegation ID
        // and successfully find the delegation
        const result = await followupTool.execute(input);
        expect(result.success).toBe(true);
        expect(result.delegationConversationId).toBe(shortenConversationId(canonicalId)); // Shortened canonical ID
    });

    it("should reject nostr:nevent1 bech32 IDs", async () => {
        const agentPubkey = "agent-pubkey-123";
        const ralNumber = registry.create(agentPubkey, conversationId, projectId);
        const context = createMockContext(ralNumber);
        const followupTool = createDelegateFollowupTool(context);

        const input = {
            delegation_conversation_id: "nostr:nevent1qqsqxpc6z8pc8qursw3ur5xupzqfsp3n2m3ck8w",
            message: "Follow-up via nostr:nevent1",
        };

        try {
            await followupTool.execute(input);
            expect(true).toBe(false);
        } catch (error: any) {
            expect(error.message).toContain("Invalid delegation conversation event ID");
        }
    });

    it("should reject note1 bech32 IDs", async () => {
        const agentPubkey = "agent-pubkey-123";
        const ralNumber = registry.create(agentPubkey, conversationId, projectId);
        const context = createMockContext(ralNumber);
        const followupTool = createDelegateFollowupTool(context);

        const input = {
            delegation_conversation_id: "note1qqsqxpc6z8pc8qursw3ur5xupzqfsp3n2m3ck8w",
            message: "Follow-up via note1",
        };

        try {
            await followupTool.execute(input);
            expect(true).toBe(false);
        } catch (error: any) {
            expect(error.message).toContain("Invalid delegation conversation event ID");
        }
    });

    it("should pass through canonical delegation IDs unchanged", async () => {
        const agentPubkey = "agent-pubkey-123";
        const ralNumber = registry.create(agentPubkey, conversationId, projectId);

        // Register a standard delegation (not a followup)
        const canonicalId = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

        registry.mergePendingDelegations(agentPubkey, conversationId, ralNumber, [{
            type: "standard",
            delegationConversationId: canonicalId,
            recipientPubkey: "recipient-agent-pubkey",
            senderPubkey: agentPubkey,
            prompt: "Original prompt",
            ralNumber,
        }]);

        const context = createMockContext(ralNumber);
        const followupTool = createDelegateFollowupTool(context);

        // User provides the canonical delegation ID directly
        const input = {
            delegation_conversation_id: canonicalId,
            message: "Follow-up using canonical ID",
        };

        const result = await followupTool.execute(input);
        expect(result.success).toBe(true);
        // Should use the same canonical ID (canonicalization returns it unchanged)
        expect(result.delegationConversationId).toBe(shortenConversationId(canonicalId));
    });

    it("should canonicalize uppercase hex IDs to lowercase", async () => {
        const agentPubkey = "agent-pubkey-123";
        const ralNumber = registry.create(agentPubkey, conversationId, projectId);

        const canonicalId = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

        registry.mergePendingDelegations(agentPubkey, conversationId, ralNumber, [{
            type: "standard",
            delegationConversationId: canonicalId,
            recipientPubkey: "recipient-agent-pubkey",
            senderPubkey: agentPubkey,
            prompt: "Original prompt",
            ralNumber,
        }]);

        const context = createMockContext(ralNumber);
        const followupTool = createDelegateFollowupTool(context);

        // User provides uppercase version
        const input = {
            delegation_conversation_id: canonicalId.toUpperCase(),
            message: "Follow-up with uppercase ID",
        };

        const result = await followupTool.execute(input);
        expect(result.success).toBe(true);
        expect(result.delegationConversationId).toBe(shortenConversationId(canonicalId));
    });
});
