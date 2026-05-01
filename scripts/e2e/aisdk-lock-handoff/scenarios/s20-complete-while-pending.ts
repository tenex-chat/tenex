// S20 — Conversation "complete" while a tool from a prior RAL is still pending.
//
// Setup:    RAL#1 starts a manual_tool. Lock TOOL_PENDING.
// Trigger:  User injects "Never mind, just say 'cancelled'." → RAL#2 spawns,
//           replies "cancelled", releases driver. The conversation is now
//           logically settled (the user's most recent intent was satisfied).
// Late:     RAL#1's manual tool eventually returns. Lock state at that moment:
//           driver=null (RAL#2 has released). RAL#1's onStepFinish runs;
//           finishTool returns "reacquired". RAL#1 continues to a final step,
//           sees the conversation ends with "cancelled", and decides what to do.
//
// Design under test: late tool resolution after logical conversation completion.
// Acceptable outcomes:
//   - RAL#1 silently completes without further user-visible output, OR
//   - RAL#1 mentions the result as an addendum.
// Either is fine; what we DON'T want:
//   - Zombie state (lock not IDLE)
//   - Crash / unhandled rejection
//   - Loss of the tool-result data (must be in store as either real tool-result
//     or late-tool-result)

import {
    ConversationStore,
    Lock,
    dispatchUserMessage,
    dispatchWakeupOrDefer,
    makeManualTool,
    type DispatchContext,
    type RalOutcome,
} from "../_runtime";
import { log, resetRalCounter, startClock } from "../_shared";

async function main(): Promise<void> {
    startClock();
    resetRalCounter();

    const store = new ConversationStore();
    const lock = new Lock();
    const promises: Promise<RalOutcome>[] = [];

    const manual = makeManualTool(
        "background_task",
        "Run the background task. Long-running; the test controls when it completes.",
    );

    const dispatchCtx: DispatchContext = {
        store,
        lock,
        makeRalContext: (ralId) => ({
            store,
            lock,
            tools: { background_task: manual.tool },
            systemPrompt:
                "You are a helpful assistant. If the user cancels a task, comply with the cancellation. Messages prefixed with [late-tool-result ...] indicate a previously running task finished — acknowledge briefly only if it's still relevant; otherwise stay quiet.",
            onLateResult: (entry) => {
                log(`[late-result] ${entry.toolName}`);
                dispatchWakeupOrDefer(dispatchCtx, `late ${entry.toolName}`, promises);
            },
            maxSteps: 3,
        }),
    };

    const r1 = dispatchUserMessage(
        dispatchCtx,
        "Run the background_task with note='start'. Then say 'task done'.",
    );
    if (!r1.spawned) throw new Error("RAL#1 should spawn");
    if (r1.promise) promises.push(r1.promise);

    await manual.started;
    log("== RAL#1 tool started ==");

    const r2 = dispatchUserMessage(
        dispatchCtx,
        "Never mind, just say 'cancelled' — don't acknowledge anything else.",
    );
    if (!r2.spawned) throw new Error("RAL#2 should spawn");
    if (r2.promise) promises.push(r2.promise);

    // Wait for RAL#2 to finish entirely (driver released back to null).
    while (lock.getDriver() !== null) {
        await new Promise((r) => setTimeout(r, 50));
    }
    // Also wait until RAL#2's promise has resolved.
    if (r2.promise) await r2.promise;
    log("== RAL#2 finished and released; signaling RAL#1's tool ==");

    manual.finish({ ok: true, label: "background_task", payload: "TASK-RESULT-Z" });

    let lastSeen = -1;
    while (promises.length !== lastSeen) {
        lastSeen = promises.length;
        // eslint-disable-next-line no-await-in-loop
        await Promise.allSettled(promises);
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 200));
    }

    log("== final store ==\n" + store.debugDump());
    log("== final lock ==", lock.snapshot());

    const entries = store.all();
    const toolResolved = entries.some(
        (e) =>
            (e.kind === "tool-result" || e.kind === "late-tool-result") &&
            e.toolName === "background_task",
    );
    const cancelMentioned = entries.some(
        (e) => e.kind === "assistant" && /cancel/i.test(e.text),
    );

    const checks: { name: string; ok: boolean; detail?: string }[] = [
        {
            name: "RAL#2 said 'cancelled' (the user's last instruction was honored)",
            ok: cancelMentioned,
        },
        { name: "background_task tool resolution recorded in store", ok: toolResolved },
        {
            name: "lock IDLE at end (no zombie state)",
            ok: lock.getDriver() === null && lock.pendingToolCount() === 0,
        },
        { name: "no unhandled rejection (RALs settled)", ok: promises.length >= 2 },
    ];
    for (const c of checks) {
        log(`[assert] ${c.ok ? "PASS" : "FAIL"} — ${c.name}${c.detail ? ` (${c.detail})` : ""}`);
    }
    const failed = checks.filter((c) => !c.ok);
    if (failed.length > 0) {
        log(`!! ${failed.length} assertion(s) failed`);
        process.exit(1);
    }
    log("!! S20 PASSED");
}

main().catch((e) => {
    console.error("FATAL", e);
    process.exit(1);
});
