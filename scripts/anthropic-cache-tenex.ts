#!/usr/bin/env bun

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ModelMessage } from "ai";
import { prepareLLMRequest } from "@/agents/execution/request-preparation";
import {
    createExecutionContextManagement,
    type ExecutionContextManagement,
} from "@/agents/execution/context-management";
import type { AgentInstance } from "@/agents/types";
import { ConversationStore } from "@/conversations/ConversationStore";
import { getDefaultProviderOptions, mergeProviderOptions } from "@/llm/provider-options";
import { config as configService } from "@/services/ConfigService";
import type { AISdkTool } from "@/tools/types";
import {
    addExplicitSystemBreakpoint,
    createAnthropicHaikuModel,
    createLargeJsonBlob,
    createLargeToolText,
    createStableSystemPrompt,
    createStableTools,
    formatUsage,
    runTurn,
    summarizePromptShape,
    type ScenarioResult,
} from "./anthropic-cache-lab-utils";

type TenexScenarioDefinition = {
    id: string;
    description: string;
    strategy: string;
    prepareProviderOptions: (preparedProviderOptions: Record<string, unknown> | undefined) => Record<string, unknown> | undefined;
    transformMessages?: (messages: ModelMessage[]) => ModelMessage[];
};

function parseOutPath(): string {
    const outFlagIndex = process.argv.indexOf("--out");
    if (outFlagIndex >= 0 && process.argv[outFlagIndex + 1]) {
        return resolve(process.argv[outFlagIndex + 1]);
    }

    return resolve(
        process.cwd(),
        "dist",
        "anthropic-cache-tenex-report.json"
    );
}

function buildTurnMessages(prefixId: string): ModelMessage[][] {
    const system = {
        role: "system",
        content: createStableSystemPrompt(prefixId),
    } satisfies ModelMessage;

    const turn1 = [
        system,
        {
            role: "user",
            content: "Inspect the current implementation and acknowledge with TENEX-TURN-1.",
        },
        {
            role: "assistant",
            content: [
                {
                    type: "tool-call",
                    toolCallId: "call-1",
                    toolName: "fs_read",
                    input: { path: "src/agents/execution/request-preparation.ts" },
                },
            ],
        },
        {
            role: "tool",
            content: [
                {
                    type: "tool-result",
                    toolCallId: "call-1",
                    toolName: "fs_read",
                    output: {
                        type: "text",
                        value: createLargeToolText("turn1-fs-read"),
                    },
                },
            ],
        },
        {
            role: "assistant",
            content: "The file is large; I will keep only the most relevant details.",
        },
        {
            role: "user",
            content: "Reply with EXACTLY TENEX-TURN-1.",
        },
    ] satisfies ModelMessage[];

    const turn2 = [
        ...turn1,
        {
            role: "assistant",
            content: [
                {
                    type: "tool-call",
                    toolCallId: "call-2",
                    toolName: "conversation_get",
                    input: { id: "conversation-2" },
                },
            ],
        },
        {
            role: "tool",
            content: [
                {
                    type: "tool-result",
                    toolCallId: "call-2",
                    toolName: "conversation_get",
                    output: {
                        type: "json",
                        value: JSON.parse(createLargeJsonBlob("turn2-conversation")),
                    },
                },
            ],
        },
        {
            role: "assistant",
            content: "I have the conversation payload and will continue from the latest messages.",
        },
        {
            role: "user",
            content: "Reply with EXACTLY TENEX-TURN-2.",
        },
    ] satisfies ModelMessage[];

    const turn3 = [
        ...turn2,
        {
            role: "assistant",
            content: [
                {
                    type: "tool-call",
                    toolCallId: "call-3",
                    toolName: "fs_read",
                    input: { path: "src/agents/execution/context-management/runtime.ts" },
                },
            ],
        },
        {
            role: "tool",
            content: [
                {
                    type: "tool-result",
                    toolCallId: "call-3",
                    toolName: "fs_read",
                    output: {
                        type: "text",
                        value: createLargeToolText("turn3-fs-read"),
                    },
                },
            ],
        },
        {
            role: "assistant",
            content: "The newest file is loaded; continue using the freshest details.",
        },
        {
            role: "user",
            content: "Reply with EXACTLY TENEX-TURN-3.",
        },
    ] satisfies ModelMessage[];

    return [turn1, turn2, turn3];
}

async function withForcedContextSettings<T>(callback: () => Promise<T>): Promise<T> {
    const originalGetContextManagementConfig = configService.getContextManagementConfig;
    const originalGetSummarizationModelName = configService.getSummarizationModelName;

    configService.getContextManagementConfig = () => ({
        tokenBudget: 2500,
        forceScratchpadThresholdPercent: 100,
        utilizationWarningThresholdPercent: 60,
        summarizationFallbackThresholdPercent: 95,
    });
    configService.getSummarizationModelName = () => undefined;

    try {
        return await callback();
    } finally {
        configService.getContextManagementConfig = originalGetContextManagementConfig;
        configService.getSummarizationModelName = originalGetSummarizationModelName;
    }
}

async function prepareTenexMessages(params: {
    contextManagement: ExecutionContextManagement;
    messages: ModelMessage[];
    tools: Record<string, AISdkTool>;
}): Promise<{
    messages: ModelMessage[];
    providerOptions: Record<string, unknown> | undefined;
}> {
    const prepared = await prepareLLMRequest({
        messages: params.messages,
        tools: params.tools,
        providerId: "anthropic",
        model: {
            provider: "anthropic",
            modelId: "claude-haiku-4-5-20251001",
        },
        contextManagement: params.contextManagement,
        toolChoice: "none",
    });

    return {
        messages: prepared.messages,
        providerOptions: prepared.providerOptions as Record<string, unknown> | undefined,
    };
}

