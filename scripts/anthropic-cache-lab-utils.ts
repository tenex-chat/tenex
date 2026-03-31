#!/usr/bin/env bun

import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText, tool, type ModelMessage } from "ai";
import type { LanguageModelV3, SharedV3ProviderOptions as ProviderOptions } from "@ai-sdk/provider";
import { z } from "zod";
import { config as configService } from "@/services/ConfigService";

const DEFAULT_MODEL_ID = "claude-haiku-4-5-20251001";
const OAUTH_BETAS = [
    "claude-code-20250219",
    "oauth-2025-04-20",
    "fine-grained-tool-streaming-2025-05-14",
] as const;
const OAUTH_SYSTEM_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude.";

type FetchWithPreconnect = typeof globalThis.fetch & {
    preconnect?: (url: string | URL, options?: Record<string, unknown>) => unknown;
};

export type CacheUsageSnapshot = {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    noCacheInputTokens: number;
    cacheReadInputTokens: number;
    cacheWriteInputTokens: number;
};

export type PromptShapeSummary = {
    systemMessages: number;
    userMessages: number;
    assistantMessages: number;
    toolMessages: number;
    placeholderMatches: number;
    totalMessages: number;
};

export type TurnResult = {
    turn: number;
    label: string;
    usage: CacheUsageSnapshot;
    finishReason?: string;
    text: string;
    promptShape: PromptShapeSummary;
    providerMetadata?: Record<string, unknown>;
};

export type ScenarioResult = {
    id: string;
    description: string;
    strategy: string;
    turns: TurnResult[];
};

function isOAuthToken(key: string): boolean {
    return key.startsWith("sk-ant-oat");
}

const oauthFetch = (async (
    ...[url, init]: Parameters<typeof globalThis.fetch>
): Promise<Response> => {
    if (init?.body && typeof init.body === "string") {
        try {
            const body = JSON.parse(init.body) as Record<string, unknown>;
            const existing = body.system;
            if (typeof existing === "string" && existing.length > 0) {
                body.system = [
                    { type: "text", text: OAUTH_SYSTEM_PROMPT },
                    { type: "text", text: existing },
                ];
            } else if (Array.isArray(existing)) {
                body.system = [{ type: "text", text: OAUTH_SYSTEM_PROMPT }, ...existing];
            } else {
                body.system = [{ type: "text", text: OAUTH_SYSTEM_PROMPT }];
            }
            init = { ...init, body: JSON.stringify(body) };
        } catch {
            // leave non-JSON bodies untouched
        }
    }

    return globalThis.fetch(url, init);
}) as FetchWithPreconnect;

oauthFetch.preconnect = (globalThis.fetch as FetchWithPreconnect).preconnect;

export async function createAnthropicHaikuModel(): Promise<LanguageModelV3> {
    const loaded = await configService.loadConfig();
    const provider = loaded.providers.providers.anthropic;

    if (!provider) {
        throw new Error("No Anthropic provider credentials found in ~/.tenex/providers.json");
    }

    const apiKey = Array.isArray(provider.apiKey) ? provider.apiKey[0] : provider.apiKey;
    if (!apiKey) {
        throw new Error("Anthropic provider credentials are empty");
    }

    const anthropic = isOAuthToken(apiKey)
        ? createAnthropic({
              authToken: apiKey,
              baseURL: provider.baseUrl,
              headers: {
                  "anthropic-beta": OAUTH_BETAS.join(","),
                  "anthropic-dangerous-direct-browser-access": "true",
                  "x-app": "cli",
              },
              fetch: oauthFetch,
          })
        : createAnthropic({
              apiKey,
              baseURL: provider.baseUrl,
          });

    return anthropic(DEFAULT_MODEL_ID) as LanguageModelV3;
}

export function createStableSystemPrompt(prefixId: string, targetParagraphs = 220): string {
    const paragraph =
        [
            `Prefix ${prefixId}: Follow TENEX operating policy exactly.`,
            "Preserve file references, keep answers concise, and reason explicitly about tool outputs.",
            "When prior tool results are summarized or replaced, rely on the preserved stable prefix and the newest dynamic tail.",
            "Treat this block as the long-lived instruction prefix for caching experiments.",
        ].join(" ");

    return Array.from({ length: targetParagraphs }, (_, index) =>
        `Section ${index + 1}: ${paragraph}`
    ).join("\n");
}

export function createLargeToolText(label: string, repeat = 260): string {
    const line =
        `// ${label}: export const value = "${label}" :: repeatable synthetic tool result for Anthropic cache experiments.`;
    return Array.from({ length: repeat }, (_, index) => `${line} line_${index + 1}`).join("\n");
}

export function createLargeJsonBlob(label: string, entries = 180): string {
    const payload = {
        label,
        conversation: {
            id: `${label}-conversation`,
            messageCount: entries * 2,
            items: Array.from({ length: entries }, (_, index) => ({
                id: `${label}-item-${index + 1}`,
                author: index % 2 === 0 ? "user" : "assistant",
                summary: `Synthetic conversation payload ${label} item ${index + 1}`,
                body: `Body for ${label} item ${index + 1}. This is intentionally verbose to exercise prompt caching behavior.`,
            })),
        },
    };

    return JSON.stringify(payload, null, 2);
}

export function createStableTools() {
    return {
        fs_read: tool({
            description: "Read a file by id from a stable synthetic fixture set.",
            inputSchema: z.object({
                path: z.string(),
            }),
            execute: async ({ path }: { path: string }) => ({
                path,
                content: "This tool should never execute in the cache lab.",
            }),
        }),
        conversation_get: tool({
            description: "Fetch a conversation payload by id from a stable synthetic fixture set.",
            inputSchema: z.object({
                id: z.string(),
            }),
            execute: async ({ id }: { id: string }) => ({
                id,
                content: "This tool should never execute in the cache lab.",
            }),
        }),
    };
}

function getNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function extractAnthropicUsage(result: unknown): CacheUsageSnapshot {
    const value = result as {
        totalUsage?: {
            inputTokens?: number;
            outputTokens?: number;
            totalTokens?: number;
            inputTokenDetails?: Record<string, unknown>;
        };
        providerMetadata?: Record<string, unknown>;
    };

    const totalUsage = value.totalUsage ?? {};
    const inputDetails = totalUsage.inputTokenDetails ?? {};
    const anthropicMetadata = (value.providerMetadata?.anthropic ?? {}) as Record<string, unknown>;
    const rawUsage = (anthropicMetadata.usage ?? {}) as Record<string, unknown>;

    const cacheWriteInputTokens =
        getNumber(rawUsage.cache_creation_input_tokens)
        ?? getNumber(anthropicMetadata.cacheCreationInputTokens)
        ?? getNumber(inputDetails.cacheWriteTokens)
        ?? 0;
    const cacheReadInputTokens =
        getNumber(rawUsage.cache_read_input_tokens)
        ?? getNumber(inputDetails.cacheReadTokens)
        ?? 0;
    const noCacheInputTokens =
        getNumber(rawUsage.input_tokens)
        ?? getNumber(inputDetails.noCacheTokens)
        ?? Math.max(
            0,
            (getNumber(totalUsage.inputTokens) ?? 0)
                - cacheWriteInputTokens
                - cacheReadInputTokens
        );
    const outputTokens =
        getNumber(rawUsage.output_tokens)
        ?? getNumber(totalUsage.outputTokens)
        ?? 0;
    const inputTokens =
        getNumber(totalUsage.inputTokens)
        ?? (noCacheInputTokens + cacheWriteInputTokens + cacheReadInputTokens);
    const totalTokens =
        getNumber(totalUsage.totalTokens)
        ?? inputTokens + outputTokens;

    return {
        inputTokens,
        outputTokens,
        totalTokens,
        noCacheInputTokens,
        cacheReadInputTokens,
        cacheWriteInputTokens,
    };
}

function countPlaceholderMatches(messages: ModelMessage[]): number {
    const haystack = JSON.stringify(messages);
    return (haystack.match(/was used, id:/g) ?? []).length;
}

export function summarizePromptShape(messages: ModelMessage[]): PromptShapeSummary {
    let systemMessages = 0;
    let userMessages = 0;
    let assistantMessages = 0;
    let toolMessages = 0;

    for (const message of messages) {
        switch (message.role) {
            case "system":
                systemMessages += 1;
                break;
            case "user":
                userMessages += 1;
                break;
            case "assistant":
                assistantMessages += 1;
                break;
            case "tool":
                toolMessages += 1;
                break;
        }
    }

    return {
        systemMessages,
        userMessages,
        assistantMessages,
        toolMessages,
        placeholderMatches: countPlaceholderMatches(messages),
        totalMessages: messages.length,
    };
}

export function cloneMessages(messages: ModelMessage[]): ModelMessage[] {
    return structuredClone(messages);
}

export function addExplicitSystemBreakpoint(
    messages: ModelMessage[],
    ttl: "5m" | "1h" = "1h"
): ModelMessage[] {
    const cloned = cloneMessages(messages);
    const systemIndex = cloned.findIndex((message) => message.role === "system");

    if (systemIndex === -1) {
        throw new Error("Cannot add explicit system breakpoint: no system message found");
    }

    const systemMessage = cloned[systemIndex] as ModelMessage & {
        providerOptions?: ProviderOptions;
    };

    systemMessage.providerOptions = {
        ...(systemMessage.providerOptions ?? {}),
        anthropic: {
            ...(((systemMessage.providerOptions?.anthropic as Record<string, unknown> | undefined) ?? {})),
            cacheControl: { type: "ephemeral", ttl },
        },
    };

    return cloned;
}

export function addExplicitBreakpointAtIndex(
    messages: ModelMessage[],
    index: number,
    ttl: "5m" | "1h" = "1h"
): ModelMessage[] {
    const cloned = cloneMessages(messages);
    const target = cloned[index] as (ModelMessage & {
        providerOptions?: ProviderOptions;
    }) | undefined;

    if (!target) {
        throw new Error(`Cannot add explicit breakpoint: message index ${index} not found`);
    }

    target.providerOptions = {
        ...(target.providerOptions ?? {}),
        anthropic: {
            ...(((target.providerOptions?.anthropic as Record<string, unknown> | undefined) ?? {})),
            cacheControl: { type: "ephemeral", ttl },
        },
    };

    return cloned;
}

export async function runTurn(params: {
    model: LanguageModelV3;
    label: string;
    turn: number;
    messages: ModelMessage[];
    providerOptions?: ProviderOptions;
}): Promise<TurnResult> {
    const result = await generateText({
        model: params.model,
        messages: params.messages,
        providerOptions: params.providerOptions,
        tools: createStableTools(),
        toolChoice: "none",
        maxOutputTokens: 24,
        temperature: 0,
    });

    return {
        turn: params.turn,
        label: params.label,
        usage: extractAnthropicUsage(result),
        finishReason: result.finishReason,
        text: result.text,
        promptShape: summarizePromptShape(params.messages),
        providerMetadata: result.providerMetadata,
    };
}

export function formatUsage(usage: CacheUsageSnapshot): string {
    return [
        `input=${usage.inputTokens}`,
        `no_cache=${usage.noCacheInputTokens}`,
        `cache_read=${usage.cacheReadInputTokens}`,
        `cache_write=${usage.cacheWriteInputTokens}`,
        `output=${usage.outputTokens}`,
    ].join(" ");
}
