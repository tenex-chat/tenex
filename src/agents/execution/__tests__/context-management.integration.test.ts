import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import type { AgentInstance } from "@/agents/types";
import { resetSystemReminders } from "@/agents/execution/system-reminders";
import { ConversationStore } from "@/conversations/ConversationStore";
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
            compactionThresholdPercent: 90,
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

    function collectTextContent(message: { content: unknown } | undefined): string {
        if (!message) {
            return "";
        }

        if (typeof message.content === "string") {
            return message.content;
        }

        if (!Array.isArray(message.content)) {
            return JSON.stringify(message.content);
        }

        return message.content
            .filter(
                (part): part is { type: "text"; text: string } =>
                    typeof part === "object"
                    && part !== null
                    && "type" in part
                    && part.type === "text"
                    && "text" in part
                    && typeof part.text === "string"
            )
            .map((part) => part.text)
            .join("\n");
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

        expect(prepared?.messages).toHaveLength(4);
        expect(prepared?.messages[0]).toMatchObject({
            role: "system",
            content: "You are helpful.",
        });
        expect(prepared?.messages[1]).toMatchObject({
            role: "user",
        });
        expect(collectTextContent(prepared?.messages[1])).toContain("Legacy user request");
        expect(prepared?.messages[2]).toMatchObject({
            role: "assistant",
        });
        expect(collectTextContent(prepared?.messages[2])).toContain("Legacy assistant reply");
        expect(prepared?.messages[3]).toMatchObject({
            role: "user",
        });
        expect(collectTextContent(prepared?.messages[3])).toContain("Continue working");
    });

    test("compact_context persists anchored compactions across prompt rebuilds", async () => {
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

        const compactContextTool = contextManagement?.optionalTools.compact_context as {
            execute: (
                input: unknown,
                options: {
                    toolCallId?: string;
                    messages?: Array<Record<string, unknown>>;
                    experimental_context: Record<string, unknown>;
                }
            ) => Promise<unknown>;
        };

        const messages = [
            { role: "system", content: "You are helpful.", id: "system-1" },
            {
                role: "user",
                id: "msg-user-1",
                eventId: "evt-user-1",
                content: [{ type: "text", text: "Initial task: debug the parser regression." }],
            },
            {
                role: "assistant",
                id: "msg-assistant-1",
                eventId: "evt-assistant-1",
                content: [{ type: "text", text: "I inspected the parser entrypoint and middleware ordering." }],
            },
            {
                role: "user",
                id: "msg-user-2",
                eventId: "evt-user-2",
                content: [{ type: "text", text: "Please keep the failed test cases in mind." }],
            },
            {
                role: "assistant",
                id: "msg-assistant-2",
                eventId: "evt-assistant-2",
                content: [{ type: "text", text: "I reproduced the failure and identified the stale cache layer." }],
            },
            {
                role: "user",
                id: "msg-user-3",
                eventId: "evt-user-3",
                content: [{ type: "text", text: "Continue with the fix and avoid losing the key findings." }],
            },
        ] as const;

        const result = await compactContextTool.execute(
            {
                message: [
                    "Task: debug parser regression.",
                    "Completed: identified middleware ordering issue and stale cache layer.",
                    "Important Findings: preserve failing test coverage.",
                    "Open Issues: implement the fix.",
                    "Next Steps: patch the parser and rerun tests.",
                    "Persistent Facts: user wants key findings preserved.",
                ].join("\n"),
                from: "Initial task: debug the parser regression.",
                to: "identified the stale cache layer.",
            },
            {
                toolCallId: "compact-tool-1",
                messages: messages as unknown as Array<Record<string, unknown>>,
                experimental_context: {
                    [CONTEXT_MANAGEMENT_KEY]: contextManagement?.requestContext,
                },
            }
        ) as { ok: boolean; compactedMessageCount?: number };

        expect(result.ok).toBe(true);
        expect(result.compactedMessageCount).toBe(4);

        const prepared = await prepareManagedRequest(contextManagement, [...messages]);
        const preparedJson = JSON.stringify(prepared?.messages);
        expect(preparedJson).toContain("Task: debug parser regression.");
        expect(preparedJson).not.toContain("Initial task: debug the parser regression.");
        expect(preparedJson).not.toContain("identified the stale cache layer.");
        expect(preparedJson).toContain("Continue with the fix and avoid losing the key findings.");

        const persistedState = store.getContextManagementCompaction(AGENT_PUBKEY);
        expect(persistedState?.edits).toHaveLength(1);
        expect(persistedState?.edits[0]).toEqual(
            expect.objectContaining({
                source: "manual",
                compactedMessageCount: 4,
                fromText: "Initial task: debug the parser regression.",
                toText: "identified the stale cache layer.",
                start: expect.objectContaining({
                    eventId: "evt-user-1",
                }),
                end: expect.objectContaining({
                    eventId: "evt-assistant-2",
                }),
            })
        );

        const rebuilt = await prepareManagedRequest(contextManagement, [...messages]);
        const rebuiltJson = JSON.stringify(rebuilt?.messages);
        expect(rebuiltJson).toContain("Task: debug parser regression.");
        expect(rebuiltJson).not.toContain("Initial task: debug the parser regression.");
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

        const preparedJson = JSON.stringify(prepared?.messages);
        expect(preparedJson).toContain("Focus on the parser errors");
        expect(preparedJson).toContain("<scratchpad>");
        expect(preparedJson).toContain("\"toolCallId\":\"call-old\"");
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
        expect(prepared?.providerOptions).toEqual(
            expect.objectContaining({
                anthropic: expect.objectContaining({
                    contextManagement: expect.objectContaining({
                        edits: expect.arrayContaining([
                            expect.objectContaining({
                                type: "clear_tool_uses_20250919",
                            }),
                        ]),
                    }),
                }),
            })
        );
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

        const shortPromptJson = JSON.stringify(shortPrompt?.messages);
        expect(shortPromptJson).not.toContain("[Context utilization:");
        expect(shortPromptJson).not.toContain("<context-window-status>");

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

        const longPromptJson = JSON.stringify(longPrompt?.messages);
        expect(longPromptJson).toContain("[Context utilization:");
        expect(longPromptJson).toContain("managed working budget");
        expect(longPromptJson).toContain("scratchpad(...)");
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

        const preparedJson = JSON.stringify(prepared?.messages);
        expect(preparedJson).not.toContain("[Context utilization:");
        expect(preparedJson).not.toContain("<context-window-status>");
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
        const preparedJson = JSON.stringify(prepared?.messages);
        expect(preparedJson).not.toContain("Use scratchpad(...) now");
        expect(preparedJson).toContain(
            "Your managed working budget is getting tight. Trim or summarize stale context before continuing."
        );
        expect(preparedJson).not.toContain("<scratchpad>");
    });

    test("context status reminder reports working budget and raw model window from the final prompt state", async () => {
        setContextManagementConfig({
            tokenBudget: 100,
        });

        using contextWindowSpy = spyOn(contextWindowCache, "getContextWindow").mockReturnValue(
            200
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
                    content: [{ type: "text", text: `Inspect the parser flow and keep the prompt focused. ${"x".repeat(620)}` }],
                },
            ],
            {
                provider: "anthropic",
                modelId: "claude-opus-4-5-20251101",
            }
        );

        const preparedJson = JSON.stringify(prepared?.messages);
        expect(preparedJson).not.toContain("[Context status]");
        expect(preparedJson).toContain("<context-window-status>");
        expect(preparedJson).toContain("managed working budget");
        expect(preparedJson).toContain("Model window:");
        expect(preparedJson).toContain("/100 tokens");
        expect(preparedJson).toContain("/200 tokens");
        expect(preparedJson).not.toContain("<scratchpad>");
    });
});
