import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { getSystemReminderContext } from "../system-reminder-context";
import { prepareLLMRequest } from "@/agents/execution/request-preparation";
import { CONTEXT_MANAGEMENT_KEY } from "@/agents/execution/context-management";
import type { ExecutionContextManagement } from "@/agents/execution/context-management";
import { config as configService } from "@/services/ConfigService";

describe("explicit request preparation order", () => {
    let getAnalysisTelemetryConfigSpy: ReturnType<typeof spyOn> | undefined;

    beforeEach(() => {
        getSystemReminderContext().clear();
    });

    afterEach(() => {
        getAnalysisTelemetryConfigSpy?.mockRestore();
        getAnalysisTelemetryConfigSpy = undefined;
    });

    test("applies context management before sanitization without injecting reminders", async () => {
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
        expect(JSON.stringify(request.messages)).not.toContain("Service-level reminder.");
        expect(JSON.stringify(request.messages)).not.toContain("<heuristic>");
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

    test("records analysis seed and request-level context metrics when analysis is enabled", async () => {
        getAnalysisTelemetryConfigSpy = spyOn(
            configService,
            "getAnalysisTelemetryConfig"
        ).mockReturnValue({
            enabled: true,
            dbPath: "/tmp/test-analysis.db",
            retentionDays: 14,
            largeMessageThresholdTokens: 2000,
            storeMessagePreviews: true,
            maxPreviewChars: 256,
            storeFullMessageText: false,
        });

        const contextManagement: ExecutionContextManagement = {
            optionalTools: {},
            requestContext: {
                conversationId: "conv-1",
                agentId: "agent-1",
            },
            prepareRequest: async () => ({
                messages: [
                    {
                        role: "user",
                        content: [{ type: "text", text: "Shortened prompt" }],
                    },
                ],
                providerOptions: undefined,
                toolChoice: undefined,
                reportActualUsage: async () => {},
            }),
        };

        const request = await prepareLLMRequest({
            messages: [
                {
                    role: "user",
                    content: [{ type: "text", text: `Long prompt ${"x".repeat(200)}` }],
                },
            ],
            tools: {},
            providerId: "openrouter",
            contextManagement,
            analysisContext: {
                conversationId: "conv-1",
                agentSlug: "executor",
                agentId: "agent-1",
                projectId: "project-1",
            },
        });

        expect(request.analysisRequestSeed?.requestId).toBeDefined();
        expect(request.analysisRequestSeed?.telemetryMetadata["analysis.request_id"]).toBe(
            request.analysisRequestSeed?.requestId
        );
        expect(
            request.analysisRequestSeed?.preparedPromptMetrics?.preContextEstimatedInputTokens
        ).toBeGreaterThan(
            request.analysisRequestSeed?.preparedPromptMetrics?.sentEstimatedInputTokens ?? 0
        );
        expect(
            request.analysisRequestSeed?.preparedPromptMetrics?.estimatedInputTokensSaved
        ).toBeGreaterThan(0);
    });

    test("applies anthropic shared-prefix breakpoints and native clear_tool_uses after final prompt preparation", async () => {
        const observe = mock(() => ({
            sharedPrefixMessageCount: 2,
            lastSharedMessageIndex: 1,
            hasSharedPrefix: true,
        }));

        const contextManagement: ExecutionContextManagement = {
            optionalTools: {},
            requestContext: {
                conversationId: "conv-1",
                agentId: "agent-1",
            },
            promptStabilityTracker: {
                observe,
            },
            prepareRequest: async ({ messages }) => ({
                messages,
                providerOptions: {
                    custom: {
                        prepared: true,
                    },
                },
                toolChoice: undefined,
                reportActualUsage: async () => {},
            }),
        };

        const request = await prepareLLMRequest({
            messages: [
                { role: "system", content: "Stable system prompt" },
                {
                    role: "user",
                    content: [{ type: "text", text: "Request text" }],
                },
                {
                    role: "assistant",
                    content: [{ type: "text", text: "Changing tail" }],
                },
            ],
            tools: {},
            providerId: "anthropic",
            contextManagement,
        });

        expect(observe).toHaveBeenCalledWith([
            { role: "system", content: "Stable system prompt" },
            {
                role: "user",
                content: [{ type: "text", text: "Request text" }],
            },
        ]);
        expect(request.messages[1]?.providerOptions).toEqual({
            anthropic: {
                cacheControl: { type: "ephemeral", ttl: "1h" },
            },
        });
        expect(request.providerOptions).toEqual({
            custom: {
                prepared: true,
            },
            anthropic: {
                contextManagement: {
                    edits: [
                        {
                            type: "clear_tool_uses_20250919",
                            trigger: { type: "tool_uses", value: 25 },
                            keep: { type: "tool_uses", value: 10 },
                            clearAtLeast: { type: "input_tokens", value: 4000 },
                            clearToolInputs: true,
                            excludeTools: [
                                "delegate",
                                "delegate_followup",
                                "delegate_crossproject",
                            ],
                        },
                    ],
                },
            },
        });
    });
});
