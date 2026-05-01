// Probe 10: stopWhen vs abort.
// - Can a custom stopWhen halt the run silently (no error, no rejection)?
// - Compare to abort() which rejects result.* promises.

import { streamText, tool } from "ai";
import type { StopCondition, ToolSet } from "ai";
import { z } from "zod";
import { MODEL, log, startClock, summarize } from "./_shared";

async function probeStopWhen(): Promise<void> {
    log("\n=== stopWhen: custom condition stopping after step 0 ===");

    const stopAfterFirst: StopCondition<ToolSet> = ({ steps }) => {
        const stop = steps.length >= 1;
        if (stop) log(`  stopWhen returned true (steps=${steps.length})`);
        return stop;
    };

    const result = streamText({
        model: MODEL,
        stopWhen: stopAfterFirst,
        prompt: "Call get_time, then say HI.",
        onStepFinish: (s) =>
            log("onStepFinish", { finishReason: s.finishReason, hasTool: !!s.toolCalls?.length }),
        onFinish: (e) =>
            log("onFinish", { finishReason: e.finishReason, steps: e.steps.length }),
        tools: {
            get_time: tool({
                description: "now",
                inputSchema: z.object({}),
                execute: async () => ({ now: Date.now() }),
            }),
        },
    });
    let text = "";
    for await (const d of result.textStream) text += d;
    try {
        const fr = await result.finishReason;
        const steps = await result.steps;
        log("OK: result.finishReason=", fr, "steps=", steps.length, "text=", text.slice(0, 80));
    } catch (e) {
        log("result.* threw:", summarize(e));
    }
}

async function probeAbortVsStopWhen(): Promise<void> {
    log("\n=== abort vs stopWhen: result.* accessibility ===");
    const ctrl = new AbortController();
    const result = streamText({
        model: MODEL,
        abortSignal: ctrl.signal,
        prompt: "Call slow_tool with seconds=10.",
        onAbort: () => log("onAbort fired"),
        tools: {
            slow_tool: tool({
                description: "sleep",
                inputSchema: z.object({ seconds: z.number() }),
                execute: async ({ seconds }, opts) =>
                    new Promise((res, rej) => {
                        const t = setTimeout(() => res({ ok: true }), seconds * 1000);
                        opts.abortSignal?.addEventListener("abort", () => {
                            clearTimeout(t);
                            rej(new Error("aborted"));
                        });
                    }),
            }),
        },
    });
    setTimeout(() => {
        log("aborting...");
        ctrl.abort();
    }, 1500);
    try {
        for await (const _ of result.textStream) {
            /* drain */
        }
    } catch (e) {
        log("textStream loop threw:", summarize(e));
    }
    // Probe each result accessor.
    for (const key of ["finishReason", "steps", "response", "totalUsage", "text"] as const) {
        try {
            const v = await (result as Record<string, unknown>)[key];
            const summary =
                key === "response"
                    ? `messages=${(v as { messages: unknown[] }).messages.length}`
                    : key === "steps"
                      ? `n=${(v as unknown[]).length}`
                      : summarize(v, 80);
            log(`  result.${key} OK:`, summary);
        } catch (e) {
            log(`  result.${key} REJECTED:`, e instanceof Error ? e.message : String(e));
        }
    }
}

async function main(): Promise<void> {
    startClock();
    try {
        await probeStopWhen();
    } catch (e) {
        log("stopWhen err:", summarize(e));
    }
    try {
        await probeAbortVsStopWhen();
    } catch (e) {
        log("abort err:", summarize(e));
    }
}

main().catch((e) => {
    console.error("FATAL", e);
    process.exit(1);
});