function definitions(): TenexScenarioDefinition[] {
    return [
        {
            id: "tenex-auto-only",
            description:
                "TENEX request preparation plus ai-sdk-context-management, using the current top-level Anthropic automatic caching only.",
            strategy: "prepareLLMRequest + context management + top-level automatic caching",
            prepareProviderOptions(preparedProviderOptions) {
                return mergeProviderOptions(
                    getDefaultProviderOptions("anthropic"),
                    preparedProviderOptions as any
                ) as Record<string, unknown> | undefined;
            },
        },
        {
            id: "tenex-explicit-system-only",
            description:
                "TENEX request preparation plus ai-sdk-context-management, but with an explicit Anthropic breakpoint on the stable system prompt only.",
            strategy: "prepareLLMRequest + context management + explicit system breakpoint",
            prepareProviderOptions(preparedProviderOptions) {
                return preparedProviderOptions;
            },
            transformMessages(messages) {
                return addExplicitSystemBreakpoint(messages, "1h");
            },
        },
        {
            id: "tenex-explicit-system-plus-auto",
            description:
                "TENEX request preparation plus ai-sdk-context-management, with both an explicit stable system breakpoint and top-level automatic caching.",
            strategy: "prepareLLMRequest + context management + explicit system breakpoint + top-level automatic caching",
            prepareProviderOptions(preparedProviderOptions) {
                return mergeProviderOptions(
                    getDefaultProviderOptions("anthropic"),
                    preparedProviderOptions as any
                ) as Record<string, unknown> | undefined;
            },
            transformMessages(messages) {
                return addExplicitSystemBreakpoint(messages, "1h");
            },
        },
    ];
}

async function main(): Promise<void> {
    const outPath = parseOutPath();
    await configService.loadConfig();
    const model = await createAnthropicHaikuModel();
    const tempRoot = await mkdtemp("/tmp/tenex-anthropic-cache-");
    const startedAt = new Date().toISOString();

    try {
        const conversationStore = new ConversationStore(tempRoot);
        conversationStore.load("cache-lab-project", "cache-lab-conversation");

        const agent = {
            name: "cache-lab",
            slug: "cache-lab",
            pubkey: "cache-lab-agent-pubkey",
        } as AgentInstance;
        const tools = createStableTools() as unknown as Record<string, AISdkTool>;
        const scenarios: ScenarioResult[] = [];

        for (const definition of definitions()) {
            const scenario: ScenarioResult = {
                id: definition.id,
                description: definition.description,
                strategy: definition.strategy,
                turns: [],
            };
            const turnMessages = buildTurnMessages(
                `${definition.id}-${Date.now()}`
            );

            console.log(`\n[tenex] ${definition.id}`);
            console.log(`strategy: ${definition.strategy}`);

            const contextManagement = await withForcedContextSettings(async () =>
                createExecutionContextManagement({
                    providerId: "anthropic",
                    conversationId: "cache-lab-conversation",
                    agent,
                    conversationStore,
                })
            );

            if (!contextManagement) {
                throw new Error("Failed to create TENEX execution context management");
            }

            for (let index = 0; index < turnMessages.length; index += 1) {
                const prepared = await withForcedContextSettings(async () =>
                    prepareTenexMessages({
                        contextManagement,
                        messages: turnMessages[index],
                        tools,
                    })
                );

                const transformedMessages = definition.transformMessages
                    ? definition.transformMessages(prepared.messages)
                    : prepared.messages;
                const providerOptions = definition.prepareProviderOptions(prepared.providerOptions);
                const result = await runTurn({
                    model,
                    label: `turn${index + 1}`,
                    turn: index + 1,
                    messages: transformedMessages,
                    providerOptions: providerOptions as any,
                });

                scenario.turns.push(result);
                console.log(
                    `  turn ${result.turn} ${result.label}: ${formatUsage(result.usage)} placeholders=${result.promptShape.placeholderMatches}`
                );
            }

            scenarios.push(scenario);
        }

        const summaryTurnMessages = buildTurnMessages(`summary-${Date.now()}`);
        const preparedSummaries = await withForcedContextSettings(async () => {
            const contextManagement = createExecutionContextManagement({
                providerId: "anthropic",
                conversationId: "cache-lab-conversation",
                agent,
                conversationStore,
            });
            if (!contextManagement) {
                throw new Error("Failed to create TENEX execution context management");
            }

            const summaries = [];
            for (const [index, messages] of summaryTurnMessages.entries()) {
                const prepared = await prepareTenexMessages({
                    contextManagement,
                    messages,
                    tools,
                });
                summaries.push({
                    turn: index + 1,
                    promptShape: summarizePromptShape(prepared.messages),
                });
            }
            return summaries;
        });

        const report = {
            generatedAt: new Date().toISOString(),
            startedAt,
            model: "claude-haiku-4-5-20251001",
            preparedPromptSummaries: preparedSummaries,
            scenarios,
        };

        await mkdir(dirname(outPath), { recursive: true });
        await writeFile(outPath, JSON.stringify(report, null, 2));
        console.log(`\nSaved TENEX report to ${outPath}`);
    } finally {
        await rm(tempRoot, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
});
