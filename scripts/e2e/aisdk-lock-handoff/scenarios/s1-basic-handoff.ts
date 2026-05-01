// S1 — Basic handoff.
//
// Setup:    Empty conversation. RAL#1 spawned by user msg "Sleep 6s then say done".
// Trigger:  At t=2s (mid-tool), user sends "While that runs, what's 7*6?".
// Expected: RAL#2 spawns immediately (lock TOOL_PENDING). RAL#2 sees a synthetic
//           tool-result for the still-running sleep tool, replies with the math.
//           At t~6s the sleep returns; if RAL#2 already finished and released,
//           a wakeup RAL#3 fires (lock free). RAL#3 sees the late-tool-result
//           system message and surfaces it ("the sleep finished").
//
// Assertions:
//   - At least 2 distinct RAL ids are spawned.
//   - The conversation store contains: assistant{tool-call sleep}, late-tool-result(sleep),
//     and at least one final assistant text after the late result.
//   - RAL#2's reply mentions "42" or "7*6" / answers the math.
//   - The lock ends in IDLE.

import {
    ConversationStore,
    Lock,
    dispatchUserMessage,
    dispatchWakeup,
    makeSleepTool,
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

    const dispatchCtx: DispatchContext = {
        store,
        lock,
        makeRalContext: (ralId) => ({
            store,
            lock,
            tools: { sleep: makeSleepTool("sleep") },
            systemPrompt:
                "You are a helpful assistant. When you see a [late-tool-result ...] system message, briefly summarize the result for the user.",
            onLateResult: (entry) => {
                log(
                    `[late-result-handler] late tool ${entry.toolName} (${entry.toolCallId.slice(-6)}) — attempting wakeup`,
                );
                const w = dispatchWakeup(dispatchCtx, `late-result for ${entry.toolName}`);
                if (w.promise) promises.push(w.promise);
            },
            maxSteps: 4,
        }),
    };

    // Initial user message (commits + spawns RAL#1).
    const r1 = dispatchUserMessage(
        dispatchCtx,
        "Call the sleep tool with seconds=6, then tell me 'done'.",
    );
    if (!r1.spawned) throw new Error("RAL#1 should have spawned");
    if (r1.promise) promises.push(r1.promise);

    // Wait until RAL#1's tool is running (lock has a pending tool, driver=null).
    while (!(lock.getDriver() === null && lock.pendingToolCount() > 0)) {
        await new Promise((r) => setTimeout(r, 50));
    }
    log("== RAL#1 is in tool window; injecting user message ==");

    // Inject second user message during tool window.
    const r2 = dispatchUserMessage(dispatchCtx, "While that runs, what's 7 times 6?");
    if (!r2.spawned) throw new Error("RAL#2 should have spawned (lock was TOOL_PENDING)");
    if (r2.promise) promises.push(r2.promise);

    // Wait for ALL spawned RALs to settle (incl. wakeup RAL fired by late-result).
    // Since `promises` may grow during execution (wakeup RAL), poll until stable.
    let settled = 0;
    while (settled < promises.length) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.allSettled(promises);
        settled = promises.length;
        // Race-safe: give the wakeup-handler microtask a chance to push.
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 100));
    }

    log("== final store ==\n" + store.debugDump());
    log("== final lock ==", lock.snapshot());

    // ---- Assertions ----
    const entries = store.all();
    const ralIds = new Set<string>();
    // crude — re-run to count distinct RAL ids based on log not feasible here;
    // count via promises array
    log(`spawned ${promises.length} RAL(s)`);

    const hasLate = entries.some((e) => e.kind === "late-tool-result");
    const hasRealResult = entries.some(
        (e) => e.kind === "tool-result" && e.toolName === "sleep",
    );
    const hasAssistantToolCall = entries.some(
        (e) => e.kind === "assistant" && e.toolCalls.some((tc) => tc.toolName === "sleep"),
    );
    // Either path is valid for S1 depending on timing:
    //  - Preempted: RAL#1 was preempted, wrote late-tool-result, wakeup fired.
    //  - Reacquired: RAL#1's tool finished after RAL#2 released; RAL#1 continued normally.
    const sleepResolved = hasLate || hasRealResult;
    const finalAssistantText = (() => {
        for (let i = entries.length - 1; i >= 0; i--) {
            const e = entries[i];
            if (e.kind === "assistant" && e.text) return e.text;
        }
        return "";
    })();

    const checks: { name: string; ok: boolean; detail?: string }[] = [
        { name: "RAL#2 spawned (concurrent)", ok: promises.length >= 2 },
        {
            name: "store has assistant{tool-call sleep}",
            ok: hasAssistantToolCall,
        },
        {
            name: "sleep resolved (either real or late-tool-result)",
            ok: sleepResolved,
            detail: `late=${hasLate} real=${hasRealResult}`,
        },
        { name: "lock IDLE at end", ok: lock.getDriver() === null && lock.pendingToolCount() === 0 },
        {
            name: "some assistant turn answered the math (mentions 42)",
            ok: entries.some(
                (e) => e.kind === "assistant" && /42/.test(e.text),
            ),
            detail: `final='${finalAssistantText.slice(0, 120)}'`,
        },
    ];
    for (const c of checks) {
        log(`[assert] ${c.ok ? "PASS" : "FAIL"} — ${c.name}${c.detail ? ` (${c.detail})` : ""}`);
    }
    const failed = checks.filter((c) => !c.ok);
    if (failed.length > 0) {
        log(`!! ${failed.length} assertion(s) failed`);
        process.exit(1);
    }
    log("!! S1 PASSED");
}

main().catch((e) => {
    console.error("FATAL", e);
    process.exit(1);
});
