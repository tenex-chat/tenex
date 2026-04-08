/**
 * Tests for concurrent message dispatch race condition
 *
 * This reproduces the bug found in trace a65d59fe2e0000000000000000000000
 * where two messages sent 3ms apart BOTH triggered agent executions instead
 * of one executing and one injecting.
 *
 * Timeline from production:
 * - Event db271d7b: "## Run Backfill? Yes, run it now" @ 713306000
 * - Event ec9e0fb5: "the backfill shouldn't be..." @ 713309000 (+3ms!)
 * - Both dispatched ~1.1s later, both started executions
 * - Both resumed RAL#1 (from 300s earlier!)
 *
 * Root cause:
 * 1. `RALStateRegistry.getState()` returns the highest-numbered RAL regardless
 *    of streaming state, so both concurrent dispatches see the same idle-but-
 *    resumable RAL#1.
 * 2. `handleDeliveryInjection()` queues the incoming message onto that RAL but
 *    returns `false` when the RAL is not currently streaming, telling
 *    `dispatchToAgent` to proceed into `agentExecutor.execute()`. The intent is
 *    "someone has to wake this idle RAL up"; in the concurrent case both
 *    dispatches take this branch.
 * 3. Inside execute(), `resolveRAL` calls `findResumableRAL()` which has no
 *    atomic claim — both concurrent calls observe the same resumable entry and
 *    both continue as resumption.
 * 4. Two concurrent LLM streams run against RAL#1, each draining the shared
 *    message queue and producing duplicate/interleaved responses.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { RALRegistry } from "@/services/ral/RALRegistry";
import type { AgentInstance } from "@/agents/types";
import type { InboundEnvelope } from "@/events/runtime/InboundEnvelope";
import type { ProjectDTag } from "@/types/project-ids";

describe("Concurrent Message Dispatch Race Condition", () => {
    const AGENT_PUBKEY = "4108cd882d5bd7446b4b5cb0688b14694f3d0dbb52bd24f16e1e29ff1636adab";
    const CONVERSATION_ID = "a65d59fe2e0000000000000000000000";
    const PROJECT_ID = "31933:test:concurrent-race" as ProjectDTag;

    let ralRegistry: RALRegistry;

    beforeEach(() => {
        // Reset singleton to ensure clean state
        // @ts-expect-error - accessing private static for testing
        RALRegistry.instance = undefined;
        ralRegistry = RALRegistry.getInstance();
    });

    afterEach(() => {
        ralRegistry.clearAll();
    });

    /**
     * Simulates the dispatch check logic from AgentDispatchService.dispatchToAgent()
     * Returns true if should proceed with execution, false if should inject
     */
    function shouldExecute(agentPubkey: string, conversationId: string): boolean {
        // This is the CURRENT (buggy) logic from handleDeliveryInjection() line 862-921
        const activeRal = ralRegistry.getState(agentPubkey, conversationId);

        if (!activeRal) {
            return true; // No RAL, proceed to execute
        }

        // THE BUG: Only skips execution if RAL is STREAMING
        // If RAL exists but is not streaming, it queues the message but returns false
        // This allows execution to proceed even though a RAL exists!
        if (activeRal.isStreaming) {
            return false; // Skip execution, inject only
        }

        return true; // RAL exists but not streaming → BUG: should skip execution!
    }

    /**
     * THE BUG: Two messages arriving 3ms apart both see no active RAL
     * and both proceed to execution, then both resume the same RAL
     */
    test("FAILING: two concurrent messages both create executions instead of one injecting", async () => {
        // Step 1: Create a RAL from an earlier execution (simulating RAL#1 from 300s ago)
        const ralNumber = ralRegistry.create(
            AGENT_PUBKEY,
            CONVERSATION_ID,
            PROJECT_ID,
            "earlier-event-id-adcad67e"
        );

        // Step 2: Mark it as complete (no longer streaming, but still exists)
        // This makes it "resumable" via findResumableRAL()
        ralRegistry.setStreaming(AGENT_PUBKEY, CONVERSATION_ID, ralNumber, false);

        // Simulate a completed delegation to make it resumable.
        // A pending delegation MUST be registered first, otherwise
        // recordCompletion() is a no-op (see DelegationRegistry:504).
        ralRegistry.mergePendingDelegations(AGENT_PUBKEY, CONVERSATION_ID, ralNumber, [
            {
                delegationConversationId: "del-conv-completed",
                recipientPubkey: "some-recipient",
                senderPubkey: AGENT_PUBKEY,
                prompt: "Some task",
                ralNumber,
            },
        ]);
        ralRegistry.recordCompletion({
            delegationConversationId: "del-conv-completed",
            recipientPubkey: "some-recipient",
            response: "Delegation done",
            completedAt: Date.now(),
        });

        // Step 3: Message 1 arrives and checks for active RAL
        const message1ShouldExecute = shouldExecute(AGENT_PUBKEY, CONVERSATION_ID);

        // Step 4: Message 2 arrives 3ms later and ALSO checks for active RAL
        // BUG: It ALSO sees no active RAL because the first one hasn't started streaming yet!
        const message2ShouldExecute = shouldExecute(AGENT_PUBKEY, CONVERSATION_ID);

        // THE BUG: Both should execute is TRUE because RAL exists but is not streaming
        // Expected: Both should be false (inject, not execute) because RAL exists
        // Actual: BOTH = true (both execute) because handleDeliveryInjection returns false for non-streaming RALs
        expect(message1ShouldExecute).toBe(true); // ❌ BUG: Should be false (RAL exists)!
        expect(message2ShouldExecute).toBe(true); // ❌ BUG: Should be false (RAL exists)!

        // Step 5: Both would then call resolveRAL() which would find the SAME resumable RAL
        const resumableRal = ralRegistry.findResumableRAL(AGENT_PUBKEY, CONVERSATION_ID);
        expect(resumableRal).toBeDefined();
        expect(resumableRal?.ralNumber).toBe(ralNumber);

        // Both executions would resume RAL#1 → race condition!
    });

    /**
     * Demonstrates the actual bug: handleDeliveryInjection returns false for non-streaming RALs
     */
    test("handleDeliveryInjection queues message but allows execution for non-streaming RAL (root cause)", () => {
        const ralNumber = ralRegistry.create(AGENT_PUBKEY, CONVERSATION_ID, PROJECT_ID);

        // Make RAL resumable (pending delegation must exist for completion to register)
        ralRegistry.mergePendingDelegations(AGENT_PUBKEY, CONVERSATION_ID, ralNumber, [
            {
                delegationConversationId: "test-del",
                recipientPubkey: "test-recipient",
                senderPubkey: AGENT_PUBKEY,
                prompt: "Some task",
                ralNumber,
            },
        ]);
        ralRegistry.recordCompletion({
            delegationConversationId: "test-del",
            recipientPubkey: "test-recipient",
            response: "Done",
            completedAt: Date.now(),
        });

        // RAL exists but is not streaming
        ralRegistry.setStreaming(AGENT_PUBKEY, CONVERSATION_ID, ralNumber, false);

        // getState() DOES return the RAL (highest ralNumber)
        const activeRal = ralRegistry.getState(AGENT_PUBKEY, CONVERSATION_ID);
        expect(activeRal).toBeDefined();
        expect(activeRal?.isStreaming).toBe(false);

        // But shouldExecute() returns TRUE because handleDeliveryInjection returns false
        // when RAL is not streaming (line 921 of AgentDispatchService.ts)
        const shouldExec = shouldExecute(AGENT_PUBKEY, CONVERSATION_ID);
        expect(shouldExec).toBe(true); // ❌ BUG: Should be false!

        // The fix: handleDeliveryInjection should return true (skip execution) when ANY RAL exists
    });

    /**
     * Simulates the exact production scenario:
     * Two messages 3ms apart, both find resumable RAL, both resume it
     */
    test("FAILING: concurrent dispatches both resume same RAL", async () => {
        // Historical RAL from earlier (like RAL#1 created at timestamp 414477000)
        const ralNumber = ralRegistry.create(
            AGENT_PUBKEY,
            CONVERSATION_ID,
            PROJECT_ID,
            "historical-trigger-event"
        );

        // Make it resumable by adding completed delegation
        ralRegistry.mergePendingDelegations(AGENT_PUBKEY, CONVERSATION_ID, ralNumber, [
            {
                delegationConversationId: "del-1",
                recipientPubkey: "recipient-1",
                senderPubkey: AGENT_PUBKEY,
                prompt: "Some task",
                ralNumber,
            },
        ]);

        ralRegistry.recordCompletion({
            delegationConversationId: "del-1",
            recipientPubkey: "recipient-1",
            response: "Done",
            completedAt: Date.now(),
        });

        ralRegistry.setStreaming(AGENT_PUBKEY, CONVERSATION_ID, ralNumber, false);

        // Message 1: "## Run Backfill? Yes, run it now" @ 713306000
        const dispatch1ActiveRal = ralRegistry.getState(AGENT_PUBKEY, CONVERSATION_ID);
        expect(dispatch1ActiveRal).toBeDefined(); // RAL exists (non-streaming)
        expect(dispatch1ActiveRal?.isStreaming).toBe(false);

        // Message 2: "the backfill shouldn't..." @ 713309000 (+3ms)
        const dispatch2ActiveRal = ralRegistry.getState(AGENT_PUBKEY, CONVERSATION_ID);
        expect(dispatch2ActiveRal).toBeDefined(); // SAME RAL!
        expect(dispatch2ActiveRal?.isStreaming).toBe(false);

        // Both executions call resolveRAL()
        const resumableRal1 = ralRegistry.findResumableRAL(AGENT_PUBKEY, CONVERSATION_ID);
        const resumableRal2 = ralRegistry.findResumableRAL(AGENT_PUBKEY, CONVERSATION_ID);

        // ❌ FAILS: Both find the SAME RAL!
        expect(resumableRal1?.ralNumber).toBe(ralNumber);
        expect(resumableRal2?.ralNumber).toBe(ralNumber);
        expect(resumableRal1?.ralNumber).toBe(resumableRal2?.ralNumber);

        // Without atomic claiming, both would resume it
        // Expected: Only ONE should resume, the other should queue message
    });

    /**
     * Shows that queued injections don't prevent execution because
     * handleDeliveryInjection returns false for non-streaming RALs
     */
    test("FAILING: queued injections don't prevent execution when RAL is not streaming", () => {
        const ralNumber = ralRegistry.create(AGENT_PUBKEY, CONVERSATION_ID, PROJECT_ID);

        // Queue a message (simulating a queued injection)
        ralRegistry.queueUserMessage(
            AGENT_PUBKEY,
            CONVERSATION_ID,
            ralNumber,
            "Earlier queued message"
        );

        ralRegistry.setStreaming(AGENT_PUBKEY, CONVERSATION_ID, ralNumber, false);

        // The RAL has queued injections but is not streaming
        const activeRal = ralRegistry.getState(AGENT_PUBKEY, CONVERSATION_ID);
        expect(activeRal).toBeDefined();
        expect(activeRal?.queuedInjections.length).toBeGreaterThan(0);

        // But shouldExecute returns TRUE because handleDeliveryInjection returns false
        const shouldExec = shouldExecute(AGENT_PUBKEY, CONVERSATION_ID);
        expect(shouldExec).toBe(true); // ❌ BUG: Should be false (RAL has queued work)!
    });

    /**
     * Demonstrates what the fix should look like:
     * handleDeliveryInjection should return true (skip execution) when ANY RAL exists
     */
    test("FIXED: skip execution when RAL exists, regardless of streaming status", () => {
        const ralNumber = ralRegistry.create(AGENT_PUBKEY, CONVERSATION_ID, PROJECT_ID);

        // Make it resumable (pending delegation required for completion to register)
        ralRegistry.mergePendingDelegations(AGENT_PUBKEY, CONVERSATION_ID, ralNumber, [
            {
                delegationConversationId: "del-completed",
                recipientPubkey: "recipient",
                senderPubkey: AGENT_PUBKEY,
                prompt: "Some task",
                ralNumber,
            },
        ]);
        ralRegistry.recordCompletion({
            delegationConversationId: "del-completed",
            recipientPubkey: "recipient",
            response: "Done",
            completedAt: Date.now(),
        });
        ralRegistry.setStreaming(AGENT_PUBKEY, CONVERSATION_ID, ralNumber, false);

        // THE FIX: Return true (skip execution) when RAL exists, even if not streaming
        function shouldExecuteFixed(agentPubkey: string, conversationId: string): boolean {
            const activeRal = ralRegistry.getState(agentPubkey, conversationId);

            if (!activeRal) {
                return true; // No RAL, proceed to execute
            }

            // FIX: Queue the message and skip execution ALWAYS when RAL exists
            // Don't check isStreaming - if RAL exists, queue and defer to resumption logic
            return false;
        }

        // Message 1
        const message1ShouldExecute = shouldExecuteFixed(AGENT_PUBKEY, CONVERSATION_ID);
        expect(message1ShouldExecute).toBe(false); // ✅ Should inject, not execute

        // Message 2
        const message2ShouldExecute = shouldExecuteFixed(AGENT_PUBKEY, CONVERSATION_ID);
        expect(message2ShouldExecute).toBe(false); // ✅ Should also inject
    });

    /**
     * Alternative fix: Atomic RAL claiming in resolveRAL()
     */
    test("FIXED: atomic claim prevents concurrent resumption", () => {
        const ralNumber = ralRegistry.create(AGENT_PUBKEY, CONVERSATION_ID, PROJECT_ID);

        ralRegistry.mergePendingDelegations(AGENT_PUBKEY, CONVERSATION_ID, ralNumber, [
            {
                delegationConversationId: "del-1",
                recipientPubkey: "recipient",
                senderPubkey: AGENT_PUBKEY,
                prompt: "Some task",
                ralNumber,
            },
        ]);
        ralRegistry.recordCompletion({
            delegationConversationId: "del-1",
            recipientPubkey: "recipient",
            response: "Done",
            completedAt: Date.now(),
        });
        ralRegistry.setStreaming(AGENT_PUBKEY, CONVERSATION_ID, ralNumber, false);

        // Simulate atomic claiming
        let claimed = false;

        function atomicClaimResumableRAL(
            agentPubkey: string,
            conversationId: string
        ): { ralNumber: number } | undefined {
            const resumableRal = ralRegistry.findResumableRAL(agentPubkey, conversationId);
            if (!resumableRal) return undefined;

            // Atomic check-and-set
            if (claimed) return undefined; // Already claimed
            claimed = true;

            return { ralNumber: resumableRal.ralNumber };
        }

        // Both executions try to claim
        const claim1 = atomicClaimResumableRAL(AGENT_PUBKEY, CONVERSATION_ID);
        const claim2 = atomicClaimResumableRAL(AGENT_PUBKEY, CONVERSATION_ID);

        // ✅ Only one succeeds
        expect(claim1).toBeDefined();
        expect(claim2).toBeUndefined();
    });

    /**
     * Edge case: RAL created between dispatch check and execution start
     */
    test("FAILING: RAL created between dispatch and execution (time-of-check-time-of-use)", async () => {
        // Message 1 dispatch checks
        const dispatch1ActiveRal = ralRegistry.getState(AGENT_PUBKEY, CONVERSATION_ID);
        expect(dispatch1ActiveRal).toBeUndefined(); // No RAL, proceed

        // Before message 1 execution starts, message 2 creates a RAL
        const ralNumber = ralRegistry.create(AGENT_PUBKEY, CONVERSATION_ID, PROJECT_ID);
        ralRegistry.setStreaming(AGENT_PUBKEY, CONVERSATION_ID, ralNumber, true);

        // Message 2 dispatch checks
        const dispatch2ActiveRal = ralRegistry.getState(AGENT_PUBKEY, CONVERSATION_ID);
        expect(dispatch2ActiveRal).toBeDefined(); // Finds RAL, should inject

        // Message 1 execution starts (too late, already decided to execute!)
        // This creates a TOCTOU race: decision made at check time, executed later

        // THE FIX: Re-check at execution time, not just dispatch time
    });
});

