/**
 * TRUE INTEGRATION TEST for PostCompletionChecker.
 *
 * This test directly exercises `checkPostCompletion()` from PostCompletionChecker.ts
 * with a stubbed ConversationStore and FullRuntimeContext.
 *
 * Critical fix being validated: The RAL scoping fix at PostCompletionChecker.ts:132-140
 * where `getConversationPendingDelegations` is called WITHOUT a ralNumber parameter
 * to get conversation-wide scope (not RAL-scoped).
 *
 * Bug scenario:
 * - RAL 1: Agent delegates task to another agent
 * - RAL 2: Agent is invoked again (delegation from RAL 1 still pending)
 * - Without the fix: pendingDelegationCount = 0 (wrong! only checks RAL 2)
 * - With the fix: pendingDelegationCount = 1 (correct! checks all conversation delegations)
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, mock } from "bun:test";
import { mkdir, rm } from "fs/promises";

// Mock dependencies that checkPostCompletion relies on
mock.module("@/services/projects", () => ({
    getProjectContext: () => ({
        project: {
            tagReference: () => ["a", "31933:testpubkey:test-project"],
        },
        agents: new Map(),
        mcpManager: undefined,
        agentLessons: [],
    }),
}));

mock.module("@/prompts/utils/systemPromptBuilder", () => ({
    buildSystemPromptMessages: async () => [],
}));

mock.module("@/services/nudge", () => ({
    NudgeService: {
        getInstance: () => ({
            fetchNudges: async () => "",
        }),
    },
}));

mock.module("@/nostr/AgentEventDecoder", () => ({
    AgentEventDecoder: {
        extractNudgeEventIds: () => [],
    },
}));

mock.module("@/tools/registry", () => ({
    getToolsObject: () => ({}),
}));

// Import after mocks are set up
import { checkPostCompletion, type PostCompletionCheckerConfig } from "../PostCompletionChecker";
import { ConversationStore } from "@/conversations/ConversationStore";
import { RALRegistry } from "@/services/ral/RALRegistry";
import { supervisorOrchestrator } from "@/agents/supervision";
import { registerDefaultHeuristics, resetRegistrationForTesting } from "@/agents/supervision/registerHeuristics";
import type { PendingDelegation } from "@/services/ral/types";
import type { FullRuntimeContext } from "../types";
import type { AgentInstance } from "@/agents/types/runtime";
import type { CompleteEvent } from "@/llm/types";
import { createMockNDKEvent } from "@/test-utils/mock-factories";

describe("PostCompletionChecker - True Integration Test", () => {
    const TEST_DIR = "/tmp/tenex-post-completion-integration-test";
    const PROJECT_ID = "test-project";
    const CONVERSATION_ID = "conv-integration-test";
    const AGENT_PUBKEY = "agent-pubkey-integration-test";

    let conversationStore: ConversationStore;
    let registry: RALRegistry;

    beforeAll(() => {
        // Ensure heuristics are registered for supervision to work
        resetRegistrationForTesting();
        registerDefaultHeuristics();
    });

    beforeEach(async () => {
        await mkdir(TEST_DIR, { recursive: true });
        conversationStore = new ConversationStore(TEST_DIR);
        conversationStore.load(PROJECT_ID, CONVERSATION_ID);
        registry = RALRegistry.getInstance();
        registry.clear(AGENT_PUBKEY, CONVERSATION_ID);
    });

    afterEach(async () => {
        registry.clear(AGENT_PUBKEY, CONVERSATION_ID);
        supervisorOrchestrator.clearState(`${AGENT_PUBKEY}:${CONVERSATION_ID}:1`);
        supervisorOrchestrator.clearState(`${AGENT_PUBKEY}:${CONVERSATION_ID}:2`);
        await rm(TEST_DIR, { recursive: true, force: true });
    });

    /**
     * Helper to create a minimal agent instance for testing
     */
    const createMockAgent = (overrides: Partial<AgentInstance> = {}): AgentInstance => {
        const mockSigner = {
            privateKey: "mock-private-key",
            sign: async () => "mock-signature",
        } as unknown;

        return {
            name: "TestAgent",
            pubkey: AGENT_PUBKEY,
            signer: mockSigner,
            role: "Test Role",
            description: "A test agent",
            instructions: "You are a test agent",
            useCriteria: "Test use criteria",
            llmConfig: "default",
            tools: [],
            eventId: "mock-event-id",
            slug: "test-agent",
            createMetadataStore: () => ({
                get: () => undefined,
                set: () => {},
            }),
            sign: async () => {},
            ...overrides,
        } as AgentInstance;
    };

    /**
     * Helper to create a FullRuntimeContext for testing
     */
    const createMockContext = (ralNumber: number): FullRuntimeContext => {
        const mockEvent = createMockNDKEvent({
            pubkey: "user-pubkey",
            content: "Test message",
            tags: [],
        });

        return {
            agent: createMockAgent(),
            conversationId: CONVERSATION_ID,
            projectBasePath: TEST_DIR,
            workingDirectory: TEST_DIR,
            currentBranch: "main",
            triggeringEvent: mockEvent,
            agentPublisher: {} as never,
            ralNumber,
            conversationStore,
            getConversation: () => conversationStore,
        } as FullRuntimeContext;
    };

    /**
     * Helper to create a minimal completion event
     */
    const createMockCompletionEvent = (): CompleteEvent => ({
        type: "complete",
        message: "I delegated the task and am waiting for a response.",
        usage: {
            inputTokens: 100,
            outputTokens: 50,
        },
    });

    /**
     * Helper to create PostCompletionCheckerConfig
     */
    const createConfig = (ralNumber: number): PostCompletionCheckerConfig => ({
        agent: createMockAgent(),
        context: createMockContext(ralNumber),
        conversationStore,
        ralNumber,
        completionEvent: createMockCompletionEvent(),
    });

    describe("conversation-wide RAL scoping fix validation", () => {
        /**
         * This is the CRITICAL test that validates the fix at PostCompletionChecker.ts:132-140.
         *
         * Scenario:
         * 1. RAL 1: Agent creates a delegation (still pending)
         * 2. RAL 2: Agent is invoked again with incomplete todos
         * 3. Expected: shouldReEngage=false because pendingDelegationCount > 0
         *
         * Without the fix (using RAL-scoped query):
         * - getConversationPendingDelegations(pubkey, convId, ralNumber=2) returns 0
         * - pending-todos heuristic would fire incorrectly
         *
         * With the fix (using conversation-wide query):
         * - getConversationPendingDelegations(pubkey, convId) returns 1
         * - pending-todos heuristic is correctly suppressed
         */
        it("should suppress pending-todos heuristic when delegation from earlier RAL is still pending", async () => {
            // RAL 1: Agent creates a delegation
            const ralNumber1 = registry.create(AGENT_PUBKEY, CONVERSATION_ID, PROJECT_ID);
            conversationStore.ensureRalActive(AGENT_PUBKEY, ralNumber1);

            // Add a pending delegation in RAL 1
            const delegation: PendingDelegation = {
                delegationConversationId: "del-conv-cross-ral-fix",
                senderPubkey: AGENT_PUBKEY,
                recipientPubkey: "slow-worker-pubkey",
                prompt: "Do a long-running task",
                ralNumber: ralNumber1,
            };
            registry.mergePendingDelegations(AGENT_PUBKEY, CONVERSATION_ID, ralNumber1, [delegation]);

            // Set up todos that would trigger the heuristic if not suppressed
            conversationStore.setTodos(AGENT_PUBKEY, [
                { id: "1", title: "Implement feature", status: "pending", description: "" },
                { id: "2", title: "Write tests", status: "in_progress", description: "" },
            ]);

            // RAL 2: Agent is invoked again (delegation from RAL 1 still pending)
            const ralNumber2 = registry.create(AGENT_PUBKEY, CONVERSATION_ID, PROJECT_ID);
            conversationStore.ensureRalActive(AGENT_PUBKEY, ralNumber2);

            // Add some messages to make the conversation realistic
            conversationStore.addMessage({
                pubkey: AGENT_PUBKEY,
                ral: ralNumber2,
                content: "I delegated the task and am waiting for a response.",
                messageType: "text",
            });

            // Create config for RAL 2
            const config = createConfig(ralNumber2);

            // THIS IS THE CRITICAL CALL - exercises the fix at PostCompletionChecker.ts:132-140
            const result = await checkPostCompletion(config);

            // Expected: shouldReEngage=false because the delegation from RAL 1 should be counted
            // The pending-todos heuristic should be SUPPRESSED because pendingDelegationCount > 0
            expect(result.shouldReEngage).toBe(false);
            expect(result.injectedMessage).toBe(false);
        });

        /**
         * Control test: When there are NO pending delegations, the heuristic SHOULD fire.
         */
        it("should trigger pending-todos heuristic when no delegations are pending", async () => {
            const ralNumber = registry.create(AGENT_PUBKEY, CONVERSATION_ID, PROJECT_ID);
            conversationStore.ensureRalActive(AGENT_PUBKEY, ralNumber);

            // Set up incomplete todos
            conversationStore.setTodos(AGENT_PUBKEY, [
                { id: "1", title: "Implement feature", status: "pending", description: "" },
            ]);

            // Add a message
            conversationStore.addMessage({
                pubkey: AGENT_PUBKEY,
                ral: ralNumber,
                content: "Done!",
                messageType: "text",
            });

            // NO pending delegations
            const pendingBefore = registry.getConversationPendingDelegations(
                AGENT_PUBKEY,
                CONVERSATION_ID
            );
            expect(pendingBefore).toHaveLength(0);

            const config = createConfig(ralNumber);
            const result = await checkPostCompletion(config);

            // Heuristic should fire - shouldReEngage=true
            expect(result.shouldReEngage).toBe(true);
            expect(result.correctionMessage).toBeDefined();
        });

        /**
         * Validates that the fix correctly handles multiple pending delegations
         * from different RALs.
         */
        it("should count all pending delegations from multiple RALs", async () => {
            // RAL 1: First delegation
            const ralNumber1 = registry.create(AGENT_PUBKEY, CONVERSATION_ID, PROJECT_ID);
            conversationStore.ensureRalActive(AGENT_PUBKEY, ralNumber1);
            registry.mergePendingDelegations(AGENT_PUBKEY, CONVERSATION_ID, ralNumber1, [
                {
                    delegationConversationId: "del-1",
                    senderPubkey: AGENT_PUBKEY,
                    recipientPubkey: "worker-1-pubkey",
                    prompt: "Task 1",
                    ralNumber: ralNumber1,
                },
            ]);

            // RAL 2: Second delegation
            const ralNumber2 = registry.create(AGENT_PUBKEY, CONVERSATION_ID, PROJECT_ID);
            conversationStore.ensureRalActive(AGENT_PUBKEY, ralNumber2);
            registry.mergePendingDelegations(AGENT_PUBKEY, CONVERSATION_ID, ralNumber2, [
                {
                    delegationConversationId: "del-2",
                    senderPubkey: AGENT_PUBKEY,
                    recipientPubkey: "worker-2-pubkey",
                    prompt: "Task 2",
                    ralNumber: ralNumber2,
                },
            ]);

            // Set up incomplete todos
            conversationStore.setTodos(AGENT_PUBKEY, [
                { id: "1", title: "Incomplete task", status: "pending", description: "" },
            ]);

            // RAL 3: Agent invoked again
            const ralNumber3 = registry.create(AGENT_PUBKEY, CONVERSATION_ID, PROJECT_ID);
            conversationStore.ensureRalActive(AGENT_PUBKEY, ralNumber3);
            conversationStore.addMessage({
                pubkey: AGENT_PUBKEY,
                ral: ralNumber3,
                content: "Waiting for delegations...",
                messageType: "text",
            });

            // Verify conversation-wide scope sees both delegations
            const allPending = registry.getConversationPendingDelegations(
                AGENT_PUBKEY,
                CONVERSATION_ID
            );
            expect(allPending).toHaveLength(2);

            // RAL-scoped query would miss them
            const ral3Pending = registry.getConversationPendingDelegations(
                AGENT_PUBKEY,
                CONVERSATION_ID,
                ralNumber3
            );
            expect(ral3Pending).toHaveLength(0);

            // Now verify checkPostCompletion uses conversation-wide scope
            const config = createConfig(ralNumber3);
            const result = await checkPostCompletion(config);

            // Should NOT fire because pendingDelegationCount = 2
            expect(result.shouldReEngage).toBe(false);
        });

        /**
         * Validates that inject-message with reEngage=false uses deferred injections
         * instead of blocking the completion.
         *
         * BUG FIX TEST: When ConsecutiveToolsWithoutTodoHeuristic fires with reEngage=false,
         * it should store the nudge as a deferred injection (for the next turn) rather than
         * queueing it in RALRegistry (which would block the current completion).
         *
         * Before fix: ralRegistry.queueSystemMessage() → hasOutstandingWork() = true → conversation()
         * After fix: conversationStore.addDeferredInjection() → hasOutstandingWork() = false → complete()
         */
        it("should use deferred injection for inject-message with reEngage=false (not block completion)", async () => {
            const ralNumber = registry.create(AGENT_PUBKEY, CONVERSATION_ID, PROJECT_ID);
            conversationStore.ensureRalActive(AGENT_PUBKEY, ralNumber);

            // Set up scenario for ConsecutiveToolsWithoutTodoHeuristic:
            // - No todos
            // - Many tool calls (exceeds threshold of 5)
            // - Not nudged before
            conversationStore.setTodos(AGENT_PUBKEY, []); // No todos

            // Add multiple tool calls to exceed threshold
            for (let i = 0; i < 6; i++) {
                conversationStore.addMessage({
                    pubkey: AGENT_PUBKEY,
                    ral: ralNumber,
                    content: "",
                    messageType: "tool-call",
                    toolData: [{
                        type: "tool-call",
                        toolName: `test_tool_${i}`,
                        toolCallId: `call-${i}`,
                        args: {},
                    }],
                });
                conversationStore.addMessage({
                    pubkey: AGENT_PUBKEY,
                    ral: ralNumber,
                    content: "",
                    messageType: "tool-result",
                    toolData: [{
                        type: "tool-result",
                        toolCallId: `call-${i}`,
                        toolName: `test_tool_${i}`,
                        result: "ok",
                    }],
                });
            }

            // Create config for the completion
            const config = createConfig(ralNumber);

            // Verify NO outstanding work before the check
            const outstandingBefore = registry.hasOutstandingWork(AGENT_PUBKEY, CONVERSATION_ID, ralNumber);
            expect(outstandingBefore.hasWork).toBe(false);
            expect(outstandingBefore.details.queuedInjections).toBe(0);

            // Run the post-completion check
            const result = await checkPostCompletion(config);

            // KEY ASSERTIONS for the bug fix:
            // 1. shouldReEngage should be FALSE (inject-message with reEngage=false)
            expect(result.shouldReEngage).toBe(false);

            // 2. injectedMessage should be TRUE (a message was queued for next turn)
            expect(result.injectedMessage).toBe(true);

            // 3. RALRegistry should still have NO outstanding work
            //    (This was the bug - before fix, queueSystemMessage would add to queuedInjections)
            const outstandingAfter = registry.hasOutstandingWork(AGENT_PUBKEY, CONVERSATION_ID, ralNumber);
            expect(outstandingAfter.hasWork).toBe(false);
            expect(outstandingAfter.details.queuedInjections).toBe(0);

            // 4. The deferred injection should be in ConversationStore
            const deferredInjections = conversationStore.getPendingDeferredInjections(AGENT_PUBKEY);
            expect(deferredInjections).toHaveLength(1);
            expect(deferredInjections[0].content).toContain("Task Tracking Suggestion");
            expect(deferredInjections[0].source).toBe("supervision:consecutive-tools-without-todo");
        });

        /**
         * Validates behavior after delegations complete.
         */
        it("should trigger heuristic after all delegations complete", async () => {
            // RAL 1: Create and then complete a delegation
            const ralNumber1 = registry.create(AGENT_PUBKEY, CONVERSATION_ID, PROJECT_ID);
            conversationStore.ensureRalActive(AGENT_PUBKEY, ralNumber1);
            registry.mergePendingDelegations(AGENT_PUBKEY, CONVERSATION_ID, ralNumber1, [
                {
                    delegationConversationId: "del-completed",
                    senderPubkey: AGENT_PUBKEY,
                    recipientPubkey: "worker-pubkey",
                    prompt: "Task",
                    ralNumber: ralNumber1,
                },
            ]);

            // Complete the delegation
            registry.recordCompletion({
                delegationConversationId: "del-completed",
                recipientPubkey: "worker-pubkey",
                response: "Done",
                completedAt: Date.now(),
            });

            // Verify no pending delegations
            const pending = registry.getConversationPendingDelegations(
                AGENT_PUBKEY,
                CONVERSATION_ID
            );
            expect(pending).toHaveLength(0);

            // Set up incomplete todos
            conversationStore.setTodos(AGENT_PUBKEY, [
                { id: "1", title: "Still pending", status: "pending", description: "" },
            ]);

            // RAL 2: Agent invoked
            const ralNumber2 = registry.create(AGENT_PUBKEY, CONVERSATION_ID, PROJECT_ID);
            conversationStore.ensureRalActive(AGENT_PUBKEY, ralNumber2);
            conversationStore.addMessage({
                pubkey: AGENT_PUBKEY,
                ral: ralNumber2,
                content: "Finished with delegation!",
                messageType: "text",
            });

            const config = createConfig(ralNumber2);
            const result = await checkPostCompletion(config);

            // Should fire now - no pending delegations to suppress
            expect(result.shouldReEngage).toBe(true);
        });
    });
});
