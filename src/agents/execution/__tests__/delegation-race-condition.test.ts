/**
 * Tests for delegation race condition fix
 *
 * These tests verify that the hasOutstandingWork() method correctly detects
 * outstanding work (queued injections and pending delegations) and that the
 * executor properly guards against premature finalization.
 *
 * The race condition being tested:
 * Delegation results arrive (via debounce) after the last prepareStep but before
 * the executor finalizes. Without proper guards, these results would be orphaned.
 *
 * Key behaviors verified:
 * 1. hasOutstandingWork() returns true when queued injections exist
 * 2. hasOutstandingWork() returns true when pending delegations exist
 * 3. hasOutstandingWork() returns false when neither exist
 * 4. Executor does NOT finalize when hasOutstandingWork() is true
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { RALRegistry } from "@/services/ral/RALRegistry";
import type { PendingDelegation } from "@/services/ral/types";

describe("Delegation Race Condition Fix", () => {
  const AGENT_PUBKEY = "test-agent-race-condition";
  const CONVERSATION_ID = "test-conv-race-condition";
  const PROJECT_ID = "31933:test:race-condition-project";

  let ralRegistry: RALRegistry;

  beforeEach(() => {
    // Reset singleton to ensure clean state between tests
    // @ts-expect-error - accessing private static for testing
    RALRegistry.instance = undefined;
    ralRegistry = RALRegistry.getInstance();
  });

  afterEach(() => {
    ralRegistry.clearAll();
  });

  describe("hasOutstandingWork()", () => {
    test("returns false when RAL does not exist", () => {
      const result = ralRegistry.hasOutstandingWork(
        "nonexistent-agent",
        "nonexistent-conv",
        1
      );

      expect(result.hasWork).toBe(false);
      expect(result.details.queuedInjections).toBe(0);
      expect(result.details.pendingDelegations).toBe(0);
      expect(result.details.completedDelegations).toBe(0);
    });

    test("returns false when RAL exists but has no outstanding work", () => {
      const ralNumber = ralRegistry.create(AGENT_PUBKEY, CONVERSATION_ID, PROJECT_ID);

      const result = ralRegistry.hasOutstandingWork(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber
      );

      expect(result.hasWork).toBe(false);
      expect(result.details.queuedInjections).toBe(0);
      expect(result.details.pendingDelegations).toBe(0);
      expect(result.details.completedDelegations).toBe(0);
    });

    test("returns true when queued injections exist", () => {
      const ralNumber = ralRegistry.create(AGENT_PUBKEY, CONVERSATION_ID, PROJECT_ID);

      // Queue an injection (simulates delegation result arriving via debounce)
      ralRegistry.queueUserMessage(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber,
        "Delegation completed with result: task done"
      );

      const result = ralRegistry.hasOutstandingWork(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber
      );

      expect(result.hasWork).toBe(true);
      expect(result.details.queuedInjections).toBe(1);
      expect(result.details.pendingDelegations).toBe(0);
    });

    test("returns true when multiple queued injections exist", () => {
      const ralNumber = ralRegistry.create(AGENT_PUBKEY, CONVERSATION_ID, PROJECT_ID);

      // Queue multiple injections
      ralRegistry.queueUserMessage(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber,
        "First delegation result"
      );
      ralRegistry.queueUserMessage(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber,
        "Second delegation result"
      );
      ralRegistry.queueSystemMessage(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber,
        "System notification"
      );

      const result = ralRegistry.hasOutstandingWork(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber
      );

      expect(result.hasWork).toBe(true);
      expect(result.details.queuedInjections).toBe(3);
      expect(result.details.pendingDelegations).toBe(0);
    });

    test("returns true when pending delegations exist", () => {
      const ralNumber = ralRegistry.create(AGENT_PUBKEY, CONVERSATION_ID, PROJECT_ID);

      const pendingDelegations: PendingDelegation[] = [
        {
          delegationConversationId: "del-conv-1",
          recipientPubkey: "recipient-1",
          senderPubkey: AGENT_PUBKEY,
          prompt: "Do task 1",
          ralNumber,
        },
      ];

      ralRegistry.setPendingDelegations(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber,
        pendingDelegations
      );

      const result = ralRegistry.hasOutstandingWork(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber
      );

      expect(result.hasWork).toBe(true);
      expect(result.details.queuedInjections).toBe(0);
      expect(result.details.pendingDelegations).toBe(1);
    });

    test("returns true when multiple pending delegations exist", () => {
      const ralNumber = ralRegistry.create(AGENT_PUBKEY, CONVERSATION_ID, PROJECT_ID);

      const pendingDelegations: PendingDelegation[] = [
        {
          delegationConversationId: "del-conv-1",
          recipientPubkey: "recipient-1",
          senderPubkey: AGENT_PUBKEY,
          prompt: "Do task 1",
          ralNumber,
        },
        {
          delegationConversationId: "del-conv-2",
          recipientPubkey: "recipient-2",
          senderPubkey: AGENT_PUBKEY,
          prompt: "Do task 2",
          ralNumber,
        },
        {
          delegationConversationId: "del-conv-3",
          recipientPubkey: "recipient-3",
          senderPubkey: AGENT_PUBKEY,
          prompt: "Do task 3",
          ralNumber,
        },
      ];

      ralRegistry.setPendingDelegations(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber,
        pendingDelegations
      );

      const result = ralRegistry.hasOutstandingWork(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber
      );

      expect(result.hasWork).toBe(true);
      expect(result.details.queuedInjections).toBe(0);
      expect(result.details.pendingDelegations).toBe(3);
    });

    test("returns true when both queued injections AND pending delegations exist", () => {
      const ralNumber = ralRegistry.create(AGENT_PUBKEY, CONVERSATION_ID, PROJECT_ID);

      // Queue an injection
      ralRegistry.queueUserMessage(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber,
        "Delegation result arriving late"
      );

      // Also have pending delegations
      const pendingDelegations: PendingDelegation[] = [
        {
          delegationConversationId: "del-conv-1",
          recipientPubkey: "recipient-1",
          senderPubkey: AGENT_PUBKEY,
          prompt: "Still waiting for this",
          ralNumber,
        },
      ];

      ralRegistry.setPendingDelegations(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber,
        pendingDelegations
      );

      const result = ralRegistry.hasOutstandingWork(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber
      );

      expect(result.hasWork).toBe(true);
      expect(result.details.queuedInjections).toBe(1);
      expect(result.details.pendingDelegations).toBe(1);
    });

    test("returns false after injections are consumed", () => {
      const ralNumber = ralRegistry.create(AGENT_PUBKEY, CONVERSATION_ID, PROJECT_ID);

      // Queue an injection
      ralRegistry.queueUserMessage(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber,
        "Delegation result"
      );

      // Verify it's detected
      let result = ralRegistry.hasOutstandingWork(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber
      );
      expect(result.hasWork).toBe(true);

      // Consume the injection
      const consumed = ralRegistry.getAndConsumeInjections(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber
      );
      expect(consumed).toHaveLength(1);

      // Now should return false
      result = ralRegistry.hasOutstandingWork(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber
      );
      expect(result.hasWork).toBe(false);
    });

    test("returns true after delegation is completed but not yet consumed", () => {
      const ralNumber = ralRegistry.create(AGENT_PUBKEY, CONVERSATION_ID, PROJECT_ID);

      const delegationConversationId = "del-conv-1";
      const recipientPubkey = "recipient-1";

      const pendingDelegations: PendingDelegation[] = [
        {
          delegationConversationId,
          recipientPubkey,
          senderPubkey: AGENT_PUBKEY,
          prompt: "Do task",
          ralNumber,
        },
      ];

      ralRegistry.setPendingDelegations(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber,
        pendingDelegations
      );

      // Verify pending delegation is detected
      let result = ralRegistry.hasOutstandingWork(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber
      );
      expect(result.hasWork).toBe(true);
      expect(result.details.pendingDelegations).toBe(1);
      expect(result.details.completedDelegations).toBe(0);

      // Complete the delegation (moves from pending to completed)
      ralRegistry.recordCompletion({
        delegationConversationId,
        recipientPubkey,
        response: "Task completed!",
        completedAt: Date.now(),
      });

      // Should STILL have work: the completed delegation hasn't been consumed by resolveRAL yet.
      // This is the fix for the fast-completing delegation race condition.
      result = ralRegistry.hasOutstandingWork(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber
      );
      expect(result.hasWork).toBe(true);
      expect(result.details.pendingDelegations).toBe(0);
      expect(result.details.completedDelegations).toBe(1);

      // Only after clearCompletedDelegations (called by resolveRAL) should work be false
      ralRegistry.clearCompletedDelegations(AGENT_PUBKEY, CONVERSATION_ID, ralNumber);
      result = ralRegistry.hasOutstandingWork(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber
      );
      expect(result.hasWork).toBe(false);
      expect(result.details.completedDelegations).toBe(0);
    });
  });

  describe("Race Condition Scenario", () => {
    /**
     * This test simulates the fast-completing delegation race condition:
     * 1. Agent delegates to child during streaming
     * 2. Child completes very quickly — recordCompletion() moves pending→completed
     * 3. Parent's stream finishes, executor checks hasOutstandingWork()
     * 4. Without fix: pendingDelegations=0, queuedInjections=0 → hasWork=false → premature finalization
     * 5. With fix: completedDelegations=1 → hasWork=true → defers finalization
     *
     * The debounce hasn't fired yet, so there's no queued injection.
     * The only signal is the completed delegation in the RAL registry.
     */
    test("detects completed delegation before debounce fires (fast-completing delegation)", () => {
      const ralNumber = ralRegistry.create(AGENT_PUBKEY, CONVERSATION_ID, PROJECT_ID);

      const delegationConversationId = "del-conv-fast";
      const recipientPubkey = "recipient-fast";

      // Step 1: Agent delegates
      ralRegistry.mergePendingDelegations(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber,
        [{
          delegationConversationId,
          recipientPubkey,
          senderPubkey: AGENT_PUBKEY,
          prompt: "Quick task",
          ralNumber,
        }]
      );

      // Step 2: Child completes very quickly (recordCompletion called immediately, no debounce)
      ralRegistry.recordCompletion({
        delegationConversationId,
        recipientPubkey,
        response: "Done instantly!",
        completedAt: Date.now(),
      });

      // Step 3: Parent's stream finishes, executor checks for outstanding work
      // At this point: pendingDelegations=0, queuedInjections=0, completedDelegations=1
      const result = ralRegistry.hasOutstandingWork(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber
      );

      // The fix: completedDelegations prevents premature finalization
      expect(result.hasWork).toBe(true);
      expect(result.details.pendingDelegations).toBe(0);
      expect(result.details.queuedInjections).toBe(0);
      expect(result.details.completedDelegations).toBe(1);
    });

    /**
     * This test simulates the original race condition:
     * 1. Agent has pending delegations
     * 2. Delegation completes and result is queued (via debounce)
     * 3. prepareStep runs but stream ends before processing queue
     * 4. Executor checks for outstanding work before finalizing
     *
     * Without the fix: executor would only check pendingDelegations (now 0)
     * and finalize prematurely, orphaning the queued result.
     *
     * With the fix: hasOutstandingWork() detects the queued injection
     * and prevents premature finalization.
     */
    test("detects queued injection after delegation completes but before processing", () => {
      const ralNumber = ralRegistry.create(AGENT_PUBKEY, CONVERSATION_ID, PROJECT_ID);

      const delegationConversationId = "del-conv-race";
      const recipientPubkey = "recipient-race";

      // Step 1: Set up pending delegation (agent is waiting)
      const pendingDelegations: PendingDelegation[] = [
        {
          delegationConversationId,
          recipientPubkey,
          senderPubkey: AGENT_PUBKEY,
          prompt: "Do important task",
          ralNumber,
        },
      ];

      ralRegistry.setPendingDelegations(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber,
        pendingDelegations
      );

      // Verify initial state: has pending delegation
      let result = ralRegistry.hasOutstandingWork(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber
      );
      expect(result.hasWork).toBe(true);
      expect(result.details.pendingDelegations).toBe(1);
      expect(result.details.queuedInjections).toBe(0);

      // Step 2: Delegation completes (moves from pending to completed)
      ralRegistry.recordCompletion({
        delegationConversationId,
        recipientPubkey,
        response: "Task done successfully!",
        completedAt: Date.now(),
      });

      // Step 3: Simulate debounce queuing the result as an injection
      // (This is what AgentDispatchService does when delegation completes)
      ralRegistry.queueUserMessage(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber,
        "# DELEGATION COMPLETED\n\nTask done successfully!"
      );

      // Step 4: This is the critical check - if we only checked pendingDelegations
      // it would be 0 and we'd finalize. But with hasOutstandingWork() we detect
      // the queued injection.
      result = ralRegistry.hasOutstandingWork(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber
      );

      // The fix: hasWork is TRUE because of the queued injection
      expect(result.hasWork).toBe(true);
      expect(result.details.pendingDelegations).toBe(0); // Delegation completed
      expect(result.details.queuedInjections).toBe(1);   // But result is queued!

      // Without this fix, executor would have finalized here, orphaning the result
    });

    test("correctly handles multiple concurrent delegations completing", () => {
      const ralNumber = ralRegistry.create(AGENT_PUBKEY, CONVERSATION_ID, PROJECT_ID);

      // Set up 3 concurrent delegations
      const pendingDelegations: PendingDelegation[] = [
        {
          delegationConversationId: "del-1",
          recipientPubkey: "recipient-1",
          senderPubkey: AGENT_PUBKEY,
          prompt: "Task 1",
          ralNumber,
        },
        {
          delegationConversationId: "del-2",
          recipientPubkey: "recipient-2",
          senderPubkey: AGENT_PUBKEY,
          prompt: "Task 2",
          ralNumber,
        },
        {
          delegationConversationId: "del-3",
          recipientPubkey: "recipient-3",
          senderPubkey: AGENT_PUBKEY,
          prompt: "Task 3",
          ralNumber,
        },
      ];

      ralRegistry.setPendingDelegations(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber,
        pendingDelegations
      );

      // First delegation completes and queues result
      ralRegistry.recordCompletion({
        delegationConversationId: "del-1",
        recipientPubkey: "recipient-1",
        response: "Task 1 done",
        completedAt: Date.now(),
      });
      ralRegistry.queueUserMessage(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber,
        "Task 1 result"
      );

      // Check state: should have work (2 pending + 1 queued + 1 completed)
      let result = ralRegistry.hasOutstandingWork(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber
      );
      expect(result.hasWork).toBe(true);
      expect(result.details.pendingDelegations).toBe(2);
      expect(result.details.queuedInjections).toBe(1);
      expect(result.details.completedDelegations).toBe(1);

      // Second delegation completes and queues result
      ralRegistry.recordCompletion({
        delegationConversationId: "del-2",
        recipientPubkey: "recipient-2",
        response: "Task 2 done",
        completedAt: Date.now(),
      });
      ralRegistry.queueUserMessage(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber,
        "Task 2 result"
      );

      result = ralRegistry.hasOutstandingWork(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber
      );
      expect(result.hasWork).toBe(true);
      expect(result.details.pendingDelegations).toBe(1);
      expect(result.details.queuedInjections).toBe(2);
      expect(result.details.completedDelegations).toBe(2);

      // Third delegation completes and queues result
      ralRegistry.recordCompletion({
        delegationConversationId: "del-3",
        recipientPubkey: "recipient-3",
        response: "Task 3 done",
        completedAt: Date.now(),
      });
      ralRegistry.queueUserMessage(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber,
        "Task 3 result"
      );

      // All delegations complete but results still queued
      result = ralRegistry.hasOutstandingWork(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber
      );
      expect(result.hasWork).toBe(true);
      expect(result.details.pendingDelegations).toBe(0);
      expect(result.details.queuedInjections).toBe(3);
      expect(result.details.completedDelegations).toBe(3);

      // Consuming injections still leaves completed delegations
      ralRegistry.getAndConsumeInjections(AGENT_PUBKEY, CONVERSATION_ID, ralNumber);
      result = ralRegistry.hasOutstandingWork(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber
      );
      expect(result.hasWork).toBe(true); // Still has completed delegations
      expect(result.details.completedDelegations).toBe(3);

      // Only after clearing completed delegations (done by resolveRAL) is work truly done
      ralRegistry.clearCompletedDelegations(AGENT_PUBKEY, CONVERSATION_ID, ralNumber);
      result = ralRegistry.hasOutstandingWork(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber
      );
      expect(result.hasWork).toBe(false);
    });
  });

  describe("Edge Cases", () => {
    test("handles RAL cleared while checking outstanding work", () => {
      const ralNumber = ralRegistry.create(AGENT_PUBKEY, CONVERSATION_ID, PROJECT_ID);

      // Queue something
      ralRegistry.queueUserMessage(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber,
        "Test message"
      );

      // Clear the RAL
      ralRegistry.clearRAL(AGENT_PUBKEY, CONVERSATION_ID, ralNumber);

      // Should return false (no RAL = no work)
      const result = ralRegistry.hasOutstandingWork(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber
      );
      expect(result.hasWork).toBe(false);
    });

    test("handles wrong RAL number", () => {
      const ralNumber = ralRegistry.create(AGENT_PUBKEY, CONVERSATION_ID, PROJECT_ID);

      // Queue on correct RAL
      ralRegistry.queueUserMessage(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber,
        "Test message"
      );

      // Check wrong RAL number
      const result = ralRegistry.hasOutstandingWork(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber + 100 // Wrong RAL number
      );
      expect(result.hasWork).toBe(false);
    });

    test("isolates outstanding work between different RALs in same conversation", () => {
      const ralNumber1 = ralRegistry.create(AGENT_PUBKEY, CONVERSATION_ID, PROJECT_ID);
      const ralNumber2 = ralRegistry.create(AGENT_PUBKEY, CONVERSATION_ID, PROJECT_ID);

      // Queue on RAL 1
      ralRegistry.queueUserMessage(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber1,
        "Message for RAL 1"
      );

      // RAL 1 should have work
      let result1 = ralRegistry.hasOutstandingWork(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber1
      );
      expect(result1.hasWork).toBe(true);

      // RAL 2 should NOT have work
      let result2 = ralRegistry.hasOutstandingWork(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber2
      );
      expect(result2.hasWork).toBe(false);
    });

    test("detects pending delegations even when RAL is missing", () => {
      // This tests Issue 1 from the code review: pending delegations persist
      // independently of the RAL state, so we must check them even when RAL is gone.

      const ralNumber = ralRegistry.create(AGENT_PUBKEY, CONVERSATION_ID, PROJECT_ID);

      // Set up a pending delegation
      const pendingDelegations: PendingDelegation[] = [
        {
          delegationConversationId: "del-conv-orphan",
          recipientPubkey: "recipient-orphan",
          senderPubkey: AGENT_PUBKEY,
          prompt: "Orphaned task",
          ralNumber,
        },
      ];

      ralRegistry.setPendingDelegations(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber,
        pendingDelegations
      );

      // Verify delegation is detected with RAL present
      let result = ralRegistry.hasOutstandingWork(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber
      );
      expect(result.hasWork).toBe(true);
      expect(result.details.pendingDelegations).toBe(1);

      // Clear the RAL (simulates early RAL cleanup)
      ralRegistry.clearRAL(AGENT_PUBKEY, CONVERSATION_ID, ralNumber);

      // CRITICAL: Even though RAL is gone, pending delegation should still be detected
      // because delegations persist in conversationDelegations map independently
      result = ralRegistry.hasOutstandingWork(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber
      );
      expect(result.hasWork).toBe(true);
      expect(result.details.pendingDelegations).toBe(1);
      expect(result.details.queuedInjections).toBe(0); // RAL gone, so no injections
    });
  });
});

