#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ModelMessage } from "ai";
import {
    AnthropicPromptCachingStrategy,
    ToolResultDecayStrategy,
    createContextManagementRuntime,
    createDefaultPromptTokenEstimator,
} from "ai-sdk-context-management";
import type { SharedV3ProviderOptions as ProviderOptions } from "@ai-sdk/provider";
import {
    addExplicitBreakpointAtIndex,
    addExplicitSystemBreakpoint,
    createAnthropicHaikuModel,
    formatUsage,
    runTurn,
    summarizePromptShape,
    type ScenarioResult,
} from "./anthropic-cache-lab-utils";
import { buildDecayPlaceholder } from "@/agents/execution/context-management/budget-profile";

const DEFAULT_JAEGER_URL = "http://23.88.91.234:16686";
const MODEL_ID = "claude-haiku-4-5-20251001";

type TraceReplaySource = {
    name: string;
    traceId: string;
    spanIndices: number[];
    description: string;
};

type TraceReplayScenario = {
    id: string;
    description: string;
    prepareMessages?: (messages: ModelMessage[]) => Promise<ModelMessage[]> | ModelMessage[];
    providerOptions?: ProviderOptions;
    attachSharedPrefixBreakpoint?: boolean;
};

type TraceReplayTurn = {
    turn: number;
    sourceIndex: number;
    sourceSpanId: string;
    sourceInputTokens: number;
    promptShape: ReturnType<typeof summarizePromptShape>;
    usage: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
        noCacheInputTokens: number;
        cacheReadInputTokens: number;
        cacheWriteInputTokens: number;
    };
    finishReason?: string;
    anthropicContextManagement?: unknown;
};

type TraceReplayResult = {
    generatedAt: string;
    model: string;
    sources: Array<{
        name: string;
        traceId: string;
        description: string;
    }>;
    scenarios: Array<
        ScenarioResult & {
            sourceName: string;
            sourceTraceId: string;
            replayTurns: TraceReplayTurn[];
        }
    >;
};

type JaegerSpan = {
    spanID: string;
    operationName: string;
    startTime: number;
    tags?: Array<{ key: string; value?: unknown }>;
};

function parseOutPath(): string {
    const outFlagIndex = process.argv.indexOf("--out");
    if (outFlagIndex >= 0 && process.argv[outFlagIndex + 1]) {
        return resolve(process.argv[outFlagIndex + 1]);
    }

    return resolve(
        process.cwd(),
        "dist",
        "anthropic-cache-trace-replay-report.json"
    );
}

function getTagMap(span: JaegerSpan): Record<string, unknown> {
    return Object.fromEntries((span.tags ?? []).map((tag) => [tag.key, tag.value]));
}

async function fetchTrace(traceId: string): Promise<JaegerSpan[]> {
    const response = await fetch(`${DEFAULT_JAEGER_URL}/api/traces/${traceId}`);
    if (!response.ok) {
        throw new Error(`Failed to fetch trace ${traceId}: ${response.status} ${response.statusText}`);
    }

    const payload = await response.json() as {
        data?: Array<{
            spans?: JaegerSpan[];
        }>;
    };
    const trace = payload.data?.[0];
    if (!trace?.spans) {
        throw new Error(`Trace ${traceId} did not contain spans`);
    }

    return trace.spans
        .filter((span) => span.operationName === "ai.streamText.doStream")
        .sort((a, b) => a.startTime - b.startTime);
}

function parsePromptMessages(span: JaegerSpan): ModelMessage[] {
    const tagMap = getTagMap(span);
    const promptRaw = tagMap["ai.prompt.messages"];
    if (typeof promptRaw !== "string") {
        throw new Error(`Span ${span.spanID} did not include ai.prompt.messages`);
    }

    return JSON.parse(promptRaw) as ModelMessage[];
}

function parseInputTokens(span: JaegerSpan): number {
    const tagMap = getTagMap(span);
    const raw =
        tagMap["ai.usage.inputTokens"]
        ?? tagMap["ai.usage.promptTokens"]
        ?? tagMap["gen_ai.usage.input_tokens"];

    return typeof raw === "number"
        ? raw
        : typeof raw === "string"
            ? Number.parseInt(raw, 10) || 0
            : 0;
}

function addScenarioNamespace(messages: ModelMessage[], namespace: string): ModelMessage[] {
    const cloned = structuredClone(messages) as ModelMessage[];
    const systemIndex = cloned.findIndex((message) => message.role === "system");

    if (systemIndex === -1) {
        return cloned;
    }

    const target = cloned[systemIndex];
    if (typeof target.content === "string") {
        target.content = `[cache-replay-namespace:${namespace}]\n${target.content}`;
        return cloned;
    }

    if (Array.isArray(target.content)) {
        target.content = [
            {
                type: "text",
                text: `[cache-replay-namespace:${namespace}]`,
            },
            ...target.content,
        ] as typeof target.content;
    }

    return cloned;
}

