// Probe 5 + 6: Replay with dangling tool-call and with synthetic tool-result.
//
// Scenario:
//   Conversation has [user, assistant{tool-call: id=X}] with NO tool-result.
//   What happens when we call streamText with that history + a new user msg?
//
// Test A: dangling — no synthetic tool-result.
// Test B: synthesized — inject a placeholder tool-result before the user msg.

import { streamText, tool } from "ai";
import type { ModelMessage } from "ai";
import { z } from "zod";
import { MODEL, log, startClock, summarize } from "./_shared";

const TOOL_CALL_ID = "toolu_synthetic_001";

function buildBaseHistory(): ModelMessage[] {
    return [
        { role: "user", content: "Get the current time, then report it." },
        {
            role: "assistant",
            content: [
                {
                    type: "tool-call",
                    toolCallId: TOOL_CALL_ID,
                    toolName: "get_time",
                    input: {},
                },
            ],
        },
    ];
}

const TOOLS = {
    get_time: tool({
        description: "Returns the current ISO time.",
        inputSchema: z.object({}),
        execute: async () => ({ now: new Date().toISOString() }),
    }),
};

async function runReplay(label: string, messages: ModelMessage[]): Promise<void> {
    log(`\n--- ${label} ---`);
    log(`history (${messages.length} msgs):`, messages.map((m) => m.role).join(" -> "));
    try {
        const result = streamText({
            model: MODEL,
            messages,
            tools: TOOLS,
            onError: ({ error }) => log(`${label} onError:`, summarize(error)),
            onStepFinish: (s) =>
                log(`${label} onStepFinish:`, {
                    finishReason: s.finishReason,
                    text: s.text?.slice(0, 80),
                }),
        });
        // Drain and capture text.
        let text = "";
        for await (const delta of result.textStream) text += delta;
        log(`${label} stream finished, text=`, text.slice(0, 200));
    } catch (e) {
        log(`${label} THREW:`, e instanceof Error ? e.message : String(e));
    }
}

async function main(): Promise<void> {
    startClock();

    // Test A: dangling tool-call followed by user message.
    const dangling: ModelMessage[] = [
        ...buildBaseHistory(),
        // No tool result! Now a fresh user message.
        { role: "user", content: "Actually, just say 'hi' and stop." },
    ];

    // Test B: synthetic tool-result injected.
    const synthesized: ModelMessage[] = [
        ...buildBaseHistory(),
        {
            role: "tool",
            content: [
                {
                    type: "tool-result",
                    toolCallId: TOOL_CALL_ID,
                    toolName: "get_time",
                    output: {
                        type: "text",
                        value: "tool execution preempted, result will arrive later",
                    },
                },
            ],
        },
        { role: "user", content: "Actually, just say 'hi' and stop." },
    ];

    await runReplay("A: dangling tool-call, no result", dangling);
    await runReplay("B: synthetic tool-result", synthesized);

    // Test C: synthetic tool-result with structured (non-text) output to confirm shape requirements.
    const synthesizedJson: ModelMessage[] = [
        ...buildBaseHistory(),
        {
            role: "tool",
            content: [
                {
                    type: "tool-result",
                    toolCallId: TOOL_CALL_ID,
                    toolName: "get_time",
                    output: {
                        type: "json",
                        value: { preempted: true, note: "result will arrive later" },
                    },
                },
            ],
        },
        { role: "user", content: "Just say 'hi' and stop." },
    ];
    await runReplay("C: synthetic tool-result (json)", synthesizedJson);
}

main().catch((e) => {
    console.error("FATAL", e);
    process.exit(1);
});
