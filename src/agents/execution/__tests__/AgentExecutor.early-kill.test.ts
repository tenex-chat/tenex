/**
 * Tests for AgentExecutor early kill check
 *
 * Verifies that agents abort immediately when their conversation
 * has been killed before they started executing (pre-emptive kill).
 *
 * This is part of the kill command race condition fix where:
 * 1. Kill tool marks agent+conversation as killed (markAgentConversationKilled)
 * 2. When agent eventually starts, it checks isAgentConversationKilled and aborts
 *
 * Note: These tests cover both RALRegistry methods AND the AgentExecutor pattern.
 * The AgentExecutor.execute() method follows the pattern tested in
 * "AgentExecutor early-kill pattern simulation" - checking isAgentConversationKilled()
 * after RAL creation and clearing the RAL if killed.
 */

import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import { RALRegistry } from "@/services/ral";

describe("AgentExecutor early kill check", () => {
    let ralRegistry: RALRegistry;

    const projectId = "test-project-id-123456789012345678901234567890123456789012345678901234567890";
    const conversationId = "test-conv-id-1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
    const agentPubkey = "test-agent-pubkey-1234567890abcdef1234567890abcdef1234567890abcdef1234";

    beforeEach(() => {
        ralRegistry = RALRegistry.getInstance();
        ralRegistry.clearAll();
    });

    afterEach(() => {
        ralRegistry.clearAll();
    });

    describe("isAgentConversationKilled check", () => {
        it("should return false for a conversation that was never killed", () => {
            expect(ralRegistry.isAgentConversationKilled(agentPubkey, conversationId)).toBe(false);
        });

        it("should return true after markAgentConversationKilled is called", () => {
            ralRegistry.markAgentConversationKilled(agentPubkey, conversationId);
            expect(ralRegistry.isAgentConversationKilled(agentPubkey, conversationId)).toBe(true);
        });

        it("should be agent-scoped (killing one agent doesn't affect others)", () => {
            const otherAgentPubkey = "other-agent-pubkey-1234567890abcdef1234567890abcdef1234567890abcdef";

            ralRegistry.markAgentConversationKilled(agentPubkey, conversationId);

            // Original agent should be killed
            expect(ralRegistry.isAgentConversationKilled(agentPubkey, conversationId)).toBe(true);

            // Other agent in same conversation should NOT be killed
            expect(ralRegistry.isAgentConversationKilled(otherAgentPubkey, conversationId)).toBe(false);
        });

        it("should be conversation-scoped (same agent in different conversation is not killed)", () => {
            const otherConversationId = "other-conv-id-1234567890abcdef1234567890abcdef1234567890abcdef12345";

            ralRegistry.markAgentConversationKilled(agentPubkey, conversationId);

            // Same agent in original conversation should be killed
            expect(ralRegistry.isAgentConversationKilled(agentPubkey, conversationId)).toBe(true);

            // Same agent in different conversation should NOT be killed
            expect(ralRegistry.isAgentConversationKilled(agentPubkey, otherConversationId)).toBe(false);
        });
    });

    describe("RAL creation after pre-emptive kill", () => {
        it("should still allow RAL creation for killed conversation (for cleanup)", () => {
            // Pre-emptively mark as killed
            ralRegistry.markAgentConversationKilled(agentPubkey, conversationId);

            // RAL creation should still work (the check happens at a higher level)
            const ralNumber = ralRegistry.create(agentPubkey, conversationId, projectId);

            expect(ralNumber).toBe(1);
            expect(ralRegistry.getRAL(agentPubkey, conversationId, ralNumber)).toBeDefined();
        });

        it("should clean up RAL state via clear() after early kill detection", () => {
            // Create a RAL
            const ralNumber = ralRegistry.create(agentPubkey, conversationId, projectId);
            expect(ralRegistry.getRAL(agentPubkey, conversationId, ralNumber)).toBeDefined();

            // Mark as killed (simulating pre-emptive kill detection)
            ralRegistry.markAgentConversationKilled(agentPubkey, conversationId);

            // Clear the RAL (what AgentExecutor does after detecting early kill)
            ralRegistry.clear(agentPubkey, conversationId);

            // RAL should be cleared
            expect(ralRegistry.getRAL(agentPubkey, conversationId, ralNumber)).toBeUndefined();

            // But killed state should also be cleared (clear removes killed marker)
            expect(ralRegistry.isAgentConversationKilled(agentPubkey, conversationId)).toBe(false);
        });
    });

    describe("getDelegationRecipientPubkey", () => {
        it("should return null for unknown delegation conversation", () => {
            const unknownConvId = "unknown-conv-id-1234567890abcdef1234567890abcdef1234567890abcdef123456";
            expect(ralRegistry.getDelegationRecipientPubkey(unknownConvId)).toBe(null);
        });

        it("should return recipient pubkey for pending delegation", () => {
            const parentAgentPubkey = "parent-agent-1234567890abcdef1234567890abcdef1234567890abcdef123456";
            const parentConversationId = "parent-conv-1234567890abcdef1234567890abcdef1234567890abcdef123456";
            const delegationConversationId = "deleg-conv-1234567890abcdef1234567890abcdef1234567890abcdef12345";
            const recipientPubkey = "recipient-agent-1234567890abcdef1234567890abcdef1234567890abcdef12";

            // Create parent RAL and add pending delegation
            const ralNumber = ralRegistry.create(parentAgentPubkey, parentConversationId, projectId);
            ralRegistry.mergePendingDelegations(parentAgentPubkey, parentConversationId, ralNumber, [{
                delegationConversationId,
                recipientPubkey,
                senderPubkey: parentAgentPubkey,
                prompt: "Test delegation",
                ralNumber,
            }]);

            // Should find the recipient pubkey
            const result = ralRegistry.getDelegationRecipientPubkey(delegationConversationId);
            expect(result).toBe(recipientPubkey);
        });
    });

    describe("Pre-emptive kill workflow", () => {
        it("should support full pre-emptive kill -> agent start -> early abort workflow", () => {
            const parentAgentPubkey = "parent-agent-1234567890abcdef1234567890abcdef1234567890abcdef123456";
            const parentConversationId = "parent-conv-1234567890abcdef1234567890abcdef1234567890abcdef123456";
            const delegationConversationId = "deleg-conv-1234567890abcdef1234567890abcdef1234567890abcdef12345";
            const recipientPubkey = "recipient-agent-1234567890abcdef1234567890abcdef1234567890abcdef12";

            // Step 1: Parent creates delegation
            const parentRalNumber = ralRegistry.create(parentAgentPubkey, parentConversationId, projectId);
            ralRegistry.mergePendingDelegations(parentAgentPubkey, parentConversationId, parentRalNumber, [{
                delegationConversationId,
                recipientPubkey,
                senderPubkey: parentAgentPubkey,
                prompt: "Test delegation",
                ralNumber: parentRalNumber,
            }]);

            // Step 2: Kill tool is called before agent starts
            // (kill tool would lookup recipient and mark as killed)
            const recipient = ralRegistry.getDelegationRecipientPubkey(delegationConversationId);
            expect(recipient).toBe(recipientPubkey);

            ralRegistry.markAgentConversationKilled(recipientPubkey, delegationConversationId);

            // Step 3: Agent eventually starts (after routing delay)
            // AgentExecutor would create RAL
            const agentRalNumber = ralRegistry.create(recipientPubkey, delegationConversationId, projectId);

            // Step 4: AgentExecutor checks isAgentConversationKilled
            const isKilled = ralRegistry.isAgentConversationKilled(recipientPubkey, delegationConversationId);
            expect(isKilled).toBe(true);

            // Step 5: AgentExecutor clears the RAL and aborts
            ralRegistry.clear(recipientPubkey, delegationConversationId);

            // RAL should be gone
            expect(ralRegistry.getRAL(recipientPubkey, delegationConversationId, agentRalNumber)).toBeUndefined();
        });
    });

    describe("AgentExecutor early-kill pattern simulation", () => {
        /**
         * This test simulates the exact pattern used in AgentExecutor.execute().
         * While we can't easily test the full AgentExecutor with all its dependencies,
         * this test verifies the core logic flow that prevents compute waste.
         *
         * The pattern in AgentExecutor.execute() is:
         * 1. Resolve/create RAL (ralRegistry.create or resolveRAL)
         * 2. Check isAgentConversationKilled IMMEDIATELY after
         * 3. If killed: clear RAL and return undefined (no LLM call)
         * 4. If not killed: continue with execution
         */
        it("should abort immediately when killed before RAL creation (no LLM call)", () => {
            const agentPubkey = "exec-agent-1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
            const conversationId = "exec-conv-1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

            // Simulate kill happening before agent starts
            ralRegistry.markAgentConversationKilled(agentPubkey, conversationId);

            // === Simulate AgentExecutor.execute() ===
            let llmWasCalled = false;
            let result: "aborted" | "completed" | undefined;

            // Step 1: Create RAL (this happens in resolveRAL)
            const ralNumber = ralRegistry.create(agentPubkey, conversationId, projectId);

            // Step 2: Early kill check (lines 140-159 in AgentExecutor.ts)
            if (ralRegistry.isAgentConversationKilled(agentPubkey, conversationId)) {
                // Step 3: Clean up and abort
                ralRegistry.clear(agentPubkey, conversationId);
                result = "aborted";
            } else {
                // Step 4: Would call LLM here
                llmWasCalled = true;
                result = "completed";
            }

            // Verify early abort happened
            expect(result).toBe("aborted");
            expect(llmWasCalled).toBe(false);
            expect(ralRegistry.getRAL(agentPubkey, conversationId, ralNumber)).toBeUndefined();
        });

        it("should proceed normally when not killed (LLM would be called)", () => {
            const agentPubkey = "normal-agent-1234567890abcdef1234567890abcdef1234567890abcdef12345";
            const conversationId = "normal-conv-1234567890abcdef1234567890abcdef1234567890abcdef12345";

            // No kill marker - normal execution
            let llmWasCalled = false;
            let result: "aborted" | "completed" | undefined;

            // Step 1: Create RAL
            const ralNumber = ralRegistry.create(agentPubkey, conversationId, projectId);

            // Step 2: Early kill check
            if (ralRegistry.isAgentConversationKilled(agentPubkey, conversationId)) {
                ralRegistry.clear(agentPubkey, conversationId);
                result = "aborted";
            } else {
                // Step 4: Would call LLM here
                llmWasCalled = true;
                result = "completed";
            }

            // Verify normal execution
            expect(result).toBe("completed");
            expect(llmWasCalled).toBe(true);
            // RAL should still exist (would be cleared later after completion)
            expect(ralRegistry.getRAL(agentPubkey, conversationId, ralNumber)).toBeDefined();

            // Clean up
            ralRegistry.clear(agentPubkey, conversationId);
        });

        it("should handle race: killed during RAL resolution", () => {
            const agentPubkey = "race-agent-1234567890abcdef1234567890abcdef1234567890abcdef123456";
            const conversationId = "race-conv-1234567890abcdef1234567890abcdef1234567890abcdef123456";

            // Simulate race: RAL creation starts, kill happens, check occurs
            const ralNumber = ralRegistry.create(agentPubkey, conversationId, projectId);

            // Kill happens during RAL resolution (between create and check)
            ralRegistry.markAgentConversationKilled(agentPubkey, conversationId);

            // Early kill check catches it
            const isKilled = ralRegistry.isAgentConversationKilled(agentPubkey, conversationId);
            expect(isKilled).toBe(true);

            // Abort path
            ralRegistry.clear(agentPubkey, conversationId);
            expect(ralRegistry.getRAL(agentPubkey, conversationId, ralNumber)).toBeUndefined();
        });
    });
});