function findSharedPrefixBreakpointIndex(messageSets: ModelMessage[][]): number | null {
    if (messageSets.length === 0) {
        return null;
    }

    const shortestLength = Math.min(...messageSets.map((messages) => messages.length));
    let commonLength = 0;

    for (let index = 0; index < shortestLength; index += 1) {
        const serialized = JSON.stringify(messageSets[0]?.[index]);
        const identical = messageSets.every(
            (messages) => JSON.stringify(messages[index]) === serialized
        );
        if (!identical) {
            break;
        }
        commonLength = index + 1;
    }

    return commonLength > 0 ? commonLength - 1 : null;
}

async function applyClientToolDecay(messages: ModelMessage[]): Promise<ModelMessage[]> {
    const estimator = createDefaultPromptTokenEstimator();
    const runtime = createContextManagementRuntime({
        strategies: [
            new ToolResultDecayStrategy({
                estimator,
                placeholder: ({ toolName, toolCallId }) =>
                    buildDecayPlaceholder(toolName, toolCallId),
            }),
            new AnthropicPromptCachingStrategy(),
        ],
        estimator,
    });

    const prepared = await runtime.prepareRequest({
        requestContext: {
            conversationId: "trace-replay",
            agentId: "trace-replay-agent",
            agentLabel: "trace-replay-agent",
        },
        messages,
        model: {
            provider: "anthropic",
            modelId: MODEL_ID,
        },
        toolChoice: "none",
        tools: {},
    });

    return prepared.messages as ModelMessage[];
}

function scenarioDefinitions(): TraceReplayScenario[] {
    const clearToolUsesProviderOptions: ProviderOptions = {
        anthropic: {
            contextManagement: {
                edits: [
                    {
                        type: "clear_tool_uses_20250919",
                        trigger: { type: "input_tokens", value: 16000 },
                        keep: { type: "tool_uses", value: 1 },
                        clearAtLeast: { type: "input_tokens", value: 4000 },
                    },
                ],
            },
        },
    };

    return [
        {
            id: "raw-auto-only",
            description: "Exact trace prompt with top-level automatic caching only.",
            providerOptions: {
                anthropic: {
                    cacheControl: { type: "ephemeral", ttl: "5m" },
                },
            },
        },
        {
            id: "raw-explicit-system",
            description: "Exact trace prompt with an explicit system breakpoint only.",
            prepareMessages: (messages) => addExplicitSystemBreakpoint(messages, "1h"),
        },
        {
            id: "raw-explicit-system-plus-auto",
            description: "Exact trace prompt with an explicit system breakpoint plus top-level automatic caching.",
            prepareMessages: (messages) => addExplicitSystemBreakpoint(messages, "1h"),
            providerOptions: {
                anthropic: {
                    cacheControl: { type: "ephemeral", ttl: "5m" },
                },
            },
        },
        {
            id: "raw-explicit-system-plus-clear-tool-uses",
            description: "Exact trace prompt with explicit system breakpoint and Anthropic native clear_tool_uses.",
            prepareMessages: (messages) => addExplicitSystemBreakpoint(messages, "1h"),
            providerOptions: clearToolUsesProviderOptions,
        },
        {
            id: "raw-explicit-system-auto-clear-tool-uses",
            description: "Exact trace prompt with explicit system breakpoint, top-level automatic caching, and Anthropic native clear_tool_uses.",
            prepareMessages: (messages) => addExplicitSystemBreakpoint(messages, "1h"),
            providerOptions: {
                anthropic: {
                    cacheControl: { type: "ephemeral", ttl: "5m" },
                    contextManagement: clearToolUsesProviderOptions.anthropic?.contextManagement,
                },
            },
        },
        {
            id: "raw-shared-prefix-breakpoint",
            description: "Exact trace prompt with an explicit breakpoint on the last shared prefix message across all replayed turns.",
            attachSharedPrefixBreakpoint: true,
        },
        {
            id: "raw-shared-prefix-plus-auto",
            description: "Exact trace prompt with a shared-prefix breakpoint plus top-level automatic caching.",
            attachSharedPrefixBreakpoint: true,
            providerOptions: {
                anthropic: {
                    cacheControl: { type: "ephemeral", ttl: "5m" },
                },
            },
        },
        {
            id: "raw-shared-prefix-auto-clear-tool-uses",
            description: "Exact trace prompt with a shared-prefix breakpoint, top-level automatic caching, and Anthropic native clear_tool_uses.",
            attachSharedPrefixBreakpoint: true,
            providerOptions: {
                anthropic: {
                    cacheControl: { type: "ephemeral", ttl: "5m" },
                    contextManagement: clearToolUsesProviderOptions.anthropic?.contextManagement,
                },
            },
        },
        {
            id: "client-tool-decay-plus-auto",
            description: "Exact trace prompt after client-side ai-sdk-context-management ToolResultDecayStrategy, with top-level automatic caching.",
            prepareMessages: applyClientToolDecay,
            providerOptions: {
                anthropic: {
                    cacheControl: { type: "ephemeral", ttl: "5m" },
                },
            },
        },
        {
            id: "client-tool-decay-plus-explicit-system",
            description: "Exact trace prompt after client-side ai-sdk-context-management ToolResultDecayStrategy, plus explicit system breakpoint.",
            prepareMessages: async (messages) =>
                addExplicitSystemBreakpoint(await applyClientToolDecay(messages), "1h"),
        },
        {
            id: "client-tool-decay-plus-shared-prefix",
            description: "Exact trace prompt after client-side ToolResultDecayStrategy, plus a breakpoint on the last shared prefix message.",
            prepareMessages: applyClientToolDecay,
            attachSharedPrefixBreakpoint: true,
        },
    ];
}

