import { describe, expect, it, beforeEach, mock } from "bun:test";
import { RALRegistry } from "../RALRegistry";
import { isStopExecutionSignal } from "../types";
import type { PendingDelegation, CompletedDelegation } from "../types";
import { handleDelegationCompletion } from "@/event-handler/DelegationCompletionHandler";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { Conversation, ConversationCoordinator } from "@/conversations";

// Mock getProjectContext
const mockAgent = {
    slug: "transparent",
    pubkey: "agent1pubkey123456789",
    name: "Transparent Agent",
};

const mockAgent2 = {
    slug: "agent2",
    pubkey: "agent2pubkey123456789",
    name: "Agent 2",
};

const CONVERSATION_ID = "conv-test-123";

mock.module("@/services/ProjectContext", () => ({
    getProjectContext: () => ({
        getAgentByPubkey: (pubkey: string) => {
            if (pubkey === mockAgent.pubkey) return mockAgent;
            if (pubkey === mockAgent2.pubkey) return mockAgent2;
            return undefined;
        },
    }),
}));

describe("RAL Delegation Flow", () => {
    let registry: RALRegistry;

    beforeEach(() => {
        // Reset singleton for testing
        // @ts-expect-error - accessing private static for testing
        RALRegistry.instance = undefined;
        registry = RALRegistry.getInstance();
    });

    describe("RALRegistry State Management", () => {
        it("should create a new RAL entry for an agent+conversation pair", () => {
            const ralNumber = registry.create(mockAgent.pubkey, CONVERSATION_ID);

            expect(ralNumber).toBeDefined();
            expect(typeof ralNumber).toBe("number");

            const state = registry.getState(mockAgent.pubkey, CONVERSATION_ID);
            expect(state).toBeDefined();
            expect(state?.isStreaming).toBe(false);
            expect(state?.conversationId).toBe(CONVERSATION_ID);
            expect(state?.pendingDelegations).toEqual([]);
            expect(state?.completedDelegations).toEqual([]);
        });

        it("should isolate RAL state between different conversations", () => {
            const conversationA = "conv-a";
            const conversationB = "conv-b";

            registry.create(mockAgent.pubkey, conversationA);
            registry.create(mockAgent.pubkey, conversationB);

            const stateA = registry.getState(mockAgent.pubkey, conversationA);
            const stateB = registry.getState(mockAgent.pubkey, conversationB);

            expect(stateA?.id).not.toBe(stateB?.id);
            expect(stateA?.conversationId).toBe(conversationA);
            expect(stateB?.conversationId).toBe(conversationB);
        });

        it("should set pending delegations", () => {
            const ralNumber = registry.create(mockAgent.pubkey, CONVERSATION_ID);

            const pendingDelegations: PendingDelegation[] = [
                {
                    eventId: "delegation-event-123",
                    recipientPubkey: mockAgent2.pubkey,
                    recipientSlug: "agent2",
                    prompt: "Please help with this task",
                },
            ];

            registry.setPendingDelegations(mockAgent.pubkey, CONVERSATION_ID, ralNumber, pendingDelegations);

            const state = registry.getState(mockAgent.pubkey, CONVERSATION_ID);
            expect(state?.pendingDelegations).toHaveLength(1);
            expect(state?.pendingDelegations[0].eventId).toBe("delegation-event-123");
        });

        it("should find state waiting for a specific delegation via event ID lookup", () => {
            const ralNumber = registry.create(mockAgent.pubkey, CONVERSATION_ID);

            const pendingDelegations: PendingDelegation[] = [
                {
                    eventId: "delegation-event-456",
                    recipientPubkey: mockAgent2.pubkey,
                    prompt: "Task prompt",
                },
            ];

            registry.setPendingDelegations(mockAgent.pubkey, CONVERSATION_ID, ralNumber, pendingDelegations);

            const waitingState = registry.findStateWaitingForDelegation("delegation-event-456");
            expect(waitingState).toBeDefined();
            expect(waitingState?.agentPubkey).toBe(mockAgent.pubkey);
            expect(waitingState?.conversationId).toBe(CONVERSATION_ID);

            const noState = registry.findStateWaitingForDelegation("unknown-event");
            expect(noState).toBeUndefined();
        });

        it("should record completion and remove from pending", () => {
            const ralNumber = registry.create(mockAgent.pubkey, CONVERSATION_ID);

            const pendingDelegations: PendingDelegation[] = [
                {
                    eventId: "delegation-event-789",
                    recipientPubkey: mockAgent2.pubkey,
                    prompt: "Task prompt",
                },
            ];

            registry.setPendingDelegations(mockAgent.pubkey, CONVERSATION_ID, ralNumber, pendingDelegations);

            const completion: CompletedDelegation = {
                eventId: "delegation-event-789",
                recipientPubkey: mockAgent2.pubkey,
                response: "Task completed successfully",
                responseEventId: "response-event-abc",
                completedAt: Date.now(),
            };

            const updatedState = registry.recordCompletion(completion);

            expect(updatedState).toBeDefined();
            expect(updatedState?.pendingDelegations).toHaveLength(0);
            expect(updatedState?.completedDelegations).toHaveLength(1);
            expect(updatedState?.completedDelegations[0].response).toBe("Task completed successfully");
        });

        it("should track partial completions correctly", () => {
            const ralNumber = registry.create(mockAgent.pubkey, CONVERSATION_ID);

            const pendingDelegations: PendingDelegation[] = [
                {
                    eventId: "delegation-1",
                    recipientPubkey: mockAgent2.pubkey,
                    prompt: "Task 1",
                },
                {
                    eventId: "delegation-2",
                    recipientPubkey: "agent3pubkey",
                    prompt: "Task 2",
                },
            ];

            registry.setPendingDelegations(mockAgent.pubkey, CONVERSATION_ID, ralNumber, pendingDelegations);

            // Complete first delegation
            const state1 = registry.recordCompletion({
                eventId: "delegation-1",
                recipientPubkey: mockAgent2.pubkey,
                response: "Done 1",
                completedAt: Date.now(),
            });

            // Partial completion - 1 pending, 1 completed
            expect(state1?.pendingDelegations).toHaveLength(1);
            expect(state1?.completedDelegations).toHaveLength(1);

            // Complete second delegation
            const state2 = registry.recordCompletion({
                eventId: "delegation-2",
                recipientPubkey: "agent3pubkey",
                response: "Done 2",
                completedAt: Date.now(),
            });

            // All complete
            expect(state2?.pendingDelegations).toHaveLength(0);
            expect(state2?.completedDelegations).toHaveLength(2);
        });

        it("should not affect isStreaming when setting pending delegations", () => {
            const ralNumber = registry.create(mockAgent.pubkey, CONVERSATION_ID);

            const initialState = registry.getState(mockAgent.pubkey, CONVERSATION_ID);
            expect(initialState?.isStreaming).toBe(false);

            // Set pending delegations - isStreaming is not affected
            registry.setPendingDelegations(mockAgent.pubkey, CONVERSATION_ID, ralNumber, [
                {
                    eventId: "del-1",
                    recipientPubkey: mockAgent2.pubkey,
                    prompt: "Task",
                },
            ]);

            const stateWithPending = registry.getState(mockAgent.pubkey, CONVERSATION_ID);
            expect(stateWithPending?.isStreaming).toBe(false);
            expect(stateWithPending?.pendingDelegations).toHaveLength(1);
        });
    });

    describe("Stop Execution Signal", () => {
        it("should correctly identify stop execution signals", () => {
            const validSignal = {
                __stopExecution: true,
                pendingDelegations: [
                    {
                        eventId: "del-123",
                        recipientPubkey: "pubkey",
                        prompt: "task",
                    },
                ],
            };

            expect(isStopExecutionSignal(validSignal)).toBe(true);

            const invalidSignals = [
                null,
                undefined,
                {},
                { __stopExecution: false },
                { pendingDelegations: [] },
                "string",
                123,
            ];

            for (const invalid of invalidSignals) {
                expect(isStopExecutionSignal(invalid)).toBe(false);
            }
        });
    });

    describe("DelegationCompletionHandler Integration", () => {
        it("should detect delegation completion via e-tag matching", async () => {
            // Setup: Create RAL with pending delegation
            const ralNumber = registry.create(mockAgent.pubkey, CONVERSATION_ID);
            registry.setPendingDelegations(mockAgent.pubkey, CONVERSATION_ID, ralNumber, [
                {
                    eventId: "original-delegation-event-id",
                    recipientPubkey: mockAgent2.pubkey,
                    recipientSlug: "agent2",
                    prompt: "Please complete this task",
                },
            ]);

            // Create mock completion event (agent2 responding)
            const completionEvent = {
                id: "response-event-id",
                pubkey: mockAgent2.pubkey,
                kind: 1111,
                content: "Task completed! Here are the results.",
                created_at: Math.floor(Date.now() / 1000),
                tags: [
                    ["e", "original-delegation-event-id"], // e-tags the delegation
                    ["p", mockAgent.pubkey], // p-tags the delegating agent
                ],
                getMatchingTags: (tag: string) => {
                    if (tag === "e") return [["e", "original-delegation-event-id"]];
                    if (tag === "p") return [["p", mockAgent.pubkey]];
                    return [];
                },
                tagValue: (tag: string) => {
                    if (tag === "e") return "original-delegation-event-id";
                    return undefined;
                },
            } as unknown as NDKEvent;

            // Create mock conversation
            const mockConversation: Conversation = {
                id: CONVERSATION_ID,
                phase: "default",
                history: [completionEvent],
                rootEventId: "root-event",
                createdAt: Date.now(),
                lastActivityAt: Date.now(),
            };

            const mockCoordinator = {} as ConversationCoordinator;

            // Execute handler - now just records completion, routing is via p-tags
            const result = await handleDelegationCompletion(
                completionEvent,
                mockConversation,
                mockCoordinator
            );

            // Verify completion was recorded
            expect(result.recorded).toBe(true);
            expect(result.agentSlug).toBe("transparent");
            expect(result.conversationId).toBe(CONVERSATION_ID);

            // Verify RAL state was updated
            const state = registry.getState(mockAgent.pubkey, CONVERSATION_ID);
            expect(state?.pendingDelegations).toHaveLength(0);
            expect(state?.completedDelegations).toHaveLength(1);
        });

        it("should not record completion for unrelated events", async () => {
            // Setup: Create RAL with pending delegation
            const ralNumber = registry.create(mockAgent.pubkey, CONVERSATION_ID);
            registry.setPendingDelegations(mockAgent.pubkey, CONVERSATION_ID, ralNumber, [
                {
                    eventId: "my-delegation-id",
                    recipientPubkey: mockAgent2.pubkey,
                    prompt: "Task",
                },
            ]);

            // Create event that doesn't e-tag any delegation
            const unrelatedEvent = {
                id: "unrelated-event",
                pubkey: "random-pubkey",
                kind: 1111,
                content: "Some random message",
                tags: [],
                getMatchingTags: () => [],
                tagValue: () => undefined,
            } as unknown as NDKEvent;

            const mockConversation: Conversation = {
                id: "conv-456",
                phase: "default",
                history: [],
                rootEventId: "root",
                createdAt: Date.now(),
                lastActivityAt: Date.now(),
            };

            const result = await handleDelegationCompletion(
                unrelatedEvent,
                mockConversation,
                {} as ConversationCoordinator
            );

            // Should not record anything for unrelated events
            expect(result.recorded).toBe(false);
            expect(result.agentSlug).toBeUndefined();

            // RAL state should be unchanged
            const state = registry.getState(mockAgent.pubkey, CONVERSATION_ID);
            expect(state?.pendingDelegations).toHaveLength(1);
            expect(state?.completedDelegations).toHaveLength(0);
        });

        it("should record each completion independently (routing via p-tags)", async () => {
            // Setup: Create RAL with multiple pending delegations
            const ralNumber = registry.create(mockAgent.pubkey, CONVERSATION_ID);
            registry.setPendingDelegations(mockAgent.pubkey, CONVERSATION_ID, ralNumber, [
                {
                    eventId: "delegation-1",
                    recipientPubkey: mockAgent2.pubkey,
                    prompt: "Task 1",
                },
                {
                    eventId: "delegation-2",
                    recipientPubkey: "agent3pubkey",
                    prompt: "Task 2",
                },
            ]);

            // First completion
            const firstCompletion = {
                id: "response-1",
                pubkey: mockAgent2.pubkey,
                kind: 1111,
                content: "Task 1 done",
                tags: [
                    ["e", "delegation-1"],
                    ["p", mockAgent.pubkey],
                ],
                getMatchingTags: (tag: string) => {
                    if (tag === "e") return [["e", "delegation-1"]];
                    if (tag === "p") return [["p", mockAgent.pubkey]];
                    return [];
                },
                tagValue: (tag: string) => {
                    if (tag === "e") return "delegation-1";
                    return undefined;
                },
            } as unknown as NDKEvent;

            const mockConversation: Conversation = {
                id: CONVERSATION_ID,
                phase: "default",
                history: [],
                rootEventId: "root",
                createdAt: Date.now(),
                lastActivityAt: Date.now(),
            };

            const result1 = await handleDelegationCompletion(
                firstCompletion,
                mockConversation,
                {} as ConversationCoordinator
            );

            // First completion should be recorded
            expect(result1.recorded).toBe(true);
            expect(result1.agentSlug).toBe("transparent");

            // Verify partial completion state
            const stateAfterFirst = registry.getState(mockAgent.pubkey, CONVERSATION_ID);
            expect(stateAfterFirst?.pendingDelegations).toHaveLength(1);
            expect(stateAfterFirst?.completedDelegations).toHaveLength(1);

            // Second completion
            const secondCompletion = {
                id: "response-2",
                pubkey: "agent3pubkey",
                kind: 1111,
                content: "Task 2 done",
                tags: [
                    ["e", "delegation-2"],
                    ["p", mockAgent.pubkey],
                ],
                getMatchingTags: (tag: string) => {
                    if (tag === "e") return [["e", "delegation-2"]];
                    if (tag === "p") return [["p", mockAgent.pubkey]];
                    return [];
                },
                tagValue: (tag: string) => {
                    if (tag === "e") return "delegation-2";
                    return undefined;
                },
            } as unknown as NDKEvent;

            const result2 = await handleDelegationCompletion(
                secondCompletion,
                mockConversation,
                {} as ConversationCoordinator
            );

            // Second completion should also be recorded
            expect(result2.recorded).toBe(true);

            // Verify all complete state
            const stateAfterSecond = registry.getState(mockAgent.pubkey, CONVERSATION_ID);
            expect(stateAfterSecond?.pendingDelegations).toHaveLength(0);
            expect(stateAfterSecond?.completedDelegations).toHaveLength(2);
        });
    });

    describe("Full Delegation Flow", () => {
        it("should handle complete delegation lifecycle", async () => {
            // 1. Agent starts execution
            const ralNumber = registry.create(mockAgent.pubkey, CONVERSATION_ID);
            expect(registry.getState(mockAgent.pubkey, CONVERSATION_ID)?.isStreaming).toBe(false);

            // 2. Agent calls delegate tool, which sets pending delegations
            const pendingDelegations: PendingDelegation[] = [
                {
                    eventId: "delegation-full-flow-test",
                    recipientPubkey: mockAgent2.pubkey,
                    recipientSlug: "agent2",
                    prompt: "Handle this subtask",
                },
            ];

            registry.setPendingDelegations(mockAgent.pubkey, CONVERSATION_ID, ralNumber, pendingDelegations);

            // 3. Verify state with pending delegations
            const stateWithPending = registry.getState(mockAgent.pubkey, CONVERSATION_ID);
            expect(stateWithPending?.pendingDelegations).toHaveLength(1);

            // 4. Agent2 completes and responds
            const completionEvent = {
                id: "agent2-response-event",
                pubkey: mockAgent2.pubkey,
                kind: 1111,
                content: "I have completed the subtask. Here are the results.",
                tags: [
                    ["e", "delegation-full-flow-test"],
                    ["p", mockAgent.pubkey],
                ],
                getMatchingTags: (tag: string) => {
                    if (tag === "e") return [["e", "delegation-full-flow-test"]];
                    if (tag === "p") return [["p", mockAgent.pubkey]];
                    return [];
                },
                tagValue: (tag: string) => {
                    if (tag === "e") return "delegation-full-flow-test";
                    return undefined;
                },
            } as unknown as NDKEvent;

            const mockConversation: Conversation = {
                id: CONVERSATION_ID,
                phase: "default",
                history: [completionEvent],
                rootEventId: "original-request",
                createdAt: Date.now(),
                lastActivityAt: Date.now(),
            };

            // 5. DelegationCompletionHandler records the completion
            // (routing happens via p-tags separately)
            const result = await handleDelegationCompletion(
                completionEvent,
                mockConversation,
                {} as ConversationCoordinator
            );

            // 6. Verify completion was recorded
            expect(result.recorded).toBe(true);
            expect(result.agentSlug).toBe("transparent");

            // 7. Verify RAL state has completion recorded
            const stateAfterCompletion = registry.getState(mockAgent.pubkey, CONVERSATION_ID);
            expect(stateAfterCompletion?.pendingDelegations).toHaveLength(0);
            expect(stateAfterCompletion?.completedDelegations).toHaveLength(1);
            expect(stateAfterCompletion?.completedDelegations[0].response).toBe(
                "I have completed the subtask. Here are the results."
            );

            // 8. AgentExecutor detects RAL with completions
            const ralState = registry.getState(mockAgent.pubkey, CONVERSATION_ID)!;
            expect(ralState.completedDelegations.length).toBeGreaterThan(0);

            // Clear completed delegations after processing
            registry.clearCompletedDelegations(mockAgent.pubkey, CONVERSATION_ID, ralNumber);
            expect(registry.getState(mockAgent.pubkey, CONVERSATION_ID)?.completedDelegations).toHaveLength(0);
        });
    });
});
