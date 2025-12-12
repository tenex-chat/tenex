import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { DelegationRegistry } from "../DelegationRegistry";
import type { AgentInstance } from "@/agents/types";

describe("DelegationRegistry.getDelegation", () => {
    let registry: DelegationRegistry;

    // Mock agent instances
    const mockAgentA: AgentInstance = {
        slug: "agent-a",
        name: "Agent A",
        pubkey: "pubkey-agent-a-1234567890abcdef",
        npub: "npub-agent-a",
        instructions: "Test agent A",
        model: "test-model",
    };

    const mockAgentB: AgentInstance = {
        slug: "agent-b",
        name: "Agent B",
        pubkey: "pubkey-agent-b-1234567890abcdef",
        npub: "npub-agent-b",
        instructions: "Test agent B",
        model: "test-model",
    };

    const rootConversationId = "conversation-root-123456";

    beforeEach(async () => {
        // Initialize the singleton instance
        await DelegationRegistry.initialize();
        registry = DelegationRegistry.getInstance();
        // Clear any existing state
        await registry.clear();
    });

    afterEach(async () => {
        // Clean up
        await registry.clear();
    });

    describe("Multiple simultaneous delegations to same agent", () => {
        it("should register two delegations in the same batch from Agent A to Agent B", async () => {
            const eventId1 = "event-delegation-1-abcdef123456";
            const eventId2 = "event-delegation-2-abcdef123456";

            // Register two delegations in the same batch
            const batchId = await registry.registerDelegation({
                delegations: [
                    {
                        eventId: eventId1,
                        pubkey: mockAgentB.pubkey,
                        request: "Task 1: Implement feature X",
                        phase: "IMPLEMENTATION",
                    },
                    {
                        eventId: eventId2,
                        pubkey: mockAgentB.pubkey,
                        request: "Task 2: Write tests for feature X",
                        phase: "TESTING",
                    },
                ],
                delegatingAgent: mockAgentA,
                rootConversationId,
            });

            expect(batchId).toBeDefined();

            // Verify both delegations are registered
            const delegation1 = registry.getDelegation(eventId1);
            const delegation2 = registry.getDelegation(eventId2);

            expect(delegation1).toBeDefined();
            expect(delegation2).toBeDefined();

            // Verify they are distinct
            expect(delegation1?.delegationEventId).toBe(eventId1);
            expect(delegation2?.delegationEventId).toBe(eventId2);

            // Verify they have the same batch
            expect(delegation1?.delegationBatchId).toBe(batchId);
            expect(delegation2?.delegationBatchId).toBe(batchId);

            // Verify they are assigned to the same agent
            expect(delegation1?.assignedTo.pubkey).toBe(mockAgentB.pubkey);
            expect(delegation2?.assignedTo.pubkey).toBe(mockAgentB.pubkey);

            // Verify they have different requests
            expect(delegation1?.content.fullRequest).toBe("Task 1: Implement feature X");
            expect(delegation2?.content.fullRequest).toBe("Task 2: Write tests for feature X");

            // Verify they have different phases
            expect(delegation1?.content.phase).toBe("IMPLEMENTATION");
            expect(delegation2?.content.phase).toBe("TESTING");
        });

        it("should correctly identify each delegation by event ID", async () => {
            const eventId1 = "event-delegation-3-xyz789";
            const eventId2 = "event-delegation-4-xyz789";

            await registry.registerDelegation({
                delegations: [
                    {
                        eventId: eventId1,
                        pubkey: mockAgentB.pubkey,
                        request: "First task",
                    },
                    {
                        eventId: eventId2,
                        pubkey: mockAgentB.pubkey,
                        request: "Second task",
                    },
                ],
                delegatingAgent: mockAgentA,
                rootConversationId,
            });

            // getDelegation returns the correct specific delegation
            const delegation1 = registry.getDelegation(eventId1);
            const delegation2 = registry.getDelegation(eventId2);

            expect(delegation1?.delegationEventId).toBe(eventId1);
            expect(delegation1?.content.fullRequest).toBe("First task");

            expect(delegation2?.delegationEventId).toBe(eventId2);
            expect(delegation2?.content.fullRequest).toBe("Second task");
        });

        it("should demonstrate getDelegationByConversationKey limitation", async () => {
            const eventId1 = "event-delegation-5-limit123";
            const eventId2 = "event-delegation-6-limit123";

            await registry.registerDelegation({
                delegations: [
                    {
                        eventId: eventId1,
                        pubkey: mockAgentB.pubkey,
                        request: "Task A",
                    },
                    {
                        eventId: eventId2,
                        pubkey: mockAgentB.pubkey,
                        request: "Task B",
                    },
                ],
                delegatingAgent: mockAgentA,
                rootConversationId,
            });

            // getDelegationByConversationKey returns only one delegation
            // (first pending or most recent)
            const delegationByKey = registry.getDelegationByConversationKey(
                rootConversationId,
                mockAgentA.pubkey,
                mockAgentB.pubkey
            );

            expect(delegationByKey).toBeDefined();

            // It will return one of them, but we can't distinguish which task
            // This demonstrates the limitation - it's ambiguous which delegation
            // we're referring to when there are multiple
            const isDelegation1 = delegationByKey?.delegationEventId === eventId1;
            const isDelegation2 = delegationByKey?.delegationEventId === eventId2;
            expect(isDelegation1 || isDelegation2).toBe(true);

            // However, using getDelegation we can get each specific one
            const specificDelegation1 = registry.getDelegation(eventId1);
            const specificDelegation2 = registry.getDelegation(eventId2);

            expect(specificDelegation1?.content.fullRequest).toBe("Task A");
            expect(specificDelegation2?.content.fullRequest).toBe("Task B");
        });

        it("should demonstrate FlattenedChronologicalStrategy-like logic with event IDs", async () => {
            const delegationEventId1 = "event-del-strat-1-abc";
            const delegationEventId2 = "event-del-strat-2-abc";
            const responseEventId1 = "event-response-1-abc";
            const responseEventId2 = "event-response-2-abc";

            // Register two delegations
            await registry.registerDelegation({
                delegations: [
                    {
                        eventId: delegationEventId1,
                        pubkey: mockAgentB.pubkey,
                        request: "Strategy Task 1",
                        phase: "PHASE_1",
                    },
                    {
                        eventId: delegationEventId2,
                        pubkey: mockAgentB.pubkey,
                        request: "Strategy Task 2",
                        phase: "PHASE_2",
                    },
                ],
                delegatingAgent: mockAgentA,
                rootConversationId,
            });

            // Simulate FlattenedChronologicalStrategy processing a delegation request event
            // When the strategy sees a kind:1111 event with id=delegationEventId1
            const processedDelegation1 = registry.getDelegation(delegationEventId1);
            expect(processedDelegation1).toBeDefined();
            expect(processedDelegation1?.content.fullRequest).toBe("Strategy Task 1");
            expect(processedDelegation1?.content.phase).toBe("PHASE_1");

            // When the strategy sees a kind:1111 event with id=delegationEventId2
            const processedDelegation2 = registry.getDelegation(delegationEventId2);
            expect(processedDelegation2).toBeDefined();
            expect(processedDelegation2?.content.fullRequest).toBe("Strategy Task 2");
            expect(processedDelegation2?.content.phase).toBe("PHASE_2");

            // Simulate processing a response event that has e-tag pointing to delegationEventId1
            // The strategy would extract the e-tag and look up the delegation
            const responseForDelegation1 = registry.getDelegation(delegationEventId1);
            expect(responseForDelegation1).toBeDefined();
            expect(responseForDelegation1?.delegationEventId).toBe(delegationEventId1);
            expect(responseForDelegation1?.content.phase).toBe("PHASE_1");

            // Similarly for the second response with e-tag pointing to delegationEventId2
            const responseForDelegation2 = registry.getDelegation(delegationEventId2);
            expect(responseForDelegation2).toBeDefined();
            expect(responseForDelegation2?.delegationEventId).toBe(delegationEventId2);
            expect(responseForDelegation2?.content.phase).toBe("PHASE_2");

            // This demonstrates that by using event IDs, we can correctly
            // distinguish between multiple simultaneous delegations
        });

        it("should handle backward compatibility with getDelegationByConversationKey", async () => {
            const eventId = "event-backward-compat-1";

            // Register a single delegation
            await registry.registerDelegation({
                delegations: [
                    {
                        eventId,
                        pubkey: mockAgentB.pubkey,
                        request: "Single task",
                    },
                ],
                delegatingAgent: mockAgentA,
                rootConversationId,
            });

            // Both methods should work for single delegations
            const byEventId = registry.getDelegation(eventId);
            const byConversationKey = registry.getDelegationByConversationKey(
                rootConversationId,
                mockAgentA.pubkey,
                mockAgentB.pubkey
            );

            expect(byEventId).toBeDefined();
            expect(byConversationKey).toBeDefined();

            // They should return the same delegation
            expect(byEventId?.delegationEventId).toBe(byConversationKey?.delegationEventId);
            expect(byEventId?.content.fullRequest).toBe(byConversationKey?.content.fullRequest);
        });

        it("should return undefined for non-existent event ID", () => {
            const nonExistentId = "event-does-not-exist-123";

            const delegation = registry.getDelegation(nonExistentId);

            expect(delegation).toBeUndefined();
        });

        it("should verify sibling delegation IDs are populated correctly", async () => {
            const eventId1 = "event-sibling-1-xyz";
            const eventId2 = "event-sibling-2-xyz";
            const eventId3 = "event-sibling-3-xyz";

            await registry.registerDelegation({
                delegations: [
                    {
                        eventId: eventId1,
                        pubkey: mockAgentB.pubkey,
                        request: "Sibling task 1",
                    },
                    {
                        eventId: eventId2,
                        pubkey: mockAgentB.pubkey,
                        request: "Sibling task 2",
                    },
                    {
                        eventId: eventId3,
                        pubkey: mockAgentB.pubkey,
                        request: "Sibling task 3",
                    },
                ],
                delegatingAgent: mockAgentA,
                rootConversationId,
            });

            const delegation1 = registry.getDelegation(eventId1);
            const delegation2 = registry.getDelegation(eventId2);
            const delegation3 = registry.getDelegation(eventId3);

            // Each delegation should have the other two as siblings
            expect(delegation1?.siblingDelegationIds).toEqual([eventId2, eventId3]);
            expect(delegation2?.siblingDelegationIds).toEqual([eventId1, eventId3]);
            expect(delegation3?.siblingDelegationIds).toEqual([eventId1, eventId2]);
        });
    });
});