function sources(): TraceReplaySource[] {
    return [
        {
            name: "human-replica-heavy",
            traceId: "5fe9471dfa2fd3cb5200000000000000",
            spanIndices: [1, 2, 3, 4],
            description:
                "Validated human-replica trace containing a large conversation_get tool-result payload and successive real Anthropic prompts.",
        },
        {
            name: "claude-code-growth",
            traceId: "3ebff00a9a0ef5ee8200000000000000",
            spanIndices: [149, 150, 151, 152],
            description:
                "Validated claude-code trace during long prompt growth, using four successive real Anthropic prompts from the heavy sequence.",
        },
    ];
}

async function main(): Promise<void> {
    const outPath = parseOutPath();
    const model = await createAnthropicHaikuModel();
    const runNamespace = Date.now().toString(36);
    const report: TraceReplayResult = {
        generatedAt: new Date().toISOString(),
        model: MODEL_ID,
        sources: sources().map((source) => ({
            name: source.name,
            traceId: source.traceId,
            description: source.description,
        })),
        scenarios: [],
    };

    for (const source of sources()) {
        const spans = await fetchTrace(source.traceId);
        const selected = source.spanIndices.map((index) => {
            const span = spans[index];
            if (!span) {
                throw new Error(
                    `Trace ${source.traceId} missing span index ${index} for ${source.name}`
                );
            }
            return span;
        });

        const promptSequence = selected.map((span, idx) => ({
            sourceIndex: source.spanIndices[idx],
            sourceSpanId: span.spanID,
            sourceInputTokens: parseInputTokens(span),
            messages: parsePromptMessages(span),
        }));

        for (const scenario of scenarioDefinitions()) {
            console.log(`\n[trace-replay] ${source.name} :: ${scenario.id}`);
            const replayTurns: TraceReplayTurn[] = [];
            const scenarioResult: ScenarioResult & {
                sourceName: string;
                sourceTraceId: string;
                replayTurns: TraceReplayTurn[];
            } = {
                id: scenario.id,
                description: scenario.description,
                strategy: scenario.description,
                sourceName: source.name,
                sourceTraceId: source.traceId,
                turns: [],
                replayTurns,
            };

            const namespacedSequence = promptSequence.map((sourcePrompt) =>
                addScenarioNamespace(
                    sourcePrompt.messages,
                    `${runNamespace}-${source.name}-${scenario.id}`
                )
            );
            let transformedSequence = await Promise.all(
                namespacedSequence.map(async (messages) =>
                    scenario.prepareMessages
                        ? await scenario.prepareMessages(messages)
                        : messages
                )
            );
            if (scenario.attachSharedPrefixBreakpoint) {
                const breakpointIndex = findSharedPrefixBreakpointIndex(transformedSequence);
                if (breakpointIndex === null) {
                    throw new Error(
                        `No shared prefix breakpoint available for ${source.name} :: ${scenario.id}`
                    );
                }
                transformedSequence = transformedSequence.map((messages) =>
                    addExplicitBreakpointAtIndex(messages, breakpointIndex, "1h")
                );
            }

            for (let turnIndex = 0; turnIndex < promptSequence.length; turnIndex += 1) {
                const sourcePrompt = promptSequence[turnIndex];
                const transformedMessages = transformedSequence[turnIndex] ?? [];
                const result = await runTurn({
                    model,
                    label: `turn${turnIndex + 1}`,
                    turn: turnIndex + 1,
                    messages: transformedMessages,
                    providerOptions: scenario.providerOptions,
                });

                replayTurns.push({
                    turn: result.turn,
                    sourceIndex: sourcePrompt.sourceIndex,
                    sourceSpanId: sourcePrompt.sourceSpanId,
                    sourceInputTokens: sourcePrompt.sourceInputTokens,
                    promptShape: result.promptShape,
                    usage: result.usage,
                    finishReason: result.finishReason,
                    anthropicContextManagement:
                        result.providerMetadata?.anthropic
                        && typeof result.providerMetadata.anthropic === "object"
                        && result.providerMetadata.anthropic !== null
                        && "contextManagement" in result.providerMetadata.anthropic
                            ? (result.providerMetadata.anthropic as Record<string, unknown>).contextManagement
                            : undefined,
                });

                scenarioResult.turns.push(result);
                console.log(
                    `  turn ${result.turn} source_idx=${sourcePrompt.sourceIndex} span=${sourcePrompt.sourceSpanId} source_input=${sourcePrompt.sourceInputTokens} replay=${formatUsage(result.usage)} placeholders=${result.promptShape.placeholderMatches}`
                );
            }

            report.scenarios.push(scenarioResult);
        }
    }

    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(report, null, 2));
    console.log(`\nSaved trace replay report to ${outPath}`);
}

main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
});
