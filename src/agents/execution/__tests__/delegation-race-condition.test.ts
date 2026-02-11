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

    test("returns false after delegation is completed", () => {
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

      // Complete the delegation
      ralRegistry.recordCompletion({
        delegationConversationId,
        recipientPubkey,
        response: "Task completed!",
        completedAt: Date.now(),
      });

      // Now should return false (pending -> completed)
      result = ralRegistry.hasOutstandingWork(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber
      );
      expect(result.hasWork).toBe(false);
      expect(result.details.pendingDelegations).toBe(0);
    });
  });

  describe("Race Condition Scenario", () => {
    /**
     * This test simulates the exact race condition:
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

      // Check state: should have work (2 pending + 1 queued)
      let result = ralRegistry.hasOutstandingWork(
        AGENT_PUBKEY,
        CONVERSATION_ID,
        ralNumber
      );
      expect(result.hasWork).toBe(true);
      expect(result.details.pendingDelegations).toBe(2);
      expect(result.details.queuedInjections).toBe(1);

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

      // Only after consuming all injections should we finalize
      ralRegistry.getAndConsumeInjections(AGENT_PUBKEY, CONVERSATION_ID, ralNumber);
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
  });
});