/**
 * Integration test simulating the full dispatch → execute flow
 */
describe("Concurrent Message Integration Test", () => {
    const AGENT_PUBKEY = "test-agent-integration";
    const CONVERSATION_ID = "test-conv-integration";
    const PROJECT_ID = "31933:test:integration" as ProjectDTag;

    let ralRegistry: RALRegistry;
    let executionCount = 0;

    beforeEach(() => {
        // @ts-expect-error - accessing private static for testing
        RALRegistry.instance = undefined;
        ralRegistry = RALRegistry.getInstance();
        executionCount = 0;
    });

    afterEach(() => {
        ralRegistry.clearAll();
    });

    /**
     * Simulates the full flow: dispatch → dispatchToAgent → execute → resolveRAL,
     * using the same atomic claim protocol as the real AgentDispatchService.
     *
     * `dispatchPhase` is an awaitable barrier: tests pass a promise that
     * resolves after BOTH dispatches have completed their dispatch-phase check
     * (`getState` + `handleDeliveryInjection`) but BEFORE either proceeds into
     * the execute phase. This interleaves the two simulated dispatches the way
     * two concurrent Node microtasks would interleave in production, without
     * relying on real timers or random scheduling.
     */
    async function simulateMessageDispatch(
        messageContent: string,
        triggeringEventId: string,
        dispatchPhase: Promise<void>
    ) {
        // Step 1: Dispatch check (AgentDispatchService.dispatchToAgent)
        const activeRal = ralRegistry.getState(AGENT_PUBKEY, CONVERSATION_ID);

        // Step 2: handleDeliveryInjection — when an idle RAL is present,
        // atomically claim it via tryAcquireResumptionClaim. Only one
        // concurrent dispatch wins the claim; the loser queues and skips.
        let preferredRalNumber: number | undefined;
        let claimToken: string | undefined;
        if (activeRal) {
            ralRegistry.queueUserMessage(
                AGENT_PUBKEY,
                CONVERSATION_ID,
                activeRal.ralNumber,
                messageContent
            );

            if (activeRal.isStreaming) {
                await dispatchPhase;
                return { executed: false, injected: true, ralNumber: activeRal.ralNumber };
            }

            claimToken = ralRegistry.tryAcquireResumptionClaim(
                AGENT_PUBKEY,
                CONVERSATION_ID,
                activeRal.ralNumber
            );
            if (claimToken === undefined) {
                // Another dispatch claimed — our message is queued, skip.
                await dispatchPhase;
                return { executed: false, injected: true, ralNumber: activeRal.ralNumber };
            }
            preferredRalNumber = activeRal.ralNumber;
        }

        try {
            // Wait for the other dispatch to finish its dispatch-phase check
            // before either of us advances into execute(). This creates the
            // window that exists in production when two events arrive 3ms apart.
            await dispatchPhase;

            // Step 3: Execute → resolveRAL (AgentExecutor.execute).
            // When a preferred RAL is held, resolveRAL pins resumption to
            // that exact entry instead of calling findResumableRAL.
            executionCount++;

            const preferredRal = preferredRalNumber !== undefined
                ? ralRegistry.getRAL(AGENT_PUBKEY, CONVERSATION_ID, preferredRalNumber)
                : undefined;
            const resumableRal = preferredRal
                ? (ralRegistry.getConversationCompletedDelegations(AGENT_PUBKEY, CONVERSATION_ID, preferredRal.ralNumber).length > 0
                    ? preferredRal
                    : undefined)
                : ralRegistry.findResumableRAL(AGENT_PUBKEY, CONVERSATION_ID);
            const injectionRal = !resumableRal
                ? (preferredRal ?? ralRegistry.findRALWithInjections(AGENT_PUBKEY, CONVERSATION_ID))
                : undefined;

            let ralNumber: number;

            if (resumableRal) {
                ralNumber = resumableRal.ralNumber;
                // Simulate clearing completed delegations as resolveRAL does
                ralRegistry.clearCompletedDelegations(AGENT_PUBKEY, CONVERSATION_ID, ralNumber);
            } else if (injectionRal) {
                ralNumber = injectionRal.ralNumber;
            } else {
                ralNumber = ralRegistry.create(AGENT_PUBKEY, CONVERSATION_ID, PROJECT_ID, triggeringEventId);
            }

            ralRegistry.setStreaming(AGENT_PUBKEY, CONVERSATION_ID, ralNumber, true);
            if (claimToken !== undefined) {
                ralRegistry.handOffResumptionClaimToStream(
                    AGENT_PUBKEY,
                    CONVERSATION_ID,
                    ralNumber,
                    claimToken
                );
            }

            return { executed: true, injected: false, ralNumber };
        } finally {
            // Dispatch-scope release: no-ops if already handed off to the stream.
            if (claimToken !== undefined && preferredRalNumber !== undefined) {
                ralRegistry.releaseResumptionClaim(
                    AGENT_PUBKEY,
                    CONVERSATION_ID,
                    preferredRalNumber,
                    claimToken
                );
            }
        }
    }

    test("FAILING: two concurrent messages create two executions", async () => {
        // Create a historical RAL (like the production trace)
        const historicalRal = ralRegistry.create(
            AGENT_PUBKEY,
            CONVERSATION_ID,
            PROJECT_ID,
            "historical-event"
        );

        // A pending delegation must exist before recordCompletion is a no-op,
        // otherwise findResumableRAL won't see any completed delegations and
        // the historical RAL won't actually be resumable.
        ralRegistry.mergePendingDelegations(AGENT_PUBKEY, CONVERSATION_ID, historicalRal, [
            {
                delegationConversationId: "old-delegation",
                recipientPubkey: "old-recipient",
                senderPubkey: AGENT_PUBKEY,
                prompt: "Some earlier task",
                ralNumber: historicalRal,
            },
        ]);
        ralRegistry.recordCompletion({
            delegationConversationId: "old-delegation",
            recipientPubkey: "old-recipient",
            response: "Old result",
            completedAt: Date.now() - 300000, // 5 minutes ago
        });

        ralRegistry.setStreaming(AGENT_PUBKEY, CONVERSATION_ID, historicalRal, false);

        // Sanity check: without concurrency, the historical RAL should be
        // genuinely resumable. If this fails, the test setup is wrong.
        const resumableSanityCheck = ralRegistry.findResumableRAL(AGENT_PUBKEY, CONVERSATION_ID);
        expect(resumableSanityCheck?.ralNumber).toBe(historicalRal);

        // Run both dispatches concurrently. Each dispatch waits on
        // `dispatchBarrier` AFTER its dispatch-phase check but BEFORE its
        // execute-phase check — this forces them to interleave the way they
        // do in production when two Nostr events arrive within a few ms.
        let releaseBarrier!: () => void;
        const dispatchBarrier = new Promise<void>((resolve) => {
            releaseBarrier = resolve;
        });

        const [result1, result2] = await Promise.all([
            simulateMessageDispatch(
                "## Run Backfill?\n\nYes, run it now (Recommended)",
                "db271d7b7b726a84bef98005eeaff2b7c7d159d7f20e5a4c6d90bc5f6caf769f",
                dispatchBarrier
            ),
            (async () => {
                // Yield once so dispatch #1 runs its synchronous dispatch-phase
                // check first, then start dispatch #2. Both will then suspend on
                // the barrier, simulating the production interleaving.
                await Promise.resolve();
                const dispatchResult = simulateMessageDispatch(
                    "the backfill shouldn't be a \"backfill\" that needs to explicitly run",
                    "ec9e0fb5025dde0f1cea8b454d01007bca7a730660488750e1f0c01cdf034512",
                    dispatchBarrier
                );
                // Release the barrier once the second dispatch has also reached
                // its dispatch-phase check point.
                releaseBarrier();
                return dispatchResult;
            })(),
        ]);

        // The fix should ensure exactly ONE execution picks up both messages.
        // Current (broken) behavior: both dispatches execute.
        expect(executionCount).toBe(1);

        // Exactly one should execute, the other should inject.
        const executedCount = [result1, result2].filter((r) => r.executed).length;
        const injectedCount = [result1, result2].filter((r) => r.injected).length;
        expect(executedCount).toBe(1);
        expect(injectedCount).toBe(1);

        // Whichever one executed should have resumed the historical RAL.
        const executed = result1.executed ? result1 : result2;
        expect(executed.ralNumber).toBe(historicalRal);
    });
});
