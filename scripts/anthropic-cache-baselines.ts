#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ModelMessage } from "ai";
import {
    addExplicitSystemBreakpoint,
    cloneMessages,
    createAnthropicHaikuModel,
    createStableSystemPrompt,
    formatUsage,
    runTurn,
    type ScenarioResult,
} from "./anthropic-cache-lab-utils";

type ScenarioDefinition = {
    id: string;
    description: string;
    strategy: string;
    buildTurns: (prefixId: string) => Array<{
        label: string;
        messages: ModelMessage[];
        providerOptions?: Record<string, unknown>;
    }>;
};

function parseOutPath(): string {
    const outFlagIndex = process.argv.indexOf("--out");
    if (outFlagIndex >= 0 && process.argv[outFlagIndex + 1]) {
        return resolve(process.argv[outFlagIndex + 1]);
    }

    return resolve(
        process.cwd(),
        "dist",
        "anthropic-cache-baselines-report.json"
    );
}

function makeBaseMessages(prefixId: string): ModelMessage[] {
    const stableSystemPrompt = createStableSystemPrompt(prefixId);
    return [
        {
            role: "system",
            content: stableSystemPrompt,
        },
    ];
}

function scenarioDefinitions(): ScenarioDefinition[] {
    return [
        {
            id: "raw-auto-identical-repeat",
            description:
                "Top-level Anthropic automatic caching with the exact same request repeated twice, then a fresh user suffix on turn three.",
            strategy: "top-level automatic cacheControl only",
            buildTurns(prefixId) {
                const base = makeBaseMessages(prefixId);
                const first = [
                    ...base,
                    {
                        role: "user",
                        content: "Reply with EXACTLY AUTO-BASELINE-1.",
                    },
                ] satisfies ModelMessage[];
                const second = cloneMessages(first);
                const third = [
                    ...base,
                    {
                        role: "user",
                        content: "Reply with EXACTLY AUTO-BASELINE-2.",
                    },
                ] satisfies ModelMessage[];

                return [
                    {
                        label: "turn1-identical-seed",
                        messages: first,
                        providerOptions: {
                            anthropic: {
                                cacheControl: { type: "ephemeral", ttl: "5m" },
                            },
                        },
                    },
                    {
                        label: "turn2-identical-repeat",
                        messages: second,
                        providerOptions: {
                            anthropic: {
                                cacheControl: { type: "ephemeral", ttl: "5m" },
                            },
                        },
                    },
                    {
                        label: "turn3-new-user-tail",
                        messages: third,
                        providerOptions: {
                            anthropic: {
                                cacheControl: { type: "ephemeral", ttl: "5m" },
                            },
                        },
                    },
                ];
            },
        },
        {
            id: "raw-auto-changing-system-tail",
            description:
                "Top-level automatic caching with a large stable system prompt plus a changing reminder system message every turn.",
            strategy: "top-level automatic cacheControl with changing system tail",
            buildTurns(prefixId) {
                const stable = makeBaseMessages(prefixId);
                const buildMessages = (reminder: string, reply: string): ModelMessage[] => [
                    ...stable,
                    {
                        role: "system",
                        content: reminder,
                    },
                    {
                        role: "user",
                        content: `Reply with EXACTLY ${reply}.`,
                    },
                ];

                return [
                    {
                        label: "turn1-reminder-a",
                        messages: buildMessages(
                            "Reminder A: current context utilization is 68%; keep the answer short.",
                            "AUTO-DYNAMIC-1"
                        ),
                        providerOptions: {
                            anthropic: {
                                cacheControl: { type: "ephemeral", ttl: "5m" },
                            },
                        },
                    },
                    {
                        label: "turn2-reminder-b",
                        messages: buildMessages(
                            "Reminder B: current context utilization is 71%; keep the answer short.",
                            "AUTO-DYNAMIC-2"
                        ),
                        providerOptions: {
                            anthropic: {
                                cacheControl: { type: "ephemeral", ttl: "5m" },
                            },
                        },
                    },
                    {
                        label: "turn3-reminder-c",
                        messages: buildMessages(
                            "Reminder C: current context utilization is 75%; keep the answer short.",
                            "AUTO-DYNAMIC-3"
                        ),
                        providerOptions: {
                            anthropic: {
                                cacheControl: { type: "ephemeral", ttl: "5m" },
                            },
                        },
                    },
                ];
            },
        },
        {
            id: "raw-explicit-system-breakpoint",
            description:
                "Explicit Anthropic cache breakpoint on the large stable system prefix while the dynamic reminder and user tail change each turn.",
            strategy: "explicit system breakpoint only",
            buildTurns(prefixId) {
                const stable = makeBaseMessages(prefixId);
                const buildMessages = (reminder: string, reply: string): ModelMessage[] => {
                    const messages = [
                        ...stable,
                        {
                            role: "system",
                            content: reminder,
                        },
                        {
                            role: "user",
                            content: `Reply with EXACTLY ${reply}.`,
                        },
                    ] satisfies ModelMessage[];

                    return addExplicitSystemBreakpoint(messages, "1h");
                };

                return [
                    {
                        label: "turn1-reminder-a",
                        messages: buildMessages(
                            "Reminder A: current context utilization is 68%; keep the answer short.",
                            "EXPLICIT-SYSTEM-1"
                        ),
                    },
                    {
                        label: "turn2-reminder-b",
                        messages: buildMessages(
                            "Reminder B: current context utilization is 71%; keep the answer short.",
                            "EXPLICIT-SYSTEM-2"
                        ),
                    },
                    {
                        label: "turn3-reminder-c",
                        messages: buildMessages(
                            "Reminder C: current context utilization is 75%; keep the answer short.",
                            "EXPLICIT-SYSTEM-3"
                        ),
                    },
                ];
            },
        },
        {
            id: "raw-explicit-system-plus-auto",
            description:
                "Explicit stable system breakpoint combined with top-level automatic caching to see whether the stable prefix still reads while the tail keeps moving.",
            strategy: "explicit system breakpoint plus top-level automatic cacheControl",
            buildTurns(prefixId) {
                const stable = makeBaseMessages(prefixId);
                const buildMessages = (reminder: string, reply: string): ModelMessage[] => {
                    const messages = [
                        ...stable,
                        {
                            role: "system",
                            content: reminder,
                        },
                        {
                            role: "user",
                            content: `Reply with EXACTLY ${reply}.`,
                        },
                    ] satisfies ModelMessage[];

                    return addExplicitSystemBreakpoint(messages, "1h");
                };

                return [
                    {
                        label: "turn1-reminder-a",
                        messages: buildMessages(
                            "Reminder A: current context utilization is 68%; keep the answer short.",
                            "EXPLICIT-AUTO-1"
                        ),
                        providerOptions: {
                            anthropic: {
                                cacheControl: { type: "ephemeral", ttl: "5m" },
                            },
                        },
                    },
                    {
                        label: "turn2-reminder-b",
                        messages: buildMessages(
                            "Reminder B: current context utilization is 71%; keep the answer short.",
                            "EXPLICIT-AUTO-2"
                        ),
                        providerOptions: {
                            anthropic: {
                                cacheControl: { type: "ephemeral", ttl: "5m" },
                            },
                        },
                    },
                    {
                        label: "turn3-reminder-c",
                        messages: buildMessages(
                            "Reminder C: current context utilization is 75%; keep the answer short.",
                            "EXPLICIT-AUTO-3"
                        ),
                        providerOptions: {
                            anthropic: {
                                cacheControl: { type: "ephemeral", ttl: "5m" },
                            },
                        },
                    },
                ];
            },
        },
    ];
}

