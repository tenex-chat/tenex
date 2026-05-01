// Probe: if prepareStep throws, what happens? Can it cleanly stop a stream?
// Also: can prepareStep call ctrl.abort() to halt the run after a tool finishes?

import { streamText, tool, stepCountIs } from "ai";
import { z } from "zod";
import { MODEL, log, startClock } from "./_shared";

async function probeThrow(): Promise<void> {
    log("\n=== prepareStep throws on step 1 ===");
    try {
        const result = streamText({
            model: MODEL,
            stopWhen: stepCountIs(5),
            prompt: "Call get_time, then say HI.",
            prepareStep: ({ stepNumber }) => {
                log(`prepareStep#${stepNumber}`);
                if (stepNumber === 1) {
                    throw new Error("prepareStep wants to stop");
                }
                return undefined;
            },
            onStepFinish: (s) => log("onStepFinish", { finishReason: s.finishReason }),
            onError: ({ error }) =>
                log("onError:", error instanceof Error ? error.message : String(error)),
            tools: {
                get_time: tool({
                    description: "now",
                    inputSchema: z.object({}),
                    execute: async () => ({ now: Date.now() }),
                }),
            },
        });
        let text = "";
        try {
            for await (const d of result.textStream) text += d;
        } catch (e) {
            log("textStream threw:", e instanceof Error ? e.message : String(e));
        }
        log("text=", text);
        try {
            log("finishReason=", await result.finishReason);
        } catch (e) {
            log("finishReason threw:", e instanceof Error ? e.message : String(e));
        }
    } catch (e) {
        log("outer threw:", e instanceof Error ? e.message : String(e));
    }
}

async function probeAbortInPrepare(): Promise<void> {
    log("\n=== prepareStep aborts via shared controller ===");
    const ctrl = new AbortController();
    let lastStepFinish: string | undefined;
    const result = streamText({
        model: MODEL,
        abortSignal: ctrl.signal,
        stopWhen: stepCountIs(5),
        prompt: "Call get_time, then say HI.",
        prepareStep: ({ stepNumber }) => {
            log(`prepareStep#${stepNumber}`);
            if (stepNumber === 1) {
                log("  >> calling ctrl.abort()");
                ctrl.abort();
            }
            return undefined;
        },
        onStepFinish: (s) => {
            lastStepFinish = s.finishReason;
            log("onStepFinish", {
                finishReason: s.finishReason,
                text: s.text?.slice(0, 60),
                hasToolResult: !!s.toolResults?.length,
            });
        },
        onAbort: () => log("onAbort fired"),
        onError: ({ error }) =>
            log("onError:", error instanceof Error ? error.message : String(error)),
        tools: {
            get_time: tool({
                description: "now",
                inputSchema: z.object({}),
                execute: async () => ({ now: Date.now() }),
            }),
        },
    });
    try {
        for await (const _ of result.textStream) {
            /* drain */
        }
    } catch (e) {
        log("loop threw:", e instanceof Error ? e.message : String(e));
    }
    log("lastStepFinish=", lastStepFinish);
    try {
        log("finishReason=", await result.finishReason);
    } catch (e) {
        log("finishReason threw:", e instanceof Error ? e.message : String(e));
    }
}

async function main(): Promise<void> {
    startClock();
    await probeThrow();
    await probeAbortInPrepare();
}

main().catch((e) => {
    console.error("FATAL", e);
    process.exit(1);
});
