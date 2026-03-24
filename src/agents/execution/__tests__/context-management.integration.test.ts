import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import type { AgentInstance } from "@/agents/types";
import { resetSystemReminders } from "@/agents/execution/system-reminders";
import { ConversationStore } from "@/conversations/ConversationStore";
import { getSystemReminderContext } from "@/llm/system-reminder-context";
import * as contextWindowCache from "@/llm/utils/context-window-cache";
import { config as configService } from "@/services/ConfigService";
import {
    CONTEXT_MANAGEMENT_KEY,
    createExecutionContextManagement,
} from "../context-management";

describe("TENEX context management integration", () => {
    const TEST_DIR = "/tmp/tenex-context-management";
    const PROJECT_ID = "project-context-management";
    const CONVERSATION_ID = "conv-context-management";
    const AGENT_PUBKEY = "agent-pubkey-123";

    let store: ConversationStore;
    let getContextManagementConfigSpy: ReturnType<typeof spyOn>;
    let getSummarizationModelNameSpy: ReturnType<typeof spyOn>;

    function buildContextManagementConfig(overrides: Record<string, unknown>) {
        return {
            tokenBudget: 40000,
            forceScratchpadThresholdPercent: 70,
            utilizationWarningThresholdPercent: 70,
            summarizationFallbackThresholdPercent: 90,
            ...overrides,
        };
    }

    function setContextManagementConfig(overrides: Record<string, unknown>): void {
        getContextManagementConfigSpy.mockReturnValue(buildContextManagementConfig(overrides) as any);
    }

    beforeEach(async () => {
        await mkdir(TEST_DIR, { recursive: true });
        store = new ConversationStore(TEST_DIR);
        store.load(PROJECT_ID, CONVERSATION_ID);
        getContextManagementConfigSpy = spyOn(
            configService,
            "getContextManagementConfig"
        ).mockReturnValue(undefined);
        getSummarizationModelNameSpy = spyOn(
            configService,
            "getSummarizationModelName"
        ).mockImplementation(() => {
            throw new Error("summarization model unavailable in tests");
        });
        resetSystemReminders();
    });

    afterEach(async () => {
        resetSystemReminders();
        getContextManagementConfigSpy?.mockRestore();
        getSummarizationModelNameSpy?.mockRestore();
        await rm(TEST_DIR, { recursive: true, force: true });
    });

    test("enables context management for codex", () => {
        setContextManagementConfig({});

        const agent = {
            name: "executor",
            slug: "executor",
            pubkey: AGENT_PUBKEY,
        } as AgentInstance;

        const contextManagement = createExecutionContextManagement({
            providerId: "codex",
            conversationId: CONVERSATION_ID,
            agent,
            conversationStore: store,
        });

        expect(contextManagement).toBeDefined();
        expect(contextManagement?.middleware).toBeDefined();
    });

    test("scratchpad tool persists state and affects the next prompt projection", async () => {
        const agent = {
            name: "executor",
            slug: "executor",
            pubkey: AGENT_PUBKEY,
        } as AgentInstance;
        const contextManagement = createExecutionContextManagement({
            providerId: "openrouter",
            conversationId: CONVERSATION_ID,
            agent,
            conversationStore: store,
        });

        expect(contextManagement).toBeDefined();
        expect(contextManagement?.optionalTools.scratchpad).toBeDefined();

        const scratchpadTool = contextManagement?.optionalTools.scratchpad as {
            execute: (input: unknown, options: { experimental_context: Record<string, unknown> }) => Promise<unknown>;
        };
        await scratchpadTool.execute(
            {
                description: "Capture the parser focus before continuing",
                setEntries: {
                    notes: "Focus on the parser errors",
                },
                omitToolCallIds: ["call-old"],
            },
            {
                experimental_context: {
                    [CONTEXT_MANAGEMENT_KEY]: contextManagement?.requestContext,
                },
            }
        );

        expect(store.getContextManagementScratchpad(AGENT_PUBKEY)).toEqual(
            expect.objectContaining({
                entries: {
                    notes: "Focus on the parser errors",
                },
                omitToolCallIds: ["call-old"],
            })
        );

        const transformed = await contextManagement?.middleware.transformParams?.({
            params: {
                prompt: [
                    { role: "system", content: "You are helpful." },
                    {
                        role: "assistant",
                        content: [{ type: "tool-call", toolCallId: "call-old", toolName: "fs_read", input: { path: "old.ts" } }],
                    },
                    {
                        role: "tool",
                        content: [{ type: "tool-result", toolCallId: "call-old", toolName: "fs_read", output: { type: "text", value: "old contents" } }],
                    },
                    {
                        role: "user",
                        content: [{ type: "text", text: "Continue." }],
                    },
                ],
                providerOptions: {
                    [CONTEXT_MANAGEMENT_KEY]: contextManagement?.requestContext,
                },
            },
            model: {
                specificationVersion: "v3",
                provider: "mock",
                modelId: "mock",
                supportedUrls: {},
                doGenerate: async () => {
                    throw new Error("unused");
                },
                doStream: async () => {
                    throw new Error("unused");
                },
            },
        } as any);

        expect(JSON.stringify(transformed?.prompt)).not.toContain("Focus on the parser errors");
        expect(JSON.stringify(transformed?.prompt)).not.toContain("\"toolCallId\":\"call-old\"");
        const scratchpadReminders = await getSystemReminderContext().collect();
        expect(scratchpadReminders).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    type: "scratchpad",
                    content: expect.stringContaining("Focus on the parser errors"),
                }),
            ])
        );
    });

    test("default stack decays stale tool results instead of dropping whole exchanges", async () => {
        setContextManagementConfig({
            tokenBudget: 200,
        });

        const agent = {
            name: "executor",
            slug: "executor",
            pubkey: AGENT_PUBKEY,
        } as AgentInstance;
        const contextManagement = createExecutionContextManagement({
            providerId: "openrouter",
            conversationId: CONVERSATION_ID,
            agent,
            conversationStore: store,
        });

        expect(contextManagement).toBeDefined();

        const prompt: Array<Record<string, unknown>> = [{ role: "system", content: "You are helpful." }];
        for (let index = 1; index <= 9; index++) {
            prompt.push({
                role: "assistant",
                content: [
                    {
                        type: "tool-call",
                        toolCallId: `call-${index}`,
                        toolName: "fs_read",
                        input: { path: `file-${index}.ts` },
                    },
                ],
            });
            prompt.push({
                role: "tool",
                content: [
                    {
                        type: "tool-result",
                        toolCallId: `call-${index}`,
                        toolName: "fs_read",
                        output: {
                            type: "text",
                            value: `result-${index} ${"x".repeat(index === 1 ? 12000 : 4000)}`,
                        },
                    },
                ],
            });
        }
        prompt.push({
            role: "user",
            content: [{ type: "text", text: "Continue." }],
        });

        const transformed = await contextManagement?.middleware.transformParams?.({
            params: {
                prompt: prompt as any,
                providerOptions: {
                    [CONTEXT_MANAGEMENT_KEY]: contextManagement?.requestContext,
                },
            },
            model: {
                specificationVersion: "v3",
                provider: "mock",
                modelId: "mock",
                supportedUrls: {},
                doGenerate: async () => {
                    throw new Error("unused");
                },
                doStream: async () => {
                    throw new Error("unused");
                },
            },
        } as any);

        const transformedJson = JSON.stringify(transformed?.prompt);
        expect(transformedJson).toContain("fs_read(tool:");
        expect(transformedJson).toContain("\"toolCallId\":\"call-1\"");
        expect(transformedJson).toContain("\"toolCallId\":\"call-9\"");
    });

    test("utilization warning only appears once the working budget threshold is crossed", async () => {
        setContextManagementConfig({
            tokenBudget: 200,
            forceScratchpadThresholdPercent: 100,
            utilizationWarningThresholdPercent: 70,
        });

        const agent = {
            name: "executor",
            slug: "executor",
            pubkey: AGENT_PUBKEY,
        } as AgentInstance;
        const contextManagement = createExecutionContextManagement({
            providerId: "openrouter",
            conversationId: CONVERSATION_ID,
            agent,
            conversationStore: store,
        });

        expect(contextManagement).toBeDefined();

        const shortPrompt = await contextManagement?.middleware.transformParams?.({
            params: {
                prompt: [
                    { role: "system", content: "You are helpful." },
                    {
                        role: "user",
                        content: [{ type: "text", text: "Short request." }],
                    },
                ],
                providerOptions: {
                    [CONTEXT_MANAGEMENT_KEY]: contextManagement?.requestContext,
                },
            },
            model: {
                specificationVersion: "v3",
                provider: "mock",
                modelId: "mock",
                supportedUrls: {},
                doGenerate: async () => {
                    throw new Error("unused");
                },
                doStream: async () => {
                    throw new Error("unused");
                },
            },
        } as any);

        expect(JSON.stringify(shortPrompt?.prompt)).not.toContain("[Context utilization:");
        const shortPromptReminders = await getSystemReminderContext().collect();
        expect(shortPromptReminders.map((reminder) => reminder.type)).toEqual([
            "scratchpad",
            "context-window-status",
        ]);

        const longPrompt = await contextManagement?.middleware.transformParams?.({
            params: {
                prompt: [
                    { role: "system", content: "You are helpful." },
                    {
                        role: "user",
                        content: [
                            {
                                type: "text",
                                text: `Long request ${"y".repeat(620)}`,
                            },
                        ],
                    },
                ],
                providerOptions: {
                    [CONTEXT_MANAGEMENT_KEY]: contextManagement?.requestContext,
                },
            },
            model: {
                specificationVersion: "v3",
                provider: "mock",
                modelId: "mock",
                supportedUrls: {},
                doGenerate: async () => {
                    throw new Error("unused");
                },
                doStream: async () => {
                    throw new Error("unused");
                },
            },
        } as any);

        expect(JSON.stringify(longPrompt?.prompt)).not.toContain("[Context utilization:");
        const utilizationReminders = await getSystemReminderContext().collect();
        expect(utilizationReminders).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    type: "context-utilization",
                    content: expect.stringContaining("[Context utilization:"),
                }),
            ])
        );
        const utilizationReminder = utilizationReminders.find(
            (reminder) => reminder.type === "context-utilization"
        );
        expect(utilizationReminder?.content).toContain("managed working budget");
        expect(utilizationReminder?.content).toContain("scratchpad(...)");
    });

    test("managed working budget excludes base system prompts and tool definitions", async () => {
        setContextManagementConfig({
            tokenBudget: 100,
            forceScratchpadThresholdPercent: 100,
            utilizationWarningThresholdPercent: 70,
        });

        const agent = {
            name: "executor",
            slug: "executor",
            pubkey: AGENT_PUBKEY,
        } as AgentInstance;
        const contextManagement = createExecutionContextManagement({
            providerId: "openrouter",
            conversationId: CONVERSATION_ID,
            agent,
            conversationStore: store,
        });

        expect(contextManagement).toBeDefined();

        const transformed = await contextManagement?.middleware.transformParams?.({
            params: {
                prompt: [
                    {
                        role: "system",
                        content: `You are helpful. ${"s".repeat(800)}`,
                    },
                    {
                        role: "user",
                        content: [{ type: "text", text: "Short request." }],
                    },
                ],
                providerOptions: {
                    [CONTEXT_MANAGEMENT_KEY]: contextManagement?.requestContext,
                },
            },
            model: {
                specificationVersion: "v3",
                provider: "mock",
                modelId: "mock",
                supportedUrls: {},
                doGenerate: async () => {
                    throw new Error("unused");
                },
                doStream: async () => {
                    throw new Error("unused");
                },
            },
        } as any);

        expect(JSON.stringify(transformed?.prompt)).not.toContain("[Context utilization:");
        const reminders = await getSystemReminderContext().collect();
        expect(reminders.map((reminder) => reminder.type)).toEqual([
            "scratchpad",
            "context-window-status",
        ]);
        const contextStatusReminder = reminders.find(
            (reminder) => reminder.type === "context-window-status"
        );
        expect(contextStatusReminder?.content).toContain("[Context status]");
        expect(contextStatusReminder?.content).toContain("managed working budget context:");
        expect(contextStatusReminder?.content).toContain(
            "Static overhead outside the managed working budget:"
        );
        expect(contextStatusReminder?.content).toContain(
            "managed working budget target: ~100 tokens"
        );
    });

    test("forced scratchpad tool choice appears once the configured threshold is crossed", async () => {
        setContextManagementConfig({
            tokenBudget: 200,
            forceScratchpadThresholdPercent: 70,
        });

        const agent = {
            name: "executor",
            slug: "executor",
            pubkey: AGENT_PUBKEY,
        } as AgentInstance;
        const contextManagement = createExecutionContextManagement({
            providerId: "openrouter",
            conversationId: CONVERSATION_ID,
            agent,
            conversationStore: store,
        });

        expect(contextManagement).toBeDefined();

        const transformed = await contextManagement?.middleware.transformParams?.({
            params: {
                prompt: [
                    { role: "system", content: "You are helpful." },
                    {
                        role: "user",
                        content: [{ type: "text", text: `Long request ${"z".repeat(620)}` }],
                    },
                ],
                providerOptions: {
                    [CONTEXT_MANAGEMENT_KEY]: contextManagement?.requestContext,
                },
            },
            model: {
                specificationVersion: "v3",
                provider: "mock",
                modelId: "mock",
                supportedUrls: {},
                doGenerate: async () => {
                    throw new Error("unused");
                },
                doStream: async () => {
                    throw new Error("unused");
                },
            },
        } as any);

        expect(transformed?.toolChoice).toEqual({
            type: "tool",
            toolName: "scratchpad",
        });

        const postScratchpadPrompt = await contextManagement?.middleware.transformParams?.({
            params: {
                prompt: [
                    { role: "system", content: "You are helpful." },
                    {
                        role: "assistant",
                        content: [
                            {
                                type: "tool-call",
                                toolCallId: "scratch-call-1",
                                toolName: "scratchpad",
                                input: { setEntries: { notes: "Keep parser context" } },
                            },
                        ],
                    },
                    {
                        role: "tool",
                        content: [
                            {
                                type: "tool-result",
                                toolCallId: "scratch-call-1",
                                toolName: "scratchpad",
                                output: { type: "json", value: { ok: true } },
                            },
                        ],
                    },
                    {
                        role: "user",
                        content: [{ type: "text", text: `Long request ${"z".repeat(620)}` }],
                    },
                ],
                providerOptions: {
                    [CONTEXT_MANAGEMENT_KEY]: contextManagement?.requestContext,
                },
            },
            model: {
                specificationVersion: "v3",
                provider: "mock",
                modelId: "mock",
                supportedUrls: {},
                doGenerate: async () => {
                    throw new Error("unused");
                },
                doStream: async () => {
                    throw new Error("unused");
                },
            },
        } as any);

        expect(postScratchpadPrompt?.toolChoice).toBeUndefined();
    });

    test("only-tool mode disables scratchpad-specific forcing and guidance", async () => {
        setContextManagementConfig({
            tokenBudget: 200,
            forceScratchpadThresholdPercent: 70,
            utilizationWarningThresholdPercent: 70,
        });

        const agent = {
            name: "executor",
            slug: "executor",
            pubkey: AGENT_PUBKEY,
        } as AgentInstance;
        const contextManagement = createExecutionContextManagement({
            providerId: "openrouter",
            conversationId: CONVERSATION_ID,
            agent,
            conversationStore: store,
            nudgeToolPermissions: {
                onlyTools: ["shell"],
            },
        });

        expect(contextManagement).toBeDefined();
        expect(contextManagement?.optionalTools.scratchpad).toBeUndefined();

        const transformed = await contextManagement?.middleware.transformParams?.({
            params: {
                prompt: [
                    { role: "system", content: "You are helpful." },
                    {
                        role: "user",
                        content: [{ type: "text", text: `Long request ${"z".repeat(620)}` }],
                    },
                ],
                providerOptions: {
                    [CONTEXT_MANAGEMENT_KEY]: contextManagement?.requestContext,
                },
            },
            model: {
                specificationVersion: "v3",
                provider: "mock",
                modelId: "mock",
                supportedUrls: {},
                doGenerate: async () => {
                    throw new Error("unused");
                },
                doStream: async () => {
                    throw new Error("unused");
                },
            },
        } as any);

        expect(transformed?.toolChoice).toBeUndefined();
        expect(JSON.stringify(transformed?.prompt)).not.toContain("Use scratchpad(...) now");
        const genericReminder = await getSystemReminderContext().collect();
        expect(genericReminder).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    type: "context-utilization",
                    content: expect.stringContaining(
                        "Your managed working budget is getting tight. Trim or summarize stale context before continuing."
                    ),
                }),
            ])
        );
        expect(genericReminder.some((reminder) => reminder.type === "scratchpad")).toBe(false);
    });

    test("context status reminder reports working budget and raw model window from the final prompt state", async () => {
        setContextManagementConfig({
            tokenBudget: 400,
        });

        using contextWindowSpy = spyOn(contextWindowCache, "getContextWindow").mockReturnValue(
            200000
        );

        const agent = {
            name: "executor",
            slug: "executor",
            pubkey: AGENT_PUBKEY,
        } as AgentInstance;
        const contextManagement = createExecutionContextManagement({
            providerId: "anthropic",
            conversationId: CONVERSATION_ID,
            agent,
            conversationStore: store,
        });

        expect(contextManagement).toBeDefined();

        const transformed = await contextManagement?.middleware.transformParams?.({
            params: {
                prompt: [
                    { role: "system", content: "You are helpful." },
                    {
                        role: "user",
                        content: [{ type: "text", text: "Inspect the parser flow and keep the prompt focused." }],
                    },
                ],
                providerOptions: {
                    [CONTEXT_MANAGEMENT_KEY]: contextManagement?.requestContext,
                },
            },
            model: {
                specificationVersion: "v3",
                provider: "anthropic",
                modelId: "claude-opus-4-5-20251101",
                supportedUrls: {},
                doGenerate: async () => {
                    throw new Error("unused");
                },
                doStream: async () => {
                    throw new Error("unused");
                },
            },
        } as any);

        expect(JSON.stringify(transformed?.prompt)).not.toContain("[Context status]");
        const contextStatusReminders = await getSystemReminderContext().collect();
        expect(contextStatusReminders).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    type: "scratchpad",
                }),
                expect.objectContaining({
                    type: "context-window-status",
                }),
            ])
        );
        const contextStatusReminder = contextStatusReminders.find(
            (reminder) => reminder.type === "context-window-status"
        );
        expect(contextStatusReminder?.content).toContain("[Context status]");
        expect(contextStatusReminder?.content).toContain(
            "Current request after context management:"
        );
        expect(contextStatusReminder?.content).toContain(
            "managed working budget context:"
        );
        expect(contextStatusReminder?.content).toContain(
            "Raw model context window: ~200,000 tokens"
        );
    });
});
