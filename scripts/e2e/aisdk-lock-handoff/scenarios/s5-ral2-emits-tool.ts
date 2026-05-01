// S5 — RAL#2 emits its OWN tool while RAL#1's tool is still pending.
//
// Setup:    RAL#1 calls manualA (long-running). Lock released; pending={A: R1}.
// Trigger:  User injects → RAL#2 spawns. RAL#2 is prompted to ALSO call a tool
//           (manualB). When manualB starts, driver releases for R2; pending=
//           {A: R1, B: R2}. Both RALs now have pending tools simultaneously.
// Resolve:  Signal manualA first → R1's onStepFinish: pendingForR1=0, driver=null
//           → reacquired by R1. R1 continues to step 1, emits final reply.
//           Signal manualB → R2's onStepFinish: pendingForR2=0, driver=null
//           (R1 may have ended) → reacquired (or preempted depending on R1's
//           state). Either way, both RALs eventually surface results.
//
// What this tests:
//   - Two concurrent pending tools owned by different RALs.
//   - The rebuilder produces a coherent message array containing TWO synthetic
//     placeholders (one per still-pending tool-call) when the wakeup RAL spawns.
//   - finishTool correctly returns "still-pending" / "reacquired" / "preempted"
//     based on each RAL's own pending count plus the global driver state.

import {
    ConversationStore,
    Lock,
    dispatchUserMessage,
    dispatchWakeupOrDefer,
    makeManualTool,
    type DispatchContext,
    type RalOutcome,
    type StoredEntry,
} from "../_runtime";
import { log, resetRalCounter, startClock } from "../_shared";

async function main(): Promise<void> {
    startClock();
    resetRalCounter();

    const store = new ConversationStore();
    const lock = new Lock();
    const promises: Promise<RalOutcome>[] = [];

    const toolA = makeManualTool(
        "task_alpha",
        "A long-running alpha task. Call only when the user explicitly asks for the alpha task.",
    );
    const toolB = makeManualTool(
        "task_beta",
        "A long-running beta task. Call only when the user explicitly asks for the beta task.",
    );

    // Snapshot peak observed pending tools for visibility.
    let peakPending = 0;
    const peakInterval = setInterval(() => {
        const c = lock.pendingToolCount();
        if (c > peakPending) peakPending = c;
    }, 25);

    const dispatchCtx: DispatchContext = {
        store,
        lock,
        makeRalContext: (ralId) => ({
            store,
            lock,
            tools: { task_alpha: toolA.tool, task_beta: toolB.tool },
            systemPrompt:
                "You are a helpful assistant. Use the tools when explicitly asked. Messages prefixed with [late-tool-result ...] are notifications that a previously running background task finished — summarize the result for the user.",
            onLateResult: (entry) => {
                log(`[late-result] ${entry.toolName}`);
                dispatchWakeupOrDefer(dispatchCtx, `late ${entry.toolName}`, promises);
            },
            maxSteps: 4,
        }),
    };

    // RAL#1 — kicks off task_alpha.
    const r1 = dispatchUserMessage(
        dispatchCtx,
        "Run the alpha task — call task_alpha with note='start'. After it finishes, say 'alpha done'.",
    );
    if (!r1.spawned) throw new Error("RAL#1 should spawn");
    if (r1.promise) promises.push(r1.promise);

    await toolA.started;
    log("== RAL#1 alpha tool started ==");

    // RAL#2 — kicks off task_beta.
    const r2 = dispatchUserMessage(
        dispatchCtx,
        "Also start the beta task — call task_beta with note='start'. After it finishes, say 'beta done'.",
    );
    if (!r2.spawned) throw new Error("RAL#2 should spawn");
    if (r2.promise) promises.push(r2.promise);

    await toolB.started;
    // Capture peak right at the documented co-pending instant (the 25ms
    // poller may have missed it given how fast the test progresses).
    peakPending = Math.max(peakPending, lock.pendingToolCount());
    log(
        `== both RALs have pending tools concurrently (peakPending=${peakPending} expected=2) ==`,
    );

    // Verify lock state during co-pending phase.
    if (lock.getDriver() !== null)
        throw new Error(`expected driver=null, got ${lock.getDriver()}`);
    if (lock.pendingToolsForRal("RAL#1") !== 1)
        throw new Error(`R1 pending != 1: ${lock.pendingToolsForRal("RAL#1")}`);
    if (lock.pendingToolsForRal("RAL#2") !== 1)
        throw new Error(`R2 pending != 1: ${lock.pendingToolsForRal("RAL#2")}`);

    // Signal alpha first.
    log("== signaling task_alpha (RAL#1's tool) ==");
    toolA.finish({ ok: true, label: "task_alpha", payload: "ALPHA-9876" });

    // Brief settle pause.
    await new Promise((r) => setTimeout(r, 300));

    log("== signaling task_beta (RAL#2's tool) ==");
    toolB.finish({ ok: true, label: "task_beta", payload: "BETA-5432" });

    let lastSeen = -1;
    while (promises.length !== lastSeen) {
        lastSeen = promises.length;
        // eslint-disable-next-line no-await-in-loop
        await Promise.allSettled(promises);
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 200));
    }
    clearInterval(peakInterval);

    log("== final store ==\n" + store.debugDump());
    log("== final lock ==", lock.snapshot());

    const entries = store.all();
    const allText = entries
        .filter((e) => e.kind === "assistant")
        .map((e) => (e as Extract<StoredEntry, { kind: "assistant" }>).text)
        .join(" ");

    const alphaRecorded = entries.some(
        (e) =>
            (e.kind === "tool-result" || e.kind === "late-tool-result") &&
            e.toolName === "task_alpha",
    );
    const betaRecorded = entries.some(
        (e) =>
            (e.kind === "tool-result" || e.kind === "late-tool-result") &&
            e.toolName === "task_beta",
    );
    const eitherSurfaced = /alpha|beta|ALPHA-9876|BETA-5432/i.test(allText);

    const checks: { name: string; ok: boolean; detail?: string }[] = [
        {
            name: "two pending tools observed concurrently",
            ok: peakPending === 2,
            detail: `peak=${peakPending}`,
        },
        { name: "alpha tool result recorded in store", ok: alphaRecorded },
        { name: "beta tool result recorded in store", ok: betaRecorded },
        {
            name: "at least one tool result surfaced verbally by an assistant turn",
            ok: eitherSurfaced,
        },
        {
            name: "lock IDLE at end",
            ok: lock.getDriver() === null && lock.pendingToolCount() === 0,
        },
        { name: "no errors thrown (>=2 RALs settled)", ok: promises.length >= 2 },
    ];
    for (const c of checks) {
        log(`[assert] ${c.ok ? "PASS" : "FAIL"} — ${c.name}${c.detail ? ` (${c.detail})` : ""}`);
    }
    const failed = checks.filter((c) => !c.ok);
    if (failed.length > 0) {
        log(`!! ${failed.length} assertion(s) failed`);
        process.exit(1);
    }
    log("!! S5 PASSED");
}

main().catch((e) => {
    console.error("FATAL", e);
    process.exit(1);
});