async function main(): Promise<void> {
    const outPath = parseOutPath();
    const model = await createAnthropicHaikuModel();
    const startedAt = new Date().toISOString();
    const scenarios: ScenarioResult[] = [];

    for (const definition of scenarioDefinitions()) {
        const prefixId = `${definition.id}-${Date.now()}`;
        const turns = definition.buildTurns(prefixId);
        const scenario: ScenarioResult = {
            id: definition.id,
            description: definition.description,
            strategy: definition.strategy,
            turns: [],
        };

        console.log(`\n[baseline] ${definition.id}`);
        console.log(`strategy: ${definition.strategy}`);

        for (let index = 0; index < turns.length; index += 1) {
            const turn = turns[index];
            const result = await runTurn({
                model,
                label: turn.label,
                turn: index + 1,
                messages: turn.messages,
                providerOptions: turn.providerOptions,
            });

            scenario.turns.push(result);
            console.log(`  turn ${result.turn} ${result.label}: ${formatUsage(result.usage)}`);
        }

        scenarios.push(scenario);
    }

    const report = {
        generatedAt: new Date().toISOString(),
        startedAt,
        model: "claude-haiku-4-5-20251001",
        scenarios,
    };

    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(report, null, 2));
    console.log(`\nSaved baseline report to ${outPath}`);
}

main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
});
