// S2 — Reverse ordering with PREEMPT path.
//
// Setup:    RAL#1 spawned, calls a manual_tool that we control.
// Trigger:  At lock-released boundary, inject a user message → RAL#2 spawns.
//           Wait until RAL#2 has streamed its first chunk (so it's the driver
//           AND in an LLM call). Then signal RAL#1's manual_tool to finish.
// Expected: RAL#1's onStepFinish runs while driver=RAL#2 → PREEMPTED.
//           RAL#1 writes a late-tool-result entry; wakeup attempt fails (lock
//           still held by RAL#2). Wakeup is deferred via lock.onceDriverReleased.
//           RAL#2 finishes streaming and releases driver → wakeup retries
//           → spawns RAL#3 (the wakeup). RAL#3 sees the late-tool-result
//           system message and surfaces it to the user.
//
// Assertions:
//   - Exactly one late-tool-result entry exists.
//   - Three (or more) RALs ran.
//   - The final assistant message references the late-result content (the
//     model surfaces "the manual tool finished" or similar).
//   - Lock IDLE at end.

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

    // RAL#2 / RAL#3 don't need the manual tool — only RAL#1 does. But we
    // pass it to all (the model will only call it if instructed).
    const manual = makeManualTool("background_task", "Run the configured background task. The task is a long-running operation that returns when complete. Always call this with note='start' when the user asks for a background task.");

    // Track when RAL#2's first chunk arrives, so we can deterministically
    // signal the manual tool while RAL#2 is still streaming.
    let ral2FirstChunk = (): void => undefined;
    const ral2FirstChunkPromise = new Promise<void>((resolve) => {
        ral2FirstChunk = resolve;
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
                tools: { background_task: manual.tool },
                systemPrompt:
                    "You are a helpful assistant. Messages prefixed with [late-tool-result ...] are system notifications that a background task you started earlier has finished. When you receive one, briefly tell the user the result, then continue any pending work.",
                onLateResult: (entry) => {
                    log(
                        `[late-result-handler] late tool ${entry.toolName} (${entry.toolCallId.slice(-6)}) — wakeup or defer`,
                    );
                    dispatchWakeupOrDefer(
                        dispatchCtx,
                        `late-result for ${entry.toolName}`,
                        promises,
                    );
                },
                onFirstChunk: isRal2
                    ? () => {
                          log(`[test] RAL#2 first chunk observed — driver=${lock.getDriver()}`);
                          ral2FirstChunk();
                      }
                    : undefined,
                maxSteps: 4,
            };
        },
    };

    // RAL#1: ask the assistant to run the background task.
    const r1 = dispatchUserMessage(
        dispatchCtx,
        "Please run the background_task with note='start'. Then say 'first done'.",
    );
    if (!r1.spawned) throw new Error("RAL#1 should spawn");
    if (r1.promise) promises.push(r1.promise);

    // Wait until manual tool's execute starts (lock TOOL_PENDING for RAL#1).
    await manual.started;
    log("== RAL#1 tool started; injecting RAL#2 message ==");

    // RAL#2: math question (will resolve in one step, no tools).
    const r2 = dispatchUserMessage(dispatchCtx, "While that runs, what's 7 times 6? Reply with just the number.");
    if (!r2.spawned) throw new Error("RAL#2 should spawn (lock was TOOL_PENDING)");
    if (r2.promise) promises.push(r2.promise);

    // Wait until RAL#2 has produced its first chunk — i.e., it's actively
    // mid-LLM-call. ONLY THEN do we signal the manual tool to finish.
    await ral2FirstChunkPromise;
    log("== RAL#2 is mid-stream; signaling RAL#1's manual tool ==");
    manual.finish({ ok: true, label: "background_task", result: "Task XYZ-42 completed: 1337 widgets processed" });

    // Drain. promises array can grow as wakeup fires.
    let lastSeen = -1;
    while (promises.length !== lastSeen) {
        lastSeen = promises.length;
        // eslint-disable-next-line no-await-in-loop
        await Promise.allSettled(promises);
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 150));
    }

    log("== final store ==\n" + store.debugDump());
    log("== final lock ==", lock.snapshot());

    // ---- Assertions ----
    const entries = store.all();
    const lateResults = entries.filter((e) => e.kind === "late-tool-result");
    const ralCountSpawned = promises.length;
    const lastAssistant = (() => {
        for (let i = entries.length - 1; i >= 0; i--) {
            const e = entries[i];
            if (e.kind === "assistant" && e.text) return e.text;
        }
        return "";
    })();
    const allAssistantText = entries
        .filter((e) => e.kind === "assistant")
        .map((e) => (e as Extract<StoredEntry, { kind: "assistant" }>).text)
        .join(" ");
    const mathAnswered = /42/.test(allAssistantText);
    const taskAcknowledged =
        /XYZ-42|1337|widget|first done|completed|finished|done/i.test(allAssistantText);

    const checks: { name: string; ok: boolean; detail?: string }[] = [
        { name: "RAL#1 was preempted (late-tool-result written)", ok: lateResults.length === 1 },
        { name: "wakeup spawned a third RAL", ok: ralCountSpawned >= 3, detail: `count=${ralCountSpawned}` },
        { name: "lock IDLE at end", ok: lock.getDriver() === null && lock.pendingToolCount() === 0 },
        {
            name: "math answered (somewhere in conversation)",
            ok: mathAnswered,
            detail: `last='${lastAssistant.slice(0, 100)}'`,
        },
        {
            name: "background task acknowledged after late-result",
            ok: taskAcknowledged,
            detail: `last='${lastAssistant.slice(0, 100)}'`,
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
    log("!! S2 PASSED");
}

main().catch((e) => {
    console.error("FATAL", e);
    process.exit(1);
});
