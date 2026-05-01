// Probe end-to-end: simulates the proposed lock-handoff design.
//
// Timeline:
//   t=0:  RAL#1 starts streamText. LLM emits tool-call(slow_tool, 4s).
//   t~1:  slow_tool.execute begins. RAL#1 "releases the lock".
//   t=2:  A new user message arrives. RAL#2 fires its own streamText with
//         a rewritten history: [..., assistant{tool-call X}, tool{synthetic
//         tool-result for X}, user{new msg}]. RAL#2 "holds the lock".
//   t=4:  RAL#1's slow_tool.execute returns. RAL#1 sees the lock is held by
//         RAL#2. Strategy under test: throw inside execute to short-circuit
//         RAL#1's stream, while writing the real result into a shared store
//         (so RAL#2 can pick it up via prepareStep on its NEXT step).

import { streamText, tool, stepCountIs } from "ai";
import type { ModelMessage } from "ai";
import { z } from "zod";
import { MODEL, log, startClock } from "./_shared";

type Store = {
    messages: ModelMessage[];
    activeRal: number;
    /** Real tool results that arrived AFTER the synthetic placeholder. */
    lateToolResults: Map<string, unknown>;
    /** RAL#1 publishes its in-flight tool call id here. */
    ral1ToolCallId?: string;
};

const store: Store = {
    messages: [
        { role: "user", content: "Use slow_tool with seconds=4 then say 'first done'." },
    ],
    activeRal: 1,
    lateToolResults: new Map(),
};

async function runRAL1(): Promise<void> {
    const id = 1;
    log(`RAL#${id} START`);

    try {
        const result = streamText({
            model: MODEL,
            messages: [...store.messages],
            // Stop when preempted OR after reasonable budget.
            stopWhen: [
                stepCountIs(3),
                ({ steps }) => {
                    if (store.activeRal !== id) {
                        log(`  RAL#${id} stopWhen: preempted (active=${store.activeRal}), stopping after step ${steps.length}`);
                        return true;
                    }
                    return false;
                },
            ],
            onStepFinish: (s) =>
                log(`  RAL#${id} onStepFinish finishReason=${s.finishReason} text="${s.text?.slice(0, 40)}" tools=${s.toolCalls?.length}`),
            onError: ({ error }) =>
                log(`  RAL#${id} onError:`, error instanceof Error ? error.message : String(error)),
            tools: {
                slow_tool: tool({
                    description: "sleep N seconds",
                    inputSchema: z.object({ seconds: z.number() }),
                    execute: async ({ seconds }, opts) => {
                        store.ral1ToolCallId = opts.toolCallId;
                        log(`  RAL#${id} slow_tool START id=${opts.toolCallId.slice(-8)} (lock RELEASED)`);

                        await new Promise((r) => setTimeout(r, seconds * 1000));

                        // Always return the real result. If preempted, also stash it
                        // for RAL#2 to pick up. The stop happens via stopWhen below.
                        const realResult = { ok: true, label: "real" };
                        if (store.activeRal !== id) {
                            store.lateToolResults.set(opts.toolCallId, realResult);
                            log(`  RAL#${id} preempted (active=${store.activeRal}); returning result + will stop via stopWhen`);
                        }
                        return realResult;
                    },
                }),
            },
        });
        let text = "";
        try {
            for await (const d of result.textStream) text += d;
        } catch (e) {
            log(`  RAL#${id} textStream loop threw:`, e instanceof Error ? e.message : String(e));
        }
        log(`RAL#${id} END text=${text.slice(0, 80)}`);
        // Probe what result.* yields after a thrown execute.
        try {
            const fr = await result.finishReason;
            log(`  RAL#${id} finishReason=${fr}`);
        } catch (e) {
            log(`  RAL#${id} finishReason threw:`, e instanceof Error ? e.message : String(e));
        }
        try {
            const steps = await result.steps;
            log(`  RAL#${id} steps=${steps.length}`);
        } catch (e) {
            log(`  RAL#${id} steps threw:`, e instanceof Error ? e.message : String(e));
        }
        try {
            const resp = await result.response;
            log(`  RAL#${id} response.messages roles=`, resp.messages.map((m) => m.role).join(","));
            log(`  RAL#${id} response.messages JSON=`, JSON.stringify(resp.messages, null, 2));
        } catch (e) {
            log(`  RAL#${id} response threw:`, e instanceof Error ? e.message : String(e));
        }
    } catch (e) {
        log(`RAL#${id} OUTER threw:`, e instanceof Error ? e.message : String(e));
    }
}

async function runRAL2(originalToolCallId: string): Promise<void> {
    const id = 2;
    store.activeRal = id;
    log(`RAL#${id} START (taking lock; original tool id=${originalToolCallId.slice(-8)})`);

    let prepareCalls = 0;
    const extended: ModelMessage[] = [
        ...store.messages,
        {
            role: "assistant",
            content: [
                {
                    type: "tool-call",
                    toolCallId: originalToolCallId,
                    toolName: "slow_tool",
                    input: { seconds: 4 },
                },
            ],
        },
        {
            role: "tool",
            content: [
                {
                    type: "tool-result",
                    toolCallId: originalToolCallId,
                    toolName: "slow_tool",
                    output: {
                        type: "json",
                        value: { preempted: true, note: "result will arrive later" },
                    },
                },
            ],
        },
        { role: "user", content: "Forget that. Reply with exactly: 'second answer'." },
    ];

    const result = streamText({
        model: MODEL,
        messages: extended,
        prepareStep: ({ stepNumber, messages }) => {
            prepareCalls++;
            log(`  RAL#${id} prepareStep#${stepNumber} (msgCount=${messages.length}, lateResults=${store.lateToolResults.size})`);
            // If a late result arrived, splice it in (replacing the synthetic).
            // For this probe we just log; in real impl, we'd rewrite the synthetic
            // tool-result with the real value and prepend a system note.
            return undefined;
        },
        onStepFinish: (s) =>
            log(`  RAL#${id} onStepFinish finishReason=${s.finishReason}`),
        tools: {
            slow_tool: tool({
                description: "sleep",
                inputSchema: z.object({ seconds: z.number() }),
                execute: async () => ({ ok: true }),
            }),
        },
    });
    let text = "";
    for await (const d of result.textStream) text += d;
    log(`RAL#${id} END text="${text.slice(0, 200)}" prepareCalls=${prepareCalls}`);
}

async function main(): Promise<void> {
    startClock();

    // Start RAL#1.
    const ral1 = runRAL1();

    // Wait until RAL#1 has captured its tool-call id (i.e., execute has started).
    while (!store.ral1ToolCallId) {
        await new Promise((r) => setTimeout(r, 50));
    }
    log("== RAL#1 tool-call captured; firing RAL#2 ==");

    // Fire RAL#2 immediately.
    const ral2 = runRAL2(store.ral1ToolCallId);

    await Promise.all([ral1, ral2]);

    log("== final ==", {
        activeRal: store.activeRal,
        lateToolResults: Array.from(store.lateToolResults.entries()).map(
            ([k, v]) => `${k.slice(-8)}=${JSON.stringify(v)}`,
        ),
    });
}

main().catch((e) => {
    console.error("FATAL", e);
    process.exit(1);
});
