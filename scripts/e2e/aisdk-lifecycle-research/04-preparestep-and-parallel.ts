// Probe 7 + 8 + 9: prepareStep mutation power, parallel tool calls, and
// onStepFinish vs prepareStep ordering across multi-step runs.

import { streamText, tool, stepCountIs } from "ai";
import type { ModelMessage } from "ai";
import { z } from "zod";
import { MODEL, log, startClock, summarize } from "./_shared";

async function probeMultiStep(): Promise<void> {
    log("\n=== MULTI-STEP: prepareStep before each step, onStepFinish after ===");
    let injectedExtra = false;

    const result = streamText({
        model: MODEL,
        // 4 steps lets us see at least one tool call + final answer.
        stopWhen: stepCountIs(4),
        prompt: "Call get_time twice (in separate steps), then summarize.",
        prepareStep: ({ stepNumber, messages }) => {
            log(`prepareStep#${stepNumber}`, {
                msgCount: messages.length,
                lastRole: messages.at(-1)?.role,
            });
            // On step 2, inject a synthetic system message via messages[] override.
            if (stepNumber === 2 && !injectedExtra) {
                injectedExtra = true;
                const rewritten: ModelMessage[] = [
                    ...messages,
                    {
                        role: "user",
                        content:
                            "[SYSTEM INJECTION via prepareStep] Stop calling tools. Just say BYE and stop.",
                    },
                ];
                log(`  >> injecting extra user msg, returning rewritten messages (n=${rewritten.length})`);
                return { messages: rewritten };
            }
            return undefined;
        },
        onStepFinish: (s) =>
            log("onStepFinish", {
                finishReason: s.finishReason,
                toolCalls: s.toolCalls?.map((c) => c.toolName),
                text: s.text?.slice(0, 60),
            }),
        onFinish: (e) =>
            log("onFinish", { finishReason: e.finishReason, steps: e.steps.length }),
        tools: {
            get_time: tool({
                description: "Returns the current ISO time.",
                inputSchema: z.object({}),
                execute: async () => ({ now: new Date().toISOString() }),
            }),
        },
    });

    let text = "";
    for await (const d of result.textStream) text += d;
    log("final text:", text.slice(0, 200));
}

async function probeParallelTools(): Promise<void> {
    log("\n=== PARALLEL TOOL CALLS in one step ===");
    const concurrentExecutions: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;

    const result = streamText({
        model: MODEL,
        stopWhen: stepCountIs(3),
        prompt:
            "Call slow_tool three times in parallel with seconds=2 and labels A, B, C. Then say DONE.",
        onStepFinish: (s) =>
            log("onStepFinish", {
                finishReason: s.finishReason,
                toolCalls: s.toolCalls?.length,
                toolResults: s.toolResults?.length,
            }),
        experimental_onToolCallStart: ({ toolCall }) =>
            log("onToolCallStart", { name: toolCall.toolName, id: toolCall.toolCallId.slice(-8) }),
        experimental_onToolCallFinish: ({ toolCall, durationMs }) =>
            log("onToolCallFinish", {
                name: toolCall.toolName,
                id: toolCall.toolCallId.slice(-8),
                durationMs: Math.round(durationMs),
            }),
        tools: {
            slow_tool: tool({
                description: "Sleep for N seconds",
                inputSchema: z.object({ seconds: z.number(), label: z.string() }),
                execute: async ({ seconds, label }, opts) => {
                    inFlight++;
                    maxInFlight = Math.max(maxInFlight, inFlight);
                    concurrentExecutions.push(`start:${label}`);
                    log(`  tool ${label} START id=${opts.toolCallId.slice(-8)} inFlight=${inFlight}`);
                    await new Promise((r) => setTimeout(r, seconds * 1000));
                    inFlight--;
                    concurrentExecutions.push(`end:${label}`);
                    log(`  tool ${label} END inFlight=${inFlight}`);
                    return { label, done: true };
                },
            }),
        },
    });

    let text = "";
    for await (const d of result.textStream) text += d;
    log("execution order:", concurrentExecutions.join(", "));
    log("max concurrent in-flight:", maxInFlight);
    log("final text:", text.slice(0, 120));
}

async function main(): Promise<void> {
    startClock();
    try {
        await probeMultiStep();
    } catch (e) {
        log("multi-step err:", summarize(e));
    }
    try {
        await probeParallelTools();
    } catch (e) {
        log("parallel err:", summarize(e));
    }
}

main().catch((e) => {
    console.error("FATAL", e);
    process.exit(1);
});
