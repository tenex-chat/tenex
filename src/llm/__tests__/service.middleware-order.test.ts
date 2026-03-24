import { beforeEach, describe, expect, mock, test } from "bun:test";
import { getSystemReminderContext } from "../system-reminder-context";
import { prepareLLMRequest } from "@/agents/execution/request-preparation";
import { CONTEXT_MANAGEMENT_KEY } from "@/agents/execution/context-management";
import type { ExecutionContextManagement } from "@/agents/execution/context-management";

describe("explicit request preparation order", () => {
    beforeEach(() => {
        getSystemReminderContext().clear();
    });

    test("applies context management before sanitization and reminders", async () => {
        const prepareRequest = mock(async () => ({
            messages: [
                { role: "user" as const, content: [] },
                {
                    role: "user" as const,
                    content: [{ type: "text" as const, text: "Keep this message" }],
                },
            ],
            providerOptions: {
                custom: {
                    prepared: true,
                },
            },
            toolChoice: undefined,
            reportActualUsage: async () => {},
        }));

        const contextManagement: ExecutionContextManagement = {
            optionalTools: {},
            requestContext: {
                conversationId: "conv-1",
                agentId: "agent-1",
                agentLabel: "Alpha",
            },
            prepareRequest,
        };

        getSystemReminderContext().queue({
            type: "heuristic",
            content: "Service-level reminder.",
        });

        const request = await prepareLLMRequest({
            messages: [
                {
                    role: "assistant",
                    content: [{ type: "text", text: "Original assistant content" }],
                },
            ],
            tools: {},
            providerId: "openrouter",
            model: {
                provider: "openrouter",
                modelId: "gpt-4",
            },
            contextManagement,
        });

        expect(prepareRequest).toHaveBeenCalledWith({
            messages: [
                {
                    role: "assistant",
                    content: [{ type: "text", text: "Original assistant content" }],
                },
            ],
            model: {
                provider: "openrouter",
                modelId: "gpt-4",
            },
            providerOptions: undefined,
            toolChoice: undefined,
            tools: {},
        });
        expect(request.messages).toHaveLength(1);
        expect(request.messages[0]).toEqual({
            role: "user",
            content: [
                {
                    type: "text",
                    text: expect.stringContaining("Keep this message"),
                },
            ],
        });
        expect(JSON.stringify(request.messages)).toContain("Service-level reminder.");
        expect(JSON.stringify(request.messages)).toContain("<heuristic>");
        expect(request.providerOptions).toEqual({
            custom: {
                prepared: true,
            },
        });
        expect(request.experimentalContext).toEqual({
            [CONTEXT_MANAGEMENT_KEY]: contextManagement.requestContext,
        });
    });

    test("preserves context-management tool choice in the final prepared request", async () => {
        const contextManagement: ExecutionContextManagement = {
            optionalTools: {},
            requestContext: {
                conversationId: "conv-1",
                agentId: "agent-1",
            },
            prepareRequest: async ({ messages }) => ({
                messages,
                toolChoice: {
                    type: "tool",
                    toolName: "scratchpad",
                },
                providerOptions: undefined,
                reportActualUsage: async () => {},
            }),
        };

        const request = await prepareLLMRequest({
            messages: [
                {
                    role: "user",
                    content: [{ type: "text", text: "Compact this context." }],
                },
            ],
            tools: {},
            providerId: "openrouter",
            contextManagement,
        });

        expect(request.toolChoice).toEqual({
            type: "tool",
            toolName: "scratchpad",
        });
    });

    test("normalizes legacy string content before invoking context management", async () => {
        const prepareRequest = mock(async ({ messages }: { messages: unknown[] }) => ({
            messages: messages as any,
            providerOptions: undefined,
            toolChoice: undefined,
            reportActualUsage: async () => {},
        }));

        const contextManagement: ExecutionContextManagement = {
            optionalTools: {},
            requestContext: {
                conversationId: "conv-1",
                agentId: "agent-1",
            },
            prepareRequest,
        };

        await prepareLLMRequest({
            messages: [
                { role: "system", content: "System prompt" },
                { role: "user", content: "Legacy user prompt" },
                { role: "assistant", content: "Legacy assistant response" },
            ],
            tools: {},
            providerId: "openrouter",
            contextManagement,
        });

        expect(prepareRequest).toHaveBeenCalledWith({
            messages: [
                { role: "system", content: "System prompt" },
                {
                    role: "user",
                    content: [{ type: "text", text: "Legacy user prompt" }],
                },
                {
                    role: "assistant",
                    content: [{ type: "text", text: "Legacy assistant response" }],
                },
            ],
            model: undefined,
            providerOptions: undefined,
            toolChoice: undefined,
            tools: {},
        });
    });
});
