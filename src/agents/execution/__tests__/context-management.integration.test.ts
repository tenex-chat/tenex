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
    type ExecutionContextManagement,
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

    async function prepareManagedRequest(
        contextManagement: ExecutionContextManagement | undefined,
        messages: Array<Record<string, unknown>>,
        model: { provider: string; modelId: string } = { provider: "mock", modelId: "mock" }
    ) {
        expect(contextManagement).toBeDefined();
        return await contextManagement?.prepareRequest({
            messages: messages as any,
            model,
        });
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
        expect(typeof contextManagement?.prepareRequest).toBe("function");
    });

    test("normalizes legacy string user and assistant content before prepareRequest", async () => {
        setContextManagementConfig({});

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

        const prepared = await prepareManagedRequest(contextManagement, [
            { role: "system", content: "You are helpful." },
            { role: "user", content: "Legacy user request" },
            { role: "assistant", content: "Legacy assistant reply" },
            { role: "user", content: "Continue working" },
        ]);

        expect(prepared?.messages).toEqual([
            { role: "system", content: "You are helpful." },
            {
                role: "user",
                content: [{ type: "text", text: "Legacy user request" }],
            },
            {
                role: "assistant",
                content: [{ type: "text", text: "Legacy assistant reply" }],
            },
            {
                role: "user",
                content: [{ type: "text", text: "Continue working" }],
            },
        ]);
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

        const prepared = await prepareManagedRequest(contextManagement, [
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
        ]);

        expect(JSON.stringify(prepared?.messages)).not.toContain("Focus on the parser errors");
        expect(JSON.stringify(prepared?.messages)).not.toContain("\"toolCallId\":\"call-old\"");
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
            tokenBudget: 12000,
            forceScratchpadThresholdPercent: 100,
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

        const prepared = await prepareManagedRequest(contextManagement, prompt);
        const transformedJson = JSON.stringify(prepared?.messages);
        expect(transformedJson).toContain("use fs_read(tool:");
        expect(transformedJson).toContain("[fs_read was used, id: call-1");
        expect(transformedJson).toContain("\"toolCallId\":\"call-9\"");
    });

    test("anthropic stack keeps stale tool results raw and exposes prompt-stability tracking", async () => {
        setContextManagementConfig({
            tokenBudget: 12000,
            forceScratchpadThresholdPercent: 100,
        });

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

        const prompt: Array<Record<string, unknown>> = [{ role: "system", content: "You are helpful." }];
        for (let index = 1; index <= 4; index++) {
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
                            value: `result-${index} ${"x".repeat(8000)}`,
                        },
                    },
                ],
            });
        }
        prompt.push({
            role: "user",
            content: [{ type: "text", text: "Continue." }],
        });

        const prepared = await prepareManagedRequest(contextManagement, prompt, {
            provider: "anthropic",
            modelId: "claude-haiku-4-5",
        });

        const transformedJson = JSON.stringify(prepared?.messages);
        expect(transformedJson).not.toContain("use fs_read(tool:");
        expect(contextManagement?.promptStabilityTracker).toBeDefined();
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

        const shortPrompt = await prepareManagedRequest(contextManagement, [
            { role: "system", content: "You are helpful." },
            {
                role: "user",
                content: [{ type: "text", text: "Short request." }],
            },
        ]);

        expect(JSON.stringify(shortPrompt?.messages)).not.toContain("[Context utilization:");
        const shortPromptReminders = await getSystemReminderContext().collect();
        expect(shortPromptReminders.map((reminder) => reminder.type)).toEqual([
            "scratchpad",
            "context-window-status",
        ]);

        const longPrompt = await prepareManagedRequest(contextManagement, [
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
        ]);

        expect(JSON.stringify(longPrompt?.messages)).not.toContain("[Context utilization:");
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

        const prepared = await prepareManagedRequest(contextManagement, [
            {
                role: "system",
                content: `You are helpful. ${"s".repeat(800)}`,
            },
            {
                role: "user",
                content: [{ type: "text", text: "Short request." }],
            },
        ]);

        expect(JSON.stringify(prepared?.messages)).not.toContain("[Context utilization:");
        const reminders = await getSystemReminderContext().collect();
        expect(reminders.map((reminder) => reminder.type)).toEqual([
            "scratchpad",
            "context-window-status",
        ]);
        const contextStatusReminder = reminders.find(
            (reminder) => reminder.type === "context-window-status"
        );
        expect(contextStatusReminder?.content).toContain("managed working budget");
        expect(contextStatusReminder?.content).toContain("~9/100 tokens");
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

        const prepared = await prepareManagedRequest(contextManagement, [
            { role: "system", content: "You are helpful." },
            {
                role: "user",
                content: [{ type: "text", text: `Long request ${"z".repeat(620)}` }],
            },
        ]);

        expect(prepared?.toolChoice).toEqual({
            type: "tool",
            toolName: "scratchpad",
        });

        const postScratchpadPrompt = await prepareManagedRequest(contextManagement, [
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
        ]);

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
            skillToolPermissions: {
                onlyTools: ["shell"],
            },
        });

        expect(contextManagement?.optionalTools.scratchpad).toBeUndefined();

        const prepared = await prepareManagedRequest(contextManagement, [
            { role: "system", content: "You are helpful." },
            {
                role: "user",
                content: [{ type: "text", text: `Long request ${"z".repeat(620)}` }],
            },
        ]);

        expect(prepared?.toolChoice).toBeUndefined();
        expect(JSON.stringify(prepared?.messages)).not.toContain("Use scratchpad(...) now");
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

        const prepared = await prepareManagedRequest(
            contextManagement,
            [
                { role: "system", content: "You are helpful." },
                {
                    role: "user",
                    content: [{ type: "text", text: "Inspect the parser flow and keep the prompt focused." }],
                },
            ],
            {
                provider: "anthropic",
                modelId: "claude-opus-4-5-20251101",
            }
        );

        expect(JSON.stringify(prepared?.messages)).not.toContain("[Context status]");
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
        expect(contextStatusReminder?.content).toContain("managed working budget");
        expect(contextStatusReminder?.content).toContain("Model window:");
        expect(contextStatusReminder?.content).toContain("200,000");
    });
});
