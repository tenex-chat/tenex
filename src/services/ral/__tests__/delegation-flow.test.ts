import { describe, expect, it, beforeEach, mock } from "bun:test";
import { RALRegistry } from "../RALRegistry";
import { isStopExecutionSignal } from "../types";
import type { PendingDelegation, CompletedDelegation } from "../types";
import { handleDelegationCompletion } from "@/services/dispatch/DelegationCompletionHandler";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

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
const PROJECT_ID = "31933:pubkey:test-project";

mock.module("@/services/projects", () => ({
    getProjectContext: () => ({
        getAgentByPubkey: (pubkey: string) => {
            if (pubkey === mockAgent.pubkey) return mockAgent;
            if (pubkey === mockAgent2.pubkey) return mockAgent2;
            return undefined;
        },
    }),
    isProjectContextInitialized: () => true,
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
            const ralNumber = registry.create(mockAgent.pubkey, CONVERSATION_ID, PROJECT_ID);

            expect(ralNumber).toBeDefined();
            expect(typeof ralNumber).toBe("number");

            const state = registry.getState(mockAgent.pubkey, CONVERSATION_ID);
            expect(state).toBeDefined();
            expect(state?.isStreaming).toBe(false);
            expect(state?.conversationId).toBe(CONVERSATION_ID);
            // Delegations are now stored at conversation level
            expect(registry.getConversationPendingDelegations(mockAgent.pubkey, CONVERSATION_ID, ralNumber)).toEqual([]);
            expect(registry.getConversationCompletedDelegations(mockAgent.pubkey, CONVERSATION_ID, ralNumber)).toEqual([]);
        });

        it("should isolate RAL state between different conversations", () => {
            const conversationA = "conv-a";
            const conversationB = "conv-b";

            registry.create(mockAgent.pubkey, conversationA, PROJECT_ID);
            registry.create(mockAgent.pubkey, conversationB, PROJECT_ID);

            const stateA = registry.getState(mockAgent.pubkey, conversationA);
            const stateB = registry.getState(mockAgent.pubkey, conversationB);

            expect(stateA?.id).not.toBe(stateB?.id);
            expect(stateA?.conversationId).toBe(conversationA);
            expect(stateB?.conversationId).toBe(conversationB);
        });

        it("should set pending delegations", () => {
            const ralNumber = registry.create(mockAgent.pubkey, CONVERSATION_ID, PROJECT_ID);

            const pendingDelegations: PendingDelegation[] = [
                {
                    type: "delegate",
                    delegationConversationId: "delegation-event-123",
                    recipientPubkey: mockAgent2.pubkey,
                    senderPubkey: mockAgent.pubkey,
                    prompt: "Please help with this task",
                    ralNumber,
                },
            ];

            registry.setPendingDelegations(mockAgent.pubkey, CONVERSATION_ID, ralNumber, pendingDelegations);

            const pending = registry.getConversationPendingDelegations(mockAgent.pubkey, CONVERSATION_ID, ralNumber);
            expect(pending).toHaveLength(1);
            expect(pending[0].delegationConversationId).toBe("delegation-event-123");
        });

        it("should find state waiting for a specific delegation via event ID lookup", () => {
            const ralNumber = registry.create(mockAgent.pubkey, CONVERSATION_ID, PROJECT_ID);

            const pendingDelegations: PendingDelegation[] = [
                {
                    type: "delegate",
                    delegationConversationId: "delegation-event-456",
                    recipientPubkey: mockAgent2.pubkey,
                    senderPubkey: mockAgent.pubkey,
                    prompt: "Task prompt",
                    ralNumber,
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
            const ralNumber = registry.create(mockAgent.pubkey, CONVERSATION_ID, PROJECT_ID);

            const pendingDelegations: PendingDelegation[] = [
                {
                    type: "delegate",
                    delegationConversationId: "delegation-event-789",
                    recipientPubkey: mockAgent2.pubkey,
                    senderPubkey: mockAgent.pubkey,
                    prompt: "Task prompt",
                    ralNumber,
                },
            ];

            registry.setPendingDelegations(mockAgent.pubkey, CONVERSATION_ID, ralNumber, pendingDelegations);

            const location = registry.recordCompletion({
                delegationConversationId: "delegation-event-789",
                recipientPubkey: mockAgent2.pubkey,
                response: "Task completed successfully",
                completedAt: Date.now(),
            });

            expect(location).toBeDefined();
            const pending = registry.getConversationPendingDelegations(mockAgent.pubkey, CONVERSATION_ID, ralNumber);
            const completed = registry.getConversationCompletedDelegations(mockAgent.pubkey, CONVERSATION_ID, ralNumber);
            expect(pending).toHaveLength(0);
            expect(completed).toHaveLength(1);
            // Transcript has 2 entries: prompt (index 0) and response (index 1)
            expect(completed[0].transcript[1].content).toBe("Task completed successfully");
        });

        it("should track partial completions correctly", () => {
            const ralNumber = registry.create(mockAgent.pubkey, CONVERSATION_ID, PROJECT_ID);

            const pendingDelegations: PendingDelegation[] = [
                {
                    type: "delegate",
                    delegationConversationId: "delegation-1",
                    recipientPubkey: mockAgent2.pubkey,
                    senderPubkey: mockAgent.pubkey,
                    prompt: "Task 1",
                    ralNumber,
                },
                {
                    type: "delegate",
                    delegationConversationId: "delegation-2",
                    recipientPubkey: "agent3pubkey",
                    senderPubkey: mockAgent.pubkey,
                    prompt: "Task 2",
                    ralNumber,
                },
            ];

            registry.setPendingDelegations(mockAgent.pubkey, CONVERSATION_ID, ralNumber, pendingDelegations);

            // Complete first delegation
            registry.recordCompletion({
                delegationConversationId: "delegation-1",
                recipientPubkey: mockAgent2.pubkey,
                response: "Done 1",
                completedAt: Date.now(),
            });

            // Partial completion - 1 pending, 1 completed
            const pending1 = registry.getConversationPendingDelegations(mockAgent.pubkey, CONVERSATION_ID, ralNumber);
            const completed1 = registry.getConversationCompletedDelegations(mockAgent.pubkey, CONVERSATION_ID, ralNumber);
            expect(pending1).toHaveLength(1);
            expect(completed1).toHaveLength(1);

            // Complete second delegation
            registry.recordCompletion({
                delegationConversationId: "delegation-2",
                recipientPubkey: "agent3pubkey",
                response: "Done 2",
                completedAt: Date.now(),
            });

            // All complete
            const pending2 = registry.getConversationPendingDelegations(mockAgent.pubkey, CONVERSATION_ID, ralNumber);
            const completed2 = registry.getConversationCompletedDelegations(mockAgent.pubkey, CONVERSATION_ID, ralNumber);
            expect(pending2).toHaveLength(0);
            expect(completed2).toHaveLength(2);
        });

        it("should not affect isStreaming when setting pending delegations", () => {
            const ralNumber = registry.create(mockAgent.pubkey, CONVERSATION_ID, PROJECT_ID);

            const initialState = registry.getState(mockAgent.pubkey, CONVERSATION_ID);
            expect(initialState?.isStreaming).toBe(false);

            // Set pending delegations - isStreaming is not affected
            registry.setPendingDelegations(mockAgent.pubkey, CONVERSATION_ID, ralNumber, [
                {
                    type: "delegate",
                    delegationConversationId: "del-1",
                    recipientPubkey: mockAgent2.pubkey,
                    senderPubkey: mockAgent.pubkey,
                    prompt: "Task",
                    ralNumber,
                },
            ]);

            const stateWithPending = registry.getState(mockAgent.pubkey, CONVERSATION_ID);
            expect(stateWithPending?.isStreaming).toBe(false);
            const pending = registry.getConversationPendingDelegations(mockAgent.pubkey, CONVERSATION_ID, ralNumber);
            expect(pending).toHaveLength(1);
        });
    });

    describe("Stop Execution Signal", () => {
        it("should correctly identify stop execution signals", () => {
            const validSignal = {
                __stopExecution: true,
                pendingDelegations: [
                    {
                        type: "delegate" as const,
                        delegationConversationId: "del-123",
                        recipientPubkey: "pubkey",
                        senderPubkey: "senderpubkey",
                        prompt: "task",
                        ralNumber: 1,
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
            const ralNumber = registry.create(mockAgent.pubkey, CONVERSATION_ID, PROJECT_ID);
            registry.setPendingDelegations(mockAgent.pubkey, CONVERSATION_ID, ralNumber, [
                {
                    type: "delegate",
                    delegationConversationId: "original-delegation-event-id",
                    recipientPubkey: mockAgent2.pubkey,
                    senderPubkey: mockAgent.pubkey,
                    prompt: "Please complete this task",
                    ralNumber,
                },
            ]);

            // Create mock completion event (agent2 responding)
            const completionEvent = {
                id: "response-event-id",
                pubkey: mockAgent2.pubkey,
                kind: 1,
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

            // Execute handler - now just records completion, routing is via p-tags
            const result = await handleDelegationCompletion(completionEvent);

            // Verify completion was recorded
            expect(result.recorded).toBe(true);
            expect(result.agentSlug).toBe("transparent");
            expect(result.conversationId).toBe(CONVERSATION_ID);

            // Verify RAL state was updated
            const pending = registry.getConversationPendingDelegations(mockAgent.pubkey, CONVERSATION_ID, ralNumber);
            const completed = registry.getConversationCompletedDelegations(mockAgent.pubkey, CONVERSATION_ID, ralNumber);
            expect(pending).toHaveLength(0);
            expect(completed).toHaveLength(1);
        });

        it("should not record completion for unrelated events", async () => {
            // Setup: Create RAL with pending delegation
            const ralNumber = registry.create(mockAgent.pubkey, CONVERSATION_ID, PROJECT_ID);
            registry.setPendingDelegations(mockAgent.pubkey, CONVERSATION_ID, ralNumber, [
                {
                    type: "delegate",
                    delegationConversationId: "my-delegation-id",
                    recipientPubkey: mockAgent2.pubkey,
                    senderPubkey: mockAgent.pubkey,
                    prompt: "Task",
                    ralNumber,
                },
            ]);

            // Create event that doesn't e-tag any delegation
            const unrelatedEvent = {
                id: "unrelated-event",
                pubkey: "random-pubkey",
                kind: 1,
                content: "Some random message",
                tags: [],
                getMatchingTags: () => [],
                tagValue: () => undefined,
            } as unknown as NDKEvent;

            const result = await handleDelegationCompletion(unrelatedEvent);

            // Should not record anything for unrelated events
            expect(result.recorded).toBe(false);
            expect(result.agentSlug).toBeUndefined();

            // RAL state should be unchanged
            const pending = registry.getConversationPendingDelegations(mockAgent.pubkey, CONVERSATION_ID, ralNumber);
            const completed = registry.getConversationCompletedDelegations(mockAgent.pubkey, CONVERSATION_ID, ralNumber);
            expect(pending).toHaveLength(1);
            expect(completed).toHaveLength(0);
        });

        it("should ignore completion for killed delegations", async () => {
            // Setup: Create RAL with pending delegation
            const ralNumber = registry.create(mockAgent.pubkey, CONVERSATION_ID, PROJECT_ID);
            registry.setPendingDelegations(mockAgent.pubkey, CONVERSATION_ID, ralNumber, [
                {
                    type: "delegate",
                    delegationConversationId: "killed-delegation-id",
                    recipientPubkey: mockAgent2.pubkey,
                    senderPubkey: mockAgent.pubkey,
                    prompt: "Task that will be killed",
                    ralNumber,
                },
            ]);

            // Verify delegation is pending
            expect(registry.getConversationPendingDelegations(mockAgent.pubkey, CONVERSATION_ID, ralNumber)).toHaveLength(1);
            expect(registry.isDelegationKilled("killed-delegation-id")).toBe(false);

            // Kill the delegation (simulates what happens when kill tool is called)
            const wasKilled = registry.markDelegationKilled("killed-delegation-id");
            expect(wasKilled).toBe(true);
            expect(registry.isDelegationKilled("killed-delegation-id")).toBe(true);

            // Create completion event from the delegated agent
            const completionEvent = {
                id: "late-completion-event",
                pubkey: mockAgent2.pubkey,
                kind: 1,
                content: "I finished the task!",
                tags: [
                    ["e", "killed-delegation-id"],
                    ["p", mockAgent.pubkey],
                ],
                getMatchingTags: (tag: string) => {
                    if (tag === "e") return [["e", "killed-delegation-id"]];
                    if (tag === "p") return [["p", mockAgent.pubkey]];
                    return [];
                },
                tagValue: (tag: string) => {
                    if (tag === "e") return "killed-delegation-id";
                    return undefined;
                },
            } as unknown as NDKEvent;

            // Attempt to record completion - should be ignored
            const result = await handleDelegationCompletion(completionEvent);

            // Verify completion was NOT recorded
            expect(result.recorded).toBe(false);

            // Verify delegation is still pending (not moved to completed)
            const pending = registry.getConversationPendingDelegations(mockAgent.pubkey, CONVERSATION_ID, ralNumber);
            const completed = registry.getConversationCompletedDelegations(mockAgent.pubkey, CONVERSATION_ID, ralNumber);
            expect(pending).toHaveLength(1); // Still pending
            expect(completed).toHaveLength(0); // Not completed
        });

        it("should preserve original kill time on idempotent kill calls", () => {
            // Setup: Create RAL with pending delegation
            const ralNumber = registry.create(mockAgent.pubkey, CONVERSATION_ID, PROJECT_ID);
            registry.setPendingDelegations(mockAgent.pubkey, CONVERSATION_ID, ralNumber, [
                {
                    type: "delegate",
                    delegationConversationId: "idempotent-kill-test",
                    recipientPubkey: mockAgent2.pubkey,
                    senderPubkey: mockAgent.pubkey,
                    prompt: "Task",
                    ralNumber,
                },
            ]);

            // First kill
            const firstKillTime = Date.now();
            const firstKill = registry.markDelegationKilled("idempotent-kill-test");
            expect(firstKill).toBe(true);

            // Get the kill time
            const delegation = registry.findDelegation("idempotent-kill-test");
            const originalKilledAt = delegation?.pending?.killedAt;
            expect(originalKilledAt).toBeDefined();
            expect(originalKilledAt).toBeGreaterThanOrEqual(firstKillTime);

            // Wait a bit and try to kill again
            const secondKill = registry.markDelegationKilled("idempotent-kill-test");
            expect(secondKill).toBe(true); // Still returns true (delegation is killed)

            // Verify original kill time is preserved
            const delegationAfter = registry.findDelegation("idempotent-kill-test");
            expect(delegationAfter?.pending?.killedAt).toBe(originalKilledAt);
        });

        it("should record each completion independently (routing via p-tags)", async () => {
            // Setup: Create RAL with multiple pending delegations
            const ralNumber = registry.create(mockAgent.pubkey, CONVERSATION_ID, PROJECT_ID);
            registry.setPendingDelegations(mockAgent.pubkey, CONVERSATION_ID, ralNumber, [
                {
                    type: "delegate",
                    delegationConversationId: "delegation-1",
                    recipientPubkey: mockAgent2.pubkey,
                    senderPubkey: mockAgent.pubkey,
                    prompt: "Task 1",
                    ralNumber,
                },
                {
                    type: "delegate",
                    delegationConversationId: "delegation-2",
                    recipientPubkey: "agent3pubkey",
                    senderPubkey: mockAgent.pubkey,
                    prompt: "Task 2",
                    ralNumber,
                },
            ]);

            // First completion
            const firstCompletion = {
                id: "response-1",
                pubkey: mockAgent2.pubkey,
                kind: 1,
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

            const result1 = await handleDelegationCompletion(firstCompletion);

            // First completion should be recorded
            expect(result1.recorded).toBe(true);
            expect(result1.agentSlug).toBe("transparent");

            // Verify partial completion state
            const pendingAfterFirst = registry.getConversationPendingDelegations(mockAgent.pubkey, CONVERSATION_ID, ralNumber);
            const completedAfterFirst = registry.getConversationCompletedDelegations(mockAgent.pubkey, CONVERSATION_ID, ralNumber);
            expect(pendingAfterFirst).toHaveLength(1);
            expect(completedAfterFirst).toHaveLength(1);

            // Second completion
            const secondCompletion = {
                id: "response-2",
                pubkey: "agent3pubkey",
                kind: 1,
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

            const result2 = await handleDelegationCompletion(secondCompletion);

            // Second completion should also be recorded
            expect(result2.recorded).toBe(true);

            // Verify all complete state
            const pendingAfterSecond = registry.getConversationPendingDelegations(mockAgent.pubkey, CONVERSATION_ID, ralNumber);
            const completedAfterSecond = registry.getConversationCompletedDelegations(mockAgent.pubkey, CONVERSATION_ID, ralNumber);
            expect(pendingAfterSecond).toHaveLength(0);
            expect(completedAfterSecond).toHaveLength(2);
        });
    });

    describe("Full Delegation Flow", () => {
        it("should handle complete delegation lifecycle", async () => {
            // 1. Agent starts execution
            const ralNumber = registry.create(mockAgent.pubkey, CONVERSATION_ID, PROJECT_ID);
            expect(registry.getState(mockAgent.pubkey, CONVERSATION_ID)?.isStreaming).toBe(false);

            // 2. Agent calls delegate tool, which sets pending delegations
            const pendingDelegations: PendingDelegation[] = [
                {
                    type: "delegate",
                    delegationConversationId: "delegation-full-flow-test",
                    recipientPubkey: mockAgent2.pubkey,
                    senderPubkey: mockAgent.pubkey,
                    prompt: "Handle this subtask",
                    ralNumber,
                },
            ];

            registry.setPendingDelegations(mockAgent.pubkey, CONVERSATION_ID, ralNumber, pendingDelegations);

            // 3. Verify state with pending delegations
            const pendingAfterDelegate = registry.getConversationPendingDelegations(mockAgent.pubkey, CONVERSATION_ID, ralNumber);
            expect(pendingAfterDelegate).toHaveLength(1);

            // 4. Agent2 completes and responds
            const completionEvent = {
                id: "agent2-response-event",
                pubkey: mockAgent2.pubkey,
                kind: 1,
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

            // 5. DelegationCompletionHandler records the completion
            // (routing happens via p-tags separately)
            const result = await handleDelegationCompletion(completionEvent);

            // 6. Verify completion was recorded
            expect(result.recorded).toBe(true);
            expect(result.agentSlug).toBe("transparent");

            // 7. Verify completion recorded in conversation storage
            const pendingAfterCompletion = registry.getConversationPendingDelegations(mockAgent.pubkey, CONVERSATION_ID, ralNumber);
            const completedAfterCompletion = registry.getConversationCompletedDelegations(mockAgent.pubkey, CONVERSATION_ID, ralNumber);
            expect(pendingAfterCompletion).toHaveLength(0);
            expect(completedAfterCompletion).toHaveLength(1);
            // Transcript has 2 entries: prompt (index 0) and response (index 1)
            expect(completedAfterCompletion[0].transcript[1].content).toBe(
                "I have completed the subtask. Here are the results."
            );

            // 8. AgentExecutor detects completed delegations
            const allCompleted = registry.getConversationCompletedDelegations(mockAgent.pubkey, CONVERSATION_ID, ralNumber);
            expect(allCompleted.length).toBeGreaterThan(0);

            // Completions remain in conversation storage until conversation ends
            // (clearing RAL doesn't delete delegations anymore - they persist)
            registry.clearRAL(mockAgent.pubkey, CONVERSATION_ID, ralNumber);

            // After clearRAL, RAL is gone but delegations persist
            expect(registry.getState(mockAgent.pubkey, CONVERSATION_ID)).toBeUndefined();
            const completedAfterClear = registry.getConversationCompletedDelegations(mockAgent.pubkey, CONVERSATION_ID, ralNumber);
            expect(completedAfterClear).toHaveLength(1); // Still there!

            // Delegations are only cleared when conversation ends
            registry.clear(mockAgent.pubkey, CONVERSATION_ID);
            const completedAfterConvClear = registry.getConversationCompletedDelegations(mockAgent.pubkey, CONVERSATION_ID, ralNumber);
            expect(completedAfterConvClear).toHaveLength(0); // Now gone
        });
    });
});