/**
 * Executor Finalization Guard Tests
 *
 * These tests verify that the AgentExecutor correctly uses hasOutstandingWork()
 * to guard against premature finalization. The key behavior being tested:
 *
 * When queued injections exist (e.g., delegation results arrived via debounce),
 * the executor should return undefined instead of publishing a completion event.
 * This allows the dispatch loop to continue processing the queued work.
 */
describe("Executor Finalization Guard", () => {
  /**
   * This test simulates the executor's finalization decision logic.
   * We extract the key logic from AgentExecutor.executeOnce() to verify
   * that the guard correctly prevents finalization when outstanding work exists.
   *
   * The actual executeOnce() method:
   * 1. Calls hasOutstandingWork()
   * 2. If (!hasMessageContent && outstandingWork.hasWork) returns undefined
   * 3. Otherwise proceeds to publish completion
   */
  describe("finalization decision logic", () => {
    const AGENT_PUBKEY = "test-agent-finalization";
    const CONVERSATION_ID = "test-conv-finalization";
    const PROJECT_ID = "31933:test:finalization-project";

    let ralRegistry: RALRegistry;

    beforeEach(() => {
      // @ts-expect-error - accessing private static for testing
      RALRegistry.instance = undefined;
      ralRegistry = RALRegistry.getInstance();
    });

    afterEach(() => {
      ralRegistry.clearAll();
    });

    /**
     * Simulates the executor's finalization guard logic.
     * Returns true if executor SHOULD finalize (publish completion).
     * Returns false if executor should defer (return undefined).
     */
    function shouldFinalize(
      hasMessageContent: boolean,
      outstandingWork: { hasWork: boolean; details: { queuedInjections: number; pendingDelegations: number; completedDelegations: number } }
    ): boolean {
      // From AgentExecutor.executeOnce():
      // if (!hasMessageContent && outstandingWork.hasWork) {
      //   return undefined; // Don't finalize
      // }
      if (!hasMessageContent && outstandingWork.hasWork) {
        return false; // Don't finalize
      }
      return true; // Proceed to finalization
    }

    test("defers finalization when queued injections exist and no message content", () => {
      const ralNumber = ralRegistry.create(AGENT_PUBKEY, CONVERSATION_ID, PROJECT_ID);

      // Queue an injection (delegation result via debounce)
      ralRegistry.queueUserMessage(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber,
        "Delegation result arrived"
      );

      const outstandingWork = ralRegistry.hasOutstandingWork(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber
      );

      // Executor receives empty completion (no message content)
      const hasMessageContent = false;

      // CRITICAL: Should NOT finalize because there's queued work
      expect(shouldFinalize(hasMessageContent, outstandingWork)).toBe(false);
    });

    test("defers finalization when pending delegations exist and no message content", () => {
      const ralNumber = ralRegistry.create(AGENT_PUBKEY, CONVERSATION_ID, PROJECT_ID);

      // Set up pending delegation
      ralRegistry.setPendingDelegations(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber,
        [{
          delegationConversationId: "del-waiting",
          recipientPubkey: "recipient-waiting",
          senderPubkey: AGENT_PUBKEY,
          prompt: "Still in progress",
          ralNumber,
        }]
      );

      const outstandingWork = ralRegistry.hasOutstandingWork(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber
      );

      const hasMessageContent = false;

      // Should NOT finalize because delegation is still pending
      expect(shouldFinalize(hasMessageContent, outstandingWork)).toBe(false);
    });

    test("allows finalization when message content exists (even with outstanding work)", () => {
      const ralNumber = ralRegistry.create(AGENT_PUBKEY, CONVERSATION_ID, PROJECT_ID);

      // Queue an injection
      ralRegistry.queueUserMessage(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber,
        "Delegation result"
      );

      const outstandingWork = ralRegistry.hasOutstandingWork(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber
      );

      // Executor has actual message content to publish
      const hasMessageContent = true;

      // Should finalize because there's content to publish
      // (the outstanding work will be processed in next iteration)
      expect(shouldFinalize(hasMessageContent, outstandingWork)).toBe(true);
    });

    test("allows finalization when no outstanding work and no message content", () => {
      const ralNumber = ralRegistry.create(AGENT_PUBKEY, CONVERSATION_ID, PROJECT_ID);

      const outstandingWork = ralRegistry.hasOutstandingWork(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber
      );

      const hasMessageContent = false;

      // Should finalize (though will throw error for missing completion event)
      expect(shouldFinalize(hasMessageContent, outstandingWork)).toBe(true);
      expect(outstandingWork.hasWork).toBe(false);
    });

    test("allows finalization when no outstanding work and has message content", () => {
      const ralNumber = ralRegistry.create(AGENT_PUBKEY, CONVERSATION_ID, PROJECT_ID);

      const outstandingWork = ralRegistry.hasOutstandingWork(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber
      );

      const hasMessageContent = true;

      // Normal finalization path - has content, no outstanding work
      expect(shouldFinalize(hasMessageContent, outstandingWork)).toBe(true);
    });

    /**
     * This test verifies the complete race condition scenario:
     * 1. Delegation starts (pending)
     * 2. Delegation completes, result queued via debounce
     * 3. Executor checks hasOutstandingWork() before finalizing
     * 4. Guard correctly detects queued injection and defers
     */
    test("prevents premature finalization in race condition scenario", () => {
      const ralNumber = ralRegistry.create(AGENT_PUBKEY, CONVERSATION_ID, PROJECT_ID);

      // Step 1: Delegation is pending
      ralRegistry.setPendingDelegations(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber,
        [{
          delegationConversationId: "del-race",
          recipientPubkey: "recipient-race",
          senderPubkey: AGENT_PUBKEY,
          prompt: "Critical task",
          ralNumber,
        }]
      );

      // At this point, executor should not finalize
      let outstandingWork = ralRegistry.hasOutstandingWork(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber
      );
      expect(shouldFinalize(false, outstandingWork)).toBe(false);

      // Step 2: Delegation completes, moves from pending to completed
      ralRegistry.recordCompletion({
        delegationConversationId: "del-race",
        recipientPubkey: "recipient-race",
        response: "Task done!",
        completedAt: Date.now(),
      });

      // Step 3: Result is queued via debounce (simulating AgentDispatchService)
      ralRegistry.queueUserMessage(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber,
        "# DELEGATION COMPLETED\n\nTask done!"
      );

      // Step 4: Executor checks before finalizing
      // OLD BUG: Would only check pendingDelegations (now 0) and finalize prematurely
      // FIX: hasOutstandingWork() also checks queuedInjections
      outstandingWork = ralRegistry.hasOutstandingWork(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber
      );

      expect(outstandingWork.hasWork).toBe(true);
      expect(outstandingWork.details.pendingDelegations).toBe(0); // Completed
      expect(outstandingWork.details.queuedInjections).toBe(1);   // Result queued!

      // Executor should NOT finalize - the queued result needs processing
      expect(shouldFinalize(false, outstandingWork)).toBe(false);

      // Step 5: After injection is consumed, still has completed delegation
      ralRegistry.getAndConsumeInjections(AGENT_PUBKEY, CONVERSATION_ID, ralNumber);
      outstandingWork = ralRegistry.hasOutstandingWork(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber
      );

      expect(outstandingWork.hasWork).toBe(true); // Completed delegation still unprocessed
      expect(outstandingWork.details.completedDelegations).toBe(1);
      expect(shouldFinalize(false, outstandingWork)).toBe(false);

      // Step 6: After completed delegations are consumed (by resolveRAL), finalization is allowed
      ralRegistry.clearCompletedDelegations(AGENT_PUBKEY, CONVERSATION_ID, ralNumber);
      outstandingWork = ralRegistry.hasOutstandingWork(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber
      );

      expect(outstandingWork.hasWork).toBe(false);
      expect(shouldFinalize(false, outstandingWork)).toBe(true);
    });
  });
});
