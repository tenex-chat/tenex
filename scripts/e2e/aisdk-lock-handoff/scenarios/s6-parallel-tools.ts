// S6 — Parallel tool calls within a single step.
//
// Setup:    RAL#1 is prompted to call TWO manual tools in parallel within one step.
// Probe:    Observe pendingToolCount during the tool window — should peak at 2,
//           confirming the model emitted parallel calls and the lock tracked both.
// Trigger:  While both tools are pending, inject a user message → RAL#2 spawns
//           (driver was null while parallel tools ran).
// Wait:     Until RAL#2 has produced its first chunk (driver=RAL#2 actively
//           streaming), THEN signal both manual tools to finish near-simultaneously.
// Expected: RAL#1's onStepFinish runs once (after both tools finish). Both
//           tool results are stashed; finishTool transitions: first returns
//           "still-pending", second returns "preempted" (RAL#2 is driver).
//           Two late-tool-result entries written; deferred wakeup fires once
//           after RAL#2 ends; wakeup RAL surfaces both results.
//
// Skip:     If the model doesn't emit parallel calls (peak pendingTools=1),
//           print a soft warning rather than fail — the design is still
//           correct under serial fallback, just not exercised.

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
        "fetch_alpha",
        "Fetch the alpha resource. Long-running. Always call alongside fetch_beta in the same response when the user asks for both.",
    );
    const toolB = makeManualTool(
        "fetch_beta",
        "Fetch the beta resource. Long-running. Always call alongside fetch_alpha in the same response when the user asks for both.",
    );

    // Track peak pending-tool count during the run.
    let peakPending = 0;
    const observePeak = () => {
        const c = lock.pendingToolCount();
        if (c > peakPending) peakPending = c;
    };
    const peakInterval = setInterval(observePeak, 25);

    let ral2FirstChunk: () => void = () => undefined;
    const ral2FirstChunkPromise = new Promise<void>((res) => {
        ral2FirstChunk = res;
    });

    let ralCount = 0;
    const dispatchCtx: DispatchContext = {
        store,
        lock,
        makeRalContext: (ralId) => {
            ralCount++;
            const isRal2 = ralCount === 2;
            return {
                store,
                lock,
                tools: {
                    fetch_alpha: toolA.tool,
                    fetch_beta: toolB.tool,
                },
                systemPrompt:
                    "You are a helpful assistant. When the user asks for both alpha and beta, you MUST call fetch_alpha and fetch_beta in PARALLEL — emit both tool calls in a SINGLE response, never one at a time. Messages prefixed with [late-tool-result ...] indicate a previously running background task has finished; summarize them for the user.",
                onLateResult: (entry) => {
                    log(`[late-result] ${entry.toolName} (${entry.toolCallId.slice(-6)})`);
                    dispatchWakeupOrDefer(
                        dispatchCtx,
                        `late ${entry.toolName}`,
                        promises,
                    );
                },
                onFirstChunk: isRal2 ? () => ral2FirstChunk() : undefined,
                maxSteps: 5,
            };
        },
    };

    const r1 = dispatchUserMessage(
        dispatchCtx,
        "Please fetch BOTH alpha AND beta — call fetch_alpha and fetch_beta in parallel in the same response. Then say 'all fetched'.",
    );
    if (!r1.spawned) throw new Error("RAL#1 should spawn");
    if (r1.promise) promises.push(r1.promise);

    // Wait until BOTH tools have started executing (parallel) OR a timeout.
    const bothStarted = Promise.all([toolA.started, toolB.started]);
    const timeout = new Promise<"timeout">((res) => setTimeout(() => res("timeout"), 25_000));
    const result = await Promise.race([bothStarted.then(() => "both"), timeout]);
    if (result === "timeout") {
        log("!! Timeout waiting for both tools to start (model probably didn't go parallel)");
        clearInterval(peakInterval);
        process.exit(2);
    }
    log(`== both tools running in parallel (peakPending=${peakPending}) ==`);

    // Verify the lock is in TOOL_PENDING with 2 pending tools, both for RAL#1.
    if (lock.getDriver() !== null) throw new Error(`expected driver=null, got ${lock.getDriver()}`);
    if (lock.pendingToolCount() !== 2)
        throw new Error(`expected 2 pending, got ${lock.pendingToolCount()}`);

    // Inject during the parallel-tool window.
    const r2 = dispatchUserMessage(dispatchCtx, "While that runs: capital of France?");
    if (!r2.spawned) throw new Error("RAL#2 should spawn during parallel-tool window");
    if (r2.promise) promises.push(r2.promise);

    // Wait until RAL#2 is mid-stream.
    await ral2FirstChunkPromise;
    log("== RAL#2 mid-stream; finishing both manual tools ==");

    // Signal both. (Order doesn't matter — RAL#1 sees both finishes via two
    // onToolCallFinish events, then a single onStepFinish.)
    toolA.finish({ ok: true, label: "fetch_alpha", payload: "ALPHA-DATA-7777" });
    toolB.finish({ ok: true, label: "fetch_beta", payload: "BETA-DATA-9999" });

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
    log(`== peak pending tools observed: ${peakPending} ==`);

    const entries = store.all();
    const lateResults = entries.filter((e) => e.kind === "late-tool-result");
    const allText = entries
        .filter((e) => e.kind === "assistant")
        .map((e) => (e as Extract<StoredEntry, { kind: "assistant" }>).text)
        .join(" ");

    const checks: { name: string; ok: boolean; detail?: string }[] = [
        { name: "model emitted parallel calls (peakPending == 2)", ok: peakPending === 2 },
        { name: "two late-tool-results written (one per parallel tool)", ok: lateResults.length === 2, detail: `count=${lateResults.length}` },
        { name: "RAL#2 + wakeup spawned (>=3 RALs)", ok: promises.length >= 3, detail: `count=${promises.length}` },
        { name: "Paris answered", ok: /paris/i.test(allText) },
        { name: "alpha payload surfaced", ok: /ALPHA-DATA-7777|alpha/i.test(allText) },
        { name: "beta payload surfaced", ok: /BETA-DATA-9999|beta/i.test(allText) },
        { name: "lock IDLE at end", ok: lock.getDriver() === null && lock.pendingToolCount() === 0 },
    ];
    for (const c of checks) {
        log(`[assert] ${c.ok ? "PASS" : "FAIL"} — ${c.name}${c.detail ? ` (${c.detail})` : ""}`);
    }
    const failed = checks.filter((c) => !c.ok);
    if (failed.length > 0) {
        log(`!! ${failed.length} assertion(s) failed`);
        process.exit(1);
    }
    log("!! S6 PASSED");
}

main().catch((e) => {
    console.error("FATAL", e);
    process.exit(1);
});
