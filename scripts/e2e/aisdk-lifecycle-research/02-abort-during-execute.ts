// Probe 3 + 4: abort during long-running tool.execute.
// - Confirms abortSignal inside execute fires when outer controller aborts.
// - Captures the FINAL shape of result.response.messages — does it contain
//   a dangling assistant tool-call without a matching tool-result?

import { streamText, tool } from "ai";
import { z } from "zod";
import { MODEL, log, startClock, summarize } from "./_shared";

async function main(): Promise<void> {
    startClock();
    const outer = new AbortController();

    let executeAbortObserved = false;
    let executeReturnedAfterAbort = false;

    const result = streamText({
        model: MODEL,
        abortSignal: outer.signal,
        prompt: "Call slow_tool with seconds=10, then say DONE.",
        onStepFinish: (step) =>
            log("onStepFinish", {
                finishReason: step.finishReason,
                toolCalls: step.toolCalls?.map((c) => c.toolName),
                toolResults: step.toolResults?.length,
            }),
        onFinish: (event) =>
            log("onFinish", {
                finishReason: event.finishReason,
                steps: event.steps.length,
                msgCount: event.response.messages.length,
            }),
        onAbort: () => log("onAbort fired"),
        onError: ({ error }) => log("onError", summarize(error)),
        tools: {
            slow_tool: tool({
                description: "Sleeps for N seconds then returns ok.",
                inputSchema: z.object({ seconds: z.number() }),
                execute: async ({ seconds }, opts) => {
                    log("tool.execute START", {
                        seconds,
                        abortAlready: opts.abortSignal?.aborted,
                    });
                    opts.abortSignal?.addEventListener("abort", () => {
                        executeAbortObserved = true;
                        log("tool: abort listener fired");
                    });
                    try {
                        await new Promise((resolve, reject) => {
                            const timer = setTimeout(resolve, seconds * 1000);
                            opts.abortSignal?.addEventListener("abort", () => {
                                clearTimeout(timer);
                                reject(new Error("aborted-by-tool"));
                            });
                        });
                        log("tool.execute END normally");
                        return { ok: true };
                    } catch (e) {
                        executeReturnedAfterAbort = true;
                        log("tool.execute threw", summarize(e));
                        throw e;
                    }
                },
            }),
        },
    });

    // Schedule abort partway through the tool execution.
    setTimeout(() => {
        log("== ABORTING outer controller ==");
        outer.abort();
    }, 1500);

    try {
        for await (const _ of result.textStream) {
            /* drain */
        }
    } catch (e) {
        log("textStream loop threw", summarize(e));
    }

    // Inspect final state.
    try {
        const responseMessages = await result.response.then((r) => r.messages);
        log("=== FINAL response.messages ===");
        log(JSON.stringify(responseMessages, null, 2));
    } catch (e) {
        log("response.messages threw:", e instanceof Error ? e.message : String(e));
    }
    try {
        const steps = await result.steps;
        log(`=== result.steps (${steps.length}) ===`);
        for (let i = 0; i < steps.length; i++) {
            const s = steps[i];
            log(`step[${i}] finishReason=${s.finishReason} toolCalls=${s.toolCalls?.length} toolResults=${s.toolResults?.length}`);
            log(`step[${i}].response.messages=`, JSON.stringify(s.response?.messages, null, 2));
        }
    } catch (e) {
        log("result.steps threw:", e instanceof Error ? e.message : String(e));
    }
    try {
        const finishReason = await result.finishReason;
        log("finishReason:", finishReason);
    } catch (e) {
        log("finishReason threw:", e instanceof Error ? e.message : String(e));
    }

    log("== summary ==", { executeAbortObserved, executeReturnedAfterAbort });
}

main().catch((e) => {
    console.error("FATAL", e);
    process.exit(1);
});
