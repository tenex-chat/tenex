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
        it("should create a new RAL entry for an agent", () => {
            const ralId = registry.create(mockAgent.pubkey);

            expect(ralId).toBeDefined();
            expect(typeof ralId).toBe("string");

            const state = registry.getStateByAgent(mockAgent.pubkey);
            expect(state).toBeDefined();
            expect(state?.status).toBe("executing");
            expect(state?.pendingDelegations).toEqual([]);
            expect(state?.completedDelegations).toEqual([]);
        });

        it("should save state with pending delegations when pausing", () => {
            registry.create(mockAgent.pubkey);

            const pendingDelegations: PendingDelegation[] = [
                {
                    eventId: "delegation-event-123",
                    recipientPubkey: mockAgent2.pubkey,
                    recipientSlug: "agent2",
                    prompt: "Please help with this task",
                },
            ];

            const messages = [
                { role: "user" as const, content: "Hello" },
                { role: "assistant" as const, content: "I will delegate this" },
            ];

            registry.saveState(mockAgent.pubkey, messages, pendingDelegations);

            const state = registry.getStateByAgent(mockAgent.pubkey);
            expect(state?.status).toBe("paused");
            expect(state?.pendingDelegations).toHaveLength(1);
            expect(state?.pendingDelegations[0].eventId).toBe("delegation-event-123");
            expect(state?.messages).toHaveLength(2);
        });

        it("should find agent waiting for a specific delegation", () => {
            registry.create(mockAgent.pubkey);

            const pendingDelegations: PendingDelegation[] = [
                {
                    eventId: "delegation-event-456",
                    recipientPubkey: mockAgent2.pubkey,
                    prompt: "Task prompt",
                },
            ];

            registry.saveState(mockAgent.pubkey, [], pendingDelegations);

            const waitingAgent = registry.findAgentWaitingForDelegation("delegation-event-456");
            expect(waitingAgent).toBe(mockAgent.pubkey);

            const noAgent = registry.findAgentWaitingForDelegation("unknown-event");
            expect(noAgent).toBeUndefined();
        });

        it("should record completion and remove from pending", () => {
            registry.create(mockAgent.pubkey);

            const pendingDelegations: PendingDelegation[] = [
                {
                    eventId: "delegation-event-789",
                    recipientPubkey: mockAgent2.pubkey,
                    prompt: "Task prompt",
                },
            ];

            registry.saveState(mockAgent.pubkey, [], pendingDelegations);

            const completion: CompletedDelegation = {
                eventId: "delegation-event-789",
                recipientPubkey: mockAgent2.pubkey,
                response: "Task completed successfully",
                responseEventId: "response-event-abc",
                completedAt: Date.now(),
            };

            registry.recordCompletion(mockAgent.pubkey, completion);

            const state = registry.getStateByAgent(mockAgent.pubkey);
            expect(state?.pendingDelegations).toHaveLength(0);
            expect(state?.completedDelegations).toHaveLength(1);
            expect(state?.completedDelegations[0].response).toBe("Task completed successfully");
        });

        it("should report all delegations complete correctly", () => {
            registry.create(mockAgent.pubkey);

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

            registry.saveState(mockAgent.pubkey, [], pendingDelegations);

            // Not complete yet
            expect(registry.allDelegationsComplete(mockAgent.pubkey)).toBe(false);

            // Complete first delegation
            registry.recordCompletion(mockAgent.pubkey, {
                eventId: "delegation-1",
                recipientPubkey: mockAgent2.pubkey,
                response: "Done 1",
                completedAt: Date.now(),
            });

            // Still not complete
            expect(registry.allDelegationsComplete(mockAgent.pubkey)).toBe(false);

            // Complete second delegation
            registry.recordCompletion(mockAgent.pubkey, {
                eventId: "delegation-2",
                recipientPubkey: "agent3pubkey",
                response: "Done 2",
                completedAt: Date.now(),
            });

            // Now all complete
            expect(registry.allDelegationsComplete(mockAgent.pubkey)).toBe(true);
        });

        it("should mark RAL as resuming", () => {
            registry.create(mockAgent.pubkey);

            const pendingDelegations: PendingDelegation[] = [
                {
                    eventId: "delegation-xyz",
                    recipientPubkey: mockAgent2.pubkey,
                    prompt: "Task",
                },
            ];

            registry.saveState(mockAgent.pubkey, [], pendingDelegations);
            expect(registry.getStateByAgent(mockAgent.pubkey)?.status).toBe("paused");

            registry.markResuming(mockAgent.pubkey);
            expect(registry.getStateByAgent(mockAgent.pubkey)?.status).toBe("executing");
        });

        it("should check hasPausedRal correctly", () => {
            registry.create(mockAgent.pubkey);

            // Executing - not paused
            expect(registry.hasPausedRal(mockAgent.pubkey)).toBe(false);

            // Pause with pending delegations
            registry.saveState(mockAgent.pubkey, [], [
                {
                    eventId: "del-1",
                    recipientPubkey: mockAgent2.pubkey,
                    prompt: "Task",
                },
            ]);

            // Now paused
            expect(registry.hasPausedRal(mockAgent.pubkey)).toBe(true);
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
            registry.create(mockAgent.pubkey);
            registry.saveState(mockAgent.pubkey, [], [
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
                id: "conv-123",
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

            // Verify RAL state was updated
            const state = registry.getStateByAgent(mockAgent.pubkey);
            expect(state?.pendingDelegations).toHaveLength(0);
            expect(state?.completedDelegations).toHaveLength(1);
        });

        it("should not record completion for unrelated events", async () => {
            // Setup: Create RAL with pending delegation
            registry.create(mockAgent.pubkey);
            registry.saveState(mockAgent.pubkey, [], [
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
            const state = registry.getStateByAgent(mockAgent.pubkey);
            expect(state?.pendingDelegations).toHaveLength(1);
            expect(state?.completedDelegations).toHaveLength(0);
        });

        it("should record each completion independently (routing via p-tags)", async () => {
            // Setup: Create RAL with multiple pending delegations
            registry.create(mockAgent.pubkey);
            registry.saveState(mockAgent.pubkey, [], [
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
                id: "conv-multi",
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
            const stateAfterFirst = registry.getStateByAgent(mockAgent.pubkey);
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
            const stateAfterSecond = registry.getStateByAgent(mockAgent.pubkey);
            expect(stateAfterSecond?.pendingDelegations).toHaveLength(0);
            expect(stateAfterSecond?.completedDelegations).toHaveLength(2);
        });
    });

    describe("Full Delegation Flow", () => {
        it("should handle complete delegation lifecycle", async () => {
            // 1. Agent starts execution
            registry.create(mockAgent.pubkey);
            expect(registry.getStateByAgent(mockAgent.pubkey)?.status).toBe("executing");

            // 2. Agent calls delegate tool, which saves state and pauses
            const messages = [
                { role: "user" as const, content: "Please get help from agent2" },
                { role: "assistant" as const, content: "I'll delegate this task" },
            ];

            const pendingDelegations: PendingDelegation[] = [
                {
                    eventId: "delegation-full-flow-test",
                    recipientPubkey: mockAgent2.pubkey,
                    recipientSlug: "agent2",
                    prompt: "Handle this subtask",
                },
            ];

            registry.saveState(mockAgent.pubkey, messages, pendingDelegations);

            // 3. Verify paused state
            const pausedState = registry.getStateByAgent(mockAgent.pubkey);
            expect(pausedState?.status).toBe("paused");
            expect(pausedState?.messages).toHaveLength(2);
            expect(pausedState?.pendingDelegations).toHaveLength(1);

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
                id: "conv-full-flow",
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
            const stateAfterCompletion = registry.getStateByAgent(mockAgent.pubkey);
            expect(stateAfterCompletion?.pendingDelegations).toHaveLength(0);
            expect(stateAfterCompletion?.completedDelegations).toHaveLength(1);
            expect(stateAfterCompletion?.completedDelegations[0].response).toBe(
                "I have completed the subtask. Here are the results."
            );

            // 8. AgentExecutor detects paused RAL with completions and resumes
            // (simulating what AgentExecutor does)
            const ralState = registry.getStateByAgent(mockAgent.pubkey)!;
            expect(ralState.status).toBe("paused");
            expect(ralState.completedDelegations.length).toBeGreaterThan(0);

            // Add completed responses as user messages (what AgentExecutor does)
            for (const completion of ralState.completedDelegations) {
                const agentName = completion.recipientSlug || completion.recipientPubkey.substring(0, 8);
                ralState.messages.push({
                    role: "user",
                    content: `[Response from ${agentName}]: ${completion.response}`,
                });
            }

            // Mark as resuming and clear completed delegations
            registry.markResuming(mockAgent.pubkey);
            expect(registry.getStateByAgent(mockAgent.pubkey)?.status).toBe("executing");

            registry.clearCompletedDelegations(mockAgent.pubkey);
            expect(registry.getCompletedDelegationsForInjection(mockAgent.pubkey)).toHaveLength(0);

            // Verify messages include the response as user message
            const finalState = registry.getStateByAgent(mockAgent.pubkey);
            expect(finalState?.messages).toHaveLength(3); // original 2 + response
            expect(finalState?.messages[2].role).toBe("user");
            expect(finalState?.messages[2].content).toContain("Response from agent2");
        });
    });
});
