// Probe 1 + 2 + 3: full lifecycle hook order around a tool call.
// - Captures relative timing of every callback streamText exposes.
// - Verifies onToolCallStart fires BEFORE tool.execute is invoked.
// - Verifies that opts inside execute carries toolCallId, messages, abortSignal.
// - Checks whether abortSignal is the SAME instance as the outer controller.signal.

import { streamText, tool } from "ai";
import { z } from "zod";
import { MODEL, log, startClock, summarize } from "./_shared";

async function main(): Promise<void> {
    startClock();

    const outer = new AbortController();

    let executeAbortSignalRef: AbortSignal | undefined;

    const result = streamText({
        model: MODEL,
        abortSignal: outer.signal,
        prompt: "Call the get_time tool exactly once, then respond with the word DONE.",
        prepareStep: ({ stepNumber, messages }) => {
            log("prepareStep", { stepNumber, msgCount: messages.length });
            return undefined;
        },
        onChunk: ({ chunk }) => {
            // Only log structural events, skip text-delta noise.
            if (chunk.type !== "text-delta" && chunk.type !== "reasoning-delta") {
                log(`onChunk:${chunk.type}`, summarize(chunk));
            }
        },
        onStepFinish: (step) => {
            log("onStepFinish", {
                finishReason: step.finishReason,
                toolCalls: step.toolCalls?.map((c) => c.toolName),
                msgCount: step.response?.messages?.length,
            });
        },
        onFinish: (event) => {
            log("onFinish", {
                finishReason: event.finishReason,
                steps: event.steps.length,
                totalMessages: event.response.messages.length,
            });
        },
        onError: ({ error }) => log("onError", summarize(error)),
        // EXPERIMENTAL hooks (AI SDK v6).
        experimental_onStart: () => log("experimental_onStart"),
        experimental_onStepStart: ({ stepNumber }) =>
            log("experimental_onStepStart", { stepNumber }),
        experimental_onToolCallStart: ({ toolCall }) =>
            log("experimental_onToolCallStart", {
                name: toolCall.toolName,
                id: toolCall.toolCallId,
            }),
        experimental_onToolCallFinish: ({ toolCall, success, durationMs }) =>
            log("experimental_onToolCallFinish", {
                name: toolCall.toolName,
                success,
                durationMs,
            }),
        tools: {
            get_time: tool({
                description: "Returns the current ISO time.",
                inputSchema: z.object({}),
                onInputStart: (opts) =>
                    log("tool.onInputStart", { id: opts.toolCallId }),
                onInputDelta: () => {
                    /* noisy, skip */
                },
                onInputAvailable: (opts) =>
                    log("tool.onInputAvailable", { id: opts.toolCallId }),
                execute: async (_input, opts) => {
                    executeAbortSignalRef = opts.abortSignal;
                    log("tool.execute START", {
                        toolCallId: opts.toolCallId,
                        msgCount: opts.messages.length,
                        abortSignalIsSame: opts.abortSignal === outer.signal,
                        abortSignalAborted: opts.abortSignal?.aborted,
                    });
                    await new Promise((r) => setTimeout(r, 200));
                    log("tool.execute END");
                    return { now: new Date().toISOString() };
                },
            }),
        },
    });

    // Drain the stream so callbacks fire.
    for await (const _ of result.textStream) {
        /* drain */
    }

    log("== final ==", {
        executeAbortSignalCaptured: !!executeAbortSignalRef,
        executeAbortSignalIsOuter: executeAbortSignalRef === outer.signal,
    });
}

main().catch((e) => {
    console.error("FATAL", e);
    process.exit(1);
});
